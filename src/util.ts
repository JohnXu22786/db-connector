/**
 * Small shared helpers: cancellation signals, hashing, ids, and timing.
 * No secrets ever flow through these.
 */

import { createHash, randomUUID } from 'node:crypto';

export interface AsyncMutexOptions {
  signal?: AbortSignal;
  onAbort?: () => unknown;
}

/** Serialize asynchronous work while preserving request order. */
export class AsyncMutex {
  private tail = Promise.resolve();

  async runExclusive<T>(
    work: () => Promise<T>,
    options: AsyncMutexOptions = {},
  ): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    if (options.signal) {
      await this.waitForTurn(previous, release, options.signal, options.onAbort);
      if (options.signal.aborted) {
        release();
        throw this.abortError(options.onAbort);
      }
    } else {
      await previous;
    }

    try {
      return await work();
    } finally {
      release();
    }
  }

  private waitForTurn(
    previous: Promise<void>,
    release: () => void,
    signal: AbortSignal,
    onAbort?: () => unknown,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let waiting = true;
      const onSignalAbort = () => {
        if (!waiting) return;
        waiting = false;
        signal.removeEventListener('abort', onSignalAbort);
        void previous.then(release);
        reject(this.abortError(onAbort));
      };

      if (signal.aborted) {
        onSignalAbort();
        return;
      }
      signal.addEventListener('abort', onSignalAbort, { once: true });
      void previous.then(() => {
        if (!waiting) return;
        waiting = false;
        signal.removeEventListener('abort', onSignalAbort);
        if (signal.aborted) {
          release();
          reject(this.abortError(onAbort));
        } else {
          resolve();
        }
      });
    });
  }

  private abortError(onAbort?: () => unknown): unknown {
    try {
      return onAbort?.() ?? new Error('mutex wait aborted');
    } catch (err) {
      return err;
    }
  }
}

const MAX_TIMEOUT_MS = 2_147_483_647;

/** sha256 hex digest of a string (used for audit statement digests). */
export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Short random id for audit record correlation. */
export function uid(): string {
  return randomUUID();
}

/** Ellipsize a single-line string from the middle. */
export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 3) return text.slice(0, max);
  const keep = max - 3;
  const left = Math.ceil(keep / 2);
  const right = Math.floor(keep / 2);
  const suffix = right === 0 ? '' : text.slice(-right);
  return `${text.slice(0, left)}...${suffix}`;
}

/**
 * Build a cancellation signal that aborts when EITHER the caller's signal
 * fires OR the timeout elapses. Uses AbortSignal.any so the resulting
 * `signal.reason` is the winning source's reason (a TimeoutError DOMException
 * for a timeout, which downstream code recognizes).
 */
export function createDeadlineSignal(
  caller?: AbortSignal,
  timeoutMs?: number,
): { signal: AbortSignal; clear: () => void } {
  const sources: AbortSignal[] = [];
  if (caller) sources.push(caller);
  if (
    timeoutMs !== undefined &&
    Number.isFinite(timeoutMs) &&
    timeoutMs > 0
  ) {
    const delayMs = Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.floor(timeoutMs)));
    sources.push(AbortSignal.timeout(delayMs));
  }

  if (sources.length === 0) {
    return { signal: new AbortController().signal, clear() {} };
  }
  if (sources.length === 1) {
    const only = sources[0]!;
    return { signal: only, clear() {} };
  }
  const signal = AbortSignal.any(sources);
  return { signal, clear() {} };
}

/** Compute timing in ms between two high-resolution markers. */
export function hrtimeMs(start: [number, number]): number {
  const [s, ns] = process.hrtime(start);
  return s * 1000 + ns / 1e6;
}
