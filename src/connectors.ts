/**
 * Connection manager: named connections with lazy open, reuse, and lifecycle.
 *
 * A connection may be *defined* (from plugin config or `db_connect`) and
 * opened on first use, then closed explicitly or when the plugin unloads.
 * Secrets are resolved through the process environment / credentials service
 * at open time and never leave this module in readable log form.
 */

import { ErrorCode, DbConnectorError } from './errors.js';
import {
  applyCredentialPassword,
  resolveConnectionSpec,
  summarizeSpec,
  validateConnectionSpec,
} from './config.js';
import { MysqlDriver } from './drivers/mysql.js';
import { PgDriver } from './drivers/postgres.js';
import { SqliteDriver } from './drivers/sqlite.js';
import type { DriverApi, DriverLogger } from './drivers/driver.js';
import type {
  ConnectionSpec,
  ConnectorStatus,
  DriverKind,
  ResolvedConnectionSpec,
} from './types.js';

export interface ResolveCredentials {
  (ref: string): Promise<string | undefined> | string | undefined;
}

interface ConnectorRecord {
  spec: ConnectionSpec;
  env: NodeJS.ProcessEnv;
  driver: DriverApi | null;
  status: 'defined' | 'connected';
  openedAt: string | null;
  lastUsedAt: string | null;
  executions: number;
  opening: Promise<DriverApi> | null;
  openingController: AbortController | null;
  closing: boolean;
  openWaiters: Set<() => void>;
  closingPromise: Promise<void> | null;
}

const DEFAULT_LOGGER: DriverLogger = { debug() {}, info() {}, warn() {} };

export class Connectors {
  private readonly map = new Map<string, ConnectorRecord>();
  private closeAllPromise: Promise<void> | null = null;

  constructor(private readonly logger: DriverLogger = DEFAULT_LOGGER) {}

  /** Register a named connection without resolving environment-backed fields. */
  define(spec: ConnectionSpec, env: NodeJS.ProcessEnv = process.env): ConnectorStatus {
    validateConnectionSpec(spec);
    if (this.map.has(spec.name)) {
      throw new DbConnectorError(
        ErrorCode.ConnectionExists,
        `a connection named "${spec.name}" already exists`,
      );
    }
    if (this.closeAllPromise) {
      throw new DbConnectorError(
        ErrorCode.ConnectionNotFound,
        'connections are closing',
      );
    }
    this.map.set(spec.name, {
      spec: { ...spec },
      env,
      driver: null,
      status: 'defined',
      openedAt: null,
      lastUsedAt: null,
      executions: 0,
      opening: null,
      openingController: null,
      closing: false,
      openWaiters: new Set(),
      closingPromise: null,
    });
    return this.statusOf(spec.name, this.map.get(spec.name)!);
  }

  /** Whether a connection name is known (defined or connected). */
  has(name: string): boolean {
    return this.map.has(name);
  }

  /** Build the driver for a spec (no network/file open yet). */
  private buildDriver(spec: ResolvedConnectionSpec): DriverApi {
    switch (spec.driver) {
      case 'sqlite':
        return new SqliteDriver(spec, this.logger);
      case 'postgres':
        return new PgDriver(spec, this.logger);
      case 'mysql':
        return new MysqlDriver(spec, this.logger);
      default: {
        const driver = spec.driver as string;
        throw new DbConnectorError(
          ErrorCode.UnsupportedDriver,
          `unsupported driver "${driver}"`,
        );
      }
    }
  }

  /**
   * Open a defined connection and hand back its live driver. Concurrent
   * requests share one open; the first to arrive does the work.
   */
  async open(
    name: string,
    resolveCredentials?: ResolveCredentials,
    signal?: AbortSignal,
  ): Promise<DriverApi> {
    const rec = this.map.get(name);
    if (!rec) {
      throw new DbConnectorError(
        ErrorCode.ConnectionNotFound,
        `connection "${name}" is not defined; run db_connect first`,
      );
    }
    if (rec.closing) throw this.connectionClosingError(name);
    if (signal?.aborted) throw cancelError(signal);
    if (rec.driver) {
      const driver = rec.driver;
      let opening = rec.opening;
      if (!opening) {
        const controller = new AbortController();
        rec.openingController = controller;
        opening = driver.connect(controller.signal).then(
          () => {
            if (controller.signal.aborted) {
              if (!rec.closing && rec.driver === driver) {
                rec.driver = null;
                rec.status = 'defined';
                void driver.close().catch(() => {});
              }
              throw cancelError(controller.signal);
            }
            return driver;
          },
          (error) => {
            rec.status = 'defined';
            if (controller.signal.aborted && !rec.closing && rec.driver === driver) {
              rec.driver = null;
              void driver.close().catch(() => {});
            }
            throw controller.signal.aborted ? cancelError(controller.signal) : error;
          },
        );
        rec.opening = opening;
        this.clearOpeningWhenSettled(rec, opening);
      }
      try {
        await this.waitForOpen(rec, opening, signal);
        if (rec.closing) throw this.connectionClosingError(name);
      } finally {
        this.abortOpeningIfUnused(rec, opening);
      }
      rec.lastUsedAt = new Date().toISOString();
      rec.status = 'connected';
      return driver;
    }
    if (rec.opening) {
      const driver = await this.waitForOpen(rec, rec.opening, signal);
      if (rec.closing) throw this.connectionClosingError(name);
      return driver;
    }

    const controller = new AbortController();
    const opening = (async () => {
      let spec = resolveConnectionSpec(rec.spec, rec.env);
      if (spec.passwordRef && resolveCredentials) {
        spec = (await applyCredentialPassword(spec, resolveCredentials)) as ResolvedConnectionSpec;
      }
      const driver = this.buildDriver(spec);
      try {
        await driver.connect(controller.signal);
        if (controller.signal.aborted) {
          void driver.close().catch(() => {});
          throw cancelError(controller.signal);
        }
      } catch (err) {
        throw controller.signal.aborted ? cancelError(controller.signal) : err;
      }
      rec.driver = driver;
      rec.status = 'connected';
      rec.openedAt = new Date().toISOString();
      rec.lastUsedAt = new Date().toISOString();
      this.logger.info('db-connector: connected %s', summarizeSpec(spec));
      return driver;
    })();
    rec.opening = opening;
    rec.openingController = controller;
    this.clearOpeningWhenSettled(rec, opening);

    try {
      const driver = await this.waitForOpen(rec, opening, signal);
      if (rec.closing) throw this.connectionClosingError(name);
      return driver;
    } finally {
      this.abortOpeningIfUnused(rec, opening);
    }
  }

  private clearOpeningWhenSettled(
    rec: ConnectorRecord,
    opening: Promise<DriverApi>,
  ): void {
    void opening.then(
      () => this.clearOpening(rec, opening),
      () => this.clearOpening(rec, opening),
    );
  }

  private clearOpening(rec: ConnectorRecord, opening: Promise<DriverApi>): void {
    if (rec.opening !== opening) return;
    rec.opening = null;
    rec.openingController = null;
  }

  private abortOpeningIfUnused(
    rec: ConnectorRecord,
    opening: Promise<DriverApi>,
  ): void {
    if (rec.opening !== opening || rec.openWaiters.size > 0) return;
    const controller = rec.openingController;
    if (controller && !controller.signal.aborted) controller.abort();
  }

  private async waitForOpen(
    rec: ConnectorRecord,
    opening: Promise<DriverApi>,
    signal?: AbortSignal,
  ): Promise<DriverApi> {
    if (rec.closing) throw this.connectionClosingError(rec.spec.name);
    if (signal?.aborted) throw cancelError(signal);
    return new Promise<DriverApi>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        rec.openWaiters.delete(cancel);
        signal?.removeEventListener('abort', onAbort);
        this.abortOpeningIfUnused(rec, opening);
      };
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
      };
      const cancel = () => {
        finish(() => reject(this.connectionClosingError(rec.spec.name)));
      };
      const onAbort = () => finish(() => reject(cancelError(signal!)));
      rec.openWaiters.add(cancel);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      opening.then(
        (driver) => {
          finish(() => {
            if (rec.closing) reject(this.connectionClosingError(rec.spec.name));
            else resolve(driver);
          });
        },
        (error) => {
          finish(() => reject(error));
        },
      );
    });
  }

  private connectionClosingError(name: string): DbConnectorError {
    return new DbConnectorError(
      ErrorCode.ConnectionNotFound,
      `connection "${name}" is closing`,
    );
  }

  /** Mark a connection as just executed against (stats only, never secrets). */
  touch(name: string): void {
    const rec = this.map.get(name);
    if (!rec) return;
    rec.executions += 1;
    rec.lastUsedAt = new Date().toISOString();
  }

  private async closeRecord(
    rec: ConnectorRecord,
    opening: Promise<DriverApi> | null,
  ): Promise<void> {
    await opening?.catch(() => {});
    await rec.driver?.close().catch(() => {});
  }

  private startClose(name: string, rec: ConnectorRecord): Promise<void> {
    if (rec.closingPromise) return rec.closingPromise;
    const opening = rec.opening;
    rec.closing = true;
    rec.openingController?.abort();
    for (const cancel of rec.openWaiters) cancel();
    const closing = (async () => {
      await this.closeRecord(rec, opening);
      if (this.map.get(name) === rec) this.map.delete(name);
    })();
    rec.closingPromise = closing;
    return closing;
  }

  /** Close and forget a connection. Unknown names are a no-op. */
  async close(name: string): Promise<void> {
    const rec = this.map.get(name);
    if (!rec) return;
    const alreadyClosing = rec.closingPromise !== null;
    await this.startClose(name, rec);
    if (!alreadyClosing) this.logger.info('db-connector: closed connection %s', name);
  }

  /** Close every open connection (plugin teardown). */
  async closeAll(): Promise<void> {
    if (this.closeAllPromise) {
      await this.closeAllPromise;
      return;
    }
    const closing = (async () => {
      const pending: Promise<void>[] = [];
      for (const [name, rec] of this.map) {
        pending.push(this.startClose(name, rec));
      }
      await Promise.all(pending);
    })();
    this.closeAllPromise = closing;
    try {
      await closing;
    } finally {
      if (this.closeAllPromise === closing) this.closeAllPromise = null;
    }
  }

  /** Redacted status of a single connection, or undefined if unknown. */
  describe(name: string): ConnectorStatus | undefined {
    const rec = this.map.get(name);
    return rec ? this.statusOf(name, rec) : undefined;
  }

  /** Redacted status of every connection. */
  list(): ConnectorStatus[] {
    const out: ConnectorStatus[] = [];
    for (const [name, rec] of this.map) {
      out.push(this.statusOf(name, rec));
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  private statusOf(name: string, rec: ConnectorRecord): ConnectorStatus {
    return {
      name,
      driver: rec.spec.driver as DriverKind,
      status: rec.status,
      openedAt: rec.openedAt,
      lastUsedAt: rec.lastUsedAt,
      executions: rec.executions,
    };
  }
}

function cancelError(signal: AbortSignal): DbConnectorError {
  const reason = signal.reason;
  const isTimeout = reason instanceof Error && /timeout/i.test(reason.message);
  return new DbConnectorError(
    isTimeout ? ErrorCode.Timeout : ErrorCode.Cancelled,
    isTimeout ? 'connection exceeded its time limit' : 'connection was cancelled',
  );
}
