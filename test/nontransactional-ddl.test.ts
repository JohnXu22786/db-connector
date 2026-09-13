import { mkdtempSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { AuditLog } from '../dist/audit.js';
import { normalizeConfig, resolveConnectionSpec } from '../dist/config.js';
import { DbConnectorError, ErrorCode } from '../dist/errors.js';
import { ExecutionEngine } from '../dist/executor.js';
import { importOptional } from '../dist/drivers/driver.js';
import { PgDriver } from '../dist/drivers/postgres.js';
import { SchemaService } from '../dist/schema.js';
import type { DriverApi, Introspection } from '../dist/drivers/driver.js';

interface QueryConfig {
  text: string;
  values?: unknown[];
  signal?: AbortSignal;
}

interface QueryResult {
  fields: Array<{ name: string }>;
  rows: Array<Record<string, unknown>>;
  rowCount: number | null;
}

function makePgDriver(
  calls: string[],
  handle: (query: string | QueryConfig) => Promise<QueryResult> = async () => ({
    fields: [],
    rows: [],
    rowCount: 0,
  }),
): PgDriver {
  const spec = resolveConnectionSpec({ name: 'pg', driver: 'postgres', database: 'test' });
  const driver = new PgDriver(spec, { debug() {}, info() {}, warn() {} });
  const client = {
    query(query: string | QueryConfig) {
      calls.push(typeof query === 'string' ? query : query.text);
      return handle(query);
    },
  };
  (driver as unknown as { client: typeof client }).client = client;
  return driver;
}

test('PostgreSQL non-transactional statements bypass the transaction wrapper', async () => {
  for (const sql of [
    'VACUUM',
    'CREATE INDEX CONCURRENTLY idx ON users (email)',
    'CREATE UNIQUE INDEX CONCURRENTLY idx_unique ON users (email)',
    'DROP INDEX CONCURRENTLY idx',
    'REINDEX INDEX CONCURRENTLY idx',
    'ALTER SYSTEM SET work_mem = 64MB',
    'CREATE DATABASE app_db',
    'DROP DATABASE app_db',
    'CREATE TABLESPACE app_ts LOCATION \'/var/lib/postgresql/data\'',
    'DROP TABLESPACE app_ts',
    'REFRESH MATERIALIZED VIEW CONCURRENTLY app_mv',
  ]) {
    const calls: string[] = [];
    const driver = makePgDriver(calls);
    await driver.write(sql, [], true, new AbortController().signal);
    assert.deepEqual(calls, [sql]);
  }
});

test('PostgreSQL ordinary writes remain transaction-wrapped', async () => {
  const calls: string[] = [];
  const driver = makePgDriver(calls);
  await driver.write('INSERT INTO users(email) VALUES (?)', ['a@x.com'], false, new AbortController().signal);
  assert.deepEqual(calls, ['BEGIN', 'INSERT INTO users(email) VALUES ($1)', 'COMMIT']);
});

test('PostgreSQL serializes concurrent transactional and direct operations', async () => {
  const calls: string[] = [];
  const driver = makePgDriver(calls);
  const first = driver.write(
    'INSERT INTO users(email) VALUES (?)',
    ['a@x.com'],
    false,
    new AbortController().signal,
  );
  const second = driver.write('VACUUM', [], true, new AbortController().signal);
  await Promise.all([first, second]);
  assert.deepEqual(calls, [
    'BEGIN',
    'INSERT INTO users(email) VALUES ($1)',
    'COMMIT',
    'VACUUM',
  ]);
});

test('PostgreSQL queued operations honor abort signals while waiting for the lock', async () => {
  const calls: string[] = [];
  let started!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let finish!: () => void;
  const firstFinished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const driver = makePgDriver(calls, async (query) => {
    const text = typeof query === 'string' ? query : query.text;
    if (text === 'VACUUM' && calls.filter((call) => call === 'VACUUM').length === 1) {
      started();
      await firstFinished;
    }
    return { fields: [], rows: [], rowCount: 0 };
  });

  const first = driver.write('VACUUM', [], true, new AbortController().signal);
  await firstStarted;

  const queuedController = new AbortController();
  const queued = driver.write('VACUUM', [], true, queuedController.signal);
  queuedController.abort(new Error('cancelled while waiting for the connection'));

  const timeout = Symbol('timeout');
  let outcome: DbConnectorError | 'resolved' | typeof timeout;
  try {
    outcome = await Promise.race([
      queued.then(
        () => 'resolved' as const,
        (err) => err as DbConnectorError,
      ),
      new Promise<typeof timeout>((resolve) => setTimeout(() => resolve(timeout), 100)),
    ]);
    assert.notEqual(outcome, timeout, 'queued operation did not observe cancellation');
    assert.notEqual(outcome, 'resolved');
    assert.equal((outcome as DbConnectorError).code, ErrorCode.Cancelled);
    assert.deepEqual(calls, ['VACUUM']);
  } finally {
    finish();
    await first;
    await queued.catch(() => {});
  }

  await driver.write('VACUUM', [], true, new AbortController().signal);
  assert.deepEqual(calls, ['VACUUM', 'VACUUM']);
});

test('PostgreSQL direct statement failures do not issue a rollback', async () => {
  const calls: string[] = [];
  const driver = makePgDriver(calls, async (query) => {
    const text = typeof query === 'string' ? query : query.text;
    if (text === 'VACUUM') throw new Error('simulated VACUUM failure');
    return { fields: [], rows: [], rowCount: 0 };
  });
  await assert.rejects(
    driver.write('VACUUM', [], true, new AbortController().signal),
    /simulated VACUUM failure/,
  );
  assert.deepEqual(calls, ['VACUUM']);
});

function emptyIntrospection(): Introspection {
  return { tables: [], views: [], columns: [], indexes: [], foreignKeys: [] };
}

function makeEngine(driver: DriverApi): ExecutionEngine {
  const dir = mkdtempSync(join(tmpdir(), 'db-connector-pg-test-'));
  const config = normalizeConfig({
    audit: { enabled: false, path: join(dir, 'audit.jsonl') },
  }, {});
  const connectors = {
    open: async () => driver,
    describe: () => ({ driver: driver.kind }),
    touch() {},
    closeAll: async () => {},
  } as never;
  return new ExecutionEngine({
    connectors,
    audit: new AuditLog(config.audit.path, false),
    config,
    schema: new SchemaService(config.schema.ttlMs),
  });
}

test('failed non-transactional DDL invalidates the schema cache and reports no rollback', async () => {
  let introspections = 0;
  const driver: DriverApi = {
    kind: 'postgres',
    async connect() {},
    async read() {
      return { columns: [], rows: [], rowCount: 0 };
    },
    async write() {
      throw new DbConnectorError(ErrorCode.QueryFailed, 'simulated invalid index');
    },
    async introspect() {
      introspections += 1;
      return emptyIntrospection();
    },
    async close() {},
  };
  const engine = makeEngine(driver);

  await engine.schema({ connection: 'pg', way: 'cli' }, new AbortController().signal);
  await engine.schema({ connection: 'pg', way: 'cli' }, new AbortController().signal);
  assert.equal(introspections, 1);

  await assert.rejects(
    engine.exec({
      connection: 'pg',
      sql: 'CREATE INDEX CONCURRENTLY idx ON users (email)',
      allowWrite: true,
      way: 'cli',
    }, new AbortController().signal),
    (err: DbConnectorError) => {
      assert.equal(err.code, ErrorCode.QueryFailed);
      assert.match(err.message, /without a transaction/i);
      assert.doesNotMatch(err.message, /and the transaction was rolled back/i);
      return true;
    },
  );

  const refreshed = await engine.schema(
    { connection: 'pg', way: 'cli' },
    new AbortController().signal,
  );
  assert.equal(refreshed.fromCache, false);
  assert.equal(introspections, 2);
  await engine.dispose();
});

test('live PostgreSQL non-transactional DDL behavior', async (t) => {
  const url = process.env.DSH_DB_CONNECTOR_TEST_POSTGRES_URL;
  if (!url) {
    t.skip('set DSH_DB_CONNECTOR_TEST_POSTGRES_URL to run the live PostgreSQL test');
    return;
  }
  try {
    await importOptional<Record<string, unknown>>('pg');
  } catch {
    t.skip('the optional pg package is not installed');
    return;
  }

  const driver = new PgDriver(
    resolveConnectionSpec({ name: 'pg-live', driver: 'postgres', connectionString: url }),
    { debug() {}, info() {}, warn() {} },
  );
  const signal = (): AbortSignal => new AbortController().signal;
  const suffix = `${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}`
    .replace(/[^A-Za-z0-9_]/g, '');
  const table = `dsh_nt_${suffix}`;
  const index = `${table}_idx`;
  const invalidIndex = `${table}_invalid_idx`;
  const q = (identifier: string): string => `\"${identifier}\"`;
  let tableCreated = false;

  await driver.connect();
  try {
    await driver.write(`CREATE TABLE ${q(table)} (email TEXT NOT NULL)`, [], true, signal());
    tableCreated = true;
    await driver.write(
      `INSERT INTO ${q(table)} (email) VALUES ('duplicate'), ('duplicate')`,
      [],
      false,
      signal(),
    );

    await Promise.all([
      driver.write(`INSERT INTO ${q(table)} (email) VALUES ('concurrent')`, [], false, signal()),
      driver.write('VACUUM', [], true, signal()),
    ]);
    await driver.write(`CREATE INDEX CONCURRENTLY ${q(index)} ON ${q(table)} (email)`, [], true, signal());
    await driver.write(`DROP INDEX CONCURRENTLY ${q(index)}`, [], true, signal());

    await assert.rejects(
      driver.write(
        `CREATE UNIQUE INDEX CONCURRENTLY ${q(invalidIndex)} ON ${q(table)} (email)`,
        [],
        true,
        signal(),
      ),
    );
    const status = await driver.read(
      'SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = $1',
      [invalidIndex],
      signal(),
    );
    assert.deepEqual(status.rows, [[false]]);
    await driver.write(`DROP INDEX CONCURRENTLY IF EXISTS ${q(invalidIndex)}`, [], true, signal());
  } finally {
    if (tableCreated) {
      await driver.write(`DROP TABLE IF EXISTS ${q(table)}`, [], true, signal()).catch(() => {});
    }
    await driver.close();
  }
});
