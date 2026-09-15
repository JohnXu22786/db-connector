/**
 * Execution engine tests for failures that happen before statement execution.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ErrorCode } from '../dist/errors.js';
import type { DriverApi } from '../dist/drivers/driver.js';
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

test('read-like exec applies the configured row limit before calling the driver', async () => {
  const h = makeHarness({ query: { maxRows: 2 } });
  let received: { sql: string; params: unknown[] } | undefined;
  installDriver(h, emptyDriver({
    read: async (sql, params) => {
      received = { sql, params };
      return { columns: ['id'], rows: [[1], [2], [3]], rowCount: 3 };
    },
  }));
  h.connectors.define({ name: 'limited-read', driver: 'sqlite' });
  const signal = freshSignal();

  const result = await h.engine.exec({
    connection: 'limited-read',
    sql: 'SELECT id FROM items WHERE owner_id = ?',
    params: [7],
    way: 'cli',
  }, signal);

  assert.deepEqual(received, {
    sql: 'SELECT id FROM items WHERE owner_id = ? LIMIT 2',
    params: [7],
  });
  assert.equal(result.kind, 'read');
  assert.match(result.note, /returned 2 row\(s\) \(capped at 2\)/);

  const records = await h.audit.query({ connection: 'limited-read' });
  assert.equal(records.length, 1);
  assert.equal(records[0]!.status, 'ok');
  assert.equal(records[0]!.rows, 2);
  assert.equal(records[0]!.statement.summary, 'SELECT id FROM items WHERE owner_id = ?');
});

test('read-like exec tightens an oversized existing top-level row limit', async () => {
  const h = makeHarness({ query: { maxRows: 2 } });
  let receivedSql: string | undefined;
  installDriver(h, emptyDriver({
    read: async (sql) => {
      receivedSql = sql;
      return { columns: ['id'], rows: [[1], [2], [3]], rowCount: 3 };
    },
  }));
  h.connectors.define({ name: 'prelimited-read', driver: 'sqlite' });

  const result = await h.engine.exec({
    connection: 'prelimited-read',
    sql: 'SELECT id FROM items LIMIT 5',
    way: 'cli',
  }, freshSignal());

  assert.equal(receivedSql, 'SELECT id FROM items LIMIT 2');
  assert.match(result.note, /returned 2 row\(s\) \(capped at 2\)/);
  const records = await h.audit.query({ connection: 'prelimited-read' });
  assert.equal(records[0]!.rows, 2);
});

test('read-like exec preserves a zero row cap in the driver guard', async () => {
  const h = makeHarness({ query: { maxRows: 0 } });
  let receivedSql: string | undefined;
  installDriver(h, emptyDriver({
    read: async (sql) => {
      receivedSql = sql;
      return { columns: ['id'], rows: [[1]], rowCount: 1 };
    },
  }));
  h.connectors.define({ name: 'zero-read', driver: 'sqlite' });

  const result = await h.engine.exec({
    connection: 'zero-read',
    sql: 'SELECT id FROM items',
    way: 'cli',
  }, freshSignal());

  assert.equal(receivedSql, 'SELECT id FROM items LIMIT 0');
  assert.match(result.note, /returned 0 row\(s\) \(capped at 0\)/);
  const records = await h.audit.query({ connection: 'zero-read' });
  assert.equal(records[0]!.rows, 0);
});

test('read-like exec passes its cap to administrative reads before materialization', async () => {
  const h = makeHarness({ query: { maxRows: 2 } });
  const received: Array<{ sql: string; maxRows: number | undefined }> = [];
  installDriver(h, emptyDriver({
    read: async (sql, _params, _signal, maxRows) => {
      received.push({ sql, maxRows });
      return {
        columns: ['id'],
        rows: Array.from({ length: 100 }, (_, id) => [id]),
        rowCount: 100,
      };
    },
  }));
  h.connectors.define({ name: 'administrative-read', driver: 'sqlite' });

  for (const sql of ['EXPLAIN QUERY PLAN SELECT 1', 'SHOW TABLES', 'DESCRIBE users']) {
    const result = await h.engine.exec(
      { connection: 'administrative-read', sql, way: 'cli' },
      freshSignal(),
    );
    assert.match(result.note, /returned 2 row\(s\) \(capped at 2\)/, sql);
  }

  assert.deepEqual(received, [
    { sql: 'EXPLAIN QUERY PLAN SELECT 1', maxRows: 2 },
    { sql: 'SHOW TABLES', maxRows: 2 },
    { sql: 'DESCRIBE users', maxRows: 2 },
  ]);
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
