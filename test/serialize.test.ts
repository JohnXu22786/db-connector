/**
 * Result serialization tests: JSON-safe types, row capping.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { capRows, serializeValue } from '../dist/serialize.js';

test('bigint serializes to exact string', () => {
  assert.equal(serializeValue(9007199254740993n), '9007199254740993');
  assert.equal(serializeValue(42n), '42');
});

test('Date serializes to ISO string; invalid dates to null', () => {
  assert.equal(serializeValue(new Date('2026-01-02T03:04:05.000Z')), '2026-01-02T03:04:05.000Z');
  assert.equal(serializeValue(new Date(NaN)), null);
});

test('binary serializes to base64', () => {
  const buf = Buffer.from([0, 1, 2, 254, 255]);
  assert.equal(serializeValue(buf), Buffer.from(buf).toString('base64'));
  const view = new Uint32Array([0xdeadbeef]);
  assert.equal(serializeValue(view), Buffer.from(view.buffer).toString('base64'));
});

test('non-finite numbers and undefined become null', () => {
  assert.equal(serializeValue(undefined), null);
  assert.equal(serializeValue(NaN), null);
  assert.equal(serializeValue(Infinity), null);
  assert.equal(serializeValue(-Infinity), null);
});

test('nested containers are converted recursively', () => {
  const input = {
    id: 1n,
    when: new Date('2026-01-01T00:00:00.000Z'),
    blob: Buffer.from('hi', 'utf8'),
    tags: [1n, 'x', NaN],
    nested: { big: 2n },
  };
  const out = serializeValue(input) as Record<string, unknown>;
  assert.equal(out.id, '1');
  assert.equal(out.when, '2026-01-01T00:00:00.000Z');
  assert.equal(typeof out.blob, 'string');
  assert.deepEqual(out.tags, ['1', 'x', null]);
  assert.deepEqual(out.nested, { big: '2' });
});

test('capRows truncates and reports', () => {
  const rows = [1, 2, 3, 4, 5];
  assert.deepEqual(capRows(rows, 3), { rows: [1, 2, 3], truncated: true });
  assert.deepEqual(capRows(rows, 10), { rows, truncated: false });
  assert.deepEqual(capRows(rows, undefined), { rows, truncated: false });
  assert.equal(capRows(rows, 0).rows.length, 0);
});
