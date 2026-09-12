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
 * transaction wrapping for writes on this same serial connection; server
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
}

interface ReplyMessage {
  id?: number;
  ok: boolean;
  payload?: unknown;
  error?: string;
}

const DB_ENV = 'DSH_DB_CONNECTOR_SQLITE_DATABASE';

export class SqliteDriver implements DriverApi {
  readonly kind = 'sqlite' as const;
  private child: ChildProcess | null = null;
  private closed = false;
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

  private request(
    op: Op,
    signal: AbortSignal,
    extra?: Partial<Omit<RequestMessage, 'id' | 'op'>>,
  ): Promise<unknown> {
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
          this.refDrop(child);
          // Drop the driver's reference immediately so the next request spawns
          // a fresh child even before this one's exit event lands.
          if (this.child === child) this.child = null;
          this.dropped.add(child);
          // Hard-kill works even while the child is blocked in native SQLite
          // and never blocks this process from exiting.
          child.kill('SIGKILL');
          reject(cancelError(signal));
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
      if (err instanceof DbConnectorError && err.code === ErrorCode.ConnectionNotFound) {
        const fresh = this.ensureChild();
        if (fresh !== child) return dispatch(++this.seq, fresh);
      }
      throw err;
    });
  }

  async connect(): Promise<void> {
    // Verify the database opens and is queryable; surface failures loudly.
    await this.request('query', new AbortController().signal, { sql: 'SELECT 1' });
  }

  async read(sql: string, params: unknown[], signal: AbortSignal): Promise<ReadOutcome> {
    return (await this.request('query', signal, { sql, params })) as ReadOutcome;
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
    const child = this.child;
    this.child = null;
    // reject any still-in-flight requests to the current (and stale) children
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      this.refDrop(entry.child);
      entry.reject(new DbConnectorError(ErrorCode.ConnectionNotFound, 'connection closed'));
    }
    if (child) this.inFlight.delete(child);
    if (child && child.exitCode === null && child.connected) {
      try {
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
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }
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
