import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { mock, test } from 'node:test';
import { ErrorCode, DbConnectorError } from '../dist/errors.js';
import { MysqlDriver } from '../dist/drivers/mysql.js';
import { makeHarness } from './helpers.ts';
import { resolveConnectionSpec } from '../dist/config.js';

interface FakeConnection {
  execute(sql: string, values?: unknown[]): Promise<[unknown, unknown]>;
  query(sql: string, values?: unknown[]): Promise<[unknown, unknown]>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  destroy(): void;
  end(): Promise<void>;
}

test('aborting a MySQL query reconnects on the next public use', async () => {
  let connectCalls = 0;
  let connectionCreates = 0;
  let firstExecuteStarted = false;
  let firstDestroyed = false;
  let releaseFirstExecute = () => {};
  const firstConnection: FakeConnection = {
    execute: () => {
      firstExecuteStarted = true;
      return new Promise<[unknown, unknown]>((resolve) => {
        releaseFirstExecute = () => resolve([[], []]);
      });
    },
    query: async () => [[], []],
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    destroy: () => {
      firstDestroyed = true;
      releaseFirstExecute();
    },
    end: async () => {},
  };
  const secondConnection: FakeConnection = {
    execute: async () => [[[2]], [{ name: 'id' }]],
    query: async () => [[], []],
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    destroy: () => {},
    end: async () => {},
  };

  const originalConnect = MysqlDriver.prototype.connect;
  MysqlDriver.prototype.connect = async function () {
    connectCalls += 1;
    const state = this as unknown as { conn: FakeConnection | null };
    if (state.conn) return;
    connectionCreates += 1;
    state.conn = connectionCreates === 1 ? firstConnection : secondConnection;
  };

  try {
    const h = makeHarness();
    await h.engine.connect({ name: 'mysql-test', driver: 'mysql', database: 'test' });

    const controller = new AbortController();
    const abortedQuery = h.engine.query(
      { connection: 'mysql-test', sql: 'SELECT 1', way: 'cli' },
      controller.signal,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(firstExecuteStarted, true);
    controller.abort();

    await assert.rejects(
      abortedQuery,
      (error: unknown) => error instanceof DbConnectorError && error.code === ErrorCode.Cancelled,
    );
    assert.equal(firstDestroyed, true);

    const result = await h.engine.query(
      { connection: 'mysql-test', sql: 'SELECT id FROM users', way: 'cli' },
      new AbortController().signal,
    );

    assert.equal(connectCalls, 3);
    assert.equal(connectionCreates, 2);
    assert.deepEqual(result.columns, ['id']);
    assert.deepEqual(result.rows, [[2]]);
  } finally {
    MysqlDriver.prototype.connect = originalConnect;
  }
});

class FakeStream extends EventEmitter {
  write(): boolean {
    return true;
  }

  setNoDelay(): void {}

  end(): void {}
}

const require = createRequire(import.meta.url);
const net = require('node:net') as {
  connect(...args: unknown[]): FakeStream;
};

test('MysqlDriver uses the URI host and port for mysql2 connections', async (t) => {
  let target: { host: unknown; port: unknown } | undefined;
  mock.method(net, 'connect', (...args: unknown[]) => {
    target = { port: args[0], host: args[1] };
    const stream = new FakeStream();
    queueMicrotask(() => stream.emit('error', new Error('test connection')));
    return stream;
  });
  t.after(() => mock.restoreAll());

  const connectionString = 'mysql://uri-user:uri-pass@db.example.test:3307/app_db';
  const spec = resolveConnectionSpec(
    { name: 'uri-only', driver: 'mysql', connectionString },
    {},
  );
  const driver = new MysqlDriver(spec, { debug() {}, info() {}, warn() {} });

  await assert.rejects(() => driver.connect(), /test connection/);

  assert.deepEqual(target, { host: 'db.example.test', port: 3307 });
});
