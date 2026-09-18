/**
 * SQLite driver backed by one persistent child process per connection (IPC).
 *
 * Why a child process instead of a worker thread: node:sqlite is synchronous,
 * so a runaway statement blocks the executing thread inside native code.
 * Worker threads cannot be preempted there, and Node's exit path waits to join
 * a stuck worker — hanging the host. An OS process, by contrast, can be
 * SIGKILLed instantly even mid-native-call and never blocks parent exit.
 *
 * The child owns the DatabaseSync handle for the connection's lifetime
 * (connection reuse / lifecycle) and executes requests serially. Timeouts and
 * cancellation are enforced by killing the child and respawning it lazily on
 * the next request (file-backed databases keep their data; `:memory:`
 * connections are intentionally best-effort).
 *
 * Read-only enforcement is the classifier's gate in the executor plus
 * transaction wrapping for transactional writes on this same serial connection;
 * non-transactional DDL runs directly; server
 * drivers additionally get READ ONLY transactions for reads.
 */

import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ErrorCode, DbConnectorError } from '../errors.js';
import type { ResolvedConnectionSpec } from '../types.js';
import type { DriverApi, DriverLogger, Introspection, ReadOutcome, WriteOutcome } from './driver.js';

type Op = 'query' | 'write' | 'schema' | 'close';

interface RequestMessage {
  id: number;
  op: Op;
  sql?: string;
  params?: unknown[];
  isDdl?: boolean;
  maxRows?: number;
}

interface ReplyMessage {
  id?: number;
  ok: boolean;
  payload?: unknown;
  error?: string;
}

interface QueuedOperation {
  operation: () => Promise<unknown>;
  signal: AbortSignal;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  onAbort: () => void;
}

const DB_ENV = 'DSH_DB_CONNECTOR_SQLITE_DATABASE';

export class SqliteDriver implements DriverApi {
  readonly kind = 'sqlite' as const;
  private child: ChildProcess | null = null;
  /** Blocks replacement requests until a deliberately killed child exits. */
  private retiring: Promise<void> | null = null;
  /** Serializes IPC dispatch so close can reject queued requests before send. */
  private operationActive = false;
  private readonly operationQueue: QueuedOperation[] = [];
  private closed = false;
  private connecting: Promise<void> | null = null;
  private connectingController: AbortController | null = null;
  private connectingWaiters = 0;
  private seq = 0;
  private readonly pending = new Map<
    number,
    { child: ChildProcess; resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();
  /** In-flight request count per child, to ref/unref the IPC handle. */
  private readonly inFlight = new Map<ChildProcess, number>();
  /** Children we intentionally SIGKILLed (abort/send-failure), for diagnostics. */
  private readonly dropped = new Set<ChildProcess>();

  constructor(
    private readonly spec: ResolvedConnectionSpec,
    private readonly logger: DriverLogger,
  ) {}

  private get database(): string {
    return this.spec.database || ':memory:';
  }

  /**
   * The child must keep the event loop alive ONLY while a request is in
   * flight (so `await` works in bare scripts) and must NOT keep it alive when
   * idle (so an unclosed connection never hangs the host). Spawned children
   * start ref'd; we unref immediately and ref per in-flight request.
   */
  private refAdd(child: ChildProcess): void {
    const n = (this.inFlight.get(child) ?? 0) + 1;
    this.inFlight.set(child, n);
    if (n === 1) child.ref();
  }

  private refDrop(child: ChildProcess): void {
    const n = (this.inFlight.get(child) ?? 1) - 1;
    if (n <= 0) {
      this.inFlight.delete(child);
      child.unref();
    } else {
      this.inFlight.set(child, n);
    }
  }

  private ensureChild(): ChildProcess {
    if (
      this.child &&
      this.child.exitCode === null &&
      this.child.connected &&
      !this.closed
    ) {
      return this.child;
    }
    const entry = fileURLToPath(new URL('./sqlite-child.js', import.meta.url));
    const child = fork(entry, {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { ...process.env, [DB_ENV]: this.database },
      serialization: 'advanced',
    });
    child.unref(); // see refAdd/refDrop
    child.on('message', (msg: ReplyMessage) => {
      const entry0 = this.pending.get(msg.id ?? -1);
      if (entry0) {
        this.pending.delete(msg.id ?? -1);
        this.refDrop(child);
        if (msg.ok) {
          entry0.resolve(msg.payload);
        } else {
          entry0.reject(
            new DbConnectorError(ErrorCode.QueryFailed, msg.error ?? 'sqlite error'),
          );
        }
      }
    });
    child.on('error', (err) => {
      if (this.child === child) this.child = null;
      this.rejectFor(child, err);
    });
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = null;
      const intentional = this.dropped.delete(child);
      if (!this.closed && (code !== 0 || signal !== null)) {
        if (!intentional) {
          this.logger.warn(
            'db-connector: sqlite child exited unexpectedly (code %s, signal %s)',
            String(code),
            String(signal),
          );
        }
        this.rejectFor(
          child,
          new Error(`sqlite child exited (code ${String(code)}, signal ${String(signal)})`),
        );
      }
    });
    this.child = child;
    return child;
  }

  /** Reject only the requests dispatched to one specific child. */
  private rejectFor(child: ChildProcess, err: unknown): void {
    const reason = err instanceof Error ? err : new Error(String(err));
    for (const [id, entry] of this.pending) {
      if (entry.child !== child) continue;
      this.pending.delete(id);
      this.refDrop(child);
      entry.reject(reason);
    }
  }

  private async request(
    op: Op,
    signal: AbortSignal,
    extra?: Partial<Omit<RequestMessage, 'id' | 'op'>>,
  ): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(
        new DbConnectorError(ErrorCode.ConnectionNotFound, 'connection is closed'),
      );
    }
    return this.enqueueOperation(
      () => this.requestUnlocked(op, signal, extra),
      signal,
    );
  }

  private async requestUnlocked(
    op: Op,
    signal: AbortSignal,
    extra?: Partial<Omit<RequestMessage, 'id' | 'op'>>,
  ): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(
        new DbConnectorError(ErrorCode.ConnectionNotFound, 'connection is closed'),
      );
    }
    if (this.retiring) await this.retiring;
    if (this.closed) {
      return Promise.reject(
        new DbConnectorError(ErrorCode.ConnectionNotFound, 'connection is closed'),
      );
    }

    const dispatch = (id: number, child: ChildProcess) => {
      return new Promise((resolve, reject) => {
        const onAbort = () => {
          signal.removeEventListener('abort', onAbort);
          this.pending.delete(id);
          if (this.child === child) this.child = null;
          this.dropped.add(child);
          // Hard-kill works even while the child is blocked in native SQLite
          // and never blocks this process from exiting.
          const exited = waitForChildExit(child);
          this.retiring = exited;
          child.kill('SIGKILL');
          void exited.then(() => {
            if (this.retiring === exited) this.retiring = null;
            this.refDrop(child);
            reject(cancelError(signal));
          });
        };
        this.pending.set(id, {
          child,
          resolve: (v) => {
            signal.removeEventListener('abort', onAbort);
            resolve(v);
          },
          reject: (e) => {
            signal.removeEventListener('abort', onAbort);
            reject(e);
          },
        });
        if (signal.aborted) {
          this.pending.delete(id);
          reject(cancelError(signal));
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        this.refAdd(child);
        try {
          child.send({ id, op, ...extra });
        } catch (err) {
          this.pending.delete(id);
          this.refDrop(child);
          signal.removeEventListener('abort', onAbort);
          if (this.child === child) this.child = null;
          // Never orphan a live child: a child whose IPC send fails (e.g. a
          // non-cloneable value or a closed channel) is killed so the next
          // request respawns cleanly.
          this.dropped.add(child);
          child.kill('SIGKILL');
          reject(
            new DbConnectorError(
              ErrorCode.ConnectionNotFound,
              `sqlite child process is not available: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
        }
      });
    };

    // One automatic retry: a child that was just SIGKILLed may still be
    // referenced until its exit event lands; resend on a fresh child.
    let child = this.ensureChild();
    const first = dispatch(++this.seq, child);
    return first.catch((err) => {
      if (
        !this.closed &&
        err instanceof DbConnectorError &&
        err.code === ErrorCode.ConnectionNotFound
      ) {
        const fresh = this.ensureChild();
        if (fresh !== child) return dispatch(++this.seq, fresh);
      }
      throw err;
    });
  }

  private enqueueOperation(
    operation: () => Promise<unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (signal.aborted) return Promise.reject(cancelError(signal));

    return new Promise<unknown>((resolve, reject) => {
      const queued: QueuedOperation = {
        operation,
        signal,
        resolve,
        reject,
        onAbort: () => {},
      };
      queued.onAbort = () => {
        const index = this.operationQueue.indexOf(queued);
        if (index < 0) return;
        this.operationQueue.splice(index, 1);
        signal.removeEventListener('abort', queued.onAbort);
        reject(cancelError(signal));
      };

      if (this.operationActive) {
        this.operationQueue.push(queued);
        signal.addEventListener('abort', queued.onAbort, { once: true });
        return;
      }

      this.operationActive = true;
      this.runOperation(queued);
    });
  }

  private runOperation(operation: QueuedOperation): void {
    operation.signal.removeEventListener('abort', operation.onAbort);
    if (operation.signal.aborted) {
      operation.reject(cancelError(operation.signal));
      this.finishOperation();
      return;
    }

    let result: Promise<unknown>;
    try {
      result = operation.operation();
    } catch (err) {
      result = Promise.reject(err);
    }
    void result
      .then(operation.resolve, operation.reject)
      .finally(() => this.finishOperation());
  }

  private finishOperation(): void {
    const next = this.operationQueue.shift();
    if (!next) {
      this.operationActive = false;
      return;
    }
    this.runOperation(next);
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw cancelError(signal);
    if (this.connecting && !this.closed) {
      await this.waitForConnecting(this.connecting, signal);
      return;
    }
    if (this.child && !this.closed) return;
    // Verify the database opens and is queryable; surface failures loudly.
    const controller = new AbortController();
    const validation = this.request('query', controller.signal, { sql: 'SELECT 1' });
    const connecting = validation.then(() => undefined);
    this.connecting = connecting;
    this.connectingController = controller;
    void connecting.then(
      () => this.clearConnecting(connecting, controller),
      () => this.clearConnecting(connecting, controller),
    );
    await this.waitForConnecting(connecting, signal);
  }

  private clearConnecting(
    connecting: Promise<void>,
    controller: AbortController,
  ): void {
    if (this.connecting !== connecting) return;
    this.connecting = null;
    if (this.connectingController === controller) this.connectingController = null;
  }

  private async waitForConnecting(
    connecting: Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    this.connectingWaiters += 1;
    try {
      if (!signal) {
        await connecting;
        return;
      }
      if (signal.aborted) throw cancelError(signal);
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const cleanup = () => signal.removeEventListener('abort', onAbort);
        const finish = (callback: () => void) => {
          if (settled) return;
          settled = true;
          cleanup();
          callback();
        };
        const onAbort = () => finish(() => reject(cancelError(signal)));
        signal.addEventListener('abort', onAbort, { once: true });
        connecting.then(
          () => finish(resolve),
          (err) => finish(() => reject(err)),
        );
        if (signal.aborted) onAbort();
      });
    } finally {
      this.connectingWaiters -= 1;
      if (this.connecting === connecting && this.connectingWaiters === 0) {
        this.connectingController?.abort();
      }
    }
  }

  async read(
    sql: string,
    params: unknown[],
    signal: AbortSignal,
    maxRows?: number,
  ): Promise<ReadOutcome> {
    return (await this.request('query', signal, { sql, params, maxRows })) as ReadOutcome;
  }

  async write(
    sql: string,
    params: unknown[],
    isDdl: boolean,
    signal: AbortSignal,
  ): Promise<WriteOutcome> {
    return (await this.request('write', signal, { sql, params, isDdl })) as WriteOutcome;
  }

  async introspect(signal: AbortSignal): Promise<Introspection> {
    return (await this.request('schema', signal)) as Introspection;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const connecting = this.connecting;
    this.connectingController?.abort();
    await connecting?.catch(() => {});
    const child = this.child;
    this.child = null;
    const retiring = this.retiring;
    const closedError = new DbConnectorError(
      ErrorCode.ConnectionNotFound,
      'connection closed',
    );
    // Requests still waiting in the parent have not reached the child and
    // must be rejected without being dispatched.
    const queued = this.operationQueue.splice(0);
    for (const operation of queued) {
      operation.signal.removeEventListener('abort', operation.onAbort);
      operation.reject(closedError);
    }
    if (child && child.exitCode === null && child.connected) {
      try {
        // The parent dispatches only one request at a time, so this close
        // message follows the already-dispatched operation and lets it settle.
        child.send({ id: -1, op: 'close' });
      } catch {
        /* channel already closed */
      }
      await Promise.race([
        new Promise<void>((resolve) => {
          child.once('exit', () => resolve());
          child.once('error', () => resolve());
        }),
        new Promise<void>((resolve) => setTimeout(resolve, 1000)),
      ]);
      if (child.exitCode === null) {
        // A native operation that outlives the graceful-close window cannot
        // reply; reject it before killing the child so no caller hangs.
        child.ref();
        this.rejectFor(child, closedError);
        this.dropped.add(child);
        const exited = waitForChildExit(child);
        child.kill('SIGKILL');
        await exited;
        child.unref();
      } else {
        this.rejectFor(child, closedError);
      }
    }
    await retiring;
  }
}

function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
  });
}

function cancelError(signal: AbortSignal): DbConnectorError {
  const reason = signal.reason;
  const isTimeout = reason instanceof Error && /timeout/i.test(reason.message);
  return new DbConnectorError(
    isTimeout ? ErrorCode.Timeout : ErrorCode.Cancelled,
    isTimeout
      ? 'query exceeded its time limit (connection was dropped)'
      : 'execution was cancelled',
  );
}
