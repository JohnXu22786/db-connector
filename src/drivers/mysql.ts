/**
 * MySQL driver over the optional `mysql2/promise` package (peer dependency).
 * Uses server-side prepared statements (`execute`) so values never touch SQL
 * text, runs reads inside a READ ONLY transaction, wraps writes in
 * BEGIN/COMMIT/ROLLBACK, and cancels in-flight queries by destroying the
 * connection when the caller's AbortSignal fires.
 */

import { ErrorCode, DbConnectorError } from '../errors.js';
import type { ResolvedConnectionSpec } from '../types.js';
import type { DriverApi, DriverLogger, Introspection, ReadOutcome, WriteOutcome } from './driver.js';
import { importOptional, redactSpecMessage } from './driver.js';

interface MysqlConnection {
  execute(sql: string, values?: unknown[]): Promise<[unknown, unknown]>;
  execute(options: {
    sql: string;
    values?: unknown[];
    rowsAsArray?: boolean;
  }): Promise<[unknown, unknown]>;
  query(sql: string, values?: unknown[]): Promise<[unknown, unknown]>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  destroy(): void;
  end(): Promise<void>;
}

interface MysqlModule {
  createConnection(opts: Record<string, unknown>): Promise<MysqlConnection>;
}

async function loadMysqlModule(): Promise<MysqlModule> {
  const raw = await importOptional<Record<string, unknown>>('mysql2/promise');
  const holder = raw as unknown as { default?: unknown };
  const ns = (holder.default ?? raw) as Record<string, unknown>;
  const createConnection = ns.createConnection;
  if (typeof createConnection !== 'function') {
    throw new Error('the "mysql2" package did not expose createConnection');
  }
  return { createConnection: createConnection as MysqlModule['createConnection'] };
}

export class MysqlDriver implements DriverApi {
  readonly kind = 'mysql' as const;
  private conn: MysqlConnection | null = null;
  private closed = false;

  constructor(
    private readonly spec: ResolvedConnectionSpec,
    private readonly logger: DriverLogger,
  ) {}

  async connect(): Promise<void> {
    if (this.conn) return;
    const { createConnection } = await loadMysqlModule();
    const conn = await createConnection({
      host: this.spec.host ?? 'localhost',
      port: this.spec.port ?? 3306,
      user: this.spec.user,
      password: this.spec.password || undefined,
      database: this.spec.database || undefined,
      ssl: normalizeSsl(this.spec.ssl),
      connectTimeout: 10000,
      ...this.spec.options,
    });
    try {
      await conn.query('SELECT 1');
    } catch (err) {
      conn.destroy();
      throw toConnectorError(this.spec, err);
    }
    this.conn = conn;
  }

  private ensure(): MysqlConnection {
    if (!this.conn || this.closed) {
      throw new DbConnectorError(
        ErrorCode.ConnectionNotFound,
        `connection "${this.spec.name}" is not connected`,
      );
    }
    return this.conn;
  }

  /** Run a query, rejecting (and destroying the connection) on abort. */
  private run(
    fn: (conn: MysqlConnection) => Promise<unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const conn = this.ensure();
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => signal.removeEventListener('abort', onAbort);
      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(toConnectorError(this.spec, err));
      };
      const onAbort = () => {
        conn.destroy(); // kills the in-flight query server-side
        if (this.conn === conn) this.conn = null;
        fail(cancelError(signal));
      };
      if (signal.aborted) {
        fail(cancelError(signal));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      fn(conn).then(
        (value) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        },
        (err) => fail(err),
      );
    });
  }

  async read(sql: string, params: unknown[], signal: AbortSignal): Promise<ReadOutcome> {
    const result = await this.run(async (conn) => {
      await conn.query('START TRANSACTION READ ONLY');
      try {
        const [rows, fields] = await conn.execute({ sql, values: params, rowsAsArray: true });
        await conn.query('ROLLBACK');
        return { rows, fields };
      } catch (err) {
        await conn.query('ROLLBACK').catch(() => {});
        throw err;
      }
    }, signal);
    return outcomeOf(result as MysqlReadResult);
  }

  async write(
    sql: string,
    params: unknown[],
    isDdl: boolean,
    signal: AbortSignal,
  ): Promise<WriteOutcome> {
    const result = await this.run(async (conn) => {
      await conn.beginTransaction();
      try {
        const [rows] = await conn.execute(sql, params);
        await conn.commit();
        return rows as { affectedRows?: number };
      } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
      }
    }, signal);
    return { affectedRows: Number((result as { affectedRows?: number })?.affectedRows ?? 0), isDdl };
  }

  async introspect(signal: AbortSignal): Promise<Introspection> {
    const schema = this.spec.database ?? '';
    const [tables, columns, stats, fks] = (await Promise.all([
      this.run(async (conn) => conn.query(QUERIES.tables.text, [schema]), signal),
      this.run(async (conn) => conn.query(QUERIES.columns.text, [schema]), signal),
      this.run(async (conn) => conn.query(QUERIES.indexes.text, [schema]), signal),
      this.run(async (conn) => conn.query(QUERIES.foreignKeys.text, [schema]), signal),
    ])) as unknown as [Array<Array<Record<string, unknown>>>, Array<Array<Record<string, unknown>>>, Array<Array<Record<string, unknown>>>, Array<Array<Record<string, unknown>>>];

    const tableRows = tables[0] ?? [];
    const columnRows = columns[0] ?? [];
    const statRows = stats[0] ?? [];
    const fkRows = fks[0] ?? [];

    const tablesOut: Array<{ name: string }> = [];
    const viewsOut: Array<{ name: string }> = [];
    for (const t of tableRows) {
      const entry = { name: String(t.table_name) };
      if (t.table_type === 'VIEW') viewsOut.push(entry);
      else tablesOut.push(entry);
    }

    const indexesOut = indexesFromStatistics(statRows);

    const fkMap = new Map<string, {
      name: string; table: string; columns: string[];
      referencedTable: string; referencedColumns: string[];
      onUpdate?: string; onDelete?: string;
    }>();
    for (const f of fkRows) {
      const key = `${String(f.table_name)}:${String(f.constraint_name)}`;
      let entry = fkMap.get(key);
      if (!entry) {
        entry = {
          name: String(f.constraint_name),
          table: String(f.table_name),
          columns: [],
          referencedTable: String(f.referenced_table_name),
          referencedColumns: [],
          onUpdate: f.update_rule !== undefined ? String(f.update_rule) : undefined,
          onDelete: f.delete_rule !== undefined ? String(f.delete_rule) : undefined,
        };
        fkMap.set(key, entry);
      }
      entry.columns.push(String(f.column_name));
      entry.referencedColumns.push(String(f.referenced_column_name));
    }

    return {
      tables: tablesOut,
      views: viewsOut,
      columns: columnRows.map((c) => ({
        table: String(c.table_name),
        name: String(c.column_name),
        type: String(c.column_type ?? c.data_type ?? ''),
        nullable: String(c.is_nullable).toUpperCase() === 'YES',
        ordinal: Number(c.ordinal_position),
        default: c.column_default === null ? null : String(c.column_default),
        primaryKey: String(c.column_key ?? '').toUpperCase() === 'PRI',
        extra: c.extra ? String(c.extra) : undefined,
      })),
      indexes: indexesOut,
      foreignKeys: [...fkMap.values()],
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const conn = this.conn;
    this.conn = null;
    if (conn) await conn.end().catch(() => {});
  }
}

interface MysqlReadResult {
  rows: unknown[][];
  fields: Array<{ name: string }>;
}

export function indexesFromStatistics(
  statRows: ReadonlyArray<Record<string, unknown>>,
): Introspection['indexes'] {
  // group index rows (statistics yields one row per column)
  const indexMap = new Map<string, {
    name: string; table: string; unique: boolean; primary: boolean; columns: string[];
  }>();
  for (const s of statRows) {
    const key = `${String(s.table_name)}:${String(s.index_name)}`;
    let entry = indexMap.get(key);
    if (!entry) {
      entry = {
        name: String(s.index_name),
        table: String(s.table_name),
        unique: Number(s.non_unique) === 0,
        primary: String(s.index_name) === 'PRIMARY',
        columns: [],
      };
      indexMap.set(key, entry);
    }
    entry.columns.push(String(s.column_name));
  }
  return [...indexMap.values()].map((e) => ({
    name: e.name,
    table: e.table,
    columns: e.columns,
    unique: e.unique,
    primary: e.primary,
  }));
}

function outcomeOf(result: MysqlReadResult): ReadOutcome {
  const columns = result.fields.map((field) => field.name);
  const aligned = result.rows.map((row) => row.map((value) => value ?? null));
  return { columns, rows: aligned, rowCount: aligned.length };
}

function normalizeSsl(ssl: unknown): boolean | object | undefined {
  if (ssl === undefined || ssl === null) return undefined;
  return ssl;
}

function cancelError(signal: AbortSignal): DbConnectorError {
  const reason = signal.reason;
  const isTimeout = reason instanceof Error && /timeout/i.test(reason.message);
  return new DbConnectorError(
    isTimeout ? ErrorCode.Timeout : ErrorCode.Cancelled,
    isTimeout ? `query exceeded its time limit` : 'execution was cancelled',
  );
}

function toConnectorError(
  spec: ResolvedConnectionSpec,
  err: unknown,
): DbConnectorError {
  if (err instanceof DbConnectorError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new DbConnectorError(ErrorCode.QueryFailed, redactSpecMessage(spec, message));
}

/** Introspection queries, parameterized by database (placeholder `?`). */
const QUERIES = {
  tables: {
    name: 'dsh-db-connector.tables',
    text: `SELECT table_name, table_type FROM information_schema.tables
       WHERE table_schema = ? AND table_type IN ('BASE TABLE', 'VIEW')
       ORDER BY table_name`,
  },
  columns: {
    name: 'dsh-db-connector.columns',
    text: `SELECT table_name, column_name, column_type, data_type, is_nullable,
       ordinal_position, column_default, column_key, extra
       FROM information_schema.columns WHERE table_schema = ?
       ORDER BY table_name, ordinal_position`,
  },
  indexes: {
    name: 'dsh-db-connector.indexes',
    text: `SELECT table_name, index_name, non_unique, seq_in_index, column_name
       FROM information_schema.statistics WHERE table_schema = ?
       ORDER BY table_name, index_name, seq_in_index`,
  },
  foreignKeys: {
    name: 'dsh-db-connector.foreign-keys',
    text: `SELECT kcu.constraint_name, kcu.table_name, kcu.column_name,
       kcu.referenced_table_name, kcu.referenced_column_name,
       rc.update_rule, rc.delete_rule
       FROM information_schema.key_column_usage AS kcu
       JOIN information_schema.referential_constraints AS rc
         ON rc.constraint_schema = kcu.constraint_schema
        AND rc.constraint_name = kcu.constraint_name
        AND rc.table_name = kcu.table_name
       WHERE kcu.table_schema = ? AND kcu.referenced_table_name IS NOT NULL
       ORDER BY kcu.table_name, kcu.constraint_name, kcu.ordinal_position`,
  },
};
