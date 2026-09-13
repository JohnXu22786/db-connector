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
 *   { id, op: 'query'|'write'|'schema'|'close', sql?, params?, isDdl? }
 * Replies: { id, ok: true, payload } | { id, ok: false, error }.
 */

import { DatabaseSync } from 'node:sqlite';
import { isNonTransactionalStatement } from '../sql.js';

interface Request {
  id: number;
  op: 'query' | 'write' | 'schema' | 'close';
  sql?: string;
  params?: unknown[];
  isDdl?: boolean;
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

function runQuery(req: Request): unknown {
  const stmt = db.prepare(req.sql ?? '');
  const columns = stmt.columns().map((column) => column.name);
  stmt.setReturnArrays(true);
  const rows = stmt.all(...(req.params ?? []) as never[]) as unknown as unknown[][];
  const data = rows.map((row) => row.map((value) => value ?? null));
  return { columns, rows: data, rowCount: data.length };
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

function runSchema(): unknown {
  const master = db
    .prepare(
      `SELECT name, type, sql FROM sqlite_master
       WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name`,
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

  const readColumns = (object: { name: string; sql?: string }): void => {
    const cols = db
      .prepare(`PRAGMA table_info("${quote(object.name)}")`)
      .all() as unknown as ColumnRow[];
    const hasAutoincrement = /AUTOINCREMENT/i.test(object.sql ?? '');
    for (const c of cols) {
      columns.push({
        table: object.name,
        name: c.name,
        type: c.type || 'ANY',
        nullable: c.notnull === 0 && (c.pk === 0 || c.type.toUpperCase() !== 'INTEGER'),
        ordinal: c.cid + 1,
        default: c.dflt_value ?? null,
        primaryKey: c.pk > 0,
        extra: c.pk > 0 && hasAutoincrement ? 'AUTOINCREMENT' : undefined,
      });
    }
  };

  for (const table of tables) {
    readColumns(table);

    const idxRows = db
      .prepare(`PRAGMA index_list("${quote(table.name)}")`)
      .all() as unknown as Array<{ name: string; unique: number; origin: string }>;
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
      table: string;
      from: string;
      to: string;
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
      entry.referencedColumns.push(fk.to);
    }
    foreignKeys.push(...grouped.values());
  }

  for (const view of views) readColumns(view);

  return { tables, views, columns, indexes, foreignKeys };
}

process.on('message', (req: Request) => {
  if (!req || typeof req !== 'object') return;
  if (req.op === 'close') {
    try {
      db.close();
    } finally {
      process.exit(0);
    }
    return;
  }
  try {
    let payload: unknown;
    if (req.op === 'query') payload = runQuery(req);
    else if (req.op === 'write') payload = runWrite(req);
    else payload = runSchema();
    process.send?.({ id: req.id, ok: true, payload });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.send?.({ id: req.id, ok: false, error: message });
  }
});

process.on('disconnect', () => process.exit(0));
