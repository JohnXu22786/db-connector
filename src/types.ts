/**
 * Shared types for the dsh-db-connector bundle.
 *
 * The bundle deliberately avoids a runtime dependency on `@deepseek-ai/cordis`
 * or `@deepseek-ai/dsh-tools`: the handful of framework shapes it touches are
 * declared structurally here (`DshContext`, `DshTool`, `DshCommand`) so the
 * package stays self-contained and testable in plain Node.
 */

/** Database engine a connection targets. */
export type DriverKind = 'sqlite' | 'postgres' | 'mysql';

/** How an execution reached the engine (who asked for it). */
export type WayKind = 'tool' | 'command' | 'cli';

/** Classification of a single SQL statement. */
export type StatementKind = 'select' | 'explain' | 'write' | 'ddl' | 'unknown';

/**
 * Connection description as users provide it (tool args, plugin config, CLI).
 *
 * Secrets are never inlined in a way that reaches logs: prefer `passwordEnv`
 * (an environment variable NAME) or `passwordRef` (a name resolved through the
 * dsh credentials service). Inline `password` is accepted for convenience but
 * strongly discouraged. Any string field also accepts a `${VAR}` placeholder
 * that is expanded from the process environment at connect time.
 */
export interface ConnectionSpec {
  /** Unique connection name used by every tool. */
  name: string;
  driver: DriverKind;
  /**
   * SQLite: file path, `:memory:`, or empty for an anonymous in-memory DB.
   * PostgreSQL / MySQL: the target database name.
   */
  database?: string;
  /** PostgreSQL / MySQL server host (defaults handled by the driver). */
  host?: string;
  /** PostgreSQL / MySQL server port; a `${VAR}` string is resolved from env. */
  port?: number | string;
  /** Login user. */
  user?: string;
  /** Inline password — discouraged; prefer passwordEnv / passwordRef. */
  password?: string;
  /** Environment variable NAME holding the password. */
  passwordEnv?: string;
  /** dsh credentials reference (an environment-variable-style name). */
  passwordRef?: string;
  /** Full connection string (e.g. `postgresql://...`). `${VAR}` expands. */
  connectionString?: string;
  /** Default schema (PostgreSQL), database (MySQL via `database`), etc. */
  schema?: string;
  /** Enable / configure TLS for server drivers. */
  ssl?: boolean | Record<string, unknown>;
  /** Driver-specific passthrough options. */
  options?: Record<string, unknown>;
}

/** A connection spec with every string expanded and secrets resolved. */
export interface ResolvedConnectionSpec extends ConnectionSpec {
  name: string;
  driver: DriverKind;
  database?: string;
  host?: string;
  port?: number;
  user?: string;
  password: string;
  connectionString?: string;
  schema?: string;
  ssl?: boolean | Record<string, unknown>;
  options: Record<string, unknown>;
  /** Where the password came from, for diagnostics only (names, not values). */
  passwordSource: 'env' | 'credentials' | 'inline' | 'none';
}

/** Normalized plugin defaults after merging config + environment. */
export interface ResolvedConfig {
  /** Pre-registered connection specs (name -> fields), opened lazily. */
  connections: Record<string, ConnectionSpec>;
  audit: {
    enabled: boolean;
    path: string;
  };
  query: {
    maxRows: number;
    timeoutMs: number;
    maxSqlChars: number;
  };
  schema: {
    ttlMs: number;
  };
  /** Global default for the write approval gate; can be overridden per call. */
  defaultAllowWrite: boolean;
}

/** Shape of one row returned by a cursor-less read query. */
export interface QueryResult {
  kind: 'query';
  connection: string;
  columns: string[];
  /** Rows as JSON-safe primitive arrays aligned with `columns`. */
  rows: unknown[][];
  /** Rows returned (== rows.length). */
  rowCount: number;
  durationMs: number;
  /** True when the result was cut at the row limit. */
  truncated: boolean;
  limit: number;
  /** Audit record id for correlation. */
  auditId: string;
}

export interface ExecResult {
  kind: 'write' | 'ddl' | 'read';
  connection: string;
  /** Rows changed (INSERT/UPDATE/DELETE), or 0 for DDL/reads. */
  affectedRows: number;
  committed: boolean;
  rolledBack: boolean;
  durationMs: number;
  auditId: string;
  /** Human-readable rollback explanation for the write approval gate. */
  note: string;
}

export interface SchemaResult {
  kind: 'schema';
  connection: string;
  capturedAt: string;
  fromCache: boolean;
  tables: SchemaTable[];
  views: SchemaView[];
  columns: SchemaColumn[];
  indexes: SchemaIndex[];
  foreignKeys: SchemaForeignKey[];
}

export interface SchemaTable {
  name: string;
  type: 'table' | 'view';
  /** SQLite only: original CREATE statement, when present. */
  sql?: string;
}

export interface SchemaView {
  name: string;
  sql?: string;
}

export interface SchemaColumn {
  table: string;
  name: string;
  type: string;
  nullable: boolean;
  /** Position within the table (1-based). */
  ordinal: number;
  default?: string | null;
  primaryKey: boolean;
  /** Extra flags, e.g. autoincrement / generated / unsigned. */
  extra?: string;
}

export interface SchemaIndex {
  name: string;
  table: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
}

export interface SchemaForeignKey {
  name: string;
  table: string;
  columns: string[];
  referencedTable: string;
  referencedColumns: string[];
  onUpdate?: string;
  onDelete?: string;
}

/** One durable audit record (written as a JSON line). */
export interface AuditRecord {
  id: string;
  ts: string;
  connection: string;
  kind: 'query' | 'write' | 'ddl' | 'read' | 'schema' | 'denied';
  way: WayKind;
  statement: {
    /** Truncated statement text — never contains credentials. */
    summary: string;
    /** sha256 of the normalized statement, for exact-match correlation. */
    digest: string;
    chars: number;
  };
  /** Rows returned / affected (0 when unknown or not applicable). */
  rows: number;
  durationMs: number;
  status: 'ok' | 'error' | 'denied';
  error?: { code: string; message: string };
}

/** ===== Structural shapes of the dsh runtime we touch ===== */

/** The slice of the dsh context this plugin relies on. */
export interface DshContext {
  logger: {
    error(...args: unknown[]): void;
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    debug(...args: unknown[]): void;
  };
  /** `ctx.get('serviceName')` — Cordis service lookup for optional services. */
  get?(service: string): unknown;
  /** `ctx.tools` when the `tools` injection is active. */
  tools?: { register(def: DshTool): () => void };
  /** `ctx.commands` when present (mounted by dsh-base, optional here). */
  commands?: { register(def: DshCommand): () => void };
  /** Effect-based teardown registration (Cordis `ctx.on`/`ctx.effect`). */
  on?(event: string, fn: (...args: never[]) => void): () => void;
}

/** Model-facing content block returned by `output.render`. */
export interface ContentBlock {
  type: 'text';
  text: string;
}

/** Execution identity handed to a tool body. */
export interface ToolRunContext {
  signal: AbortSignal;
  token: string;
  [key: string]: unknown;
}

/** A tool registered through `ctx.tools.register` (structural subset). */
export interface DshTool {
  name: string;
  description: string;
  /** Full JSON Schema (raw registration owns input validation). */
  parameters: Record<string, unknown>;
  output: {
    schema: Record<string, unknown>;
    render(args: unknown, value: unknown): ContentBlock[];
  };
  timeoutMs?: number;
  execute(args: Record<string, unknown>, exec: ToolRunContext): Promise<unknown>;
}

/** A command registered through `ctx.commands.register` (structural subset). */
export interface DshCommand {
  name: string;
  description: string;
  input?: { hint: string };
  recordInput?: boolean;
  handler(info: {
    agent: { id: string };
    rawInput: string;
    signal: AbortSignal;
  }): Promise<{ kind: 'success'; text: string }> | { kind: 'success'; text: string };
}

/** Server-side summary exposed by the connection manager. */
export interface ConnectorStatus {
  name: string;
  driver: DriverKind;
  status: 'connected' | 'defined' | 'closed';
  openedAt: string | null;
  lastUsedAt: string | null;
  /** Running counter of audit records emitted for this connection. */
  executions: number;
}
