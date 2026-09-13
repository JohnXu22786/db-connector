/**
 * Driver contract shared by sqlite / postgres / mysql implementations.
 *
 * All drivers are "thin": they only translate schema-safe operations to the
 * underlying client and never perform policy decisions. Read/write gating and
 * auditing live in the executor, one layer above.
 */

import { ErrorCode, DbConnectorError } from '../errors.js';
import type { DriverKind } from '../types.js';

/** Materialized read result, rows pre-aligned with `columns`. */
export interface ReadOutcome {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
}

/** Result of a write / DDL statement, transactional where supported. */
export interface WriteOutcome {
  affectedRows: number;
  /** Schema objects created/altered by DDL don't report a row count. */
  isDdl: boolean;
}

/** Raw schema facts a driver can introspect. */
export interface Introspection {
  tables: ReadonlyArray<{ name: string; sql?: string }>;
  views: ReadonlyArray<{ name: string; sql?: string }>;
  columns: ReadonlyArray<{
    table: string;
    name: string;
    type: string;
    nullable: boolean;
    ordinal: number;
    default: string | null;
    primaryKey: boolean;
    extra?: string;
  }>;
  indexes: ReadonlyArray<{
    name: string;
    table: string;
    columns: string[];
    unique: boolean;
    primary: boolean;
  }>;
  foreignKeys: ReadonlyArray<{
    name: string;
    table: string;
    columns: string[];
    referencedTable: string;
    referencedColumns: string[];
    onUpdate?: string;
    onDelete?: string;
  }>;
}

export interface DriverApi {
  readonly kind: DriverKind;
  /** Open / validate the underlying handle. Idempotent. */
  connect(): Promise<void>;
  /**
   * Execute a read-only statement (SELECT/EXPLAIN). Must observe `signal`
   * and settle only after its owned work reaches quiescence.
   */
  read(sql: string, params: unknown[], signal: AbortSignal): Promise<ReadOutcome>;
  /**
   * Execute a write or DDL statement with transaction protection where
   * supported: COMMIT on success, ROLLBACK on failure. Must observe `signal`.
   */
  write(sql: string, params: unknown[], isDdl: boolean, signal: AbortSignal): Promise<WriteOutcome>;
  /** Full schema introspection (used by the schema snapshot service). */
  introspect(signal: AbortSignal): Promise<Introspection>;
  /** Release the underlying handle(s). Idempotent. */
  close(): Promise<void>;
}

/** Structural logging seam so drivers never see the full dsh context. */
export interface DriverLogger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

/** Load the optional server driver package, with a friendly failure. */
export async function importOptional<T>(name: string): Promise<T> {
  try {
    return await import(name);
  } catch (err) {
    const friendly =
      name === 'pg' ? 'postgres' : name === 'mysql2' ? 'mysql' : name;
    if (
      err instanceof Error &&
      'code' in err &&
      (err.code === 'MODULE_NOT_FOUND' || err.code === 'ERR_MODULE_NOT_FOUND')
    ) {
      throw new DbConnectorError(
        ErrorCode.DriverNotInstalled,
        `the "${name}" package is not installed; run "npm i ${name}" to enable ${friendly} connections`,
      );
    }
    throw new DbConnectorError(
      ErrorCode.DriverNotInstalled,
      `failed to load "${name}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Strip any embedded credentials from a driver error message. Drivers may
 * echo the attempted URL or query, which can include user:password or the
 * full connection string; those are redacted before the message is returned.
 */
export function redactSpecMessage(
  spec: { password?: string; connectionString?: string },
  message: string,
): string {
  let out = message;
  if (spec.password) out = out.split(spec.password).join('***');
  if (spec.connectionString) {
    out = out.split(spec.connectionString).join('[redacted connection string]');
  }
  return out;
}
