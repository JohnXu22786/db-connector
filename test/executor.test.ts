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

test('read-like exec applies the row limit before calling the driver', async () => {
  const h = makeHarness({ query: { maxRows: 2 } });
  let receivedSql: string | undefined;
  installDriver(h, emptyDriver({
    read: async (sql) => {
      receivedSql = sql;
      return { columns: ['id'], rows: [[1], [2], [3]], rowCount: 3 };
    },
  }));
  h.connectors.define({ name: 'limited-read', driver: 'sqlite' });

  const result = await h.engine.exec({
    connection: 'limited-read',
    sql: 'SELECT id FROM items',
    way: 'cli',
  }, freshSignal());

  assert.equal(receivedSql, 'SELECT id FROM items LIMIT 2');
  assert.match(result.note, /returned 2 row\(s\) \(capped at 2\)/);
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
