import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ErrorCode, DbConnectorError } from '../dist/errors.js';
import { MysqlDriver } from '../dist/drivers/mysql.js';
import type { ResolvedConnectionSpec } from '../dist/types.js';

test('aborting a MySQL operation clears the destroyed connection for reconnect', async () => {
  let releaseExecute: (() => void) | undefined;
  let destroyed = false;
  const connection = {
    execute: () => new Promise<[unknown, unknown]>((resolve) => {
      releaseExecute = () => resolve([[], []]);
    }),
    query: async () => [[], []] as [unknown, unknown],
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    destroy: () => {
      destroyed = true;
    },
    end: async () => {},
  };
  const driver = new MysqlDriver(
    {
      name: 'mysql-test',
      driver: 'mysql',
      password: '',
      options: {},
      passwordSource: 'none',
    } satisfies ResolvedConnectionSpec,
    { debug() {}, info() {}, warn() {} },
  );
  const state = driver as unknown as { conn: typeof connection | null };
  state.conn = connection;

  const controller = new AbortController();
  const operation = driver.read('SELECT 1', [], controller.signal);
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();

  await assert.rejects(
    operation,
    (error: unknown) => error instanceof DbConnectorError && error.code === ErrorCode.Cancelled,
  );
  releaseExecute?.();

  assert.equal(destroyed, true);
  assert.equal(state.conn, null);
});
