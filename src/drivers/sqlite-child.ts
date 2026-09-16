/**
 * SQLite child process: owns one DatabaseSync for the connection's lifetime
 * and executes requests serially over IPC.
 *
 * A process (rather than a worker thread) is used so a runaway synchronous
 * statement can be hard-terminated with SIGKILL — which works even while the
 * child is blocked in native SQLite code, and never blocks the parent process
 * from exiting (a stuck worker thread would).
 *
 * Protocol (process.send / process.on('message')):
 *   { id, op: 'query'|'write'|'schema'|'close', sql?, params?, isDdl?, maxRows? }
 * Replies: { id, ok: true, payload } | { id, ok: false, error }.
 */

import { DatabaseSync } from 'node:sqlite';
import { isNonTransactionalStatement, scan, type Token } from '../sql.js';

interface Request {
  id: number;
  op: 'query' | 'write' | 'schema' | 'close';
  sql?: string;
  params?: unknown[];
  isDdl?: boolean;
  maxRows?: number;
}

interface ColumnRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface MasterRow {
  name: string;
  type: string;
  sql: string | null;
}

const database = process.env.DSH_DB_CONNECTOR_SQLITE_DATABASE ?? ':memory:';
const db = new DatabaseSync(database);

// `process.send` is asynchronous. Keep the child alive until every response
// has been acknowledged by the IPC channel; otherwise a close message can
// call process.exit while the previous response is still buffered.
let pendingResponseSends = 0;
let closeRequested = false;
let closeStarted = false;

function exitAfterResponses(): void {
  if (!closeRequested || closeStarted || pendingResponseSends !== 0) return;
  closeStarted = true;
  try {
    db.close();
  } finally {
    process.exit(0);
  }
}

function sendResponse(message: {
  id: number;
  ok: boolean;
  payload?: unknown;
  error?: string;
}): void {
  if (!process.send) {
    exitAfterResponses();
    return;
  }

  pendingResponseSends += 1;
  let acknowledged = false;
  const onAcknowledged = (): void => {
    if (acknowledged) return;
    acknowledged = true;
    pendingResponseSends -= 1;
    exitAfterResponses();
  };

  try {
    process.send(message, onAcknowledged);
  } catch {
    // A disconnected parent cannot receive the response. Do not leave the
    // close path waiting forever for an acknowledgement that cannot arrive.
    onAcknowledged();
  }
}

function runQuery(req: Request): unknown {
  const stmt = db.prepare(req.sql ?? '');
  const columns = stmt.columns().map((column) => column.name);
  stmt.setReturnArrays(true);
  const maxRows = boundedRowLimit(req.maxRows);
  if (maxRows === undefined) {
    const rows = stmt.all(...(req.params ?? []) as never[]) as unknown as unknown[][];
    const data = rows.map((row) => row.map((value) => value ?? null));
    return { columns, rows: data, rowCount: data.length };
  }

  const data: unknown[][] = [];
  let truncated = false;
  for (const row of stmt.iterate(...(req.params ?? []) as never[]) as Iterable<unknown[]>) {
    if (data.length >= maxRows) {
      truncated = true;
      break;
    }
    data.push(row.map((value) => value ?? null));
  }
  return { columns, rows: data, rowCount: data.length, truncated };
}

function boundedRowLimit(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  if (value < 0) throw new RangeError('maxRows must be a non-negative number');
  return Math.floor(value);
}

function runWrite(req: Request): unknown {
  // SQLite's VACUUM command cannot run while a transaction is active.
  if (isNonTransactionalStatement(req.sql ?? '', 'sqlite')) {
    const stmt = db.prepare(req.sql ?? '');
    stmt.run(...(req.params ?? []) as never[]);
    return { affectedRows: 0, isDdl: req.isDdl === true };
  }

  db.exec('BEGIN');
  try {
    const stmt = db.prepare(req.sql ?? '');
    const result = stmt.run(...(req.params ?? []) as never[]);
    db.exec('COMMIT');
    return { affectedRows: Number(result.changes), isDdl: req.isDdl === true };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function sqliteAsciiUpper(value: string): string {
  return value.replace(/[a-z]/g, (character) => character.toUpperCase());
}

function isSqliteWord(token: Token, word: string): boolean {
  return token.type === 'word' && sqliteAsciiUpper(token.value) === word;
}

const SQLITE_TABLE_CONSTRAINTS = new Set(['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'CHECK', 'FOREIGN']);

function isSqliteTableConstraint(token: Token | undefined): boolean {
  return token?.type === 'word' && SQLITE_TABLE_CONSTRAINTS.has(sqliteAsciiUpper(token.value));
}

function sqliteIdentifierKey(name: string): string {
  return name.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function normalizeSqliteTypeName(token: Token): string | undefined {
  if (token.type === 'word') return token.value;
  if (token.type === 'quotedid') {
    if (token.value.startsWith('"') && token.value.endsWith('"')) {
      return token.value.slice(1, -1).replaceAll('""', '"');
    }
    if (token.value.startsWith('`') && token.value.endsWith('`')) {
      return token.value.slice(1, -1).replaceAll('``', '`');
    }
    if (token.value.startsWith('[') && token.value.endsWith(']')) {
      return token.value.slice(1, -1);
    }
  }
  if (token.type === 'string' && token.value.startsWith("'") && token.value.endsWith("'")) {
    return token.value.slice(1, -1).replaceAll("''", "'");
  }
  return undefined;
}

function isSqliteTypeName(token: Token, typeName: string): boolean {
  const value = normalizeSqliteTypeName(token);
  return value !== undefined && sqliteAsciiUpper(value) === typeName;
}

function readSqliteIdentifier(tokens: Token[]): string | undefined {
  const first = tokens[0];
  if (!first) return undefined;
  return normalizeSqliteTypeName(first);
}

/** Find columns whose own top-level definition declares AUTOINCREMENT. */
function readSqliteAutoincrementColumns(sql: string): Set<string> {
  const tokens = scan(sql, 'sqlite').filter(
    (token) => token.type !== 'space' && token.type !== 'comment',
  );
  const openIndex = tokens.findIndex(
    (token) => token.type === 'symbol' && token.value === '(',
  );
  if (openIndex < 0) return new Set();

  const bodyDepth = tokens[openIndex]!.depth;
  const autoincrementColumns = new Set<string>();
  const integerColumns = new Map<string, string>();
  const definitions: Token[][] = [];
  let definition: Token[] = [];
  let nestedDepth = 0;

  for (const token of tokens.slice(openIndex + 1)) {
    if (token.type === 'symbol' && token.value === '(') {
      nestedDepth += 1;
      definition.push(token);
    } else if (token.type === 'symbol' && token.value === ')') {
      if (nestedDepth === 0) {
        definitions.push(definition);
        break;
      }
      nestedDepth -= 1;
      definition.push(token);
    } else if (token.type === 'symbol' && token.value === ',' && nestedDepth === 0) {
      definitions.push(definition);
      definition = [];
    } else {
      definition.push(token);
    }
  }

  for (const current of definitions) {
    const topLevel = current.filter((token) => token.depth === bodyDepth);
    if (isSqliteTableConstraint(topLevel[0])) continue;
    const name = readSqliteIdentifier(topLevel);
    if (name === undefined) continue;

    const integerIndex = topLevel.findIndex(
      (token, index) => index > 0 && isSqliteTypeName(token, 'INTEGER'),
    );
    if (integerIndex < 0) continue;
    integerColumns.set(sqliteIdentifierKey(name), name);

    const primaryIndex = topLevel.findIndex(
      (token, index) => index > integerIndex && isSqliteWord(token, 'PRIMARY'),
    );
    if (primaryIndex < 0) continue;
    const keyIndex = topLevel.findIndex(
      (token, index) => index > primaryIndex && isSqliteWord(token, 'KEY'),
    );
    if (keyIndex < 0) continue;
    const autoincrementIndex = topLevel.findIndex(
      (token, index) => index > keyIndex && isSqliteWord(token, 'AUTOINCREMENT'),
    );
    if (autoincrementIndex >= 0) autoincrementColumns.add(name);
  }

  for (const current of definitions) {
    const topLevel = current.filter((token) => token.depth === bodyDepth);
    const primaryIndex = topLevel.findIndex((token) => isSqliteWord(token, 'PRIMARY'));
    if (primaryIndex < 0) continue;
    const keyIndex = topLevel.findIndex(
      (token, index) => index > primaryIndex && isSqliteWord(token, 'KEY'),
    );
    if (keyIndex < 0) continue;
    const openIndex = current.findIndex(
      (token, index) =>
        index > keyIndex &&
        token.type === 'symbol' &&
        token.value === '(' &&
        token.depth === bodyDepth + 1,
    );
    if (openIndex < 0) continue;
    const keyColumns = current.slice(openIndex + 1).filter(
      (token) => token.depth === bodyDepth + 1,
    );
    const name = readSqliteIdentifier(keyColumns);
    if (name === undefined) continue;
    const columnName = integerColumns.get(sqliteIdentifierKey(name));
    if (columnName === undefined) continue;
    if (keyColumns.some((token) => isSqliteWord(token, 'AUTOINCREMENT'))) {
      autoincrementColumns.add(columnName);
    }
  }

  return autoincrementColumns;
}

function runSchema(): unknown {
  const master = db
    .prepare(
      `SELECT name, type, sql FROM sqlite_temp_master
       WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'
       UNION ALL
       SELECT main.name, main.type, main.sql FROM sqlite_master AS main
       WHERE main.type IN ('table','view') AND main.name NOT LIKE 'sqlite_%'
         AND NOT EXISTS (
           SELECT 1 FROM sqlite_temp_master AS temp
           WHERE temp.type IN ('table','view') AND temp.name NOT LIKE 'sqlite_%'
             AND temp.name COLLATE NOCASE = main.name COLLATE NOCASE
         )
       ORDER BY name`,
    )
    .all() as unknown as MasterRow[];

  const tables: Array<{ name: string; sql?: string }> = [];
  const views: Array<{ name: string; sql?: string }> = [];
  for (const row of master) {
    const entry = { name: row.name, ...(row.sql ? { sql: row.sql } : {}) };
    if (row.type === 'table') tables.push(entry);
    else views.push(entry);
  }

  const columns: Array<{
    table: string;
    name: string;
    type: string;
    nullable: boolean;
    ordinal: number;
    default: string | null;
    primaryKey: boolean;
    extra?: string;
  }> = [];
  const indexes: Array<{
    name: string;
    table: string;
    columns: string[];
    unique: boolean;
    primary: boolean;
  }> = [];
  const foreignKeys: Array<{
    name: string;
    table: string;
    columns: string[];
    referencedTable: string;
    referencedColumns: string[];
    onUpdate?: string;
    onDelete?: string;
  }> = [];

  const quote = (name: string): string => name.replaceAll('"', '""');
  const primaryKeyColumns = new Map<string, string[]>();
  const readPrimaryKeyColumns = (table: string): string[] => {
    const cached = primaryKeyColumns.get(table);
    if (cached) return cached;

    const columns = (db
      .prepare(`PRAGMA table_xinfo("${quote(table)}")`)
      .all() as unknown as ColumnRow[])
      .filter((column) => column.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((column) => column.name);
    primaryKeyColumns.set(table, columns);
    return columns;
  };

  const readColumns = (object: { name: string; sql?: string }, hasPrimaryKeyIndex = false): void => {
    const cols = db
      .prepare(`PRAGMA table_xinfo("${quote(object.name)}")`)
      .all() as unknown as ColumnRow[];
    const autoincrementColumns = readSqliteAutoincrementColumns(object.sql ?? '');
    for (const c of cols) {
      const isRowidAlias = c.pk > 0 && c.type.toUpperCase() === 'INTEGER' && !hasPrimaryKeyIndex;
      columns.push({
        table: object.name,
        name: c.name,
        type: c.type || 'ANY',
        nullable: c.notnull === 0 && !isRowidAlias,
        ordinal: c.cid + 1,
        default: c.dflt_value ?? null,
        primaryKey: c.pk > 0,
        extra: c.pk > 0 && autoincrementColumns.has(c.name) ? 'AUTOINCREMENT' : undefined,
      });
    }
  };

  for (const table of tables) {
    const idxRows = db
      .prepare(`PRAGMA index_list("${quote(table.name)}")`)
      .all() as unknown as Array<{ name: string; unique: number; origin: string }>;
    const hasPrimaryKeyIndex = idxRows.some((idx) => idx.origin === 'pk');
    readColumns(table, hasPrimaryKeyIndex);

    for (const idx of idxRows) {
      const parts = db
        .prepare(`PRAGMA index_info("${quote(idx.name)}")`)
        .all() as unknown as Array<{ seqno: number; name: string | null }>;
      parts.sort((a, b) => a.seqno - b.seqno);
      indexes.push({
        name: idx.name,
        table: table.name,
        columns: parts.map((p) => p.name ?? ''),
        unique: idx.unique !== 0,
        primary: idx.origin === 'pk',
      });
    }

    const fkRows = db
      .prepare(`PRAGMA foreign_key_list("${quote(table.name)}")`)
      .all() as unknown as Array<{
      id: number;
      seq: number;
      table: string;
      from: string;
      to: string | null;
      on_update: string;
      on_delete: string;
    }>;
    const grouped = new Map<number, (typeof foreignKeys)[number]>();
    for (const fk of fkRows) {
      let entry = grouped.get(fk.id);
      if (!entry) {
        entry = {
          name: `fk_${table.name}_${fk.from}`,
          table: table.name,
          columns: [],
          referencedTable: fk.table,
          referencedColumns: [],
          onUpdate: fk.on_update || undefined,
          onDelete: fk.on_delete || undefined,
        };
        grouped.set(fk.id, entry);
      }
      entry.columns.push(fk.from);
      entry.referencedColumns.push(fk.to ?? readPrimaryKeyColumns(fk.table)[fk.seq] ?? '');
    }
    foreignKeys.push(...grouped.values());
  }

  for (const view of views) readColumns(view);

  return { tables, views, columns, indexes, foreignKeys };
}

process.on('message', (req: Request) => {
  if (!req || typeof req !== 'object') return;
  if (req.op === 'close') {
    closeRequested = true;
    exitAfterResponses();
    return;
  }
  try {
    let payload: unknown;
    if (req.op === 'query') payload = runQuery(req);
    else if (req.op === 'write') payload = runWrite(req);
    else payload = runSchema();
    sendResponse({ id: req.id, ok: true, payload });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendResponse({ id: req.id, ok: false, error: message });
  }
});

process.on('disconnect', () => process.exit(0));
