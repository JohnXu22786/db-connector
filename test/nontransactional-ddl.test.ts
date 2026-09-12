import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { resolveConnectionSpec } from '../dist/config.js';
import { PgDriver } from '../dist/drivers/postgres.js';

interface QueryConfig {
  text: string;
  values?: unknown[];
  signal?: AbortSignal;
}

function makePgDriver(calls: string[]): PgDriver {
  const spec = resolveConnectionSpec({ name: 'pg', driver: 'postgres', database: 'test' });
  const driver = new PgDriver(spec, { debug() {}, info() {}, warn() {} });
  const client = {
    query(query: string | QueryConfig) {
      calls.push(typeof query === 'string' ? query : query.text);
      return Promise.resolve({ fields: [], rows: [], rowCount: 0 });
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
