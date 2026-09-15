/**
 * Execution engine: the single pipeline every tool / command goes through.
 *
 * Responsibilities, in order:
 *   1. resolve the named connection (lazy open + credential resolution)
 *   2. enforce single-statement input
 *   3. classify the statement; enforce the read-only / write-approval gates
 *   4. bind parameters (positional `?` or named `:param`), never interpolated
 *   5. apply the SELECT guard limit + row cap + deadline (AbortSignal)
 *   6. execute through the driver (transaction protection where supported)
 *   7. write one durable audit record (ok / error / denied) for every call
 *
 * The engine never sees credentials and never logs them; only the sanitized
 * connection name crosses these boundaries.
 */

import { ErrorCode, DbConnectorError } from './errors.js';
import {
  assertSingleStatement,
  classifyStatement,
  ensureSelectLimit,
  isNonTransactionalStatement,
  isReadStatement,
  rewriteNamedToPositional,
  scan,
} from './sql.js';
import { capRows, serializeValue } from './serialize.js';
import { createDeadlineSignal, hrtimeMs } from './util.js';
import type { AuditLog } from './audit.js';
import type { Connectors, ResolveCredentials } from './connectors.js';
import type { SchemaService } from './schema.js';
import type {
  AuditRecord,
  ConnectionSpec,
  ConnectorStatus,
  ExecResult,
  QueryResult,
  ResolvedConfig,
  SchemaResult,
  StatementKind,
  WayKind,
  DriverKind,
} from './types.js';

export interface EngineOptions {
  connectors: Connectors;
  audit: AuditLog;
  config: ResolvedConfig;
  schema: SchemaService;
  resolveCredentials?: ResolveCredentials;
  logger?: { debug(...a: unknown[]): void; info(...a: unknown[]): void; warn(...a: unknown[]): void };
}

export interface QueryOptions {
  connection: string;
  sql: string;
  params?: unknown[];
  namedParams?: Record<string, unknown>;
  limit?: number;
  timeoutMs?: number;
  way: WayKind;
}

export interface ExecOptions {
  connection: string;
  sql: string;
  params?: unknown[];
  namedParams?: Record<string, unknown>;
  allowWrite?: boolean;
  timeoutMs?: number;
  way: WayKind;
}

export interface SchemaOptions {
  connection: string;
  refresh?: boolean;
  filter?: string;
  timeoutMs?: number;
  way: WayKind;
}

export interface AuditOptions {
  connection?: string;
  kind?: AuditRecord['kind'];
  since?: string;
  limit?: number;
}

interface BindResult {
  sql: string;
  values: unknown[];
}

const NOOP_LOGGER = { debug() {}, info() {}, warn() {} };

export class ExecutionEngine {
  private readonly connectors: Connectors;
  private readonly auditLog: AuditLog;
  private readonly config: ResolvedConfig;
  private readonly schemaService: SchemaService;
  private readonly resolveCredentials?: ResolveCredentials;
  private readonly logger: { debug(...a: unknown[]): void; info(...a: unknown[]): void; warn(...a: unknown[]): void };

  constructor(opts: EngineOptions) {
    this.connectors = opts.connectors;
    this.auditLog = opts.audit;
    this.config = opts.config;
    this.schemaService = opts.schema;
    this.resolveCredentials = opts.resolveCredentials;
    this.logger = opts.logger ?? NOOP_LOGGER;
  }

  // ===== connection lifecycle =====

  /** Define + open a connection (used by db_connect / CLI). Idempotent by
   *  name: a config-pre-registered or previously connected name is reopened
   *  (or returned as-is) rather than rejected as a duplicate. */
  async connect(spec: ConnectionSpec): Promise<ConnectorStatus> {
    const name = spec.name;
    if (this.connectors.has(name)) return this.realize(name);
    try {
      this.connectors.define(spec);
      return await this.realize(name);
    } catch (err) {
      // drop the definition on a failed open so a retry can redefine it
      await this.connectors.close(name).catch(() => {});
      throw err;
    }
  }

  private async realize(name: string): Promise<ConnectorStatus> {
    try {
      await this.connectors.open(name, this.resolveCredentials);
    } catch (err) {
      throw err; // definition is preserved for a later retry
    }
    this.connectors.touch(name);
    return this.statusOf(name);
  }

  private statusOf(name: string): ConnectorStatus {
    const status = this.connectors.describe(name);
    if (status) return status;
    throw new DbConnectorError(
      ErrorCode.ConnectionNotFound,
      `connection "${name}" is not defined; run db_connect first`,
    );
  }

  async close(name: string): Promise<void> {
    await this.connectors.close(name);
    this.schemaService.invalidate(name);
  }

  async listConnections(): Promise<{ connections: ConnectorStatus[] }> {
    return { connections: this.connectors.list() };
  }

  // ===== statement execution =====

  /**
   * Read-only query. Any non read statement (INSERT/UPDATE/DELETE/DDL/unknown)
   * is denied and audited before anything reaches a database.
   */
  async query(opts: QueryOptions, signal: AbortSignal): Promise<QueryResult> {
    const driverKind = this.connectors.describe(opts.connection)?.driver;
    const classification = classifyStatement(opts.sql, driverKind);
    try {
      assertSingleStatement(opts.sql, driverKind);
    } catch (err) {
      await this.auditFail(opts.connection, opts.sql, 'query', 0, opts.way, err);
      throw err;
    }

    if (!isReadStatement(opts.sql, driverKind)) {
      await this.auditDenied(opts.connection, opts.sql, classification.kind, ErrorCode.ReadOnlyViolation, opts.way);
      throw new DbConnectorError(
        ErrorCode.ReadOnlyViolation,
        `read-only path: "${classification.firstWord || 'statement'}" statements are not allowed in db_query; use db_exec with allowWrite=true for writes`,
      );
    }

    let bound: BindResult;
    let limit: number;
    let guarded: { sql: string; applied: boolean };
    try {
      bound = this.bind(opts.sql, opts.params, opts.namedParams, driverKind);
      limit = this.effectiveLimit(opts.limit);
      guarded =
        classification.kind === 'select'
          ? ensureSelectLimit(bound.sql, limit, driverKind)
          : { sql: bound.sql, applied: false };
    } catch (err) {
      await this.auditFail(opts.connection, opts.sql, 'query', 0, opts.way, err);
      throw err;
    }
    const protectedSql = guarded.sql;

    const openStarted = process.hrtime();
    let driver;
    try {
      driver = await this.requireDriver(opts.connection);
    } catch (err) {
      await this.auditFail(opts.connection, opts.sql, 'query', hrtimeMs(openStarted), opts.way, err);
      throw err;
    }
    let deadline: ReturnType<ExecutionEngine['deadline']>;
    try {
      deadline = this.deadline(opts.timeoutMs, signal);
    } catch (err) {
      await this.auditFail(opts.connection, opts.sql, 'query', 0, opts.way, err);
      throw err;
    }
    const started = process.hrtime();
    let outcome;
    try {
      outcome = await driver.read(protectedSql, bound.values, deadline.signal, limit);
    } catch (err) {
      const duration = hrtimeMs(started);
      await this.auditFail(opts.connection, opts.sql, 'query', duration, opts.way, err);
      throw err;
    } finally {
      deadline.clear();
    }
    const duration = hrtimeMs(started);

    const { rows, truncated: sliced } = capRows(outcome.rows, limit);
    // "truncated" reflects THIS call's cap: the server-side guard applied and
    // returned exactly the cap, or the client-side slice cut rows. A query
    // that happens to have exactly the cap rows reads as truncated too — a
    // documented ambiguity.
    const truncated =
      sliced ||
      outcome.truncated === true ||
      (guarded.applied && outcome.rows.length === limit);
    const serialized = rows.map((r) => r.map(serializeValue));
    this.connectors.touch(opts.connection);
    const auditId = await this.auditOk({
      connection: opts.connection,
      kind: 'query',
      way: opts.way,
      sql: protectedSql,
      rows: serialized.length,
      durationMs: duration,
    });
    return {
      kind: 'query',
      connection: opts.connection,
      columns: outcome.columns,
      rows: serialized,
      rowCount: serialized.length,
      durationMs: duration,
      truncated,
      limit,
      auditId,
    };
  }

  /**
   * Write-capable executor. INSERT/UPDATE/DELETE/DDL (and anything the
   * classifier cannot read) require the approval gate: `allowWrite` on the
   * call or the plugin-level `defaultAllowWrite`. Drivers use transaction
   * protection where supported; some statements must run outside a transaction.
   */
  async exec(opts: ExecOptions, signal: AbortSignal): Promise<ExecResult> {
    const driverKind = this.connectors.describe(opts.connection)?.driver;
    const classification = classifyStatement(opts.sql, driverKind);
    const readLike = classification.kind === 'select' || classification.kind === 'explain';
    const openAuditKind = readLike ? 'read' : classification.kind === 'ddl' ? 'ddl' : 'write';

    try {
      assertSingleStatement(opts.sql, driverKind);
    } catch (err) {
      await this.auditFail(opts.connection, opts.sql, openAuditKind, 0, opts.way, err);
      throw err;
    }

    if (!readLike) {
      const allowed = opts.allowWrite === true || this.config.defaultAllowWrite === true;
      if (!allowed) {
        await this.auditDenied(opts.connection, opts.sql, classification.kind, ErrorCode.WriteNotAllowed, opts.way);
        throw new DbConnectorError(
          ErrorCode.WriteNotAllowed,
          `write approval gate: "${classification.firstWord || 'statement'}" is a write; pass allowWrite=true to confirm (transaction protection is used where supported; some statements must execute outside a transaction)`,
        );
      }
    }

    let bound: BindResult;
    try {
      bound = this.bind(opts.sql, opts.params, opts.namedParams, driverKind);
    } catch (err) {
      await this.auditFail(opts.connection, opts.sql, openAuditKind, 0, opts.way, err);
      throw err;
    }
    const readLimit = readLike ? this.effectiveLimit(undefined) : undefined;
    const protectedSql =
      classification.kind === 'select'
        ? ensureSelectLimit(bound.sql, readLimit!, driverKind).sql
        : bound.sql;
    const openStarted = process.hrtime();
    let driver;
    try {
      driver = await this.requireDriver(opts.connection);
    } catch (err) {
      await this.auditFail(opts.connection, opts.sql, openAuditKind, hrtimeMs(openStarted), opts.way, err);
      throw err;
    }
    let deadline: ReturnType<ExecutionEngine['deadline']>;
    try {
      deadline = this.deadline(opts.timeoutMs, signal);
    } catch (err) {
      await this.auditFail(opts.connection, opts.sql, openAuditKind, 0, opts.way, err);
      throw err;
    }
    const started = process.hrtime();
    const isDdl = classification.kind === 'ddl';
    // The classifier deliberately leaves PRAGMA as unknown because it may
    // write. The driver still needs to bypass its transaction wrapper for
    // approved non-transactional forms such as SQLite journal_mode changes.
    const nonTransactional = isNonTransactionalStatement(bound.sql, driver.kind);

    try {
      if (readLike) {
        const outcome = await driver.read(
          protectedSql,
          bound.values,
          deadline.signal,
          readLimit,
        );
        const { rows } = capRows(outcome.rows, readLimit!);
        this.connectors.touch(opts.connection);
        const auditId = await this.auditOk({
          connection: opts.connection,
          kind: 'read',
          way: opts.way,
          sql: opts.sql,
          rows: rows.length,
          durationMs: hrtimeMs(started),
        });
        return {
          kind: 'read',
          connection: opts.connection,
          affectedRows: 0,
          committed: true,
          rolledBack: false,
          durationMs: hrtimeMs(started),
          auditId,
          note: `read-only statement executed; returned ${rows.length} row(s) (capped at ${readLimit})`,
        };
      }

      const outcome = await driver.write(
        bound.sql,
        bound.values,
        isDdl,
        deadline.signal,
      );
      const duration = hrtimeMs(started);
      if (isDdl) this.schemaService.invalidate(opts.connection);
      this.connectors.touch(opts.connection);
      const auditId = await this.auditOk({
        connection: opts.connection,
        kind: isDdl ? 'ddl' : 'write',
        way: opts.way,
        sql: opts.sql,
        rows: outcome.affectedRows,
        durationMs: duration,
      });
      return {
        kind: isDdl ? 'ddl' : 'write',
        connection: opts.connection,
        affectedRows: outcome.affectedRows,
        committed: true,
        rolledBack: false,
        durationMs: duration,
        auditId,
        note: rollbackNote(isDdl, outcome.affectedRows, driver.kind, nonTransactional),
      };
    } catch (err) {
      if (readLike) {
        const duration = hrtimeMs(started);
        await this.auditFail(opts.connection, opts.sql, 'read', duration, opts.way, err);
        throw err;
      }
      if (nonTransactional) this.schemaService.invalidate(opts.connection);
      const dbErr = wrapWriteError(err, isDdl, nonTransactional);
      const duration = hrtimeMs(started);
      await this.auditFail(opts.connection, opts.sql, isDdl ? 'ddl' : 'write', duration, opts.way, dbErr);
      throw dbErr;
    } finally {
      deadline.clear();
    }
  }

  /** Schema snapshot for one connection (cached; refresh/flush with opts). */
  async schema(opts: SchemaOptions, signal: AbortSignal): Promise<SchemaResult> {
    const openStarted = process.hrtime();
    const scope = opts.filter ? ` filter="${opts.filter}"` : '';
    const sql = `schema introspection<${opts.connection}${scope}>`;
    let driver;
    try {
      driver = await this.requireDriver(opts.connection);
    } catch (err) {
      await this.auditFail(opts.connection, sql, 'schema', hrtimeMs(openStarted), opts.way, err);
      throw err;
    }
    const deadline = this.deadline(opts.timeoutMs, signal);
    const started = process.hrtime();
    let snapshot: SchemaResult;
    try {
      snapshot = await this.schemaService.get(driver, opts.connection, {
        refresh: opts.refresh,
        filter: opts.filter,
        signal: deadline.signal,
      });
    } catch (err) {
      await this.auditFail(opts.connection, sql, 'schema', hrtimeMs(started), opts.way, err);
      throw err;
    } finally {
      deadline.clear();
    }
    const duration = hrtimeMs(started);
    this.connectors.touch(opts.connection);
    await this.auditOk({
      connection: opts.connection,
      kind: 'schema',
      way: opts.way,
      sql,
      rows: snapshot.tables.length + snapshot.views.length,
      durationMs: duration,
    });
    return snapshot;
  }

  /** Query the audit trail (metadata + statement summaries; never config). */
  async audit(opts: AuditOptions): Promise<{ records: AuditRecord[] }> {
    const records = await this.auditLog.query({
      connection: opts.connection,
      kind: opts.kind,
      since: opts.since,
      limit: opts.limit,
    });
    return { records };
  }

  /** Close all connections (plugin teardown). */
  async dispose(): Promise<void> {
    await this.connectors.closeAll();
    this.schemaService.clear();
  }

  // ===== internals =====

  private async requireDriver(name: string): Promise<import('./drivers/driver.js').DriverApi> {
    return this.connectors.open(name, this.resolveCredentials);
  }

  private bind(
    sql: string,
    params?: unknown[],
    namedParams?: Record<string, unknown>,
    driver?: DriverKind,
  ): BindResult {
    if (params !== undefined && namedParams !== undefined) {
      throw new DbConnectorError(
        ErrorCode.InvalidArgs,
        'pass either "params" (positional array) or "namedParams" (object), not both',
      );
    }
    if (namedParams !== undefined) {
      const provided = Object.keys(namedParams);
      const { sql: rewritten, order } = rewriteNamedToPositional(sql, provided, driver);
      const values = order.map((key) => normalizeParam(namedParams[key], 0));
      this.checkArity(rewritten, values.length, driver);
      return { sql: rewritten, values };
    }
    const raw = params === undefined ? [] : params;
    if (!Array.isArray(raw)) {
      throw new DbConnectorError(ErrorCode.InvalidArgs, '"params" must be an array');
    }
    const values = raw.map(normalizeParam);
    this.checkArity(sql, values.length, driver);
    return { sql, values };
  }

  /** Friendly guard: placeholder count must equal bound value count. */
  private checkArity(sql: string, length: number, driver?: DriverKind): void {
    const count = countPositional(sql, driver);
    if (count !== length) {
      throw new DbConnectorError(
        ErrorCode.InvalidParams,
        `statement has ${count} "?" placeholder(s) but ${length} value(s) were provided`,
      );
    }
  }

  private effectiveLimit(requested: number | undefined): number {
    if (requested !== undefined) {
      if (!Number.isFinite(requested) || requested < 0) {
        throw new DbConnectorError(ErrorCode.InvalidArgs, '"limit" must be a non-negative number');
      }
      return Math.floor(requested);
    }
    return this.config.query.maxRows;
  }

  private deadline(timeoutMs: number | undefined, caller: AbortSignal) {
    const budget = timeoutMs ?? this.config.query.timeoutMs;
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      throw new DbConnectorError(ErrorCode.InvalidArgs, '"timeoutMs" must be a positive number');
    }
    return createDeadlineSignal(caller, budget);
  }

  private async auditOk(input: {
    connection: string;
    kind: 'query' | 'write' | 'ddl' | 'read' | 'schema';
    way: WayKind;
    sql: string;
    rows: number;
    durationMs: number;
  }): Promise<string> {
    try {
      return await this.auditLog.append({
        connection: input.connection,
        kind: input.kind,
        way: input.way,
        sql: input.sql,
        maxSqlChars: this.config.query.maxSqlChars,
        rows: input.rows,
        durationMs: input.durationMs,
        status: 'ok',
      });
    } catch (err) {
      // Audit durability is best-effort: a log failure must never turn an
      // already-executed (possibly committed) statement into an error.
      this.logger.warn('db-connector: audit append failed: %s', String(err));
      return '';
    }
  }

  private async auditDenied(
    connection: string,
    sql: string,
    kind: StatementKind,
    code: ErrorCode,
    way: WayKind,
  ): Promise<void> {
    try {
      await this.auditLog.append({
        connection,
        kind: 'denied',
        way,
        sql,
        maxSqlChars: this.config.query.maxSqlChars,
        rows: 0,
        durationMs: 0,
        status: 'denied',
        error: { code, message: `${kind} statement rejected by the ${code} gate` },
      });
    } catch (err) {
      this.logger.warn('db-connector: failed to audit a denied call: %s', String(err));
    }
  }

  private async auditFail(
    connection: string,
    sql: string,
    kind: 'query' | 'write' | 'ddl' | 'read' | 'schema',
    durationMs: number,
    way: WayKind,
    err: unknown,
  ): Promise<void> {
    const code = err instanceof DbConnectorError ? err.code : ErrorCode.QueryFailed;
    const message = err instanceof Error ? err.message : String(err);
    try {
      await this.auditLog.append({
        connection,
        kind,
        way,
        sql,
        maxSqlChars: this.config.query.maxSqlChars,
        rows: 0,
        durationMs,
        status: 'error',
        error: { code, message },
      });
    } catch (auditErr) {
      this.logger.warn('db-connector: failed to audit a failed call: %s', String(auditErr));
    }
  }
}

/** Count `?` markers outside strings/comments in a statement. */
function countPositional(sql: string, driver?: DriverKind): number {
  let count = 0;
  for (const t of scan(sql, driver ?? {})) {
    if (t.type === 'param' && t.value === '?') count += 1;
  }
  return count;
}

/**
 * Value normalization for binding. Values travel to database clients and (for
 * SQLite) across IPC structured-clone, so anything non-serializable must be
 * rejected up front rather than silently mis-behaving per driver. `undefined`
 * becomes NULL (drivers accept null); bigint/symbol/function are refused.
 */
function normalizeParam(value: unknown, index = 0): unknown {
  if (value === undefined) return null;
  const t = typeof value;
  if (t === 'bigint' || t === 'symbol' || t === 'function') {
    throw new DbConnectorError(
      ErrorCode.InvalidParams,
      `param #${index + 1} has non-serializable type "${t}"; use a string, number, boolean, null, or Buffer`,
    );
  }
  return value;
}

function rollbackNote(
  isDdl: boolean,
  affectedRows: number,
  driver: import('./types.js').DriverKind,
  nonTransactional: boolean,
): string {
  if (nonTransactional && !isDdl) {
    return 'statement executed without a transaction; failures are not rolled back.';
  }
  if (isDdl) {
    if (nonTransactional) {
      return 'DDL executed without a transaction; failures are not rolled back, and the schema snapshot cache has been invalidated.';
    }
    return driver === 'mysql'
      ? 'DDL ran inside a transaction wrapper, but MySQL DDL implicitly commits — a later failure cannot undo structural changes. The schema snapshot cache has been invalidated.'
      : 'DDL executed inside a transaction (transactional DDL on SQLite/PostgreSQL); a failure rolls back any partially-completed structural change, and the schema snapshot cache has been invalidated.';
  }
  return `statement executed inside an explicit transaction (${affectedRows} row(s) affected); the transaction commits on success and rolls back on failure — no partial rows survive an error.`;
}

function wrapWriteError(err: unknown, isDdl: boolean, nonTransactional: boolean): DbConnectorError {
  if (err instanceof DbConnectorError) {
    if (err.code === ErrorCode.QueryFailed || err.code === ErrorCode.Timeout || err.code === ErrorCode.Cancelled) {
      // Surface the transaction outcome to the caller without leaking internals.
      const prefix = isDdl ? 'DDL' : 'write';
      if (nonTransactional) {
        return new DbConnectorError(err.code, `${prefix} failed without a transaction; partial changes were not rolled back: ${err.message}`, err.details);
      }
      return new DbConnectorError(err.code, `${prefix} failed and the transaction was rolled back: ${err.message}`, err.details);
    }
    return err;
  }
  const message = err instanceof Error ? err.message : String(err);
  if (nonTransactional) {
    return new DbConnectorError(ErrorCode.QueryFailed, `${isDdl ? 'DDL' : 'write'} failed without a transaction; partial changes were not rolled back: ${message}`);
  }
  return new DbConnectorError(ErrorCode.QueryFailed, `write failed and the transaction was rolled back: ${message}`);
}
