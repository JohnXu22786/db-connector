/**
 * Schema introspection snapshot + cache.
 *
 * A snapshot captures tables / views / columns / indexes / foreign keys for
 * one connection. Snapshots are cached per connection with a TTL so repeated
 * `db_schema` calls don't hammer the catalog; `refresh` bypasses the cache and
 * `filter` narrows the returned materialization without touching the cache.
 */

import type { DriverApi } from './drivers/driver.js';
import type {
  SchemaColumn,
  SchemaForeignKey,
  SchemaIndex,
  SchemaResult,
  SchemaTable,
  SchemaView,
} from './types.js';

export interface SchemaRequest {
  refresh?: boolean;
  filter?: string;
  signal: AbortSignal;
}

interface CacheEntry {
  at: number;
  snapshot: Omit<SchemaResult, 'fromCache'>;
}

export class SchemaService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly latestIntrospection = new Map<string, symbol>();

  constructor(private readonly ttlMs: number) {}

  async get(
    driver: DriverApi,
    connection: string,
    req: SchemaRequest,
  ): Promise<SchemaResult> {
    const cached = this.cache.get(connection);
    const fresh = Boolean(
      !req.refresh && cached && Date.now() - cached.at < this.ttlMs,
    );
    let base: Omit<SchemaResult, 'fromCache'>;
    if (fresh) {
      base = cached!.snapshot;
    } else {
      const request = Symbol();
      this.latestIntrospection.set(connection, request);
      try {
        base = buildSnapshot(connection, await driver.introspect(req.signal));
        if (this.latestIntrospection.get(connection) === request) {
          this.cache.set(connection, { at: Date.now(), snapshot: base });
        }
      } finally {
        if (this.latestIntrospection.get(connection) === request) {
          this.latestIntrospection.delete(connection);
        }
      }
    }

    const filter = normalizeFilter(req.filter);
    const selection = filter
      ? new Set(
          [...base.tables.map((t) => t.name), ...base.views.map((v) => v.name)].filter(
            (name) => name.toLowerCase().includes(filter),
          ),
        )
      : null;

    const tables = selection
      ? base.tables.filter((t) => selection.has(t.name))
      : base.tables;
    const views = selection
      ? base.views.filter((v) => selection.has(v.name))
      : base.views;
    const keep = (t: string): boolean => !selection || selection.has(t);
    const columns = base.columns.filter((c) => keep(c.table));
    const indexes = base.indexes.filter((i) => keep(i.table));
    const foreignKeys = base.foreignKeys.filter((f) => keep(f.table));

    return {
      kind: 'schema',
      connection,
      capturedAt: fresh ? cached!.snapshot.capturedAt : base.capturedAt,
      fromCache: fresh,
      tables,
      views,
      columns,
      indexes,
      foreignKeys,
    };
  }

  /** Drop a connection's cached snapshot (e.g. after DDL). */
  invalidate(connection: string): void {
    this.cache.delete(connection);
  }

  clear(): void {
    this.cache.clear();
  }
}

function normalizeFilter(filter: string | undefined): string | null {
  if (!filter) return null;
  const trimmed = filter.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function buildSnapshot(
  connection: string,
  raw: Awaited<ReturnType<DriverApi['introspect']>>,
): Omit<SchemaResult, 'fromCache'> {
  const tables: SchemaTable[] = raw.tables.map((t) => ({
    name: t.name,
    type: 'table',
    ...(t.sql ? { sql: t.sql } : {}),
  }));
  const views: SchemaView[] = raw.views.map((v) => ({
    name: v.name,
    ...(v.sql ? { sql: v.sql } : {}),
  }));

  const columns: SchemaColumn[] = raw.columns.map((c) => ({
    table: c.table,
    name: c.name,
    type: c.type,
    nullable: c.nullable,
    ordinal: c.ordinal,
    default: c.default ?? null,
    primaryKey: c.primaryKey,
    ...(c.extra ? { extra: c.extra } : {}),
  }));

  const indexes: SchemaIndex[] = raw.indexes.map((i) => ({
    name: i.name,
    table: i.table,
    columns: [...i.columns],
    unique: i.unique,
    primary: i.primary,
  }));

  const foreignKeys: SchemaForeignKey[] = raw.foreignKeys.map((f) => ({
    name: f.name,
    table: f.table,
    columns: [...f.columns],
    referencedTable: f.referencedTable,
    referencedColumns: [...f.referencedColumns],
    ...(f.onUpdate ? { onUpdate: f.onUpdate } : {}),
    ...(f.onDelete ? { onDelete: f.onDelete } : {}),
  }));

  return {
    kind: 'schema',
    connection,
    capturedAt: new Date().toISOString(),
    tables,
    views,
    columns,
    indexes,
    foreignKeys,
  };
}
