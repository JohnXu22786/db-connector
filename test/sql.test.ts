/**
 * SQL classification / guarding tests — the read-only trust boundary.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { DbConnectorError } from '../dist/errors.js';
import {
  assertSingleStatement,
  classifyStatement,
  ensureSelectLimit,
  isReadStatement,
  isNonTransactionalStatement,
  normalizeText,
  rewriteNamedToPositional,
  summarizeSql,
  toDollarPlaceholders,
} from '../dist/sql.js';

test('classify simple statements', () => {
  assert.equal(classifyStatement('SELECT * FROM t').kind, 'select');
  assert.equal(classifyStatement('select id from t where x = 1').kind, 'select');
  assert.equal(classifyStatement('EXPLAIN SELECT * FROM t').kind, 'explain');
  assert.equal(classifyStatement('	EXPLAIN QUERY PLAN SELECT 1').kind, 'explain');
  assert.equal(classifyStatement('SHOW TABLES').kind, 'explain');
  assert.equal(classifyStatement('DESCRIBE t').kind, 'explain');
  assert.equal(classifyStatement('INSERT INTO t VALUES (1)').kind, 'write');
  assert.equal(classifyStatement('UPDATE t SET a=1').kind, 'write');
  assert.equal(classifyStatement('DELETE FROM t').kind, 'write');
  assert.equal(classifyStatement('MERGE INTO t USING s ON ..').kind, 'write');
  assert.equal(classifyStatement('CREATE TABLE t (id INTEGER)').kind, 'ddl');
  assert.equal(classifyStatement('ALTER TABLE t ADD COLUMN x').kind, 'ddl');
  assert.equal(classifyStatement('DROP TABLE t').kind, 'ddl');
  assert.equal(classifyStatement('VACUUM').kind, 'ddl');
  assert.equal(classifyStatement('BEGIN').kind, 'ddl');
  assert.equal(classifyStatement('TRUNCATE t').kind, 'ddl');
  assert.equal(classifyStatement('FROBNICATE the widget').kind, 'unknown');
  assert.equal(classifyStatement('').kind, 'unknown');
  assert.equal(classifyStatement('   -- nothing but a comment').kind, 'unknown');
});

test('PRAGMA is never trusted on the read path (it can write)', () => {
  assert.equal(classifyStatement('PRAGMA table_info(users)').kind, 'unknown');
  assert.equal(classifyStatement('PRAGMA journal_mode = WAL').kind, 'unknown');
  assert.equal(classifyStatement('PRAGMA user_version = 99').kind, 'unknown');
  assert.equal(isReadStatement('PRAGMA journal_mode = WAL'), false);
});

test('non-transactional statement detection covers SQLite PRAGMAs and PostgreSQL commands', () => {
  assert.equal(isNonTransactionalStatement('PRAGMA journal_mode = WAL', 'sqlite'), true);
  assert.equal(isNonTransactionalStatement('PRAGMA user_version = 99', 'sqlite'), true);
  assert.equal(isNonTransactionalStatement('PRAGMA journal_mode = WAL', 'postgres'), false);

  for (const sql of [
    'ALTER SYSTEM SET work_mem = 64MB',
    'CREATE DATABASE app_db',
    'DROP DATABASE app_db',
    'CREATE TABLESPACE app_ts LOCATION \'/var/lib/postgresql/data\'',
    'DROP TABLESPACE app_ts',
    'REFRESH MATERIALIZED VIEW CONCURRENTLY app_mv',
  ]) {
    assert.equal(isNonTransactionalStatement(sql, 'postgres'), true, sql);
  }
});

test('EXPLAIN ANALYZE classifies by its real statement', () => {
  assert.equal(classifyStatement('EXPLAIN ANALYZE SELECT * FROM t').kind, 'select');
  assert.equal(classifyStatement('EXPLAIN ANALYZE SELECT 1 INTO newtab').kind, 'write');
  assert.equal(classifyStatement('EXPLAIN ANALYZE SELECT 1 INTO newtab', 'postgres').kind, 'ddl');
  assert.equal(classifyStatement('EXPLAIN ANALYZE DELETE FROM t').kind, 'write');
  assert.equal(classifyStatement('EXPLAIN ANALYZE INSERT INTO t VALUES (1)', 'postgres').kind, 'write');
  assert.equal(classifyStatement('EXPLAIN ANALYZE UPDATE t SET a = 1').kind, 'write');
  assert.equal(classifyStatement('EXPLAIN (ANALYZE, BUFFERS) INSERT INTO t VALUES (1)').kind, 'write');
  assert.equal(isReadStatement('EXPLAIN ANALYZE SELECT 1'), true);
  assert.equal(isReadStatement('EXPLAIN ANALYZE DELETE FROM t'), false);
});

test('data-modifying CTEs are writes even when the outer keyword is SELECT', () => {
  assert.equal(
    classifyStatement('WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x').kind,
    'write',
  );
  assert.equal(
    classifyStatement('WITH x AS (SELECT 1) SELECT * FROM x').kind,
    'select',
  );
  assert.equal(
    classifyStatement('WITH "delete" AS (SELECT 1) SELECT * FROM "delete"').kind,
    'select',
  );
});

test('REPLACE under a CTE and SELECT ... INTO require write approval', () => {
  assert.equal(
    classifyStatement('WITH x AS (VALUES(1)) REPLACE INTO t SELECT * FROM x').kind,
    'write',
  );
  assert.equal(classifyStatement('REPLACE INTO t VALUES (1)').kind, 'write');
  assert.equal(classifyStatement('SELECT * INTO newtab FROM t').kind, 'write');
  assert.equal(classifyStatement('SELECT * INTO newtab FROM t', 'postgres').kind, 'ddl');
  assert.equal(classifyStatement('SELECT * INTO newtab FROM t', 'mysql').kind, 'write');
  // a top-level INTO inside a plain SELECT query is still a write on SELECT
  assert.equal(classifyStatement('SELECT a INTO OUTFILE "/tmp/x" FROM t').kind, 'write');
  // but an INTO inside a subquery (depth > 0) is not top-level
  assert.equal(classifyStatement('SELECT (SELECT 1 INTO x) FROM t').kind, 'select');
});

test('string literals and comments cannot change classification', () => {
  assert.equal(classifyStatement("SELECT 'INSERT'").kind, 'select');
  assert.equal(classifyStatement("SELECT 'insert' ' from t").kind, 'select');
  assert.equal(classifyStatement('SELECT 1 -- DROP TABLE t').kind, 'select');
  assert.equal(classifyStatement('SELECT 1 /* hijack */').kind, 'select');
  assert.equal(classifyStatement("SELECT 'crea te'").kind, 'select');
  assert.equal(classifyStatement("INSERT 'x' INTO t").kind, 'write');
  assert.equal(classifyStatement('DELETE /* c */ FROM t').kind, 'write');
});

test('CTE (WITH) statements resolve to their real data statement', () => {
  assert.equal(classifyStatement('WITH c AS (SELECT 1) SELECT * FROM c').kind, 'select');
  assert.equal(classifyStatement('WITH c AS (SELECT 1) SELECT 1 INTO newtab').kind, 'write');
  assert.equal(classifyStatement('WITH c AS (SELECT 1) SELECT 1 INTO newtab', 'postgres').kind, 'ddl');
  assert.equal(
    classifyStatement('WITH c AS (SELECT 1) DELETE FROM t WHERE id IN (SELECT * FROM c)').kind,
    'write',
  );
  assert.equal(
    classifyStatement('WITH c AS (SELECT 1) UPDATE t SET a = 1 WHERE id IN (SELECT * FROM c)').kind,
    'write',
  );
  // INSERT ... SELECT under WITH still resolves to the INSERT.
  assert.equal(
    classifyStatement('WITH c AS (SELECT 1) INSERT INTO t SELECT * FROM c').kind,
    'write',
  );
  // A quoted identifier that looks like a statement keyword is not matched.
  assert.equal(classifyStatement('WITH "select" AS (SELECT 1) SELECT * FROM "select"').kind, 'select');
});

test('isReadStatement only accepts select/explain', () => {
  assert.equal(isReadStatement('SELECT 1'), true);
  assert.equal(isReadStatement('EXPLAIN SELECT 1'), true);
  assert.equal(isReadStatement('INSERT INTO t VALUES (1)'), false);
  assert.equal(isReadStatement('WITH c AS (SELECT 1) SELECT * FROM c'), true);
  assert.equal(isReadStatement('WITH c AS (SELECT 1) DELETE FROM t'), false);
});

test('single-statement enforcement ignores semicolons in strings/comments', () => {
  assert.doesNotThrow(() => assertSingleStatement('SELECT 1'));
  assert.doesNotThrow(() => assertSingleStatement("SELECT ';' AS x"));
  assert.doesNotThrow(() => assertSingleStatement('SELECT 1; -- trailing comment only'));
  assert.throws(() => assertSingleStatement('SELECT 1; SELECT 2'), DbConnectorError);
  assert.throws(() => assertSingleStatement('SELECT 1; SELECT 2;'), DbConnectorError);
  assert.throws(() => assertSingleStatement('SELECT 1; DROP TABLE t'), (e) => {
    assert.equal((e as DbConnectorError).code, 'MULTI_STATEMENTS');
    return true;
  });
});

test('single-statement enforcement allows semicolons inside CREATE TRIGGER bodies', () => {
  assert.doesNotThrow(() => assertSingleStatement(
    'CREATE TRIGGER trg AFTER INSERT ON t BEGIN INSERT INTO log VALUES (new.id); UPDATE t SET x = 1 WHERE id = new.id; END;',
  ));
  assert.throws(() => assertSingleStatement(
    'CREATE TRIGGER trg AFTER INSERT ON t BEGIN INSERT INTO log VALUES (new.id); END; SELECT 1;',
  ), DbConnectorError);
});

test('toDollarPlaceholders rewrites positional ? outside strings/comments', () => {
  assert.deepEqual(toDollarPlaceholders('SELECT * FROM t WHERE a = ? AND b = ?'), {
    sql: 'SELECT * FROM t WHERE a = $1 AND b = $2',
    count: 2,
  });
  assert.deepEqual(toDollarPlaceholders("SELECT '?' AS q, ?"), {
    sql: "SELECT '?' AS q, $1",
    count: 1,
  });
  assert.deepEqual(toDollarPlaceholders('SELECT * FROM t'), {
    sql: 'SELECT * FROM t',
    count: 0,
  });
});

test('rewriteNamedToPositional maps :name markers in order', () => {
  const out = rewriteNamedToPositional(
    'INSERT INTO t(a, b) VALUES(:b, :a)',
    ['a', 'b'],
  );
  assert.equal(out.sql, 'INSERT INTO t(a, b) VALUES(?, ?)');
  assert.deepEqual(out.order, ['b', 'a']);
});

test('rewriteNamedToPositional rejects an unknown :name', () => {
  assert.throws(
    () => rewriteNamedToPositional('SELECT :nope', ['a']),
    (e) => (e as DbConnectorError).code === 'INVALID_PARAMS',
  );
});

test('rewriteNamedToPositional ignores colons inside strings and casts', () => {
  const out = rewriteNamedToPositional("SELECT ':keep' AS s, now()::text, :v", ['v']);
  assert.equal(out.sql, "SELECT ':keep' AS s, now()::text, ?");
  assert.deepEqual(out.order, ['v']);
});

test('ensureSelectLimit appends LIMIT only when none exists at top level', () => {
  const withLimit = ensureSelectLimit('SELECT id FROM t LIMIT 5', 10);
  assert.equal(withLimit.applied, false);
  assert.equal(withLimit.sql, 'SELECT id FROM t LIMIT 5');

  const added = ensureSelectLimit('SELECT id FROM t', 10);
  assert.equal(added.applied, true);
  assert.equal(added.sql, 'SELECT id FROM t LIMIT 10');

  assert.equal(ensureSelectLimit('SELECT id FROM t;', 3).sql, 'SELECT id FROM t LIMIT 3;');
  assert.equal(ensureSelectLimit('SELECT (SELECT 1 LIMIT 2)', 3).applied, true);
  // not a select -> untouched
  assert.equal(ensureSelectLimit('INSERT INTO t VALUES (1)', 3).applied, false);
  // trailing comment after the terminator is not swallowed
  assert.equal(ensureSelectLimit('SELECT 1; -- done', 2).sql, 'SELECT 1 LIMIT 2; -- done');
  // a `;` inside a trailing comment must NOT swallow the guard limit
  assert.equal(ensureSelectLimit('SELECT 1 -- hi ; bye', 5).sql, 'SELECT 1 LIMIT 5 -- hi ; bye');
  assert.equal(ensureSelectLimit('SELECT 1 /* ; */', 5).sql, 'SELECT 1 LIMIT 5 /* ; */');
});

test('normalizeText strips comments and collapses whitespace', () => {
  assert.equal(normalizeText("SELECT  1, 'x' -- c"), "SELECT 1, 'x'");
  assert.equal(normalizeText('SELECT\n\t2 /* b */ , 3'), 'SELECT 2 , 3');
});

test('summarizeSql caps length and keeps a stable digest', () => {
  const a = summarizeSql('SELECT 1', 512);
  const b = summarizeSql('  SELECT    1  ', 512);
  assert.equal(a.digest, b.digest);
  const long = 'SELECT ' + 'a'.repeat(1000);
  const sum = summarizeSql(long, 100);
  assert.ok(sum.summary.length <= 103); // 100 + '...' ellipsis
  assert.equal(sum.chars, 1007);
});
