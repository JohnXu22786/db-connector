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
  let firstDestroyCalls = 0;
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
      firstDestroyCalls += 1;
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
    assert.equal(firstDestroyCalls, 1);

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

const mysqlPromise = require('mysql2/promise') as {
  createConnection(options: Record<string, unknown>): Promise<FakeConnection>;
};

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test('MysqlDriver closes a connection that finishes connecting concurrently', async (t) => {
  const validation = deferred<[unknown, unknown]>();
  const validationStarted = deferred<void>();
  let createCalls = 0;
  let endCalls = 0;
  const connection: FakeConnection = {
    execute: async () => [[], []],
    query: async (sql) => {
      if (sql === 'SELECT 1') {
        validationStarted.resolve();
        return validation.promise;
      }
      return [[], []];
    },
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    destroy: () => {},
    end: async () => {
      endCalls += 1;
    },
  };
  mock.method(mysqlPromise, 'createConnection', async () => {
    createCalls += 1;
    return connection;
  });
  t.after(() => mock.restoreAll());

  const driver = new MysqlDriver(
    resolveConnectionSpec({ name: 'lifecycle', driver: 'mysql', database: 'test' }, {}),
    { debug() {}, info() {}, warn() {} },
  );
  const connecting = driver.connect();
  await validationStarted.promise;
  const closing = driver.close();

  assert.equal(endCalls, 0);
  validation.resolve([[], []]);
  await Promise.all([connecting, closing]);

  assert.equal(createCalls, 1);
  assert.equal(endCalls, 1);
  assert.equal((driver as unknown as { conn: FakeConnection | null }).conn, null);
  await assert.rejects(() => driver.connect(), (error: unknown) => {
    return error instanceof DbConnectorError && error.code === ErrorCode.ConnectionNotFound;
  });
});

test('MysqlDriver releases its lifecycle lock after a failed connection', async (t) => {
  let createCalls = 0;
  let destroyCalls = 0;
  let endCalls = 0;
  const failedConnection: FakeConnection = {
    execute: async () => [[], []],
    query: async () => {
      throw new Error('validation failed');
    },
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    destroy: () => {
      destroyCalls += 1;
    },
    end: async () => {},
  };
  const workingConnection: FakeConnection = {
    execute: async () => [[], []],
    query: async () => [[], []],
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    destroy: () => {},
    end: async () => {
      endCalls += 1;
    },
  };
  mock.method(mysqlPromise, 'createConnection', async () => {
    createCalls += 1;
    return createCalls === 1 ? failedConnection : workingConnection;
  });
  t.after(() => mock.restoreAll());

  const driver = new MysqlDriver(
    resolveConnectionSpec({ name: 'retry', driver: 'mysql', database: 'test' }, {}),
    { debug() {}, info() {}, warn() {} },
  );

  await assert.rejects(() => driver.connect());
  await driver.connect();

  assert.equal(createCalls, 2);
  assert.equal(destroyCalls, 1);
  assert.equal((driver as unknown as { conn: FakeConnection | null }).conn, workingConnection);
  await driver.close();
  assert.equal(endCalls, 1);
});

test('MysqlDriver reconnects after a non-abort query failure', async (t) => {
  let createCalls = 0;
  let failedExecuteCalls = 0;
  let failedDestroyCalls = 0;
  const failedConnection: FakeConnection = {
    execute: async () => {
      failedExecuteCalls += 1;
      throw Object.assign(new Error('connection lost'), {
        code: 'PROTOCOL_CONNECTION_LOST',
        fatal: true,
      });
    },
    query: async () => [[], []],
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    destroy: () => {
      failedDestroyCalls += 1;
    },
    end: async () => {},
  };
  const workingConnection: FakeConnection = {
    execute: async () => [[[2]], [{ name: 'id' }]],
    query: async () => [[], []],
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    destroy: () => {},
    end: async () => {},
  };
  mock.method(mysqlPromise, 'createConnection', async () => {
    createCalls += 1;
    return createCalls === 1 ? failedConnection : workingConnection;
  });
  t.after(() => mock.restoreAll());

  const driver = new MysqlDriver(
    resolveConnectionSpec({ name: 'query-retry', driver: 'mysql', database: 'test' }, {}),
    { debug() {}, info() {}, warn() {} },
  );

  await driver.connect();
  await assert.rejects(
    () => driver.read('SELECT id FROM users', [], new AbortController().signal),
    (error: unknown) => error instanceof DbConnectorError && error.code === ErrorCode.QueryFailed,
  );
  assert.equal(failedExecuteCalls, 1);
  assert.equal(failedDestroyCalls, 1);
  assert.equal((driver as unknown as { conn: FakeConnection | null }).conn, null);

  await driver.connect();
  const result = await driver.read(
    'SELECT id FROM users',
    [],
    new AbortController().signal,
  );

  assert.equal(createCalls, 2);
  assert.deepEqual(result.columns, ['id']);
  assert.deepEqual(result.rows, [[2]]);
  await driver.close();
});

test('MysqlDriver reuses a connection after a nonfatal statement error', async () => {
  let executeCalls = 0;
  let beginCalls = 0;
  let rollbackCalls = 0;
  let commitCalls = 0;
  let destroyCalls = 0;
  const connection: FakeConnection = {
    execute: async () => {
      executeCalls += 1;
      if (executeCalls === 1) {
        throw Object.assign(new Error('duplicate entry'), {
          code: 'ER_DUP_ENTRY',
          errno: 1062,
          sqlState: '23000',
          fatal: false,
        });
      }
      return [{ affectedRows: 1 }, []];
    },
    query: async () => [[], []],
    beginTransaction: async () => {
      beginCalls += 1;
    },
    commit: async () => {
      commitCalls += 1;
    },
    rollback: async () => {
      rollbackCalls += 1;
    },
    destroy: () => {
      destroyCalls += 1;
    },
    end: async () => {},
  };
  const driver = new MysqlDriver(
    resolveConnectionSpec({ name: 'recoverable-query', driver: 'mysql', database: 'test' }, {}),
    { debug() {}, info() {}, warn() {} },
  );
  (driver as unknown as { conn: FakeConnection | null }).conn = connection;

  await assert.rejects(
    () => driver.write('INSERT INTO users (id) VALUES (?)', [1], false, new AbortController().signal),
    (error: unknown) => error instanceof DbConnectorError && error.code === ErrorCode.QueryFailed,
  );
  const result = await driver.write(
    'INSERT INTO users (id) VALUES (?)',
    [2],
    false,
    new AbortController().signal,
  );

  assert.equal(executeCalls, 2);
  assert.equal(beginCalls, 2);
  assert.equal(rollbackCalls, 1);
  assert.equal(commitCalls, 1);
  assert.equal(destroyCalls, 0);
  assert.equal((driver as unknown as { conn: FakeConnection | null }).conn, connection);
  assert.deepEqual(result, { affectedRows: 1, isDdl: false });

  await driver.close();
});

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

test('MysqlDriver uses the URI database for schema introspection', async () => {
  const schemas: unknown[] = [];
  const connection = {
    async query(sql: string, values?: unknown[]) {
      const database = values?.[0];
      schemas.push(database);
      if (sql.includes('information_schema.tables') && database === 'app_db') {
        return [[{ table_name: 'users', table_type: 'BASE TABLE' }], []];
      }
      return [[], []];
    },
    async execute() {
      return [[], []];
    },
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    destroy() {},
    async end() {},
  };
  const spec = resolveConnectionSpec(
    {
      name: 'uri-schema',
      driver: 'mysql',
      connectionString: 'mysql://uri-user:uri-pass@db.example.test:3307/app_db',
    },
    {},
  );
  const driver = new MysqlDriver(spec, { debug() {}, info() {}, warn() {} });
  (driver as unknown as { conn: unknown }).conn = connection;

  const introspection = await driver.introspect(new AbortController().signal);

  assert.deepEqual(schemas, ['app_db', 'app_db', 'app_db', 'app_db']);
  assert.deepEqual(introspection.tables, [{ name: 'users' }]);
});

test('MysqlDriver keeps colon-containing foreign key names distinct', async () => {
  const connection = {
    async query(sql: string) {
      if (sql.includes('information_schema.key_column_usage')) {
        return [[
          {
            table_name: 'a:b',
            constraint_name: 'c',
            column_name: 'first_id',
            referenced_table_name: 'parents',
            referenced_column_name: 'id',
            update_rule: 'RESTRICT',
            delete_rule: 'CASCADE',
          },
          {
            table_name: 'a',
            constraint_name: 'b:c',
            column_name: 'second_id',
            referenced_table_name: 'parents',
            referenced_column_name: 'id',
            update_rule: 'RESTRICT',
            delete_rule: 'CASCADE',
          },
        ], []];
      }
      return [[], []];
    },
    async execute() {
      return [[], []];
    },
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    destroy() {},
    async end() {},
  };
  const driver = new MysqlDriver(
    resolveConnectionSpec({ name: 'fk-collision', driver: 'mysql', database: 'app_db' }, {}),
    { debug() {}, info() {}, warn() {} },
  );
  (driver as unknown as { conn: unknown }).conn = connection;

  const introspection = await driver.introspect(new AbortController().signal);

  assert.deepEqual(introspection.foreignKeys, [
    {
      name: 'c',
      table: 'a:b',
      columns: ['first_id'],
      referencedTable: 'parents',
      referencedColumns: ['id'],
      onUpdate: 'RESTRICT',
      onDelete: 'CASCADE',
    },
    {
      name: 'b:c',
      table: 'a',
      columns: ['second_id'],
      referencedTable: 'parents',
      referencedColumns: ['id'],
      onUpdate: 'RESTRICT',
      onDelete: 'CASCADE',
    },
  ]);
});
