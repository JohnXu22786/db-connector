import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createDeadlineSignal, truncateMiddle } from '../dist/util.js';

test('truncateMiddle does not overflow when only one character fits beside the ellipsis', () => {
  assert.equal(truncateMiddle('abcdefgh', 4), 'a...');
});

test('normalizes fractional and oversized finite timeout values', () => {
  const originalSetTimeout = globalThis.setTimeout;
  const delays: number[] = [];
  globalThis.setTimeout = ((_: () => void, delay?: number) => {
    delays.push(delay ?? 0);
    return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  try {
    createDeadlineSignal(undefined, 1.5);
    createDeadlineSignal(undefined, Number.MAX_SAFE_INTEGER);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }

  assert.deepEqual(delays, [1, 2_147_483_647]);
});

test('clear cancels a pending deadline timeout', async () => {
  const deadline = createDeadlineSignal(undefined, 10);

  deadline.clear();
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(deadline.signal.aborted, false);
});
