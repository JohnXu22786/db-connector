/**
 * Audit log tests: JSONL shape, filtering, and the disabled mode.
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AuditLog } from '../dist/audit.js';

function freshPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'db-connector-audit-')), 'audit.jsonl');
}

function input(over: Partial<Parameters<AuditLog['append']>[0]> = {}): Parameters<AuditLog['append']>[0] {
  return {
    connection: 'c1',
    kind: 'query',
    way: 'tool',
    sql: 'SELECT * FROM users',
    maxSqlChars: 512,
    rows: 3,
    durationMs: 12,
    status: 'ok',
    ...over,
  };
}

test('append writes one valid JSON line with the full schema', async () => {
  const log = new AuditLog(freshPath());
  const id = await log.append(input());
  assert.ok(id.length > 0);
  await log.flush();

  const lines = (await readFile(log.path, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0]!);
  assert.equal(rec.id, id);
  assert.equal(rec.connection, 'c1');
  assert.equal(rec.kind, 'query');
  assert.match(rec.ts, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(rec.rows, 3);
  assert.equal(rec.durationMs, 12);
  assert.equal(rec.status, 'ok');
  assert.ok(rec.statement.digest.length === 64);
  assert.ok(rec.statement.summary.includes('SELECT * FROM users'));
  assert.ok(!JSON.stringify(rec).includes('password'));
});

test('error records carry code + message, rows default to 0', async () => {
  const log = new AuditLog(freshPath());
  await log.append(input({ status: 'error', error: { code: 'QUERY_FAILED', message: 'boom' }, rows: 0 }));
  await log.flush();
  const lines = (await readFile(log.path, 'utf8')).trim().split('\n');
  const rec = JSON.parse(lines[0]!);
  assert.equal(rec.error.code, 'QUERY_FAILED');
  assert.equal(rec.error.message, 'boom');
  assert.equal(rec.rows, 0);
  assert.equal(rec.status, 'error');
});

test('query filters by connection, kind, since, and limit (newest first)', async () => {
  const log = new AuditLog(freshPath());
  const before = new Date(Date.now() - 60_000).toISOString();
  for (let i = 0; i < 5; i += 1) {
    await log.append(input({ connection: 'a', kind: 'query', sql: `SELECT ${i}` }));
  }
  await log.append(input({ connection: 'b', kind: 'write', sql: 'UPDATE x', rows: 1, status: 'ok' }));
  await log.append(input({ connection: 'b', kind: 'denied', sql: 'DELETE FROM x', status: 'denied' }));
  await log.flush();

  const all = await log.query({});
  assert.equal(all.length, 7);

  const connA = await log.query({ connection: 'a' });
  assert.equal(connA.length, 5);
  assert.ok(connA.every((r) => r.connection === 'a'));

  const writes = await log.query({ connection: 'b', kind: 'write' });
  assert.equal(writes.length, 1);

  const since = await log.query({ since: before });
  assert.equal(since.length, 7);

  const limited = await log.query({ limit: 2 });
  assert.equal(limited.length, 2);
  // newest first: last append (denied b) is first
  assert.equal(limited[0]!.kind, 'denied');
});

test('missing log file returns an empty list', async () => {
  const log = new AuditLog(join(mkdtempSync(join(tmpdir(), 'db-connector-audit-')), 'nope.jsonl'));
  assert.deepEqual(await log.query({}), []);
});

test('disabled audit appends nothing and returns empty', async () => {
  const log = new AuditLog(freshPath(), false);
  const id = await log.append(input());
  assert.equal(id, '');
  await log.flush();
  assert.deepEqual(await log.query({}), []);
});

test('concurrent appends arrive in submission order (serialized writes)', async () => {
  const log = new AuditLog(freshPath());
  const ids = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      log.append(input({ connection: 'c', sql: `SELECT ${i}` })),
    ),
  );
  await log.flush();
  assert.equal(ids.length, 20);
  assert.equal(new Set(ids).size, 20);
  // newest-first read must equal the reverse of submission order
  const recs = await log.query({ connection: 'c' });
  assert.equal(recs.length, 20);
  assert.deepEqual(
    recs.map((r) => r.id),
    [...ids].reverse(),
  );
});

test('tolerates a malformed line in the middle of the log', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'db-connector-audit-'));
  const path = join(dir, 'audit.jsonl');
  await mkdir(dir, { recursive: true });
  const log = new AuditLog(path);
  await log.append(input({ connection: 'a' }));
  await log.flush();
  const fs = await import('node:fs/promises');
  await fs.appendFile(path, 'not-json\n');
  await log.append(input({ connection: 'b' }));
  await log.flush();
  const recs = await log.query({});
  assert.equal(recs.length, 2);
});

test('an append failure never throws and does not poison later attempts', async () => {
  // Point the log at a directory: every append fails with EISDIR.
  const dir = mkdtempSync(join(tmpdir(), 'db-connector-audit-'));
  const blocked = join(dir, 'blocked');
  await mkdir(blocked, { recursive: true });
  const log = new AuditLog(blocked);

  const firstId = await log.append(input());
  assert.ok(firstId.length > 0); // id is returned even when the write fails
  const secondId = await log.append(input());
  assert.ok(secondId.length > 0);
  assert.ok(log.failed >= 2);     // counted, not thrown
  assert.ok(log.lastError);       // recorded for diagnostics
  await assert.doesNotReject(() => log.flush());

  // A working log is completely unaffected.
  const ok = new AuditLog(join(dir, 'ok.jsonl'));
  await ok.append(input({ connection: 'fine' }));
  await ok.flush();
  const recs = await ok.query({ connection: 'fine' });
  assert.equal(recs.length, 1);
});
