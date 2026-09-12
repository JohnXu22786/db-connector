/**
 * PostgreSQL driver over the optional `pg` package (peer dependency). Uses
 * prepared-style parameterized queries (`$1..$n`) so values never touch SQL
 * text, tracks cancellation through pg's query cancellation API, and wraps
 * transactional writes in an explicit transaction (COMMIT / ROLLBACK).
 */

import { ErrorCode, DbConnectorError } from '../errors.js';
import { isNonTransactionalStatement, toDollarPlaceholders } from '../sql.js';
import type { ResolvedConnectionSpec } from '../types.js';
import type { DriverApi, DriverLogger, Introspection, ReadOutcome, WriteOutcome } from './driver.js';
import { importOptional, redactSpecMessage } from './driver.js';

/**
 * The `pg` package is an optional peer dependency, so we use a small
 * structural view of its client instead of importing its types.
 */
interface PgQueryResult {
  fields: Array<{ name: string }>;
  rows: Array<Record<string, unknown>>;
  rowCount: number | null;
}

interface PgArrayQueryResult extends Omit<PgQueryResult, 'rows'> {
  rows: unknown[][];
}

interface PgQueryConfig {
  text: string;
  values?: unknown[];
  name?: string;
  rowMode?: 'array';
}

type PgQueryHandle = object;
type PgQueryCallback = (err: Error | null, result?: PgQueryResult) => void;
type PgQueryConstructor = new (
  config: PgQueryConfig,
  values?: unknown[],
  callback?: PgQueryCallback,
) => PgQueryHandle;

interface PgQueryable {
  query(query: PgQueryHandle): PgQueryHandle;
  query(text: string): Promise<PgQueryResult>;
}

type PgEventListener = (...args: unknown[]) => void;

interface PgStreamLike {
  destroy(error?: Error): void;
}

interface PgEventSource {
  on(event: string, listener: PgEventListener): void;
  removeListener?(event: string, listener: PgEventListener): void;
}

interface PgConnectionLike extends PgEventSource {
  stream?: PgStreamLike;
  sslNegotiation?: string;
  connect(portOrPath: number | string, host?: string): void;
  requestSsl?(): void;
  cancel?(processID: number | null, secretKey: number | null): void;
}

interface PgClientLike extends PgQueryable {
  connect(): Promise<void>;
  end(): Promise<void>;
  host?: string;
  port?: number;
  ssl?: unknown;
  sslNegotiation?: string;
  processID?: number | null;
  secretKey?: number | null;
  activeQuery?: PgQueryHandle;
  _activeQuery?: PgQueryHandle;
  _queryQueue?: PgQueryHandle[];
  _sentQueryQueue?: PgQueryHandle[];
  pipeline?: boolean;
  _pipelineInFlight?: boolean;
  connection?: PgConnectionLike;
  cancel(...args: unknown[]): unknown;
}

type PgClientConfig = Record<string, unknown>;
type PgClientConstructor = new (config?: PgClientConfig) => PgClientLike;

type PgModule = {
  Client: PgClientConstructor;
  Query: PgQueryConstructor;
};

async function loadPgModule(): Promise<PgModule> {
  const raw = await importOptional<Record<string, unknown>>('pg');
  const holder = raw as unknown as { default?: unknown };
  const ns = (holder.default ?? raw) as Record<string, unknown>;
  const Client = ns.Client;
  if (typeof Client !== 'function') {
    throw new Error('the "pg" package did not expose a Client constructor');
  }
  const Query = ns.Query;
  if (typeof Query !== 'function') {
    throw new Error('the "pg" package did not expose a Query constructor');
  }
  return { Client: Client as PgModule['Client'], Query: Query as PgQueryConstructor };
}

export class PgDriver implements DriverApi {
  readonly kind = 'postgres' as const;
  private client: PgClientLike | null = null;
  private clientConstructor: PgClientConstructor | null = null;
  private queryConstructor: PgQueryConstructor | null = null;
  private clientConfig: PgClientConfig | null = null;
  private readonly clientErrorListeners = new WeakMap<PgClientLike, PgEventListener>();
  private closed = false;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly spec: ResolvedConnectionSpec,
    private readonly logger: DriverLogger,
  ) {}

  async connect(): Promise<void> {
    await this.withOperationLock(async () => {
      if (this.client) return;
      const { Client, Query } = await loadPgModule();
      const clientConfig: PgClientConfig = {
        host: this.spec.host,
        port: this.spec.port,
        user: this.spec.user,
        password: this.spec.password || undefined,
        database: this.spec.database || 'postgres',
        ssl: normalizeSsl(this.spec.ssl),
        connectionString: this.spec.connectionString,
        ...this.spec.options,
      };
      const client = new Client(clientConfig);
      this.attachClientErrorHandler(client);
      try {
        await client.connect();
        await client.query('SELECT 1');
      } catch (err) {
        void client.end().catch(() => {});
        throw toConnectorError(this.spec, err);
      }
      this.clientConstructor = Client;
      this.queryConstructor = Query;
      this.clientConfig = clientConfig;
      this.client = client;
    });
  }

  private async withOperationLock<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const previous = this.operationTail;
    let release!: () => void;
    this.operationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    let acquired = false;
    try {
      await waitForOperationLock(previous, signal);
      acquired = true;
      return await operation();
    } finally {
      if (acquired) {
        release();
      } else {
        // An aborted waiter must not let a later operation overtake the
        // operation it was queued behind. Release this queue entry only once
        // the prior operation has finished.
        void previous.then(release, release);
      }
    }
  }

  private ensure(): PgClientLike {
    if (!this.client || this.closed) {
      throw new DbConnectorError(
        ErrorCode.ConnectionNotFound,
        `connection "${this.spec.name}" is not connected`,
      );
    }
    this.attachClientErrorHandler(this.client);
    return this.client;
  }

  private attachClientErrorHandler(client: PgClientLike): void {
    if (this.clientErrorListeners.has(client)) return;
    const events = client as unknown as PgEventSource;
    if (typeof events.on !== 'function') return;
    const listener: PgEventListener = (err) => {
      // A stream error may be delivered after cancellation has already
      // invalidated this client. Keep the listener attached so that delayed
      // EventEmitter errors cannot become uncaught process errors.
      if (this.client === client) this.invalidateClient(client, err, false);
    };
    events.on('error', listener);
    this.clientErrorListeners.set(client, listener);
  }

  private invalidateClient(client: PgClientLike, cause: unknown, destroy = true): void {
    if (this.client !== client) return;
    this.client = null;
    this.clientConstructor = null;
    this.queryConstructor = null;
    this.clientConfig = null;
    if (destroy) destroyPgClientConnection(client, cause);
    void client.end().catch(() => {});
  }

  async read(sql: string, params: unknown[], signal: AbortSignal): Promise<ReadOutcome> {
    return this.withOperationLock(() => this.readUnlocked(sql, params, signal), signal);
  }

  private async readUnlocked(
    sql: string,
    params: unknown[],
    signal: AbortSignal,
  ): Promise<ReadOutcome> {
    const client = this.ensure();
    const converted = toDollarPlaceholders(sql);
    try {
      // Server-side read-only backstop: even a statement that slips past the
      // classifier cannot mutate data inside a READ ONLY transaction.
      await client.query('BEGIN TRANSACTION READ ONLY');
      try {
        const result = await queryWithCancellation(
          client,
          this.clientConstructor!,
          this.queryConstructor!,
          this.clientConfig!,
          {
            text: converted.sql,
            values: params,
            rowMode: 'array',
          },
          signal,
        );
        await client.query('ROLLBACK');
        return outcomeOf(result as unknown as PgArrayQueryResult);
      } catch (err) {
        if (isCancellationFailure(err)) {
          this.invalidateClient(client, err);
        } else {
          await client.query('ROLLBACK').catch(() => {});
        }
        throw err;
      }
    } catch (err) {
      if (isCancellationFailure(err)) this.invalidateClient(client, err);
      throw toConnectorError(this.spec, err);
    }
  }

  async write(
    sql: string,
    params: unknown[],
    isDdl: boolean,
    signal: AbortSignal,
  ): Promise<WriteOutcome> {
    return this.withOperationLock(() => this.writeUnlocked(sql, params, isDdl, signal), signal);
  }

  private async writeUnlocked(
    sql: string,
    params: unknown[],
    isDdl: boolean,
    signal: AbortSignal,
  ): Promise<WriteOutcome> {
    const client = this.ensure();
    const converted = toDollarPlaceholders(sql);
    try {
      // PostgreSQL rejects VACUUM and concurrent-index operations in a transaction.
      if (isNonTransactionalStatement(sql, 'postgres')) {
        const result = await queryWithCancellation(
          client,
          this.clientConstructor!,
          this.queryConstructor!,
          this.clientConfig!,
          { text: converted.sql, values: params },
          signal,
        );
        return { affectedRows: result.rowCount ?? 0, isDdl };
      }

      await client.query('BEGIN');
      try {
        const result = await queryWithCancellation(
          client,
          this.clientConstructor!,
          this.queryConstructor!,
          this.clientConfig!,
          { text: converted.sql, values: params },
          signal,
        );
        await client.query('COMMIT');
        return { affectedRows: result.rowCount ?? 0, isDdl };
      } catch (err) {
        if (isCancellationFailure(err)) {
          this.invalidateClient(client, err);
        } else {
          await client.query('ROLLBACK').catch(() => {});
        }
        throw err;
      }
    } catch (err) {
      if (isCancellationFailure(err)) this.invalidateClient(client, err);
      throw toConnectorError(this.spec, err);
    }
  }

  async introspect(signal: AbortSignal): Promise<Introspection> {
    return this.withOperationLock(() => this.introspectUnlocked(signal), signal);
  }

  private async introspectUnlocked(signal: AbortSignal): Promise<Introspection> {
    const client = this.ensure();
    const schema = this.spec.schema || 'public';
    const queries = [
      queryWithCancellation(client, this.clientConstructor!, this.queryConstructor!, this.clientConfig!, { ...QUERIES.tables, values: [schema] }, signal, (err) => this.invalidateClient(client, err)),
      queryWithCancellation(client, this.clientConstructor!, this.queryConstructor!, this.clientConfig!, { ...QUERIES.views, values: [schema] }, signal, (err) => this.invalidateClient(client, err)),
      queryWithCancellation(client, this.clientConstructor!, this.queryConstructor!, this.clientConfig!, { ...QUERIES.columns, values: [schema] }, signal, (err) => this.invalidateClient(client, err)),
      queryWithCancellation(client, this.clientConstructor!, this.queryConstructor!, this.clientConfig!, { ...QUERIES.primaryKeys, values: [schema] }, signal, (err) => this.invalidateClient(client, err)),
      queryWithCancellation(client, this.clientConstructor!, this.queryConstructor!, this.clientConfig!, { ...QUERIES.indexes, values: [schema] }, signal, (err) => this.invalidateClient(client, err)),
      queryWithCancellation(client, this.clientConstructor!, this.queryConstructor!, this.clientConfig!, { ...QUERIES.foreignKeys, values: [schema] }, signal, (err) => this.invalidateClient(client, err)),
    ] as const;
    try {
      const [tables, views, columns, pks, indexes, fks] = await Promise.all(queries);
      const pkRows = pks.rows as Array<{ table_name: string; column_name: string }>;
      const pkByTable = new Map<string, Set<string>>();
      for (const row of pkRows) {
        let set = pkByTable.get(row.table_name);
        if (!set) {
          set = new Set();
          pkByTable.set(row.table_name, set);
        }
        set.add(row.column_name);
      }
      return {
        tables: tables.rows.map((r) => ({ name: r.table_name as string })),
        views: views.rows.map((r) => ({ name: r.table_name as string })),
        columns: columns.rows.map((r) => ({
          table: r.table_name as string,
          name: r.column_name as string,
          type: r.data_type as string,
          nullable: !(r.is_nullable === 'NO'),
          ordinal: Number(r.ordinal_position),
          default: (r.column_default as string | null) ?? null,
          primaryKey: pkByTable.get(r.table_name as string)?.has(r.column_name as string) ?? false,
        })),
        indexes: indexes.rows.map((r) => ({
          name: r.index_name as string,
          table: r.table_name as string,
          columns: (r.column_names as string[]).filter(Boolean),
          unique: Boolean(r.is_unique),
          primary: Boolean(r.is_primary),
        })),
        foreignKeys: fks.rows.map((r) => ({
          name: r.constraint_name as string,
          table: r.table_name as string,
          columns: (r.column_names as string[]),
          referencedTable: r.referenced_table as string,
          referencedColumns: (r.referenced_columns as string[]),
          onUpdate: (r.on_update as string | null) ?? undefined,
          onDelete: (r.on_delete as string | null) ?? undefined,
        })),
      } as Introspection;
    } catch (err) {
      // Promise.all rejects on the first queued cancellation, but the active
      // query may still be waiting for its cancellation connection to fail.
      // Keep the operation lock held until every query has settled so that
      // the failure callback can invalidate the shared client first.
      const settled = await Promise.allSettled(queries);
      for (const result of settled) {
        if (result.status === 'rejected' && isCancellationFailure(result.reason)) {
          this.invalidateClient(client, result.reason);
          throw toConnectorError(this.spec, result.reason);
        }
      }
      if (isCancellationFailure(err)) this.invalidateClient(client, err);
      throw toConnectorError(this.spec, err);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.withOperationLock(async () => {
      const client = this.client;
      this.client = null;
      this.clientConstructor = null;
      this.queryConstructor = null;
      this.clientConfig = null;
      if (client) await client.end().catch(() => {});
    });
  }
}

class PgCancellationFailure extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.cause = cause;
    this.name = 'PgCancellationFailure';
  }
}

function isCancellationFailure(err: unknown): err is PgCancellationFailure {
  return err instanceof PgCancellationFailure;
}

function destroyPgClientConnection(client: PgClientLike, cause: unknown): void {
  const stream = client.connection?.stream;
  if (!stream) return;
  const error = cause instanceof Error ? cause : new Error(String(cause));
  try {
    stream.destroy(error);
  } catch {
    // The cancellation error is already being propagated to the caller.
  }
}

function cancelQuery(
  client: PgClientLike,
  Client: PgClientConstructor,
  clientConfig: PgClientConfig,
  query: PgQueryHandle,
  onError: (err: unknown) => void,
): () => void {
  if (client.cancel.length <= 1) {
    // pg-native's API cancels the query on the connected client directly.
    client.cancel(query);
    return () => {};
  }

  // The pure-JS pg implementation uses this client's connection only to
  // send a CancelRequest for the target client's active query.
  const cancelClient = new Client({ ...clientConfig });
  const sources = new Set<PgEventSource>();
  const listeners: Array<{ source: PgEventSource; event: string; listener: PgEventListener }> = [];
  const connection = cancelClient.connection;
  if (connection) sources.add(connection);
  const cancelClientEvents = cancelClient as unknown as PgEventSource;
  if (typeof cancelClientEvents.on === 'function') sources.add(cancelClientEvents);
  if (sources.size === 0) {
    throw new Error('pg cancellation client did not expose an error event source');
  }

  const errorListener: PgEventListener = (err) => onError(err);
  const addListener = (source: PgEventSource, event: string, listener: PgEventListener) => {
    source.on(event, listener);
    listeners.push({ source, event, listener });
  };
  for (const source of sources) addListener(source, 'error', errorListener);
  try {
    if (cancelClient.ssl) {
      if (!connection || !connection.cancel) {
        throw new Error('pg cancellation connection does not support TLS cancellation');
      }
      const sslNegotiation = cancelClient.sslNegotiation ?? connection.sslNegotiation ?? 'postgres';
      if (sslNegotiation !== 'direct' && !connection.requestSsl) {
        throw new Error('pg cancellation connection does not support TLS cancellation');
      }
      const onConnect: PgEventListener = () => {
        try {
          connection.requestSsl!();
        } catch (err) {
          onError(err);
        }
      };
      const onSslConnect: PgEventListener = () => {
        try {
          if (client.processID == null || client.secretKey == null) {
            throw new Error('pg client did not expose cancellation credentials');
          }
          connection.cancel!(client.processID, client.secretKey);
        } catch (err) {
          onError(err);
        }
      };
      if (sslNegotiation !== 'direct') {
        addListener(connection, 'connect', onConnect);
      }
      addListener(connection, 'sslconnect', onSslConnect);
      const port = cancelClient.port ?? client.port ?? 5432;
      const host = cancelClient.host ?? client.host;
      if (host?.startsWith('/')) {
        connection.connect(`${host}/.s.PGSQL.${port}`);
      } else {
        connection.connect(port, host);
      }
    } else {
      const result = cancelClient.cancel(client, query);
      if (isPromiseLike(result)) void result.catch(onError);
    }
  } catch (err) {
    for (const { source, event, listener } of listeners) {
      source.removeListener?.(event, listener);
    }
    throw err;
  }

  return () => {
    for (const { source, event, listener } of listeners) {
      source.removeListener?.(event, listener);
    }
  };
}

type PgPromiseLike = {
  catch(onRejected: (reason: unknown) => unknown): unknown;
};

function isPromiseLike(value: unknown): value is PgPromiseLike {
  return typeof value === 'object' && value !== null &&
    typeof (value as { then?: unknown }).then === 'function' &&
    typeof (value as { catch?: unknown }).catch === 'function';
}

/** Execute a pg 8.13 query with callback access to the handle used for cancel. */
function queryWithCancellation(
  client: PgClientLike,
  Client: PgClientConstructor,
  Query: PgQueryConstructor,
  clientConfig: PgClientConfig,
  config: PgQueryConfig,
  signal: AbortSignal,
  onCancellationFailure?: (err: unknown) => void,
): Promise<PgQueryResult> {
  if (signal.aborted) return Promise.reject(cancelError(signal));

  return new Promise<PgQueryResult>((resolve, reject) => {
    let query: PgQueryHandle | undefined;
    let settled = false;
    let cancelRequested = false;
    let cancelSent = false;
    let cancellationWaitsForDrain = false;
    let removeCancellationErrorListener: (() => void) | undefined;

    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
      removeCancellationErrorListener?.();
      removeCancellationErrorListener = undefined;
    };
    const finish = (handler: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      handler();
    };
    const failCancellation = (err: unknown) => {
      if (settled) return;
      destroyPgClientConnection(client, err);
      onCancellationFailure?.(err);
      finish(() => reject(new PgCancellationFailure(err)));
    };
    const requestCancel = () => {
      if (!query || cancelSent || settled) return;
      cancelSent = true;
      const position = queryPosition(client, query);
      if (position !== 'active') {
        try {
          if (position === 'sent') {
            cancellationWaitsForDrain = true;
            const removeDrainListener = waitForPipelineDrain(
              client,
              () => finish(() => reject(cancelError(signal))),
              failCancellation,
            );
            if (settled) removeDrainListener();
            else removeCancellationErrorListener = removeDrainListener;
          }
          const result = client.cancel.length <= 1
            ? client.cancel(query)
            : client.cancel(client, query);
          if (isPromiseLike(result)) void result.catch(failCancellation);
          if (position !== 'sent') finish(() => reject(cancelError(signal)));
        } catch (err) {
          failCancellation(err);
        }
        return;
      }
      try {
        const removeErrorListener = cancelQuery(
          client,
          Client,
          clientConfig,
          query,
          failCancellation,
        );
        if (settled) removeErrorListener();
        else removeCancellationErrorListener = removeErrorListener;
      } catch (err) {
        failCancellation(err);
        return;
      }
    };
    const onAbort = () => {
      if (settled || cancelRequested) return;
      cancelRequested = true;
      requestCancel();
    };

    signal.addEventListener('abort', onAbort, { once: true });
    try {
      query = new Query(config, undefined, (err, result) => {
        if (settled) return;
        if (cancelRequested) {
          if (cancellationWaitsForDrain) return;
          finish(() => reject(cancelError(signal)));
        } else if (err) {
          finish(() => reject(err));
        } else if (!result) {
          finish(() => reject(new Error('pg returned no query result')));
        } else {
          finish(() => resolve(result));
        }
      });
      client.query(query);
    } catch (err) {
      finish(() => reject(err));
      return;
    }

    // An abort can happen synchronously while pg is creating the query. The
    // handle is available after query() returns, so retry the cancellation.
    if (signal.aborted && !cancelRequested) onAbort();
    if (cancelRequested) requestCancel();
  });
}

function isActiveQuery(client: PgClientLike, query: PgQueryHandle): boolean {
  // pg 8.13 exposes the active handle through _activeQuery; older/custom
  // clients may only expose activeQuery.
  const privateActiveQuery = client._activeQuery;
  return privateActiveQuery !== undefined
    ? privateActiveQuery === query
    : client.activeQuery === query;
}

type PgQueryPosition = 'active' | 'queued' | 'sent' | 'unknown';

function queryPosition(client: PgClientLike, query: PgQueryHandle): PgQueryPosition {
  if (isActiveQuery(client, query)) return 'active';
  if (client._queryQueue?.includes(query)) return 'queued';
  if (client._sentQueryQueue?.includes(query)) return 'sent';
  // pg-native does not expose _sentQueryQueue while a native pipeline is in
  // flight. Any handle that is no longer queued or active is already on wire.
  if (client.pipeline && client._pipelineInFlight) return 'sent';
  return 'unknown';
}

function waitForPipelineDrain(
  client: PgClientLike,
  onDrain: () => void,
  onError: (err: unknown) => void,
): () => void {
  const clientEvents = client as unknown as PgEventSource;
  if (typeof clientEvents.on !== 'function') {
    throw new Error('pg pipeline client did not expose drain events');
  }

  const sources = new Set<PgEventSource>([clientEvents]);
  if (client.connection) sources.add(client.connection);
  const listeners: Array<{ source: PgEventSource; event: string; listener: PgEventListener }> = [];
  const addListener = (source: PgEventSource, event: string, listener: PgEventListener) => {
    source.on(event, listener);
    listeners.push({ source, event, listener });
  };
  addListener(clientEvents, 'drain', () => onDrain());
  const errorListener: PgEventListener = (err) => onError(err);
  for (const source of sources) addListener(source, 'error', errorListener);

  return () => {
    for (const { source, event, listener } of listeners) {
      source.removeListener?.(event, listener);
    }
  };
}

function outcomeOf(result: PgArrayQueryResult): ReadOutcome {
  const columns = result.fields.map((f) => f.name);
  const rows = result.rows.map((row) => row.map((value) => value ?? null));
  return { columns, rows, rowCount: rows.length };
}

function normalizeSsl(ssl: unknown): boolean | object | undefined {
  if (ssl === undefined || ssl === null) return undefined;
  return ssl;
}

function cancelError(signal: AbortSignal): DbConnectorError {
  const reason = signal.reason;
  const isTimeout = reason instanceof Error && /timeout/i.test(reason.message);
  return new DbConnectorError(
    isTimeout ? ErrorCode.Timeout : ErrorCode.Cancelled,
    isTimeout ? 'query exceeded its time limit' : 'execution was cancelled',
  );
}

function waitForOperationLock(
  previous: Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) return previous;
  if (signal.aborted) return Promise.reject(cancelError(signal));

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(cancelError(signal));
    };

    signal.addEventListener('abort', onAbort, { once: true });
    previous.then(
      () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      },
      (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      },
    );
    if (signal.aborted) onAbort();
  });
}

function toConnectorError(
  spec: ResolvedConnectionSpec,
  err: unknown,
): DbConnectorError {
  if (err instanceof DbConnectorError) return err;
  const message = err instanceof Error ? err.message : String(err);
  // pg error objects carry .code; surface a stable code + sanitized text.
  return new DbConnectorError(ErrorCode.QueryFailed, redactSpecMessage(spec, message));
}

/** Introspection queries, parameterized by target schema (placeholder $1..$n). */
const QUERIES = {
  tables: {
    name: 'dsh-db-connector.tables',
    text: `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name`,
  },
  views: {
    name: 'dsh-db-connector.views',
    text: `SELECT table_name FROM information_schema.views
       WHERE table_schema = $1 ORDER BY table_name`,
  },
  columns: {
    name: 'dsh-db-connector.columns',
    text: `SELECT table_name, column_name, data_type, is_nullable, ordinal_position, column_default
       FROM information_schema.columns WHERE table_schema = $1
       ORDER BY table_name, ordinal_position`,
  },
  primaryKeys: {
    name: 'dsh-db-connector.primary-keys',
    text: `SELECT tc.table_name, kcu.column_name, tc.constraint_name
       FROM information_schema.table_constraints AS tc
       JOIN information_schema.key_column_usage AS kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1
       ORDER BY tc.table_name, kcu.ordinal_position`,
  },
  indexes: {
    name: 'dsh-db-connector.indexes',
    text: `SELECT i.relname AS index_name, t.relname AS table_name,
       idx.indisunique AS is_unique, idx.indisprimary AS is_primary,
       array_agg(
         CASE WHEN k.attnum = 0
              THEN pg_get_indexdef(idx.indexrelid, k.ord::integer, true)
              ELSE a.attname::text
          END ORDER BY k.ord
       ) AS column_names
       FROM pg_index idx
       JOIN pg_class t ON t.oid = idx.indrelid
       JOIN pg_class i ON i.oid = idx.indexrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       JOIN LATERAL unnest(idx.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
       LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
       WHERE n.nspname = $1 AND t.relkind = 'r'
       GROUP BY i.relname, t.relname, idx.indisunique, idx.indisprimary
       ORDER BY t.relname, i.relname`,
  },
  foreignKeys: {
    name: 'dsh-db-connector.foreign-keys',
    text: `SELECT rc.constraint_name,
       tc.table_name,
       array_agg(kcu.column_name) AS column_names,
       ccu.table_name AS referenced_table,
       (SELECT array_agg(x.column_name ORDER BY x.ordinal_position)
          FROM information_schema.key_column_usage x
         WHERE x.constraint_name = rc.constraint_name AND x.constraint_schema = $1
           AND x.position_in_unique_constraint IS NOT NULL) AS referenced_columns,
       rc.update_rule AS on_update, rc.delete_rule AS on_delete
       FROM information_schema.referential_constraints AS rc
       JOIN information_schema.table_constraints AS tc
         ON tc.constraint_name = rc.constraint_name AND tc.constraint_schema = $1
       JOIN information_schema.key_column_usage AS kcu
         ON kcu.constraint_name = rc.constraint_name AND kcu.constraint_schema = $1
       JOIN information_schema.constraint_column_usage AS ccu
         ON ccu.constraint_name = rc.unique_constraint_name
      WHERE ccu.constraint_schema = $1
       GROUP BY rc.constraint_name, tc.table_name, rc.update_rule, rc.delete_rule, ccu.table_name
       ORDER BY tc.table_name, rc.constraint_name`,
  },
};
