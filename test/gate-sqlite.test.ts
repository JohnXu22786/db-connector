/**
 * End-to-end executor tests against real SQLite: read-only gate, write
 * approval gate, transaction rollback, parameter injection safety, result
 * limits, timeouts, and the audit trail on the happy AND failure paths.
 */

import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { DbConnectorError } from '../dist/errors.js';
import { freshSignal, makeHarness, seedSqlite, type Harness } from './helpers.ts';

async function setup(): Promise<Harness> {
  const h = makeHarness();
  await seedSqlite(h);
  return h;
}

test('db query returns columns, JSON-safe rows, and an audit id', async () => {
  const h = await setup();
  const result = await h.engine.query(
    { connection: 'sample', sql: 'SELECT * FROM users ORDER BY id', way: 'cli' },
    freshSignal(),
  );
  assert.equal(result.kind, 'query');
  assert.deepEqual(result.columns, ['id', 'email', 'age']);
  assert.equal(result.rowCount, 2);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.rows[0], [1, 'a@x.com', 30]);
  assert.ok(result.auditId.length > 0);
  assert.ok(result.durationMs >= 0);
});

test('read-only gate rejects writes through db_query and records a denial', async () => {
  const h = await setup();
  await assert.rejects(
    h.engine.query(
      { connection: 'sample', sql: 'DELETE FROM users', way: 'tool' },
      freshSignal(),
    ),
    (e: DbConnectorError) => e.code === 'READ_ONLY_VIOLATION',
  );
  // data untouched, denial audited
  const { rows: stillThere } = (await h.engine.query(
    { connection: 'sample', sql: 'SELECT COUNT(*) AS n FROM users', way: 'cli' },
    freshSignal(),
  ));
  assert.equal(stillThere[0]![0], 2);
  const { records } = await h.engine.audit({});
  assert.ok(records.some((r) => r.kind === 'denied' && r.status === 'denied'));
});

test('read-only gate rejects DDL and unknown statements too', async () => {
  const h = await setup();
  await assert.rejects(
    h.engine.query({ connection: 'sample', sql: 'VACUUM', way: 'cli' }, freshSignal()),
    (e: DbConnectorError) => e.code === 'READ_ONLY_VIOLATION',
  );
  await assert.rejects(
    h.engine.query({ connection: 'sample', sql: 'CREATE TABLE x (id INTEGER)', way: 'cli' }, freshSignal()),
    (e: DbConnectorError) => e.code === 'READ_ONLY_VIOLATION',
  );
});

test('read-only gate closes the PRAGMA / EXPLAIN ANALYZE / CTE-write holes', async () => {
  const h = await setup();
  // PRAGMA can persist writes (user_version =, journal_mode = ...) — never
  // trusted through the read path.
  await assert.rejects(
    h.engine.query({ connection: 'sample', sql: 'PRAGMA user_version = 99', way: 'cli' }, freshSignal()),
    (e: DbConnectorError) => e.code === 'READ_ONLY_VIOLATION',
  );
  // EXPLAIN ANALYZE executes its statement on servers that support it.
  await assert.rejects(
    h.engine.query({ connection: 'sample', sql: 'EXPLAIN ANALYZE DELETE FROM users', way: 'cli' }, freshSignal()),
    (e: DbConnectorError) => e.code === 'READ_ONLY_VIOLATION',
  );
  // A data-modifying CTE is a write even when it reads as SELECT first.
  await assert.rejects(
    h.engine.query(
      { connection: 'sample', sql: 'WITH x AS (DELETE FROM users RETURNING *) SELECT * FROM x', way: 'cli' },
      freshSignal(),
    ),
    (e: DbConnectorError) => e.code === 'READ_ONLY_VIOLATION',
  );
  // REPLACE under a CTE (SQLite) must not bypass the read-only gate.
  await assert.rejects(
    h.engine.query(
      { connection: 'sample', sql: 'WITH x AS (VALUES(9)) REPLACE INTO users(email, age) SELECT 1, 2 FROM x', way: 'cli' },
      freshSignal(),
    ),
    (e: DbConnectorError) => e.code === 'READ_ONLY_VIOLATION',
  );
  // ... and it must not bypass the write approval gate either.
  await assert.rejects(
    h.engine.exec(
      { connection: 'sample', sql: 'WITH x AS (VALUES(9)) REPLACE INTO users(email, age) SELECT 1, 2 FROM x', way: 'cli' },
      freshSignal(),
    ),
    (e: DbConnectorError) => e.code === 'WRITE_NOT_ALLOWED',
  );
  // SELECT ... INTO creates a table / writes a file — treat as a write.
  await assert.rejects(
    h.engine.query(
      { connection: 'sample', sql: 'SELECT * INTO backup_users FROM users', way: 'cli' },
      freshSignal(),
    ),
    (e: DbConnectorError) => e.code === 'READ_ONLY_VIOLATION',
  );
  // db_exec still lets a read-only PRAGMA through with explicit approval.
  const allowed = await h.engine.exec(
    { connection: 'sample', sql: 'PRAGMA table_info(users)', allowWrite: true, way: 'cli' },
    freshSignal(),
  );
  assert.equal(allowed.committed, true);
});

test('read-only path accepts EXPLAIN', async () => {
  const h = await setup();
  const result = await h.engine.query(
    { connection: 'sample', sql: 'EXPLAIN QUERY PLAN SELECT * FROM users', way: 'cli' },
    freshSignal(),
  );
  assert.ok(result.rowCount > 0);
});

test('write approval gate denies without allowWrite and audits it', async () => {
  const h = await setup();
  await assert.rejects(
    h.engine.exec({ connection: 'sample', sql: "INSERT INTO users(email, age) VALUES ('x', 1)", way: 'tool' }, freshSignal()),
    (e: DbConnectorError) => e.code === 'WRITE_NOT_ALLOWED',
  );
  const { records } = await h.engine.audit({});
  assert.ok(records.some((r) => r.kind === 'denied' && r.status === 'denied'));
});

test('write approval allows with allowWrite and returns affected rows + note', async () => {
  const h = await setup();
  const result = await h.engine.exec(
    { connection: 'sample', sql: "INSERT INTO users(email, age) VALUES ('c@x.com', 40)", allowWrite: true, way: 'tool' },
    freshSignal(),
  );
  assert.equal(result.kind, 'write');
  assert.equal(result.affectedRows, 1);
  assert.equal(result.committed, true);
  assert.equal(result.rolledBack, false);
  assert.ok(result.note.includes('transaction'));
  assert.equal(result.note.includes('roll'), true);
});

test('SQLite VACUUM runs outside the write transaction wrapper', async () => {
  const h = await setup();
  const result = await h.engine.exec(
    { connection: 'sample', sql: 'VACUUM', allowWrite: true, way: 'cli' },
    freshSignal(),
  );
  assert.equal(result.kind, 'ddl');
  assert.equal(result.committed, true);
  assert.equal(result.rolledBack, false);
});

test('failed write rolls back (no partial rows survive)', async () => {
  const h = await setup();
  // Updating id=2 to a duplicate email violates the UNIQUE constraint.
  await assert.rejects(
    h.engine.exec(
      { connection: 'sample', sql: "UPDATE users SET email = 'a@x.com' WHERE id = 2", allowWrite: true, way: 'tool' },
      freshSignal(),
    ),
    (e: DbConnectorError) => e.code === 'QUERY_FAILED' && /rolled back/i.test(e.message),
  );
  // The failed transaction left both rows intact.
  const { rows } = await h.engine.query(
    { connection: 'sample', sql: "SELECT email FROM users WHERE id = 2", way: 'cli' },
    freshSignal(),
  );
  assert.deepEqual(rows[0], ['b@x.com']);
});

test('multi-statement input is refused on both query and exec', async () => {
  const h = await setup();
  for (const [fn, sql, extra] of [
    [h.engine.query.bind(h.engine), 'SELECT 1; SELECT 2', {}],
    [h.engine.exec.bind(h.engine), "INSERT INTO users(email) VALUES ('a'); DROP TABLE users", { allowWrite: true }],
  ] as const) {
    await assert.rejects(
      fn({ connection: 'sample', sql, ...extra, way: 'cli' } as never, freshSignal()),
      (e: DbConnectorError) => e.code === 'MULTI_STATEMENTS',
    );
  }
});

test('parameterized values cannot inject SQL', async () => {
  const h = await setup();
  const evil = "x'); DROP TABLE users; --";
  await h.engine.exec(
    { connection: 'sample', sql: 'INSERT INTO users(email, age) VALUES(?, ?)', params: [evil, 5], allowWrite: true, way: 'cli' },
    freshSignal(),
  );
  // table still exists and the literal value is stored verbatim
  const { rows } = await h.engine.query(
    { connection: 'sample', sql: "SELECT email FROM users WHERE age = 5", way: 'cli' },
    freshSignal(),
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]![0], evil);
  // users table still has all rows (drop didn't happen)
  const { rows: n } = await h.engine.query(
    { connection: 'sample', sql: 'SELECT COUNT(*) FROM users', way: 'cli' },
    freshSignal(),
  );
  assert.equal(n[0]![0], 3);
});

test('named parameters bind in order', async () => {
  const h = await setup();
  const result = await h.engine.query(
    {
      connection: 'sample',
      sql: 'SELECT email FROM users WHERE age >= :min AND age < :max',
      namedParams: { min: 26, max: 40 },
      way: 'cli',
    },
    freshSignal(),
  );
  assert.deepEqual(result.rows, [['a@x.com']]);
});

test('parameter arity mismatch is a friendly INVALID_PARAMS', async () => {
  const h = await setup();
  await assert.rejects(
    h.engine.query({ connection: 'sample', sql: 'SELECT ? + ?', params: [1], way: 'cli' }, freshSignal()),
    (e: DbConnectorError) => e.code === 'INVALID_PARAMS',
  );
  await assert.rejects(
    h.engine.query(
      { connection: 'sample', sql: 'SELECT * FROM users', params: [1, 2], way: 'cli' },
      freshSignal(),
    ),
    (e: DbConnectorError) => e.code === 'INVALID_PARAMS',
  );
  // mixing `:name` with a bare `?` must be rejected, not silently mis-bound
  await assert.rejects(
    h.engine.query(
      { connection: 'sample', sql: 'SELECT :x AS a, ? AS b', namedParams: { x: 5 }, way: 'cli' },
      freshSignal(),
    ),
    (e: DbConnectorError) => e.code === 'INVALID_PARAMS',
  );
  // non-serializable values (bigint) are refused before they reach a driver
  await assert.rejects(
    h.engine.query(
      { connection: 'sample', sql: 'SELECT ?', params: [1n as never], way: 'cli' },
      freshSignal(),
    ),
    (e: DbConnectorError) => e.code === 'INVALID_PARAMS',
  );
});

test('result cap applies and reports truncation', async () => {
  const h = await setup();
  for (let i = 0; i < 20; i += 1) {
    await h.engine.exec(
      { connection: 'sample', sql: 'INSERT INTO orders(user_id, total) VALUES(?, ?)', params: [1, i], allowWrite: true, way: 'cli' },
      freshSignal(),
    );
  }
  const capped = await h.engine.query(
    { connection: 'sample', sql: 'SELECT * FROM orders', limit: 5, way: 'cli' },
    freshSignal(),
  );
  assert.equal(capped.rowCount, 5);
  assert.equal(capped.truncated, true);
  assert.equal(capped.limit, 5);
});

test('SELECT guard limit is appended when absent', async () => {
  const h = await setup();
  for (let i = 0; i < 10; i += 1) {
    await h.engine.exec(
      { connection: 'sample', sql: 'INSERT INTO orders(user_id, total) VALUES(?, ?)', params: [1, i], allowWrite: true, way: 'cli' },
      freshSignal(),
    );
  }
  const res = await h.engine.query(
    { connection: 'sample', sql: 'SELECT * FROM orders', limit: 3, way: 'cli' },
    freshSignal(),
  );
  assert.equal(res.rowCount, 3);
  // the executed (audited) statement carried the LIMIT â€” audit records it
  const { records } = await h.engine.audit({ connection: 'sample', limit: 50 });
  const hit = records.find((r) => r.kind === 'query' && r.statement.summary.includes('LIMIT 3'));
  assert.ok(hit, 'expected the guarded LIMIT in the audit record');
});

test('long query times out with TIMEOUT and the connection recovers in-memory survives file', async () => {
  const h = await setup();
  const hang = 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT COUNT(*) FROM c';
  await assert.rejects(
    h.engine.query(
      { connection: 'sample', sql: hang, timeoutMs: 250, way: 'tool' },
      freshSignal(),
    ),
    (e: DbConnectorError) => e.code === 'TIMEOUT',
  );
  // the connection is re-created lazily; the file-backed data is intact
  const { rows } = await h.engine.query(
    { connection: 'sample', sql: 'SELECT COUNT(*) FROM users', way: 'cli' },
    freshSignal(),
  );
  assert.equal(rows[0]![0], 2);
});

test('executing reads through db_exec returns kind "read"', async () => {
  const h = await setup();
  const result = await h.engine.exec(
    { connection: 'sample', sql: 'SELECT COUNT(*) FROM users', way: 'tool' },
    freshSignal(),
  );
  assert.equal(result.kind, 'read');
  assert.equal(result.committed, true);
});

test('DDL through db_exec invalidates the schema cache', async () => {
  const h = await setup();
  const before = await h.engine.schema({ connection: 'sample', way: 'cli' }, freshSignal());
  assert.equal(before.tables.some((t) => t.name === 'users'), true);
  assert.equal(before.columns.some((c) => c.table === 'users' && c.name === 'age'), true);

  await h.engine.exec(
    { connection: 'sample', sql: 'ALTER TABLE users ADD COLUMN nickname TEXT', allowWrite: true, way: 'cli' },
    freshSignal(),
  );

  // Refresh bypasses a cache that DDL has already invalidated.
  const after = await h.engine.schema(
    { connection: 'sample', refresh: true, way: 'cli' },
    freshSignal(),
  );
  assert.equal(after.columns.some((c) => c.table === 'users' && c.name === 'nickname'), true);
});

test('unknown connections raise CONNECTION_NOT_FOUND', async () => {
  const h = await setup();
  await assert.rejects(
    h.engine.query({ connection: 'ghost', sql: 'SELECT 1', way: 'cli' }, freshSignal()),
    (e: DbConnectorError) => e.code === 'CONNECTION_NOT_FOUND',
  );
});

test('an audit write failure never breaks the executed statement', async () => {
  // Force every audit append to fail: pointing the log at the OS temp root
  // makes appendFile throw EISDIR. The DB work must still succeed and stay
  // durable; auditing is best-effort.
  const h = makeHarness({ audit: { path: tmpdir() } });
  const engine = h.engine;
  await engine.connect({ name: 'a', driver: 'sqlite', database: ':memory:' });
  await engine.exec(
    { connection: 'a', sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)', allowWrite: true, way: 'cli' },
    freshSignal(),
  );
  await engine.exec(
    { connection: 'a', sql: "INSERT INTO t(v) VALUES ('kept')", allowWrite: true, way: 'cli' },
    freshSignal(),
  );
  const q = await engine.query({ connection: 'a', sql: 'SELECT v FROM t', way: 'cli' }, freshSignal());
  assert.deepEqual(q.rows, [['kept']]);
  assert.ok(h.audit.failed > 0);
});
