/**
 * Schema introspection tests on SQLite: tables/views/columns/indexes/FKs,
 * snapshot caching (TTL), refresh, and filter narrowing.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { DriverApi, Introspection } from '../dist/drivers/driver.js';
import { SchemaService } from '../dist/schema.js';
import { freshSignal, makeHarness, seedSqlite } from './helpers.ts';

test('schema snapshot lists tables, columns, indexes, foreign keys', async () => {
  const h = makeHarness();
  await seedSqlite(h);
  const s = await h.engine.schema({ connection: 'sample', way: 'cli' }, freshSignal());

  assert.deepEqual(
    s.tables.map((t) => t.name).sort(),
    ['orders', 'users'],
  );
  assert.equal(s.views.length, 0);

  const userCols = s.columns.filter((c) => c.table === 'users');
  assert.equal(userCols.length, 3);
  const idCol = userCols.find((c) => c.name === 'id')!;
  assert.equal(idCol.primaryKey, true);
  assert.equal(idCol.nullable, false);
  assert.equal(idCol.ordinal, 1);
  const emailCol = userCols.find((c) => c.name === 'email')!;
  assert.equal(emailCol.type.toUpperCase(), 'TEXT');
  assert.equal(emailCol.nullable, false);

  const emailIndex = s.indexes.find((i) => i.table === 'users' && i.columns.includes('email'));
  assert.ok(emailIndex, 'email UNIQUE constraint surfaces as an index');
  assert.equal(emailIndex!.unique, true);

  const fk = s.foreignKeys.find((f) => f.table === 'orders');
  assert.ok(fk);
  assert.deepEqual(fk!.columns, ['user_id']);
  assert.equal(fk!.referencedTable, 'users');
  assert.deepEqual(fk!.referencedColumns, ['id']);
});

test('schema snapshot lists columns for SQLite views', async () => {
  const h = makeHarness();
  await seedSqlite(h);
  await h.engine.exec({
    connection: 'sample',
    sql: 'CREATE VIEW user_directory AS SELECT id, email FROM users',
    allowWrite: true,
    way: 'cli',
  }, freshSignal());

  const s = await h.engine.schema({ connection: 'sample', way: 'cli' }, freshSignal());

  assert.deepEqual(s.views.map((v) => v.name), ['user_directory']);
  assert.deepEqual(
    s.columns
      .filter((c) => c.table === 'user_directory')
      .map((c) => ({ name: c.name, type: c.type, ordinal: c.ordinal })),
    [
      { name: 'id', type: 'INTEGER', ordinal: 1 },
      { name: 'email', type: 'TEXT', ordinal: 2 },
    ],
  );
});

test('schema snapshots are cached within TTL and refreshable', async () => {
  const h = makeHarness({ schema: { ttlMs: 600000 } });
  await seedSqlite(h);

  const first = await h.engine.schema({ connection: 'sample', way: 'cli' }, freshSignal());
  assert.equal(first.fromCache, false);
  const second = await h.engine.schema({ connection: 'sample', way: 'cli' }, freshSignal());
  assert.equal(second.fromCache, true);
  assert.equal(second.capturedAt, first.capturedAt);

  const fresh = await h.engine.schema({ connection: 'sample', refresh: true, way: 'cli' }, freshSignal());
  assert.equal(fresh.fromCache, false);
});

test('schema filter narrows to matching tables and their objects', async () => {
  const h = makeHarness();
  await seedSqlite(h);
  const s = await h.engine.schema({ connection: 'sample', filter: 'user', way: 'cli' }, freshSignal());

  assert.deepEqual(s.tables.map((t) => t.name), ['users']);
  assert.equal(s.columns.every((c) => c.table === 'users'), true);
  assert.equal(s.indexes.every((i) => i.table === 'users'), true);
  assert.equal(s.foreignKeys.length, 0); // orders (owner of the FK) filtered out
});

test('schema result is credential-free JSON', async () => {
  const h = makeHarness();
  await seedSqlite(h);
  const s = await h.engine.schema({ connection: 'sample', way: 'cli' }, freshSignal());
  const text = JSON.stringify(s);
  assert.ok(!text.includes('password'));
});

test('concurrent refreshes keep the newer snapshot in the cache', async () => {
  let calls = 0;
  let releaseOlder!: (raw: Introspection) => void;
  const older = new Promise<Introspection>((resolve) => {
    releaseOlder = resolve;
  });
  const snapshot = (table: string): Introspection => ({
    tables: [{ name: table }],
    views: [],
    columns: [],
    indexes: [],
    foreignKeys: [],
  });
  const driver: DriverApi = {
    kind: 'sqlite',
    connect: async () => {},
    read: async () => ({ columns: [], rows: [], rowCount: 0 }),
    write: async () => ({ affectedRows: 0, isDdl: false }),
    introspect: () => {
      calls += 1;
      return calls === 1 ? older : Promise.resolve(snapshot('newer'));
    },
    close: async () => {},
  };
  const service = new SchemaService(600_000);

  const olderRefresh = service.get(driver, 'sample', {
    refresh: true,
    signal: freshSignal(),
  });
  const newerRefresh = await service.get(driver, 'sample', {
    refresh: true,
    signal: freshSignal(),
  });
  releaseOlder(snapshot('older'));
  await olderRefresh;

  const cached = await service.get(driver, 'sample', {
    signal: freshSignal(),
  });
  assert.equal(newerRefresh.tables[0]?.name, 'newer');
  assert.equal(cached.fromCache, true);
  assert.deepEqual(cached.tables.map((table) => table.name), ['newer']);
});
