/** Regression coverage for transaction serialization on server drivers. */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { MysqlDriver } from '../dist/drivers/mysql.js';
import { PgDriver } from '../dist/drivers/postgres.js';
import { DbConnectorError, ErrorCode } from '../dist/errors.js';
import type { ResolvedConnectionSpec } from '../dist/types.js';

type PgResult = {
  fields: Array<{ name: string }>;
  rows: Array<Record<string, unknown>>;
  rowCount: number;
};

type PgClientStub = {
  query(input: string | { text: string }): Promise<PgResult>;
  connect(): Promise<void>;
  end(): Promise<void>;
};

type MysqlConnectionStub = {
  execute(sql: string, values?: unknown[]): Promise<[unknown, unknown]>;
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

test('PostgreSQL serializes concurrent transaction sequences', async () => {
  const events: string[] = [];
  const client: PgClientStub = {
    connect: async () => {},
    end: async () => {},
    query: async (input) => {
      events.push(typeof input === 'string' ? input : input.text);
      return { fields: [{ name: 'value' }], rows: [{ value: 1 }], rowCount: 1 };
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
    execute: async (sql) => {
      events.push(sql);
      return sql === 'SELECT 1' ? [[{ value: 1 }], []] : [{ affectedRows: 1 }, []];
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
      return { fields: [{ name: 'value' }], rows: [{ value: 1 }], rowCount: 1 };
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
    statement.resolve({ fields: [{ name: 'value' }], rows: [{ value: 1 }], rowCount: 1 });
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
    execute: async (sql) => {
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
    statement.resolve([[{ value: 1 }], []]);
    await first;
    await queued.catch(() => {});
  }

  assert.deepEqual(events, ['START TRANSACTION READ ONLY', 'SELECT first', 'ROLLBACK']);
});
