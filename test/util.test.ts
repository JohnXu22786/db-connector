import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createDeadlineSignal } from '../dist/util.js';

test('normalizes fractional and oversized finite timeout values', () => {
  const originalTimeout = AbortSignal.timeout;
  const delays: number[] = [];
  AbortSignal.timeout = ((delay: number) => {
    delays.push(delay);
    return new AbortController().signal;
  }) as typeof AbortSignal.timeout;

  try {
    createDeadlineSignal(undefined, 1.5);
    createDeadlineSignal(undefined, Number.MAX_SAFE_INTEGER);
  } finally {
    AbortSignal.timeout = originalTimeout;
  }

  assert.deepEqual(delays, [1, 2_147_483_647]);
});
