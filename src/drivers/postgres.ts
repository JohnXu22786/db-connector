/**
 * PostgreSQL driver over the optional `pg` package (peer dependency). Uses
 * prepared-style parameterized queries (`$1..$n`) so values never touch SQL
 * text, tracks cancellation through pg's query-level AbortSignal, and wraps
 * transactional writes in an explicit transaction (COMMIT / ROLLBACK).
 */

import { ErrorCode, DbConnectorError } from '../errors.js';
import { isNonTransactionalStatement, toDollarPlaceholders } from '../sql.js';
import type { ResolvedConnectionSpec } from '../types.js';
import type { DriverApi, DriverLogger, Introspection, ReadOutcome, WriteOutcome } from './driver.js';
import { importOptional, redactSpecMessage } from './driver.js';

/**
 * The `pg` package is an optional peer dependency, so we use a small
 * structural view of its client instead of importing its types.
 */
interface PgQueryResult {
  fields: Array<{ name: string }>;
  rows: Array<Record<string, unknown>>;
  rowCount: number | null;
}

interface PgArrayQueryResult extends Omit<PgQueryResult, 'rows'> {
  rows: unknown[][];
}

interface PgQueryConfig {
  text: string;
  values?: unknown[];
  signal?: AbortSignal;
  name?: string;
  rowMode?: 'array';
}

interface PgQueryable {
  query(config: PgQueryConfig): Promise<PgQueryResult>;
  query(text: string): Promise<PgQueryResult>;
}

interface PgClientLike extends PgQueryable {
  connect(): Promise<void>;
  end(): Promise<void>;
}

type PgModule = { Client: new (...args: never[]) => PgClientLike };

async function loadPgModule(): Promise<PgModule> {
  const raw = await importOptional<Record<string, unknown>>('pg');
  const holder = raw as unknown as { default?: unknown };
  const ns = (holder.default ?? raw) as Record<string, unknown>;
  const Client = ns.Client;
  if (typeof Client !== 'function') {
    throw new Error('the "pg" package did not expose a Client constructor');
  }
  return { Client: Client as PgModule['Client'] };
}

export class PgDriver implements DriverApi {
  readonly kind = 'postgres' as const;
  private client: PgClientLike | null = null;
  private closed = false;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly spec: ResolvedConnectionSpec,
    private readonly logger: DriverLogger,
  ) {}

  async connect(): Promise<void> {
    await this.withOperationLock(async () => {
      if (this.client) return;
      const { Client } = await loadPgModule();
      const client = new Client({
        host: this.spec.host,
        port: this.spec.port,
        user: this.spec.user,
        password: this.spec.password || undefined,
        database: this.spec.database || 'postgres',
        ssl: normalizeSsl(this.spec.ssl),
        connectionString: this.spec.connectionString,
        ...this.spec.options,
      } as never);
      try {
        await client.connect();
        await client.query('SELECT 1');
      } catch (err) {
        void client.end().catch(() => {});
        throw toConnectorError(this.spec, err);
      }
      this.client = client;
    });
  }

  private async withOperationLock<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const previous = this.operationTail;
    let release!: () => void;
    this.operationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    let acquired = false;
    try {
      await waitForOperationLock(previous, signal);
      acquired = true;
      return await operation();
    } finally {
      if (acquired) {
        release();
      } else {
        // An aborted waiter must not let a later operation overtake the
        // operation it was queued behind. Release this queue entry only once
        // the prior operation has finished.
        void previous.then(release, release);
      }
    }
  }

  private ensure(): PgClientLike {
    if (!this.client || this.closed) {
      throw new DbConnectorError(
        ErrorCode.ConnectionNotFound,
        `connection "${this.spec.name}" is not connected`,
      );
    }
    return this.client;
  }

  async read(sql: string, params: unknown[], signal: AbortSignal): Promise<ReadOutcome> {
    return this.withOperationLock(() => this.readUnlocked(sql, params, signal), signal);
  }

  private async readUnlocked(
    sql: string,
    params: unknown[],
    signal: AbortSignal,
  ): Promise<ReadOutcome> {
    const client = this.ensure();
    const converted = toDollarPlaceholders(sql);
    try {
      // Server-side read-only backstop: even a statement that slips past the
      // classifier cannot mutate data inside a READ ONLY transaction.
      await client.query('BEGIN TRANSACTION READ ONLY');
      try {
        const result = await client.query({
          text: converted.sql,
          values: params,
          signal,
          rowMode: 'array',
        } as never);
        await client.query('ROLLBACK');
        return outcomeOf(result as unknown as PgArrayQueryResult);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
    } catch (err) {
      throw toConnectorError(this.spec, err);
    }
  }

  async write(
    sql: string,
    params: unknown[],
    isDdl: boolean,
    signal: AbortSignal,
  ): Promise<WriteOutcome> {
    return this.withOperationLock(() => this.writeUnlocked(sql, params, isDdl, signal), signal);
  }

  private async writeUnlocked(
    sql: string,
    params: unknown[],
    isDdl: boolean,
    signal: AbortSignal,
  ): Promise<WriteOutcome> {
    const client = this.ensure();
    const converted = toDollarPlaceholders(sql);
    try {
      // PostgreSQL rejects VACUUM and concurrent-index operations in a transaction.
      if (isNonTransactionalStatement(sql, 'postgres')) {
        const result: PgQueryResult = await client.query({
          text: converted.sql,
          values: params,
          signal,
        } as never);
        return { affectedRows: result.rowCount ?? 0, isDdl };
      }

      await client.query('BEGIN');
      try {
        const result: PgQueryResult = await client.query({
          text: converted.sql,
          values: params,
          signal,
        } as never);
        await client.query('COMMIT');
        return { affectedRows: result.rowCount ?? 0, isDdl };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
    } catch (err) {
      throw toConnectorError(this.spec, err);
    }
  }

  async introspect(signal: AbortSignal): Promise<Introspection> {
    return this.withOperationLock(() => this.introspectUnlocked(signal), signal);
  }

  private async introspectUnlocked(signal: AbortSignal): Promise<Introspection> {
    const client = this.ensure();
    const schema = this.spec.schema || 'public';
    const signalOpts = { signal } as const;
    try {
      const [tables, views, columns, pks, indexes, fks] = await Promise.all([
        client.query({ ...QUERIES.tables, values: [schema], ...signalOpts }),
        client.query({ ...QUERIES.views, values: [schema], ...signalOpts }),
        client.query({ ...QUERIES.columns, values: [schema], ...signalOpts }),
        client.query({ ...QUERIES.primaryKeys, values: [schema], ...signalOpts }),
        client.query({ ...QUERIES.indexes, values: [schema], ...signalOpts }),
        client.query({ ...QUERIES.foreignKeys, values: [schema], ...signalOpts }),
      ]);
      const pkRows = pks.rows as Array<{ table_name: string; column_name: string }>;
      const pkByTable = new Map<string, Set<string>>();
      for (const row of pkRows) {
        let set = pkByTable.get(row.table_name);
        if (!set) {
          set = new Set();
          pkByTable.set(row.table_name, set);
        }
        set.add(row.column_name);
      }
      return {
        tables: tables.rows.map((r) => ({ name: r.table_name as string })),
        views: views.rows.map((r) => ({ name: r.table_name as string })),
        columns: columns.rows.map((r) => ({
          table: r.table_name as string,
          name: r.column_name as string,
          type: r.data_type as string,
          nullable: !(r.is_nullable === 'NO'),
          ordinal: Number(r.ordinal_position),
          default: (r.column_default as string | null) ?? null,
          primaryKey: pkByTable.get(r.table_name as string)?.has(r.column_name as string) ?? false,
        })),
        indexes: indexes.rows.map((r) => ({
          name: r.index_name as string,
          table: r.table_name as string,
          columns: (r.column_names as string[]).filter(Boolean),
          unique: Boolean(r.is_unique),
          primary: Boolean(r.is_primary),
        })),
        foreignKeys: fks.rows.map((r) => ({
          name: r.constraint_name as string,
          table: r.table_name as string,
          columns: (r.column_names as string[]),
          referencedTable: r.referenced_table as string,
          referencedColumns: (r.referenced_columns as string[]),
          onUpdate: (r.on_update as string | null) ?? undefined,
          onDelete: (r.on_delete as string | null) ?? undefined,
        })),
      } as Introspection;
    } catch (err) {
      throw toConnectorError(this.spec, err);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.withOperationLock(async () => {
      const client = this.client;
      this.client = null;
      if (client) await client.end().catch(() => {});
    });
  }
}

function outcomeOf(result: PgArrayQueryResult): ReadOutcome {
  const columns = result.fields.map((f) => f.name);
  const rows = result.rows.map((row) => row.map((value) => value ?? null));
  return { columns, rows, rowCount: rows.length };
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
    isTimeout ? 'query exceeded its time limit' : 'execution was cancelled',
  );
}

function waitForOperationLock(
  previous: Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) return previous;
  if (signal.aborted) return Promise.reject(cancelError(signal));

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(cancelError(signal));
    };

    signal.addEventListener('abort', onAbort, { once: true });
    previous.then(
      () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      },
      (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      },
    );
    if (signal.aborted) onAbort();
  });
}

function toConnectorError(
  spec: ResolvedConnectionSpec,
  err: unknown,
): DbConnectorError {
  if (err instanceof DbConnectorError) return err;
  const message = err instanceof Error ? err.message : String(err);
  // pg error objects carry .code; surface a stable code + sanitized text.
  return new DbConnectorError(ErrorCode.QueryFailed, redactSpecMessage(spec, message));
}

/** Introspection queries, parameterized by target schema (placeholder $1..$n). */
const QUERIES = {
  tables: {
    name: 'dsh-db-connector.tables',
    text: `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name`,
  },
  views: {
    name: 'dsh-db-connector.views',
    text: `SELECT table_name FROM information_schema.views
       WHERE table_schema = $1 ORDER BY table_name`,
  },
  columns: {
    name: 'dsh-db-connector.columns',
    text: `SELECT table_name, column_name, data_type, is_nullable, ordinal_position, column_default
       FROM information_schema.columns WHERE table_schema = $1
       ORDER BY table_name, ordinal_position`,
  },
  primaryKeys: {
    name: 'dsh-db-connector.primary-keys',
    text: `SELECT tc.table_name, kcu.column_name, tc.constraint_name
       FROM information_schema.table_constraints AS tc
       JOIN information_schema.key_column_usage AS kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1
       ORDER BY tc.table_name, kcu.ordinal_position`,
  },
  indexes: {
    name: 'dsh-db-connector.indexes',
    text: `SELECT i.relname AS index_name, t.relname AS table_name,
       idx.indisunique AS is_unique, idx.indisprimary AS is_primary,
       array_agg(
         CASE WHEN k.attnum = 0
              THEN pg_get_indexdef(idx.indexrelid, k.ord::integer, true)
              ELSE a.attname::text
          END ORDER BY k.ord
       ) AS column_names
       FROM pg_index idx
       JOIN pg_class t ON t.oid = idx.indrelid
       JOIN pg_class i ON i.oid = idx.indexrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       JOIN LATERAL unnest(idx.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
       LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
       WHERE n.nspname = $1 AND t.relkind = 'r'
       GROUP BY i.relname, t.relname, idx.indisunique, idx.indisprimary
       ORDER BY t.relname, i.relname`,
  },
  foreignKeys: {
    name: 'dsh-db-connector.foreign-keys',
    text: `SELECT rc.constraint_name,
       tc.table_name,
       array_agg(kcu.column_name ORDER BY kcu.ordinal_position) AS column_names,
       ccu.table_name AS referenced_table,
       array_agg(rku.column_name ORDER BY kcu.ordinal_position) AS referenced_columns,
       rc.update_rule AS on_update, rc.delete_rule AS on_delete
       FROM information_schema.referential_constraints AS rc
       JOIN information_schema.table_constraints AS tc
         ON tc.constraint_name = rc.constraint_name AND tc.constraint_schema = $1
       JOIN information_schema.key_column_usage AS kcu
         ON kcu.constraint_name = rc.constraint_name AND kcu.constraint_schema = $1
       JOIN information_schema.key_column_usage AS rku
         ON rku.constraint_name = rc.unique_constraint_name
        AND rku.constraint_schema = rc.unique_constraint_schema
        AND rku.ordinal_position = kcu.position_in_unique_constraint
       JOIN (
         SELECT DISTINCT constraint_schema, constraint_name, table_name
           FROM information_schema.constraint_column_usage
       ) AS ccu
         ON ccu.constraint_name = rc.unique_constraint_name
        AND ccu.constraint_schema = rc.unique_constraint_schema
       GROUP BY rc.constraint_name, tc.table_name, rc.update_rule, rc.delete_rule, ccu.table_name
       ORDER BY tc.table_name, rc.constraint_name`,
  },
};
