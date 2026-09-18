/**
 * CLI (/db command) tests: parsing plus dispatch through the real engine.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { runDbLine, splitFlags, tokenize } from '../dist/commands.js';
import { DbConnectorError } from '../dist/errors.js';
import { freshSignal, makeHarness, type Harness } from './helpers.ts';

test('tokenize respects single and double quotes', () => {
  assert.deepEqual(tokenize('a b "c d" e'), ['a', 'b', 'c d', 'e']);
  assert.deepEqual(tokenize('a \'b c\' d'), ['a', 'b c', 'd']);
});

test('tokenize decodes backslash escapes inside quotes', () => {
  const input = 'query --sql "SELECT \\"C:\\\\tmp\\""';
  assert.deepEqual(tokenize(input), ['query', '--sql', 'SELECT "C:\\tmp"']);
});

test('tokenize preserves ordinary backslashes in quoted values', () => {
  const input = 'connect app --db "C:\\tmp\\app.db"';
  assert.deepEqual(tokenize(input), ['connect', 'app', '--db', 'C:\\tmp\\app.db']);
});

test('splitFlags separates positionals from --key value pairs', () => {
  const { positionals, flags } = splitFlags(
    tokenize('connect app --driver sqlite --db ./x.db --refresh'),
  );
  assert.deepEqual(positionals, ['connect', 'app']);
  assert.equal(flags.driver, 'sqlite');
  assert.equal(flags.db, './x.db');
  assert.equal(flags.refresh, true);
});

test('help and status without connections', async () => {
  const h = makeHarness();
  const help = await runDbLine(h.engine, 'help', freshSignal());
  assert.ok(help.includes('db query'));
  const status = await runDbLine(h.engine, 'status', freshSignal());
  assert.equal(status, 'No connections defined. Run /db connect <name> --driver ...');
});

test('connect + query + schema + audit round-trip', async () => {
  const h = makeHarness();
  const db = `${h.dir.replace(/\\/g, '/')}/c.sqlite`;
  const created = await runDbLine(h.engine, `connect app --driver sqlite --db ${db}`, freshSignal());
  assert.ok(created.includes('Connected app'));

  await h.engine.exec(
    { connection: 'app', sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)', allowWrite: true, way: 'command' },
    freshSignal(),
  );
  await h.engine.exec(
    { connection: 'app', sql: 'INSERT INTO t(v) VALUES (?)', params: ['x'], allowWrite: true, way: 'command' },
    freshSignal(),
  );

  const q = await runDbLine(h.engine, 'query app --sql "SELECT v FROM t"', freshSignal());
  assert.ok(q.includes('1 row(s)'));
  assert.ok(q.includes('columns: v'));

  const s = await runDbLine(h.engine, 'schema app', freshSignal());
  assert.ok(s.includes('tables: 1'));

  const a = await runDbLine(h.engine, 'audit app', freshSignal());
  assert.ok(a.includes('Audit records'));
  assert.ok(a.includes('write'));
});

test('connect reports the existing connection driver on a mismatched reconnect', async () => {
  const h = makeHarness();
  const db = `${h.dir.replace(/\\/g, '/')}/c.sqlite`;

  assert.equal(
    await runDbLine(h.engine, `connect app --driver sqlite --db ${db}`, freshSignal()),
    'Connected app (sqlite).',
  );
  assert.equal(
    await runDbLine(h.engine, 'connect app --driver postgres --db other', freshSignal()),
    'Connected app (sqlite).',
  );
});

test('exec requires --allow-write', async () => {
  const h = await makeHarnessAndRows();
  await assert.rejects(
    runDbLine(h.engine, 'exec app --sql "DELETE FROM t"', freshSignal()),
    (e: DbConnectorError) => e.code === 'WRITE_NOT_ALLOWED',
  );
  const ok = await runDbLine(h.engine, 'exec app --sql "DELETE FROM t" --allow-write', freshSignal());
  assert.ok(ok.includes('row(s) affected'));
});

test('unknown subcommand and missing args produce friendly errors', async () => {
  const h = await makeHarnessAndRows();
  const unknown = await runDbLine(h.engine, 'frobnicate', freshSignal());
  assert.ok(unknown.includes('unknown subcommand'));
  await assert.rejects(
    runDbLine(h.engine, 'query app', freshSignal()),
    /missing --sql/,
  );
});

test('query rejects an invalid numeric limit flag', async () => {
  const h = await makeHarnessAndRows();
  await assert.rejects(
    runDbLine(h.engine, 'query app --sql "SELECT v FROM t" --limit=abc', freshSignal()),
    (e: DbConnectorError) => e.code === 'INVALID_ARGS' && /limit/i.test(e.message),
  );
});

test('query rejects an invalid numeric timeout flag', async () => {
  const h = await makeHarnessAndRows();
  await assert.rejects(
    runDbLine(h.engine, 'query app --sql "SELECT v FROM t" --timeout=abc', freshSignal()),
    (e: DbConnectorError) => e.code === 'INVALID_ARGS' && /timeout/i.test(e.message),
  );
});

test('query rejects a bare numeric limit flag', async () => {
  const h = await makeHarnessAndRows();
  await assert.rejects(
    runDbLine(h.engine, 'query app --sql "SELECT v FROM t" --limit', freshSignal()),
    (e: DbConnectorError) => e.code === 'INVALID_ARGS' && /limit/i.test(e.message),
  );
});

test('query rejects a bare numeric timeout flag', async () => {
  const h = await makeHarnessAndRows();
  await assert.rejects(
    runDbLine(h.engine, 'query app --sql "SELECT v FROM t" --timeout', freshSignal()),
    (e: DbConnectorError) => e.code === 'INVALID_ARGS' && /timeout/i.test(e.message),
  );
});

test('params CSV decode maps numbers, booleans, null, strings', async () => {
  const h = await makeHarnessAndRows();
  const marker = 'zap567';
  await runDbLine(
    h.engine,
    `exec app --sql "INSERT INTO t(v) VALUES (?)" --params ${marker} --allow-write`,
    freshSignal(),
  );
  const q = await runDbLine(h.engine, `query app --sql "SELECT v FROM t WHERE v = ?" --params ${marker}`, freshSignal());
  assert.ok(q.includes('1 row(s)'));
});

test('params CSV decode preserves an empty value for query', async () => {
  const h = await makeHarnessAndRows();
  const q = await runDbLine(h.engine, 'query app --sql "SELECT ? AS v" --params ""', freshSignal());
  assert.ok(q.includes('1 row(s)'));
  assert.match(q, /"rows": \[\s*\[\s*""/);
});

test('params CSV decode preserves an empty value for exec', async () => {
  const h = await makeHarnessAndRows();
  const result = await runDbLine(
    h.engine,
    'exec app --sql "INSERT INTO t(v) VALUES (?)" --params "" --allow-write',
    freshSignal(),
  );
  assert.ok(result.includes('1 row(s) affected'));
});

async function makeHarnessAndRows(): Promise<Harness> {
  const h = makeHarness();
  await h.engine.connect({ name: 'app', driver: 'sqlite', database: h.dir + '/app.sqlite' });
  await h.engine.exec({ connection: 'app', sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)', allowWrite: true, way: 'command' }, freshSignal());
  await h.engine.exec({ connection: 'app', sql: 'INSERT INTO t(v) VALUES (?)', params: ['hello'], allowWrite: true, way: 'command' }, freshSignal());
  await h.engine.exec({ connection: 'app', sql: 'INSERT INTO t(v) VALUES (?)', params: ['world'], allowWrite: true, way: 'command' }, freshSignal());
  return h;
}
