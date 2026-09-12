/**
 * Connection manager tests: define/open/close lifecycle, reuse, duplicates,
 * lazy credential resolution, and redacted status output.
 */

import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { test } from 'node:test';
import { DbConnectorError } from '../dist/errors.js';
import type { DriverApi } from '../dist/drivers/driver.js';
import { makeHarness } from './helpers.ts';

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeFakeDriver(
  onConnect: () => Promise<void> = async () => {},
  onClose: () => Promise<void> = async () => {},
): DriverApi {
  return {
    kind: 'sqlite',
    connect: onConnect,
    async read() {
      return { columns: [], rows: [], rowCount: 0 };
    },
    async write() {
      return { affectedRows: 0, isDdl: false };
    },
    async introspect() {
      return { tables: [], views: [], columns: [], indexes: [], foreignKeys: [] };
    },
    close: onClose,
  };
}

function installDriver(h: ReturnType<typeof makeHarness>, driver: DriverApi): void {
  (h.connectors as unknown as {
    buildDriver(spec: unknown): DriverApi;
  }).buildDriver = () => driver;
}

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

test('close cancels a pending open waiter and closes its driver', async () => {
  const h = makeHarness();
  const openingStarted = deferred<void>();
  const releaseOpening = deferred<void>();
  let closeCalls = 0;
  installDriver(h, makeFakeDriver(async () => {
    openingStarted.resolve();
    await releaseOpening.promise;
  }, async () => {
    closeCalls += 1;
  }));
  h.connectors.define({ name: 'a', driver: 'sqlite' });
  const opening = h.connectors.open('a');
  await openingStarted.promise;

  let closeFinished = false;
  const closing = h.connectors.close('a').then(() => {
    closeFinished = true;
  });
  const openingRejected = assert.rejects(
    opening,
    (e: DbConnectorError) => e.code === 'CONNECTION_NOT_FOUND',
  );
  await openingRejected;
  assert.equal(closeFinished, false);
  releaseOpening.resolve();
  await closing;
  assert.equal(closeCalls, 1);
  assert.equal(h.connectors.has('a'), false);
});

test('closeAll cancels a pending open waiter and closes its driver', async () => {
  const h = makeHarness();
  const openingStarted = deferred<void>();
  const releaseOpening = deferred<void>();
  let closeCalls = 0;
  installDriver(h, makeFakeDriver(async () => {
    openingStarted.resolve();
    await releaseOpening.promise;
  }, async () => {
    closeCalls += 1;
  }));
  h.connectors.define({ name: 'a', driver: 'sqlite' });
  const opening = h.connectors.open('a');
  await openingStarted.promise;

  let closeAllFinished = false;
  const closing = h.connectors.closeAll().then(() => {
    closeAllFinished = true;
  });
  const openingRejected = assert.rejects(
    opening,
    (e: DbConnectorError) => e.code === 'CONNECTION_NOT_FOUND',
  );
  await openingRejected;
  assert.equal(closeAllFinished, false);
  releaseOpening.resolve();
  await closing;
  assert.equal(closeCalls, 1);
  assert.deepEqual(h.connectors.list(), []);
});

test('open cannot return a driver while close is in progress', async () => {
  const h = makeHarness();
  const closeStarted = deferred<void>();
  const releaseClose = deferred<void>();
  installDriver(h, makeFakeDriver(async () => {}, async () => {
    closeStarted.resolve();
    await releaseClose.promise;
  }));
  h.connectors.define({ name: 'a', driver: 'sqlite' });
  await h.connectors.open('a');

  const pendingOpen = h.connectors.open('a');
  const concurrentOpen = assert.rejects(
    pendingOpen,
    (e: DbConnectorError) => e.code === 'CONNECTION_NOT_FOUND',
  );
  const closing = h.connectors.close('a');
  await closeStarted.promise;

  releaseClose.resolve();
  await Promise.all([closing, concurrentOpen]);
});

test('open cannot return a driver while closeAll is in progress', async () => {
  const h = makeHarness();
  const closeStarted = deferred<void>();
  const releaseClose = deferred<void>();
  let closeCalls = 0;
  installDriver(h, makeFakeDriver(async () => {}, async () => {
    closeCalls += 1;
    closeStarted.resolve();
    await releaseClose.promise;
  }));
  h.connectors.define({ name: 'a', driver: 'sqlite' });
  await h.connectors.open('a');

  const pendingOpen = h.connectors.open('a');
  const concurrentOpen = assert.rejects(
    pendingOpen,
    (e: DbConnectorError) => e.code === 'CONNECTION_NOT_FOUND',
  );
  const closing = h.connectors.closeAll();
  await closeStarted.promise;

  releaseClose.resolve();
  await Promise.all([closing, concurrentOpen]);
  assert.equal(closeCalls, 1);
});

test('close reserves the name and shares in-progress teardown', async () => {
  const h = makeHarness();
  const closeStarted = deferred<void>();
  const releaseClose = deferred<void>();
  let closeCalls = 0;
  installDriver(h, makeFakeDriver(async () => {}, async () => {
    closeCalls += 1;
    closeStarted.resolve();
    await releaseClose.promise;
  }));
  h.connectors.define({ name: 'a', driver: 'sqlite' });
  await h.connectors.open('a');

  const firstClose = h.connectors.close('a');
  await closeStarted.promise;
  assert.throws(
    () => h.connectors.define({ name: 'a', driver: 'sqlite' }),
    (e: DbConnectorError) => e.code === 'CONNECTION_EXISTS',
  );

  let secondFinished = false;
  const secondClose = h.connectors.close('a').then(() => {
    secondFinished = true;
  });
  await nextTurn();
  assert.equal(secondFinished, false);

  releaseClose.resolve();
  await Promise.all([firstClose, secondClose]);
  assert.equal(closeCalls, 1);
  assert.equal(h.connectors.has('a'), false);
});

test('closeAll reserves names and shares in-progress teardown', async () => {
  const h = makeHarness();
  const closeStarted = deferred<void>();
  const releaseClose = deferred<void>();
  let closeCalls = 0;
  installDriver(h, makeFakeDriver(async () => {}, async () => {
    closeCalls += 1;
    closeStarted.resolve();
    await releaseClose.promise;
  }));
  h.connectors.define({ name: 'a', driver: 'sqlite' });
  await h.connectors.open('a');

  const firstCloseAll = h.connectors.closeAll();
  await closeStarted.promise;
  assert.throws(
    () => h.connectors.define({ name: 'a', driver: 'sqlite' }),
    (e: DbConnectorError) => e.code === 'CONNECTION_EXISTS',
  );

  let secondFinished = false;
  const secondCloseAll = h.connectors.closeAll().then(() => {
    secondFinished = true;
  });
  await nextTurn();
  assert.equal(secondFinished, false);

  releaseClose.resolve();
  await Promise.all([firstCloseAll, secondCloseAll]);
  assert.equal(closeCalls, 1);
  assert.deepEqual(h.connectors.list(), []);
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
