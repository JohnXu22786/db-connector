/**
 * Regression coverage for driver transaction serialization, result conversion,
 * and SQLite lifecycle behavior, without requiring live database servers.
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { mock, test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MysqlDriver } from '../dist/drivers/mysql.js';
import { PgDriver } from '../dist/drivers/postgres.js';
import { SqliteDriver } from '../dist/drivers/sqlite.js';
import { DbConnectorError, ErrorCode } from '../dist/errors.js';
import type { ResolvedConnectionSpec } from '../dist/types.js';

type PgResult = {
  fields: Array<{ name: string }>;
  rows: unknown[][];
  rowCount: number;
};

type PgClientStub = {
  query(input: string | { text: string }): Promise<PgResult>;
  connect(): Promise<void>;
  end(): Promise<void>;
};

const require = createRequire(import.meta.url);

type MysqlConnectionStub = {
  execute(input: string | { sql: string; values?: unknown[]; rowsAsArray?: boolean }): Promise<[unknown, unknown]>;
  query(sql: string, values?: unknown[]): Promise<[unknown, unknown]>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  destroy(): void;
  end(): Promise<void>;
};

const spec = (driver: 'postgres' | 'mysql'): ResolvedConnectionSpec => ({
  name: 'server',
  driver,
  password: '',
  passwordSource: 'none',
  options: {},
});

function installPgClient(driver: PgDriver, client: PgClientStub): void {
  (driver as unknown as { client: PgClientStub }).client = client;
}

function installMysqlConnection(driver: MysqlDriver, conn: MysqlConnectionStub): void {
  (driver as unknown as { conn: MysqlConnectionStub }).conn = conn;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function mysqlSql(input: string | { sql: string }): string {
  return typeof input === 'string' ? input : input.sql;
}

test('PostgreSQL serializes concurrent transaction sequences', async () => {
  const events: string[] = [];
  const client: PgClientStub = {
    connect: async () => {},
    end: async () => {},
    query: async (input) => {
      events.push(typeof input === 'string' ? input : input.text);
      return { fields: [{ name: 'value' }], rows: [[1]], rowCount: 1 };
    },
  };
  const driver = new PgDriver(spec('postgres'), {
    debug() {},
    info() {},
    warn() {},
  });
  installPgClient(driver, client);

  const signal = new AbortController().signal;
  const read = driver.read('SELECT 1', [], signal);
  const write = driver.write('UPDATE t SET value = value + 1', [], false, signal);
  const [readResult, writeResult] = await Promise.all([read, write]);

  assert.deepEqual(readResult.rows, [[1]]);
  assert.equal(writeResult.affectedRows, 1);
  assert.deepEqual(events, [
    'BEGIN TRANSACTION READ ONLY',
    'SELECT 1',
    'ROLLBACK',
    'BEGIN',
    'UPDATE t SET value = value + 1',
    'COMMIT',
  ]);
});

test('MySQL serializes concurrent transaction sequences', async () => {
  const events: string[] = [];
  const conn: MysqlConnectionStub = {
    execute: async (input) => {
      const sql = mysqlSql(input);
      events.push(sql);
      return sql === 'SELECT 1' ? [[[1]], [{ name: 'value' }]] : [{ affectedRows: 1 }, []];
    },
    query: async (sql) => {
      events.push(sql);
      return [[], []];
    },
    beginTransaction: async () => {
      events.push('BEGIN');
    },
    commit: async () => {
      events.push('COMMIT');
    },
    rollback: async () => {
      events.push('ROLLBACK');
    },
    destroy: () => {},
    end: async () => {},
  };
  const driver = new MysqlDriver(spec('mysql'), {
    debug() {},
    info() {},
    warn() {},
  });
  installMysqlConnection(driver, conn);

  const signal = new AbortController().signal;
  const read = driver.read('SELECT 1', [], signal);
  const write = driver.write('UPDATE t SET value = value + 1', [], false, signal);
  const [readResult, writeResult] = await Promise.all([read, write]);

  assert.deepEqual(readResult.rows, [[1]]);
  assert.equal(writeResult.affectedRows, 1);
  assert.deepEqual(events, [
    'START TRANSACTION READ ONLY',
    'SELECT 1',
    'ROLLBACK',
    'BEGIN',
    'UPDATE t SET value = value + 1',
    'COMMIT',
  ]);
});

test('PostgreSQL serializes introspection after an active write transaction', async () => {
  const events: string[] = [];
  const statement = deferred<PgResult>();
  const started = deferred<void>();
  const client: PgClientStub = {
    connect: async () => {},
    end: async () => {},
    query: async (input) => {
      const text = typeof input === 'string' ? input : input.text;
      events.push(text);
      if (text === 'UPDATE first') {
        started.resolve();
        return statement.promise;
      }
      return { fields: [], rows: [], rowCount: 0 };
    },
  };
  const driver = new PgDriver(spec('postgres'), {
    debug() {},
    info() {},
    warn() {},
  });
  installPgClient(driver, client);

  const write = driver.write('UPDATE first', [], false, new AbortController().signal);
  await started.promise;
  const introspection = driver.introspect(new AbortController().signal);
  await nextTurn();

  try {
    assert.deepEqual(events, ['BEGIN', 'UPDATE first']);
  } finally {
    statement.resolve({ fields: [], rows: [], rowCount: 1 });
    await Promise.all([write, introspection]);
  }

  assert.equal(events[2], 'COMMIT');
  assert.equal(events.length, 9);
});

test('PostgreSQL keeps the operation lock until all catalog queries settle after a failure', async () => {
  const events: string[] = [];
  const viewsStarted = deferred<void>();
  const viewsResult = deferred<PgResult>();
  const client: PgClientStub = {
    connect: async () => {},
    end: async () => {},
    query: async (input) => {
      const text = typeof input === 'string' ? input : input.text;
      events.push(text);
      if (text.includes('FROM information_schema.tables')) {
        throw new Error('catalog failure');
      }
      if (text.includes('FROM information_schema.views')) {
        viewsStarted.resolve();
        return viewsResult.promise;
      }
      return { fields: [], rows: [], rowCount: 0 };
    },
  };
  const driver = new PgDriver(spec('postgres'), {
    debug() {},
    info() {},
    warn() {},
  });
  installPgClient(driver, client);

  const introspection = driver.introspect(new AbortController().signal);
  void introspection.catch(() => {});
  await viewsStarted.promise;
  await nextTurn();

  const queued = driver.write(
    'UPDATE after catalog failure',
    [],
    false,
    new AbortController().signal,
  );
  await nextTurn();

  try {
    assert.equal(events.includes('BEGIN'), false);
  } finally {
    viewsResult.resolve({ fields: [], rows: [], rowCount: 0 });
    await assert.rejects(introspection, /catalog failure/);
    await queued;
  }

  assert.deepEqual(events.slice(-3), [
    'BEGIN',
    'UPDATE after catalog failure',
    'COMMIT',
  ]);
});

test('PostgreSQL introspection keeps primary keys associated with their table', async () => {
  const client: PgClientStub = {
    connect: async () => {},
    end: async () => {},
    query: async (input) => {
      const text = typeof input === 'string' ? input : input.text;
      if (text.includes('FROM information_schema.tables')) {
        return {
          fields: [],
          rows: [{ table_name: 'first_table' }, { table_name: 'second_table' }],
          rowCount: 2,
        } as never;
      }
      if (text.includes('FROM information_schema.columns')) {
        return {
          fields: [],
          rows: [
            {
              table_name: 'first_table',
              column_name: 'id',
              data_type: 'integer',
              is_nullable: 'NO',
              ordinal_position: '1',
              column_default: null,
            },
            {
              table_name: 'second_table',
              column_name: 'id',
              data_type: 'integer',
              is_nullable: 'NO',
              ordinal_position: '1',
              column_default: null,
            },
            {
              table_name: 'second_table',
              column_name: 'code',
              data_type: 'integer',
              is_nullable: 'NO',
              ordinal_position: '2',
              column_default: null,
            },
          ],
          rowCount: 3,
        } as never;
      }
      if (text.includes('FROM information_schema.table_constraints')) {
        const rows = text.includes('tc.table_name = kcu.table_name')
          ? [
              { table_name: 'first_table', column_name: 'id' },
              { table_name: 'second_table', column_name: 'code' },
            ]
          : [
              { table_name: 'first_table', column_name: 'id' },
              { table_name: 'first_table', column_name: 'code' },
              { table_name: 'second_table', column_name: 'id' },
              { table_name: 'second_table', column_name: 'code' },
            ];
        return { fields: [], rows, rowCount: rows.length } as never;
      }
      return { fields: [], rows: [], rowCount: 0 };
    },
  };
  const driver = new PgDriver(spec('postgres'), {
    debug() {},
    info() {},
    warn() {},
  });
  installPgClient(driver, client);

  const introspection = await driver.introspect(new AbortController().signal);
  const secondTable = introspection.columns.filter((item) => item.table === 'second_table');

  assert.equal(secondTable.find((item) => item.name === 'code')?.primaryKey, true);
  assert.equal(secondTable.find((item) => item.name === 'id')?.primaryKey, false);
});

test('PostgreSQL close waits before ending the client used by queued operations', async () => {
  const events: string[] = [];
  const statement = deferred<PgResult>();
  const started = deferred<void>();
  let ended = false;
  let endStarted = false;
  const client: PgClientStub = {
    connect: async () => {},
    end: async () => {
      endStarted = true;
      ended = true;
    },
    query: async (input) => {
      if (ended) throw new Error('client ended');
      const text = typeof input === 'string' ? input : input.text;
      events.push(text);
      if (text === 'SELECT first') {
        started.resolve();
        return statement.promise;
      }
      return { fields: [], rows: [], rowCount: 0 };
    },
  };
  const driver = new PgDriver(spec('postgres'), logger);
  installPgClient(driver, client);

  const active = driver.read('SELECT first', [], signal());
  await started.promise;
  const queued = driver.read('SELECT queued', [], signal());
  const closing = driver.close();
  await nextTurn();

  assert.equal(endStarted, false);
  assert.deepEqual(events, ['BEGIN TRANSACTION READ ONLY', 'SELECT first']);

  statement.resolve({ fields: [], rows: [], rowCount: 1 });
  await active;
  const queuedError = await queued.then(() => undefined, (err: unknown) => err);
  await closing;

  assert.ok(queuedError instanceof DbConnectorError);
  assert.equal((queuedError as DbConnectorError).code, ErrorCode.ConnectionNotFound);
  assert.deepEqual(events, [
    'BEGIN TRANSACTION READ ONLY',
    'SELECT first',
    'ROLLBACK',
  ]);
  assert.equal(endStarted, true);
});

test('PostgreSQL reconnects after close without leaking the new client', async (t) => {
  let clientCreates = 0;
  const endCalls: number[] = [];
  class FakePgClient implements PgClientStub {
    private readonly id = ++clientCreates;

    async connect(): Promise<void> {}

    async query(): Promise<PgResult> {
      return { fields: [{ name: 'value' }], rows: [[1]], rowCount: 1 };
    }

    async end(): Promise<void> {
      endCalls.push(this.id);
    }
  }
  function createFakePgClient(): FakePgClient {
    return new FakePgClient();
  }
  const pg = require('pg') as { Client: typeof FakePgClient };
  mock.method(pg, 'Client', createFakePgClient);
  t.after(() => mock.restoreAll());

  const driver = new PgDriver(spec('postgres'), logger);
  await driver.connect();
  await driver.close();
  await driver.connect();

  try {
    const result = await driver.read('SELECT 1', [], signal());
    assert.deepEqual(result.rows, [[1]]);
  } finally {
    await driver.close();
  }

  assert.equal(clientCreates, 2);
  assert.deepEqual(endCalls, [1, 2]);
});

test('MySQL close waits before ending the connection used by an active transaction', async () => {
  const events: string[] = [];
  const statement = deferred<[unknown, unknown]>();
  const started = deferred<void>();
  let ended = false;
  let endStarted = false;
  const conn: MysqlConnectionStub = {
    execute: async (input) => {
      const sql = mysqlSql(input);
      events.push(sql);
      if (sql === 'SELECT first') {
        started.resolve();
        return statement.promise;
      }
      return [[], []];
    },
    query: async (sql) => {
      if (ended) throw new Error('connection ended');
      events.push(sql);
      return [[], []];
    },
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    destroy: () => {},
    end: async () => {
      endStarted = true;
      ended = true;
    },
  };
  const driver = new MysqlDriver(spec('mysql'), logger);
  installMysqlConnection(driver, conn);

  const active = driver.read('SELECT first', [], signal());
  await started.promise;
  const closing = driver.close();

  try {
    await nextTurn();
    assert.equal(endStarted, false);
    assert.deepEqual(events, ['START TRANSACTION READ ONLY', 'SELECT first']);

    statement.resolve([[[1]], [{ name: 'value' }]]);
    await active;
    await closing;

    assert.equal(endStarted, true);
    assert.deepEqual(events, [
      'START TRANSACTION READ ONLY',
      'SELECT first',
      'ROLLBACK',
    ]);
  } finally {
    statement.resolve([[], []]);
    await Promise.allSettled([active, closing]);
  }
});

test('PostgreSQL rejects an aborted queued request without starting a transaction', async () => {
  const events: string[] = [];
  const statement = deferred<PgResult>();
  const started = deferred<void>();
  const client: PgClientStub = {
    connect: async () => {},
    end: async () => {},
    query: async (input) => {
      const text = typeof input === 'string' ? input : input.text;
      events.push(text);
      if (text === 'SELECT first') {
        started.resolve();
        return statement.promise;
      }
      return { fields: [{ name: 'value' }], rows: [[1]], rowCount: 1 };
    },
  };
  const driver = new PgDriver(spec('postgres'), {
    debug() {},
    info() {},
    warn() {},
  });
  installPgClient(driver, client);

  const first = driver.read('SELECT first', [], new AbortController().signal);
  await started.promise;
  const queuedAbort = new AbortController();
  const queued = driver.write('UPDATE second', [], false, queuedAbort.signal);
  let queuedSettled = false;
  let queuedError: unknown;
  void queued.then(
    () => {
      queuedSettled = true;
    },
    (err: unknown) => {
      queuedSettled = true;
      queuedError = err;
    },
  );
  queuedAbort.abort(new Error('query timeout'));
  await nextTurn();

  try {
    assert.equal(queuedSettled, true);
    assert.ok(queuedError instanceof DbConnectorError);
    assert.equal((queuedError as DbConnectorError).code, ErrorCode.Timeout);
    assert.deepEqual(events, ['BEGIN TRANSACTION READ ONLY', 'SELECT first']);
  } finally {
    statement.resolve({ fields: [{ name: 'value' }], rows: [[1]], rowCount: 1 });
    await first;
    await queued.catch(() => {});
  }

  assert.deepEqual(events, ['BEGIN TRANSACTION READ ONLY', 'SELECT first', 'ROLLBACK']);
});

test('MySQL rejects an aborted queued request without starting a transaction', async () => {
  const events: string[] = [];
  const statement = deferred<[unknown, unknown]>();
  const started = deferred<void>();
  const conn: MysqlConnectionStub = {
    execute: async (input) => {
      const sql = mysqlSql(input);
      events.push(sql);
      if (sql === 'SELECT first') {
        started.resolve();
        return statement.promise;
      }
      return [{ affectedRows: 1 }, []];
    },
    query: async (sql) => {
      events.push(sql);
      return [[], []];
    },
    beginTransaction: async () => {
      events.push('BEGIN');
    },
    commit: async () => {
      events.push('COMMIT');
    },
    rollback: async () => {
      events.push('ROLLBACK');
    },
    destroy: () => {},
    end: async () => {},
  };
  const driver = new MysqlDriver(spec('mysql'), {
    debug() {},
    info() {},
    warn() {},
  });
  installMysqlConnection(driver, conn);

  const first = driver.read('SELECT first', [], new AbortController().signal);
  await started.promise;
  const queuedAbort = new AbortController();
  const queued = driver.write('UPDATE second', [], false, queuedAbort.signal);
  let queuedSettled = false;
  let queuedError: unknown;
  void queued.then(
    () => {
      queuedSettled = true;
    },
    (err: unknown) => {
      queuedSettled = true;
      queuedError = err;
    },
  );
  queuedAbort.abort(new Error('query timeout'));
  await nextTurn();

  try {
    assert.equal(queuedSettled, true);
    assert.ok(queuedError instanceof DbConnectorError);
    assert.equal((queuedError as DbConnectorError).code, ErrorCode.Timeout);
    assert.deepEqual(events, ['START TRANSACTION READ ONLY', 'SELECT first']);
  } finally {
    statement.resolve([[[1]], [{ name: 'value' }]]);
    await first;
    await queued.catch(() => {});
  }

  assert.deepEqual(events, ['START TRANSACTION READ ONLY', 'SELECT first', 'ROLLBACK']);
});

test('MySQL invalidates an active connection abort before a queued request runs', async () => {
  const events: string[] = [];
  const statement = deferred<[unknown, unknown]>();
  const started = deferred<void>();
  let destroyed = false;
  const destroyedError = () => {
    throw new Error('connection destroyed');
  };
  const conn: MysqlConnectionStub = {
    execute: async (input) => {
      const sql = mysqlSql(input);
      if (destroyed) return destroyedError();
      events.push(sql);
      if (sql === 'SELECT first') {
        started.resolve();
        return statement.promise;
      }
      return [{ affectedRows: 1 }, []];
    },
    query: async (sql) => {
      if (destroyed) return destroyedError();
      events.push(sql);
      return [[], []];
    },
    beginTransaction: async () => {
      if (destroyed) return destroyedError();
      events.push('BEGIN');
    },
    commit: async () => {
      if (destroyed) return destroyedError();
      events.push('COMMIT');
    },
    rollback: async () => {
      if (destroyed) return destroyedError();
      events.push('ROLLBACK');
    },
    destroy: () => {
      destroyed = true;
      events.push('DESTROY');
    },
    end: async () => {},
  };
  const driver = new MysqlDriver(spec('mysql'), {
    debug() {},
    info() {},
    warn() {},
  });
  installMysqlConnection(driver, conn);

  const activeAbort = new AbortController();
  const active = driver.read('SELECT first', [], activeAbort.signal);
  await started.promise;
  const queued = driver.write('UPDATE second', [], false, new AbortController().signal);

  activeAbort.abort(new Error('query timeout'));
  statement.resolve([[[1]], [{ name: 'value' }]]);

  const activeError = await active.then(() => undefined, (err: unknown) => err);
  const queuedError = await queued.then(() => undefined, (err: unknown) => err);

  assert.ok(activeError instanceof DbConnectorError);
  assert.equal((activeError as DbConnectorError).code, ErrorCode.Timeout);
  assert.ok(queuedError instanceof DbConnectorError);
  assert.equal((queuedError as DbConnectorError).code, ErrorCode.ConnectionNotFound);
  assert.deepEqual(events, ['START TRANSACTION READ ONLY', 'SELECT first', 'DESTROY']);
});

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

test('SQLite does not retry a request after close starts', async () => {
  const driver = new SqliteDriver(
    {
      name: 'sqlite-test',
      driver: 'sqlite',
      database: ':memory:',
      password: '',
      passwordSource: 'none',
      options: {},
    },
    logger,
  );
  const state = driver as unknown as {
    child: { kill(signal?: NodeJS.Signals): boolean } | null;
  };

  try {
    const request = driver.read('SELECT 1', [], signal());
    const closing = driver.close();
    const requestError = await request.then(() => undefined, (err: unknown) => err);
    await closing;

    assert.ok(requestError instanceof DbConnectorError);
    assert.equal((requestError as DbConnectorError).code, ErrorCode.ConnectionNotFound);
    assert.equal(state.child, null);
  } finally {
    state.child?.kill('SIGKILL');
  }
});

test('SQLite close rejects queued writes without executing them', async () => {
  const database = join(mkdtempSync(join(tmpdir(), 'db-connector-')), 'pending.sqlite');
  const spec = {
    name: 'sqlite-test',
    driver: 'sqlite' as const,
    database,
    password: '',
    passwordSource: 'none' as const,
    options: {},
  };
  const driver = new SqliteDriver(spec, logger);
  let closing: Promise<void> | undefined;
  let reopened: SqliteDriver | undefined;

  try {
    await driver.connect();
    await driver.write(
      'CREATE TABLE entries(value TEXT)',
      [],
      true,
      signal(),
    );

    const active = driver.read(
      `WITH RECURSIVE counter(value) AS (
         VALUES(0)
         UNION ALL
         SELECT value + 1 FROM counter WHERE value < 1000000
       )
       SELECT sum(value) FROM counter`,
      [],
      signal(),
    );
    const queued = driver.write(
      "INSERT INTO entries(value) VALUES ('queued')",
      [],
      false,
      signal(),
    );
    closing = driver.close();

    const [activeError, queuedError] = await Promise.all([
      active.then(() => undefined, (err: unknown) => err),
      queued.then(() => undefined, (err: unknown) => err),
    ]);
    await closing;

    assert.ok(activeError instanceof DbConnectorError);
    assert.equal((activeError as DbConnectorError).code, ErrorCode.ConnectionNotFound);
    assert.ok(queuedError instanceof DbConnectorError);
    assert.equal((queuedError as DbConnectorError).code, ErrorCode.ConnectionNotFound);

    reopened = new SqliteDriver(spec, logger);
    await reopened.connect();
    const result = await reopened.read(
      'SELECT COUNT(*) AS count FROM entries',
      [],
      signal(),
    );
    assert.deepEqual(result.rows, [[0]]);
  } finally {
    await closing?.catch(() => {});
    await driver.close();
    await reopened?.close();
  }
});

test('SQLite cancellation waits for the child to exit before rejecting', async () => {
  const driver = new SqliteDriver(
    {
      name: 'sqlite-test',
      driver: 'sqlite',
      database: ':memory:',
      password: '',
      passwordSource: 'none',
      options: {},
    },
    logger,
  );
  const state = driver as unknown as {
    ensureChild(): {
      send: (...args: unknown[]) => boolean;
      kill: (signal?: NodeJS.Signals) => boolean;
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
    };
    child: {
      kill(signal?: NodeJS.Signals): boolean;
    } | null;
  };
  const child = state.ensureChild();
  const originalSend = child.send.bind(child);
  const originalKill = child.kill.bind(child);
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let killCalled!: () => void;
  const killStarted = new Promise<void>((resolve) => {
    killCalled = resolve;
  });

  // Keep the request pending, then delay the actual SIGKILL so an immediate
  // cancellation rejection is observable without relying on a slow query.
  child.send = () => true;
  child.kill = (signal) => {
    killCalled();
    killTimer = setTimeout(() => {
      killTimer = undefined;
      originalKill(signal);
    }, 50);
    return true;
  };

  const controller = new AbortController();
  try {
    const request = driver.read('SELECT 1', [], controller.signal);
    let settled = false;
    void request.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    controller.abort();
    const nextRequest = driver.read('SELECT 1', [], signal());
    await killStarted;
    await nextTurn();
    assert.equal(settled, false);
    assert.equal(state.child, null);

    const requestError = await request.then(() => undefined, (err: unknown) => err);
    assert.ok(requestError instanceof DbConnectorError);
    assert.equal((requestError as DbConnectorError).code, ErrorCode.Cancelled);
    assert.equal(child.exitCode === null && child.signalCode === null, false);
    await nextRequest;
  } finally {
    if (killTimer !== undefined) clearTimeout(killTimer);
    child.send = originalSend;
    if (child.exitCode === null && child.signalCode === null) originalKill('SIGKILL');
    await driver.close();
  }
});

test('SQLite close waits for a canceled child before reopening', async () => {
  const spec = {
    name: 'sqlite-test',
    driver: 'sqlite' as const,
    database: ':memory:',
    password: '',
    passwordSource: 'none' as const,
    options: {},
  };
  const driver = new SqliteDriver(spec, logger);
  const state = driver as unknown as {
    ensureChild(): {
      send: (...args: unknown[]) => boolean;
      kill: (signal?: NodeJS.Signals) => boolean;
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
    };
  };
  const child = state.ensureChild();
  const originalSend = child.send.bind(child);
  const originalKill = child.kill.bind(child);
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let killCalled!: () => void;
  const killStarted = new Promise<void>((resolve) => {
    killCalled = resolve;
  });
  child.send = () => true;
  child.kill = (signal) => {
    killCalled();
    killTimer = setTimeout(() => {
      killTimer = undefined;
      originalKill(signal);
    }, 50);
    return true;
  };

  const controller = new AbortController();
  let closing: Promise<void> | undefined;
  let reopened: SqliteDriver | undefined;
  try {
    const cancellation = driver.read('SELECT 1', [], controller.signal);
    controller.abort();
    closing = driver.close();
    let closeSettled = false;
    void closing.then(() => {
      closeSettled = true;
    });

    await killStarted;
    await nextTurn();
    assert.equal(closeSettled, false);

    const cancellationError = await cancellation.then(() => undefined, (err: unknown) => err);
    assert.ok(cancellationError instanceof DbConnectorError);
    assert.equal((cancellationError as DbConnectorError).code, ErrorCode.Cancelled);
    await closing;

    reopened = new SqliteDriver(spec, logger);
    await reopened.connect();
  } finally {
    if (killTimer !== undefined) clearTimeout(killTimer);
    child.send = originalSend;
    if (child.exitCode === null && child.signalCode === null) originalKill('SIGKILL');
    if (closing) await closing;
    else await driver.close();
    await reopened?.close();
  }
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
