/**
 * Shared helpers for the test suite. Tests run against the compiled `dist`
 * output so what is exercised is exactly what ships.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { AuditLog } from '../dist/audit.js';
import { normalizeConfig } from '../dist/config.js';
import { Connectors } from '../dist/connectors.js';
import { ExecutionEngine, type EngineOptions } from '../dist/executor.js';
import { SchemaService } from '../dist/schema.js';
import type { ResolvedConfig } from '../dist/types.js';

export interface Harness {
  engine: ExecutionEngine;
  connectors: Connectors;
  audit: AuditLog;
  schema: SchemaService;
  cfg: ResolvedConfig;
  dir: string;
}

export function noopLogger() {
  return { debug() {}, info() {}, warn() {} };
}

/** Every harness created in a test process is disposed after the tests run,
 *  closing SQLite worker threads so the process can exit. The hook is
 *  registered at MODULE scope (never inside a test body). */
const live = new Set<Harness>();
after(() => Promise.all([...live].map((h) => h.engine.dispose())));

export function makeHarness(overrides: Partial<Record<string, unknown>> = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'db-connector-'));
  const cfg = normalizeConfig({ audit: { path: join(dir, 'audit.jsonl') }, ...overrides }, {});
  const connectors = new Connectors(noopLogger());
  const audit = new AuditLog(cfg.audit.path, cfg.audit.enabled);
  const schema = new SchemaService(cfg.schema.ttlMs);
  const engine = new ExecutionEngine({
    connectors,
    audit,
    config: cfg,
    schema,
  } satisfies EngineOptions);
  const h: Harness = { engine, connectors, audit, schema, cfg, dir };
  live.add(h);
  return h;
}

/** Create + seed a sqlite connection in the harness's temp dir. */
export async function seedSqlite(h: Harness, name = 'sample'): Promise<string> {
  const dbPath = join(h.dir, `${name}.sqlite`);
  const sig = (): AbortSignal => new AbortController().signal;
  await h.engine.connect({ name, driver: 'sqlite', database: dbPath });
  await h.engine.exec({
    connection: name,
    sql: 'CREATE TABLE users(id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, age INTEGER)',
    allowWrite: true,
    way: 'cli',
  }, sig());
  await h.engine.exec({
    connection: name,
    sql: 'INSERT INTO users(email, age) VALUES(?, ?)',
    params: ['a@x.com', 30],
    allowWrite: true,
    way: 'cli',
  }, sig());
  await h.engine.exec({
    connection: name,
    sql: 'INSERT INTO users(email, age) VALUES(?, ?)',
    params: ['b@x.com', 25],
    allowWrite: true,
    way: 'cli',
  }, sig());
  await h.engine.exec({
    connection: name,
    sql: 'CREATE TABLE orders(id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id), total REAL)',
    allowWrite: true,
    way: 'cli',
  }, sig());
  return dbPath;
}

export function freshSignal(): AbortSignal {
  return new AbortController().signal;
}
