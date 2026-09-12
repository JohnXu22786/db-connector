/**
 * Driver result conversion tests using fake clients so optional server
 * drivers can be covered without requiring live MySQL or PostgreSQL servers.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { MysqlDriver } from '../dist/drivers/mysql.js';
import { PgDriver } from '../dist/drivers/postgres.js';

const logger = { debug() {}, info() {}, warn() {} };

test('MySQL read conversion preserves empty columns and duplicate values', async () => {
  const driver = new MysqlDriver(
    { name: 'mysql-test', driver: 'mysql', database: 'test' } as never,
    logger,
  );
  const executeOptions: unknown[] = [];
  const results: Array<[unknown, unknown]> = [
    [[], [{ name: 'id' }, { name: 'label' }]],
    [[[1, 2]], [{ name: 'value' }, { name: 'value' }]],
  ];
  (driver as unknown as { conn: MysqlClientFake }).conn = {
    async query() {
      return [[], []];
    },
    async execute(options) {
      executeOptions.push(options);
      return results.shift()!;
    },
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    destroy() {},
    async end() {},
  };

  const empty = await driver.read('SELECT id, label FROM t WHERE 1 = 0', [], signal());
  assert.deepEqual(empty, {
    columns: ['id', 'label'],
    rows: [],
    rowCount: 0,
  });

  const duplicate = await driver.read('SELECT 1 AS value, 2 AS value', [], signal());
  assert.deepEqual(duplicate, {
    columns: ['value', 'value'],
    rows: [[1, 2]],
    rowCount: 1,
  });
  assert.deepEqual(executeOptions, [
    { sql: 'SELECT id, label FROM t WHERE 1 = 0', values: [], rowsAsArray: true },
    { sql: 'SELECT 1 AS value, 2 AS value', values: [], rowsAsArray: true },
  ]);
});

test('PostgreSQL read conversion preserves empty columns and duplicate values', async () => {
  const driver = new PgDriver(
    { name: 'postgres-test', driver: 'postgres', database: 'test' } as never,
    logger,
  );
  const queryConfigs: unknown[] = [];
  const results: PgResultFake[] = [
    { fields: [{ name: 'id' }, { name: 'label' }], rows: [], rowCount: 0 },
    { fields: [{ name: 'value' }, { name: 'value' }], rows: [[1, 2]], rowCount: 1 },
  ];
  (driver as unknown as { client: PgClientFake }).client = {
    async query(query) {
      if (typeof query === 'string') {
        return { fields: [], rows: [], rowCount: null };
      }
      queryConfigs.push(query);
      return results.shift()!;
    },
    async connect() {},
    async end() {},
  };

  const empty = await driver.read('SELECT id, label FROM t WHERE false', [], signal());
  assert.deepEqual(empty, {
    columns: ['id', 'label'],
    rows: [],
    rowCount: 0,
  });

  const duplicate = await driver.read('SELECT 1 AS value, 2 AS value', [], signal());
  assert.deepEqual(duplicate, {
    columns: ['value', 'value'],
    rows: [[1, 2]],
    rowCount: 1,
  });
  assert.deepEqual(
    queryConfigs.map((query) => {
      const config = query as { text: string; values: unknown[]; rowMode: string };
      return { text: config.text, values: config.values, rowMode: config.rowMode };
    }),
    [
      { text: 'SELECT id, label FROM t WHERE false', values: [], rowMode: 'array' },
      { text: 'SELECT 1 AS value, 2 AS value', values: [], rowMode: 'array' },
    ],
  );
  assert.equal(queryConfigs.every((query) => 'signal' in (query as object)), true);
});

interface MysqlClientFake {
  query(sql: string): Promise<[unknown, unknown]>;
  execute(options: unknown): Promise<[unknown, unknown]>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  destroy(): void;
  end(): Promise<void>;
}

interface PgResultFake {
  fields: Array<{ name: string }>;
  rows: unknown[][];
  rowCount: number | null;
}

interface PgClientFake {
  query(query: unknown): Promise<PgResultFake>;
  connect(): Promise<void>;
  end(): Promise<void>;
}

function signal(): AbortSignal {
  return new AbortController().signal;
}
