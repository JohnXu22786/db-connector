/**
 * Regression coverage for driver transaction serialization, result conversion,
 * and SQLite lifecycle behavior, without requiring live database servers.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
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
