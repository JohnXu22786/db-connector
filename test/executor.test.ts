/**
 * Execution engine tests for failures that happen before statement execution.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { DbConnectorError, ErrorCode } from '../dist/errors.js';
import type { DriverApi } from '../dist/drivers/driver.js';
import { summarizeSql } from '../dist/sql.js';
import { freshSignal, makeHarness, type Harness } from './helpers.ts';

function installDriver(h: Harness, driver: DriverApi): void {
  (h.connectors as unknown as {
    buildDriver(spec: unknown): DriverApi;
  }).buildDriver = () => driver;
}

function emptyDriver(overrides: Partial<DriverApi> = {}): DriverApi {
  return {
    kind: 'sqlite',
    connect: async () => {},
    read: async () => ({ columns: [], rows: [], rowCount: 0 }),
    write: async () => ({ affectedRows: 0, isDdl: false }),
    introspect: async () => ({
      tables: [],
      views: [],
      columns: [],
      indexes: [],
      foreignKeys: [],
    }),
    close: async () => {},
    ...overrides,
  };
}

function connectAbortError(signal: AbortSignal): DbConnectorError {
  const isTimeout = signal.reason instanceof Error && /timeout/i.test(signal.reason.message);
  return new DbConnectorError(
    isTimeout ? ErrorCode.Timeout : ErrorCode.Cancelled,
    isTimeout ? 'connection exceeded its time limit' : 'connection was cancelled',
  );
}

function waitForConnectAbort(signal: AbortSignal | undefined): Promise<never> {
  if (!signal) return Promise.reject(new Error('connect signal missing'));
  if (signal.aborted) return Promise.reject(connectAbortError(signal));
  return new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(connectAbortError(signal)), { once: true });
  });
}

test('lazy query applies its timeout while opening the connection', async () => {
  const h = makeHarness();
  const keepAlive = setTimeout(() => {}, 1000);
  let receivedSignal: AbortSignal | undefined;
  installDriver(h, emptyDriver({
    connect: async (signal) => {
      receivedSignal = signal;
      await waitForConnectAbort(signal);
    },
  }));
  h.connectors.define({ name: 'slow-query-open', driver: 'sqlite' });

  try {
    await assert.rejects(
      h.engine.query(
        { connection: 'slow-query-open', sql: 'SELECT 1', timeoutMs: 20, way: 'cli' },
        freshSignal(),
      ),
      (error: unknown) => error instanceof DbConnectorError && error.code === ErrorCode.Timeout,
    );
    assert.ok(receivedSignal);
    assert.equal(receivedSignal.aborted, true);
  } finally {
    clearTimeout(keepAlive);
  }
});

test('lazy exec applies caller cancellation while opening the connection', async () => {
  const h = makeHarness();
  const keepAlive = setTimeout(() => {}, 1000);
  let receivedSignal: AbortSignal | undefined;
  let resolveConnectStarted!: () => void;
  const connectStarted = new Promise<void>((resolve) => {
    resolveConnectStarted = resolve;
  });
  installDriver(h, emptyDriver({
    connect: async (signal) => {
      receivedSignal = signal;
      resolveConnectStarted();
      await waitForConnectAbort(signal);
    },
  }));
  h.connectors.define({ name: 'cancelled-exec-open', driver: 'sqlite' });
  const controller = new AbortController();
  const execution = h.engine.exec(
    {
      connection: 'cancelled-exec-open',
      sql: 'UPDATE items SET value = 1',
      allowWrite: true,
      way: 'cli',
    },
    controller.signal,
  );

  try {
    await connectStarted;
    controller.abort();
    await assert.rejects(
      execution,
      (error: unknown) => error instanceof DbConnectorError && error.code === ErrorCode.Cancelled,
    );
    assert.ok(receivedSignal);
    assert.equal(receivedSignal.aborted, true);
  } finally {
    clearTimeout(keepAlive);
  }
});

test('lazy schema applies its timeout while opening the connection', async () => {
  const h = makeHarness();
  const keepAlive = setTimeout(() => {}, 1000);
  let receivedSignal: AbortSignal | undefined;
  installDriver(h, emptyDriver({
    connect: async (signal) => {
      receivedSignal = signal;
      await waitForConnectAbort(signal);
    },
  }));
  h.connectors.define({ name: 'slow-schema-open', driver: 'sqlite' });

  try {
    await assert.rejects(
      h.engine.schema(
        { connection: 'slow-schema-open', timeoutMs: 20, way: 'cli' },
        freshSignal(),
      ),
      (error: unknown) => error instanceof DbConnectorError && error.code === ErrorCode.Timeout,
    );
    assert.ok(receivedSignal);
    assert.equal(receivedSignal.aborted, true);
  } finally {
    clearTimeout(keepAlive);
  }
});

test('db_query passes its cap to the driver and preserves bounded truncation', async () => {
  const h = makeHarness({ query: { maxRows: 2 } });
  let receivedMaxRows: number | undefined;
  installDriver(h, emptyDriver({
    read: async (_sql, _params, _signal, maxRows) => {
      receivedMaxRows = maxRows;
      return {
        columns: ['id'],
        rows: [[1], [2]],
        rowCount: 2,
        truncated: true,
      };
    },
  }));
  h.connectors.define({ name: 'bounded-query', driver: 'sqlite' });

  const result = await h.engine.query(
    {
      connection: 'bounded-query',
      sql: 'SELECT id FROM items LIMIT 100',
      limit: 2,
      way: 'cli',
    },
    freshSignal(),
  );

  assert.equal(receivedMaxRows, 2);
  assert.deepEqual(result.rows, [[1], [2]]);
  assert.equal(result.truncated, true);
});

test('executor preserves PostgreSQL JSONB operators in audit summaries', async () => {
  const h = makeHarness();
  installDriver(h, emptyDriver({ kind: 'postgres' }));
  h.connectors.define({ name: 'pg', driver: 'postgres', database: 'test' });

  const sql = "SELECT doc #> '{a}' FROM t";
  await h.engine.query({ connection: 'pg', sql, limit: 10, way: 'cli' }, freshSignal());

  const records = await h.audit.query({ connection: 'pg' });
  assert.equal(records.length, 1);
  assert.deepEqual(
    records[0]!.statement,
    summarizeSql(`${sql} LIMIT 10`, 512, 'postgres'),
  );
  assert.equal(records[0]!.statement.summary, "SELECT doc #> 'x' FROM t LIMIT 10");
});

test('read-like db_exec guards driver materialization with the configured row cap', async () => {
  const h = makeHarness({ query: { maxRows: 2 } });
  let executedSql = '';
  installDriver(h, emptyDriver({
    read: async (sql) => {
      executedSql = sql;
      return { columns: ['id'], rows: [[1], [2], [3]], rowCount: 3 };
    },
  }));
  h.connectors.define({ name: 'bounded-exec', driver: 'sqlite', database: 'test' });

  const result = await h.engine.exec(
    { connection: 'bounded-exec', sql: 'SELECT id FROM items ORDER BY id', way: 'cli' },
    freshSignal(),
  );

  assert.equal(result.kind, 'read');
  assert.equal(executedSql, 'SELECT id FROM items ORDER BY id LIMIT 2');
  const records = await h.audit.query({ connection: 'bounded-exec' });
  assert.equal(records[0]!.rows, 2);
  assert.match(result.note, /returned 2 row\(s\) \(capped at 2\)/);
});

test('read-like db_exec passes its cap to the driver when SQL already has a limit', async () => {
  const h = makeHarness({ query: { maxRows: 2 } });
  const calls: Array<{ sql: string; maxRows: number | undefined }> = [];
  installDriver(h, emptyDriver({
    read: async (sql, _params, _signal, maxRows) => {
      calls.push({ sql, maxRows });
      return { columns: ['id'], rows: [[1], [2], [3]], rowCount: 3 };
    },
  }));

  for (const [index, sql] of [
    'SELECT id FROM items LIMIT 1000000',
    'EXPLAIN SELECT id FROM items',
  ].entries()) {
    const connection = `bounded-existing-limit-${index}`;
    h.connectors.define({ name: connection, driver: 'sqlite' });
    const result = await h.engine.exec({ connection, sql, way: 'cli' }, freshSignal());
    assert.equal(result.kind, 'read');
    assert.match(result.note, /returned 2 row\(s\) \(capped at 2\)/);
  }

  assert.deepEqual(calls, [
    { sql: 'SELECT id FROM items LIMIT 1000000', maxRows: 2 },
    { sql: 'EXPLAIN SELECT id FROM items', maxRows: 2 },
  ]);
});

test('invalid query validation is audited', async () => {
  const h = makeHarness();

  await assert.rejects(
    h.engine.query({
      connection: 'validation-query',
      sql: 'SELECT 1; SELECT 2',
      way: 'cli',
    }, freshSignal()),
    (err: unknown) => {
      assert.equal((err as { code?: string }).code, ErrorCode.MultiStatements);
      return true;
    },
  );

  const records = await h.audit.query({ connection: 'validation-query' });
  assert.equal(records.length, 1);
  assert.equal(records[0]!.kind, 'query');
  assert.equal(records[0]!.status, 'error');
  assert.equal(records[0]!.error?.code, ErrorCode.MultiStatements);
});

test('invalid exec validation is audited', async () => {
  const h = makeHarness();

  await assert.rejects(
    h.engine.exec({
      connection: 'validation-exec',
      sql: 'UPDATE items SET value = 1; DELETE FROM items',
      allowWrite: true,
      way: 'cli',
    }, freshSignal()),
    (err: unknown) => {
      assert.equal((err as { code?: string }).code, ErrorCode.MultiStatements);
      return true;
    },
  );

  const records = await h.audit.query({ connection: 'validation-exec' });
  assert.equal(records.length, 1);
  assert.equal(records[0]!.kind, 'write');
  assert.equal(records[0]!.status, 'error');
  assert.equal(records[0]!.error?.code, ErrorCode.MultiStatements);
});

test('failed lazy connection open is audited', async () => {
  const h = makeHarness();
  installDriver(h, emptyDriver({
    connect: async () => {
      throw new Error('open failed');
    },
  }));
  h.connectors.define({ name: 'broken', driver: 'sqlite' });

  await assert.rejects(
    h.engine.query({ connection: 'broken', sql: 'SELECT 1', way: 'cli' }, freshSignal()),
    /open failed/,
  );

  const records = await h.audit.query({ connection: 'broken' });
  assert.equal(records.length, 1);
  assert.equal(records[0]!.kind, 'query');
  assert.equal(records[0]!.status, 'error');
  assert.equal(records[0]!.error?.code, ErrorCode.QueryFailed);
  assert.equal(records[0]!.error?.message, 'open failed');
});

test('failed lazy connection open during a write is audited', async () => {
  const h = makeHarness();
  installDriver(h, emptyDriver({
    connect: async () => {
      throw new Error('write open failed');
    },
  }));
  h.connectors.define({ name: 'broken-write', driver: 'sqlite' });

  await assert.rejects(
    h.engine.exec({
      connection: 'broken-write',
      sql: 'UPDATE items SET value = 1',
      allowWrite: true,
      way: 'cli',
    }, freshSignal()),
    /write open failed/,
  );

  const records = await h.audit.query({ connection: 'broken-write' });
  assert.equal(records.length, 1);
  assert.equal(records[0]!.kind, 'write');
  assert.equal(records[0]!.status, 'error');
  assert.equal(records[0]!.error?.code, ErrorCode.QueryFailed);
  assert.equal(records[0]!.error?.message, 'write open failed');
});

test('failed lazy connection open during DDL is audited as ddl', async () => {
  const h = makeHarness();
  installDriver(h, emptyDriver({
    connect: async () => {
      throw new Error('ddl open failed');
    },
  }));
  h.connectors.define({ name: 'broken-ddl', driver: 'sqlite' });

  await assert.rejects(
    h.engine.exec({
      connection: 'broken-ddl',
      sql: 'CREATE TABLE items (id INTEGER)',
      allowWrite: true,
      way: 'cli',
    }, freshSignal()),
    /ddl open failed/,
  );

  const records = await h.audit.query({ connection: 'broken-ddl' });
  assert.equal(records.length, 1);
  assert.equal(records[0]!.kind, 'ddl');
  assert.equal(records[0]!.status, 'error');
  assert.equal(records[0]!.error?.code, ErrorCode.QueryFailed);
  assert.equal(records[0]!.error?.message, 'ddl open failed');
});

test('failed lazy connection open during a read-like exec is audited as read', async () => {
  const h = makeHarness();
  installDriver(h, emptyDriver({
    connect: async () => {
      throw new Error('read open failed');
    },
  }));
  h.connectors.define({ name: 'broken-read', driver: 'sqlite' });

  await assert.rejects(
    h.engine.exec({
      connection: 'broken-read',
      sql: 'SELECT 1',
      way: 'cli',
    }, freshSignal()),
    /read open failed/,
  );

  const records = await h.audit.query({ connection: 'broken-read' });
  assert.equal(records.length, 1);
  assert.equal(records[0]!.kind, 'read');
  assert.equal(records[0]!.status, 'error');
  assert.equal(records[0]!.error?.code, ErrorCode.QueryFailed);
  assert.equal(records[0]!.error?.message, 'read open failed');
});

test('failed SELECT and EXPLAIN through exec are reported and audited as reads', async () => {
  const h = makeHarness();
  installDriver(h, emptyDriver({
    read: async () => {
      throw new Error('driver read failed');
    },
    write: async () => {
      throw new Error('write should not be called');
    },
  }));

  for (const [index, sql] of ['SELECT 1', 'EXPLAIN SELECT 1'].entries()) {
    const connection = `broken-read-${index}`;
    h.connectors.define({ name: connection, driver: 'sqlite' });

    await assert.rejects(
      h.engine.exec({ connection, sql, way: 'cli' }, freshSignal()),
      (err: unknown) => {
        assert.equal((err as Error).message, 'driver read failed');
        assert.doesNotMatch((err as Error).message, /write|transaction|rolled back/i);
        return true;
      },
    );

    const records = await h.audit.query({ connection });
    assert.equal(records.length, 1);
    assert.equal(records[0]!.kind, 'read');
    assert.equal(records[0]!.status, 'error');
    assert.equal(records[0]!.error?.code, ErrorCode.QueryFailed);
    assert.equal(records[0]!.error?.message, 'driver read failed');
  }
});

test('failed schema introspection is audited', async () => {
  const h = makeHarness();
  installDriver(h, emptyDriver({
    introspect: async () => {
      throw new Error('schema failed');
    },
  }));
  h.connectors.define({ name: 'broken-schema', driver: 'sqlite' });

  await assert.rejects(
    h.engine.schema({ connection: 'broken-schema', way: 'cli' }, freshSignal()),
    /schema failed/,
  );

  const records = await h.audit.query({ connection: 'broken-schema' });
  assert.equal(records.length, 1);
  assert.equal(records[0]!.kind, 'schema');
  assert.equal(records[0]!.status, 'error');
  assert.equal(records[0]!.error?.code, ErrorCode.QueryFailed);
  assert.equal(records[0]!.error?.message, 'schema failed');
});

test('invalid schema timeout validation is audited for every rejected value', async () => {
  const h = makeHarness();
  installDriver(h, emptyDriver());

  for (const [index, timeoutMs] of [0, -1, Number.NaN, Number.POSITIVE_INFINITY].entries()) {
    const connection = `invalid-schema-timeout-${index}`;
    h.connectors.define({ name: connection, driver: 'sqlite' });

    await assert.rejects(
      h.engine.schema({ connection, timeoutMs, way: 'cli' }, freshSignal()),
      (err: unknown) => {
        assert.equal((err as { code?: string }).code, ErrorCode.InvalidArgs);
        return true;
      },
    );

    const records = await h.audit.query({ connection });
    assert.equal(records.length, 1);
    assert.equal(records[0]!.kind, 'schema');
    assert.equal(records[0]!.status, 'error');
    assert.equal(records[0]!.error?.code, ErrorCode.InvalidArgs);
    assert.equal(records[0]!.error?.message, '"timeoutMs" must be a positive number');
  }
});

test('valid schema timeout still completes normally', async () => {
  const h = makeHarness();
  let introspections = 0;
  installDriver(h, emptyDriver({
    introspect: async () => {
      introspections += 1;
      return {
        tables: [],
        views: [],
        columns: [],
        indexes: [],
        foreignKeys: [],
      };
    },
  }));
  h.connectors.define({ name: 'valid-schema-timeout', driver: 'sqlite' });

  const result = await h.engine.schema(
    { connection: 'valid-schema-timeout', timeoutMs: 1000, way: 'cli' },
    freshSignal(),
  );

  assert.equal(introspections, 1);
  assert.deepEqual(result.tables, []);
  const records = await h.audit.query({ connection: 'valid-schema-timeout' });
  assert.equal(records.length, 1);
  assert.equal(records[0]!.kind, 'schema');
  assert.equal(records[0]!.status, 'ok');
});

test('executor binds markers using the MySQL escaped-string dialect', async () => {
  const h = makeHarness();
  let received: { sql: string; params: unknown[] } | undefined;
  installDriver(h, emptyDriver({
    kind: 'mysql',
    read: async (sql, params) => {
      received = { sql, params };
      return { columns: [], rows: [], rowCount: 0 };
    },
  }));
  h.connectors.define({ name: 'mysql-escaped', driver: 'mysql', database: 'test' });

  await h.engine.query({
    connection: 'mysql-escaped',
    sql: "SELECT 'it\\'s ? :ignored', ? LIMIT 1",
    params: [42],
    way: 'cli',
  }, freshSignal());

  assert.deepEqual(received, {
    sql: "SELECT 'it\\'s ? :ignored', ? LIMIT 1",
    params: [42],
  });
});

test("executor binds markers using PostgreSQL E'...' strings", async () => {
  const h = makeHarness();
  let received: { sql: string; params: unknown[] } | undefined;
  installDriver(h, emptyDriver({
    kind: 'postgres',
    read: async (sql, params) => {
      received = { sql, params };
      return { columns: [], rows: [], rowCount: 0 };
    },
  }));
  h.connectors.define({ name: 'postgres-escaped', driver: 'postgres', database: 'test' });

  await h.engine.query({
    connection: 'postgres-escaped',
    sql: "SELECT E'it\\'s ? :ignored', :value LIMIT 1",
    namedParams: { value: 42 },
    way: 'cli',
  }, freshSignal());

  assert.deepEqual(received, {
    sql: "SELECT E'it\\'s ? :ignored', ? LIMIT 1",
    params: [42],
  });
});

test('server VALUES guards preserve exact-limit truncation', async () => {
  const h = makeHarness();
  let received: string | undefined;
  installDriver(h, emptyDriver({
    kind: 'postgres',
    read: async (sql) => {
      received = sql;
      return { columns: ['value'], rows: [[1]], rowCount: 1 };
    },
  }));
  h.connectors.define({ name: 'postgres-values', driver: 'postgres', database: 'test' });

  const result = await h.engine.query({
    connection: 'postgres-values',
    sql: 'VALUES (1)',
    limit: 1,
    way: 'cli',
  }, freshSignal());

  assert.equal(received, 'VALUES (1) LIMIT 1');
  assert.equal(result.truncated, true);
  assert.deepEqual(result.rows, [[1]]);
});
