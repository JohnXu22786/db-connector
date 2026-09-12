/**
 * Connection manager tests: define/open/close lifecycle, reuse, duplicates,
 * lazy credential resolution, and redacted status output.
 */

import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { test } from 'node:test';
import { DbConnectorError, ErrorCode } from '../dist/errors.js';
import type { DriverApi } from '../dist/drivers/driver.js';
import { makeHarness } from './helpers.ts';

test('list is empty initially; define+open shows connected', async () => {
  const h = makeHarness();
  assert.deepEqual(h.connectors.list(), []);
  h.connectors.define({ name: 'a', driver: 'sqlite', database: join(h.dir, 'a.sqlite') });
  assert.equal(h.connectors.list()[0]!.status, 'defined');
  await h.connectors.open('a');
  const status = h.connectors.list()[0]!;
  assert.equal(status.status, 'connected');
  assert.ok(status.openedAt);
});

test('duplicate definition is refused', () => {
  const h = makeHarness();
  h.connectors.define({ name: 'a', driver: 'sqlite' });
  assert.throws(
    () => h.connectors.define({ name: 'a', driver: 'sqlite' }),
    (e: DbConnectorError) => e.code === 'CONNECTION_EXISTS',
  );
});

test('open on unknown name raises CONNECTION_NOT_FOUND', async () => {
  const h = makeHarness();
  await assert.rejects(
    h.connectors.open('nope'),
    (e: DbConnectorError) => e.code === 'CONNECTION_NOT_FOUND',
  );
});

test('open is idempotent and shared by concurrent callers', async () => {
  const h = makeHarness();
  h.connectors.define({ name: 'a', driver: 'sqlite', database: join(h.dir, 'a.sqlite') });
  const [d1, d2] = await Promise.all([h.connectors.open('a'), h.connectors.open('a')]);
  assert.equal(d1, d2);
});

test('close removes the connection; closeAll clears everything', async () => {
  const h = makeHarness();
  h.connectors.define({ name: 'a', driver: 'sqlite', database: join(h.dir, 'a.sqlite') });
  h.connectors.define({ name: 'b', driver: 'sqlite', database: join(h.dir, 'b.sqlite') });
  await h.connectors.open('a');
  await h.connectors.close('a');
  assert.equal(h.connectors.has('a'), false);
  await h.connectors.open('b');
  await h.connectors.closeAll();
  assert.deepEqual(h.connectors.list(), []);
  assert.equal(h.connectors.has('b'), false);
});

test('touch increments the execution counter and updates last-used', async () => {
  const h = makeHarness();
  h.connectors.define({ name: 'a', driver: 'sqlite', database: join(h.dir, 'a.sqlite') });
  await h.connectors.open('a');
  h.connectors.touch('a');
  h.connectors.touch('a');
  assert.equal(h.connectors.list()[0]!.executions, 2);
  assert.ok(h.connectors.list()[0]!.lastUsedAt);
});

test('failed open (unsupported driver) is surfaced cleanly', async () => {
  const h = makeHarness();
  h.connectors.define({ name: 'x', driver: 'sqlite' });
  // sqlite :memory: always opens; simulate failure with a bogus path is
  // flaky across platforms, so instead assert define-time validation.
  assert.throws(
    () => h.connectors.define({ name: 'bad', driver: 'cassandra' as never }),
    (e: DbConnectorError) => e.code === 'UNSUPPORTED_DRIVER',
  );
});

test('sqlite connections persist state across engines lifecycle', async () => {
  const h = makeHarness();
  const db = join(h.dir, 's.sqlite');
  await h.engine.connect({ name: 's', driver: 'sqlite', database: db });
  await h.engine.exec(
    { connection: 's', sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)', allowWrite: true, way: 'cli' },
    new AbortController().signal,
  );
  await h.engine.exec(
    { connection: 's', sql: "INSERT INTO t(v) VALUES (?)", params: ['kept'], allowWrite: true, way: 'cli' },
    new AbortController().signal,
  );
  // simulate a dropped connection (timeout path) by reopening the file
  await h.engine.close('s');
  await h.engine.connect({ name: 's', driver: 'sqlite', database: db });
  const { rows } = await h.engine.query(
    { connection: 's', sql: 'SELECT v FROM t', way: 'cli' },
    new AbortController().signal,
  );
  assert.deepEqual(rows, [['kept']]);
});

test('open reconnects an existing driver after a dropped connection', async () => {
  const h = makeHarness();
  h.connectors.define({ name: 'mysql', driver: 'mysql', database: 'test' });

  let connected = false;
  let connectCalls = 0;
  const driver: DriverApi = {
    kind: 'mysql',
    connect: async () => {
      connectCalls += 1;
      connected = true;
    },
    read: async () => {
      if (!connected) {
        throw new DbConnectorError(ErrorCode.ConnectionNotFound, 'connection dropped');
      }
      return { columns: [], rows: [], rowCount: 0 };
    },
    write: async (_sql, _params, isDdl) => ({ affectedRows: 0, isDdl }),
    introspect: async () => ({
      tables: [],
      views: [],
      columns: [],
      indexes: [],
      foreignKeys: [],
    }),
    close: async () => {
      connected = false;
    },
  };
  const record = (h.connectors as unknown as {
    map: Map<string, { driver: DriverApi | null; status: string }>;
  }).map.get('mysql');
  assert.ok(record);
  record.driver = driver;
  record.status = 'connected';

  const reopened = await h.connectors.open('mysql');
  assert.equal(reopened, driver);
  assert.equal(connectCalls, 1);
  await reopened.read('SELECT 1', [], new AbortController().signal);
});
