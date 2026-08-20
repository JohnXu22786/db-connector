/**
 * Typed errors carrying a stable machine-readable `code` so tools, the CLI,
 * and audit records can classify failures without parsing human text.
 */

/** Stable error codes exposed by the bundle. */
export const ErrorCode = {
  /** Arguments failed schema validation. */
  InvalidArgs: 'INVALID_ARGS',
  /** The named connection does not exist (or is not connected). */
  ConnectionNotFound: 'CONNECTION_NOT_FOUND',
  /** Connecting to the server failed (auth, network, bad path...). */
  ConnectionFailed: 'CONNECTION_FAILED',
  /** A connection with this name is already registered. */
  ConnectionExists: 'CONNECTION_EXISTS',
  UnsupportedDriver: 'UNSUPPORTED_DRIVER',
  /** The driver package (pg / mysql2) is not installed. */
  DriverNotInstalled: 'DRIVER_NOT_INSTALLED',
  /** Input contained more than one top-level statement. */
  MultiStatements: 'MULTI_STATEMENTS',
  /** A write statement reached a read-only path. */
  ReadOnlyViolation: 'READ_ONLY_VIOLATION',
  /** A write was attempted without passing the approval gate. */
  WriteNotAllowed: 'WRITE_NOT_ALLOWED',
  /** Query execution exceeded its deadline. */
  Timeout: 'TIMEOUT',
  /** Execution was cancelled by the caller signal. */
  Cancelled: 'CANCELLED',
  /** The database rejected the statement. */
  QueryFailed: 'QUERY_FAILED',
  /** The audit log could not be read or written. */
  AuditUnavailable: 'AUDIT_UNAVAILABLE',
  /** Parameter binding produced no replacements for named placeholders. */
  InvalidParams: 'INVALID_PARAMS',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export class DbConnectorError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'DbConnectorError';
    this.code = code;
    this.details = details;
  }

  /** True when `error` is a DbConnectorError (any realm). */
  static is(err: unknown): err is DbConnectorError {
    return err instanceof DbConnectorError;
  }
}
