/**
 * Schema introspection tests on SQLite: tables/views/columns/indexes/FKs,
 * snapshot caching (TTL), refresh, and filter narrowing.
 */

import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DriverApi, Introspection } from '../dist/drivers/driver.js';
import { SchemaService } from '../dist/schema.js';
import { freshSignal, makeHarness, seedSqlite } from './helpers.ts';

async function assertInvalidationRevokesRefresh(
  revoke: (service: SchemaService) => void,
): Promise<void> {
  let calls = 0;
  let releaseStale!: (raw: Introspection) => void;
  const stale = new Promise<Introspection>((resolve) => {
    releaseStale = resolve;
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
      if (calls === 1) return Promise.resolve(snapshot('before'));
      if (calls === 2) return stale;
      return Promise.resolve(snapshot('fresh'));
    },
    close: async () => {},
  };
  const service = new SchemaService(600_000);

  await service.get(driver, 'sample', { signal: freshSignal() });
  const preInvalidation = service.get(driver, 'sample', {
    refresh: true,
    signal: freshSignal(),
  });
  revoke(service);
  releaseStale(snapshot('stale'));
  await preInvalidation;

  const after = await service.get(driver, 'sample', {
    signal: freshSignal(),
  });
  assert.equal(calls, 3);
  assert.equal(after.fromCache, false);
  assert.deepEqual(after.tables.map((table) => table.name), ['fresh']);
}

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

test('schema snapshot resolves shorthand SQLite foreign-key references', async () => {
  const h = makeHarness();
  await h.engine.connect({
    name: 'sample',
    driver: 'sqlite',
    database: join(h.dir, 'sample.sqlite'),
  });
  await h.engine.exec({
    connection: 'sample',
    sql: 'CREATE TABLE parent (id INTEGER PRIMARY KEY)',
    allowWrite: true,
    way: 'cli',
  }, freshSignal());
  await h.engine.exec({
    connection: 'sample',
    sql: 'CREATE TABLE child (parent_id INTEGER REFERENCES parent)',
    allowWrite: true,
    way: 'cli',
  }, freshSignal());

  const s = await h.engine.schema({ connection: 'sample', way: 'cli' }, freshSignal());
  const fk = s.foreignKeys.find((foreignKey) => foreignKey.table === 'child');

  assert.ok(fk);
  assert.deepEqual(fk!.columns, ['parent_id']);
  assert.equal(fk!.referencedTable, 'parent');
  assert.deepEqual(fk!.referencedColumns, ['id']);
});

test('schema snapshot preserves SQLite nullability for non-INTEGER primary keys', async () => {
  const h = makeHarness();
  await h.engine.connect({ name: 'sample', driver: 'sqlite', database: join(h.dir, 'sample.sqlite') });
  await h.engine.exec({
    connection: 'sample',
    sql: 'CREATE TABLE records (key TEXT PRIMARY KEY, value TEXT)',
    allowWrite: true,
    way: 'cli',
  }, freshSignal());

  const s = await h.engine.schema({ connection: 'sample', way: 'cli' }, freshSignal());
  const key = s.columns.find((column) => column.table === 'records' && column.name === 'key')!;

  assert.equal(key.primaryKey, true);
  assert.equal(key.nullable, true);
});

test('schema snapshot preserves SQLite nullability for composite INTEGER primary keys', async () => {
  const h = makeHarness();
  await h.engine.connect({ name: 'sample', driver: 'sqlite', database: join(h.dir, 'sample.sqlite') });
  await h.engine.exec({
    connection: 'sample',
    sql: 'CREATE TABLE records (key INTEGER, scope INTEGER, PRIMARY KEY (key, scope))',
    allowWrite: true,
    way: 'cli',
  }, freshSignal());

  const s = await h.engine.schema({ connection: 'sample', way: 'cli' }, freshSignal());
  const keys = s.columns.filter((column) => column.table === 'records' && column.primaryKey);

  assert.deepEqual(keys.map((column) => column.name), ['key', 'scope']);
  assert.equal(keys.every((column) => column.nullable), true);
});

test('schema snapshot does not infer SQLite AUTOINCREMENT from unrelated SQL text', async () => {
  const h = makeHarness();
  await h.engine.connect({ name: 'sample', driver: 'sqlite', database: join(h.dir, 'sample.sqlite') });
  await h.engine.exec({
    connection: 'sample',
    sql: `CREATE TABLE records (
      key TEXT,
      scope TEXT,
      note TEXT DEFAULT 'AUTOINCREMENT' CHECK (note <> 'AUTOINCREMENT'),
      -- AUTOINCREMENT
      PRIMARY KEY (key, scope)
    )`,
    allowWrite: true,
    way: 'cli',
  }, freshSignal());

  const s = await h.engine.schema({ connection: 'sample', way: 'cli' }, freshSignal());
  const keys = s.columns.filter((column) => column.table === 'records' && column.primaryKey);

  assert.deepEqual(keys.map((column) => column.name), ['key', 'scope']);
  assert.equal(keys.every((column) => column.extra === undefined), true);
});

test('schema snapshot preserves SQLite AUTOINCREMENT metadata for its declaring primary key', async () => {
  const h = makeHarness();
  await h.engine.connect({ name: 'sample', driver: 'sqlite', database: join(h.dir, 'sample.sqlite') });
  await h.engine.exec({
    connection: 'sample',
    sql: 'CREATE TABLE records (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT)',
    allowWrite: true,
    way: 'cli',
  }, freshSignal());

  const s = await h.engine.schema({ connection: 'sample', way: 'cli' }, freshSignal());
  const id = s.columns.find((column) => column.table === 'records' && column.name === 'id')!;

  assert.equal(id.extra, 'AUTOINCREMENT');
});

test('schema snapshot preserves SQLite nullability for INTEGER PRIMARY KEY DESC', async () => {
  const h = makeHarness();
  await h.engine.connect({ name: 'sample', driver: 'sqlite', database: join(h.dir, 'sample.sqlite') });
  await h.engine.exec({
    connection: 'sample',
    sql: 'CREATE TABLE records (key INTEGER PRIMARY KEY DESC, value TEXT)',
    allowWrite: true,
    way: 'cli',
  }, freshSignal());

  const s = await h.engine.schema({ connection: 'sample', way: 'cli' }, freshSignal());
  const key = s.columns.find((column) => column.table === 'records' && column.name === 'key')!;

  assert.equal(key.primaryKey, true);
  assert.equal(key.nullable, true);
});

test('schema snapshot includes SQLite generated columns', async () => {
  const h = makeHarness();
  await h.engine.connect({ name: 'sample', driver: 'sqlite', database: join(h.dir, 'sample.sqlite') });
  await h.engine.exec({
    connection: 'sample',
    sql: 'CREATE TABLE measurements (raw INTEGER, doubled INTEGER GENERATED ALWAYS AS (raw * 2) STORED)',
    allowWrite: true,
    way: 'cli',
  }, freshSignal());

  const s = await h.engine.schema({ connection: 'sample', way: 'cli' }, freshSignal());

  assert.deepEqual(
    s.columns
      .filter((column) => column.table === 'measurements')
      .map((column) => ({ name: column.name, type: column.type, ordinal: column.ordinal })),
    [
      { name: 'raw', type: 'INTEGER', ordinal: 1 },
      { name: 'doubled', type: 'INTEGER', ordinal: 2 },
    ],
  );
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

test('schema snapshot includes SQLite temporary tables and views', async () => {
  const h = makeHarness();
  await h.engine.connect({
    name: 'sample',
    driver: 'sqlite',
    database: join(h.dir, 'sample.sqlite'),
  });
  await h.engine.exec({
    connection: 'sample',
    sql: 'CREATE TEMP TABLE temp_records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)',
    allowWrite: true,
    way: 'cli',
  }, freshSignal());
  await h.engine.exec({
    connection: 'sample',
    sql: 'CREATE TEMP VIEW temp_directory AS SELECT id, value FROM temp_records',
    allowWrite: true,
    way: 'cli',
  }, freshSignal());

  const s = await h.engine.schema({ connection: 'sample', way: 'cli' }, freshSignal());

  assert.deepEqual(s.tables.map((table) => table.name), ['temp_records']);
  assert.deepEqual(s.views.map((view) => view.name), ['temp_directory']);
  assert.deepEqual(
    s.columns
      .filter((column) => column.table === 'temp_directory')
      .map((column) => ({ name: column.name, type: column.type, ordinal: column.ordinal })),
    [
      { name: 'id', type: 'INTEGER', ordinal: 1 },
      { name: 'value', type: 'TEXT', ordinal: 2 },
    ],
  );
});

test('schema snapshot gives SQLite temporary objects precedence over case-insensitive shadows', async () => {
  const h = makeHarness();
  await h.engine.connect({
    name: 'sample',
    driver: 'sqlite',
    database: join(h.dir, 'sample.sqlite'),
  });
  await h.engine.exec({
    connection: 'sample',
    sql: 'CREATE TABLE shadow_table (persistent_id INTEGER PRIMARY KEY, persistent_value TEXT)',
    allowWrite: true,
    way: 'cli',
  }, freshSignal());
  await h.engine.exec({
    connection: 'sample',
    sql: "CREATE VIEW shadow_view AS SELECT 1 AS persistent_id, 'persistent' AS persistent_value",
    allowWrite: true,
    way: 'cli',
  }, freshSignal());
  await h.engine.exec({
    connection: 'sample',
    sql: 'CREATE TEMP TABLE SHADOW_VIEW (temp_id TEXT, temp_value REAL)',
    allowWrite: true,
    way: 'cli',
  }, freshSignal());
  await h.engine.exec({
    connection: 'sample',
    sql: 'CREATE TEMP VIEW SHADOW_TABLE AS SELECT temp_id, temp_value FROM SHADOW_VIEW',
    allowWrite: true,
    way: 'cli',
  }, freshSignal());

  const s = await h.engine.schema({ connection: 'sample', way: 'cli' }, freshSignal());

  assert.deepEqual(s.tables.map((table) => table.name), ['SHADOW_VIEW']);
  assert.deepEqual(s.views.map((view) => view.name), ['SHADOW_TABLE']);
  assert.deepEqual(
    s.columns
      .filter((column) => column.table === 'SHADOW_VIEW')
      .map((column) => ({ name: column.name, type: column.type })),
    [
      { name: 'temp_id', type: 'TEXT' },
      { name: 'temp_value', type: 'REAL' },
    ],
  );
  assert.deepEqual(
    s.columns
      .filter((column) => column.table === 'SHADOW_TABLE')
      .map((column) => ({ name: column.name, type: column.type })),
    [
      { name: 'temp_id', type: 'TEXT' },
      { name: 'temp_value', type: 'REAL' },
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

test('schema cache returns isolated snapshots', async () => {
  const driver: DriverApi = {
    kind: 'sqlite',
    connect: async () => {},
    read: async () => ({ columns: [], rows: [], rowCount: 0 }),
    write: async () => ({ affectedRows: 0, isDdl: false }),
    introspect: async () => ({
      tables: [{ name: 'users', sql: 'CREATE TABLE users (...)' }],
      views: [{ name: 'user_directory', sql: 'CREATE VIEW user_directory AS ...' }],
      columns: [{
        table: 'users',
        name: 'id',
        type: 'INTEGER',
        nullable: false,
        ordinal: 1,
        default: null,
        primaryKey: true,
      }],
      indexes: [{
        name: 'users_email_idx',
        table: 'users',
        columns: ['email'],
        unique: true,
        primary: false,
      }],
      foreignKeys: [{
        name: 'orders_user_fk',
        table: 'orders',
        columns: ['user_id'],
        referencedTable: 'users',
        referencedColumns: ['id'],
      }],
    }),
    close: async () => {},
  };
  const service = new SchemaService(600_000);

  const first = await service.get(driver, 'sample', { signal: freshSignal() });
  first.tables[0]!.name = 'mutated';
  first.tables.splice(0, 1);
  first.views[0]!.sql = 'mutated';
  first.columns[0]!.name = 'mutated';
  first.indexes[0]!.columns.push('mutated');
  first.foreignKeys[0]!.columns[0] = 'mutated';
  first.foreignKeys[0]!.referencedColumns.push('mutated');

  const cached = await service.get(driver, 'sample', { signal: freshSignal() });

  assert.equal(cached.fromCache, true);
  assert.deepEqual(cached.tables, [{ name: 'users', type: 'table', sql: 'CREATE TABLE users (...)' }]);
  assert.deepEqual(cached.views, [{ name: 'user_directory', sql: 'CREATE VIEW user_directory AS ...' }]);
  assert.deepEqual(cached.columns, [{
    table: 'users',
    name: 'id',
    type: 'INTEGER',
    nullable: false,
    ordinal: 1,
    default: null,
    primaryKey: true,
  }]);
  assert.deepEqual(cached.indexes[0]!.columns, ['email']);
  assert.deepEqual(cached.foreignKeys[0]!.columns, ['user_id']);
  assert.deepEqual(cached.foreignKeys[0]!.referencedColumns, ['id']);
});

test('schema cache is invalidated when a connection name is rebound', async () => {
  const h = makeHarness({ schema: { ttlMs: 600000 } });
  const firstDb = join(h.dir, 'first.sqlite');
  const secondDb = join(h.dir, 'second.sqlite');

  await h.engine.connect({ name: 'second-seed', driver: 'sqlite', database: secondDb });
  await h.engine.exec(
    { connection: 'second-seed', sql: 'CREATE TABLE second_table (id INTEGER PRIMARY KEY)', allowWrite: true, way: 'cli' },
    freshSignal(),
  );
  await h.engine.close('second-seed');

  await h.engine.connect({ name: 'app', driver: 'sqlite', database: firstDb });
  await h.engine.exec(
    { connection: 'app', sql: 'CREATE TABLE first_table (id INTEGER PRIMARY KEY)', allowWrite: true, way: 'cli' },
    freshSignal(),
  );
  const first = await h.engine.schema({ connection: 'app', way: 'cli' }, freshSignal());
  assert.deepEqual(first.tables.map((table) => table.name), ['first_table']);

  await h.engine.close('app');
  await h.engine.connect({ name: 'app', driver: 'sqlite', database: secondDb });

  const rebound = await h.engine.schema({ connection: 'app', way: 'cli' }, freshSignal());
  assert.equal(rebound.fromCache, false);
  assert.deepEqual(rebound.tables.map((table) => table.name), ['second_table']);
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

test('invalidate revokes in-flight introspection cache writes', () =>
  assertInvalidationRevokesRefresh((service) => service.invalidate('sample')),
);

test('clear revokes in-flight introspection cache writes', () =>
  assertInvalidationRevokesRefresh((service) => service.clear()),
);
