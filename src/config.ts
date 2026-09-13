/**
 * Plugin + connection configuration: normalization, environment expansion,
 * credential resolution, and secret-safe summarization.
 *
 * Secrets never leave this module in resolvable form when they are not meant
 * to: `summarizeSpec` returns only non-secret fields, and `ResolvedConnectionSpec`
 * is the single object passed to drivers (never emitted into logs).
 */

import { ErrorCode, DbConnectorError } from './errors.js';
import type {
  ConnectionSpec,
  DriverKind,
  ResolvedConfig,
  ResolvedConnectionSpec,
} from './types.js';

const DRIVER_KINDS: ReadonlySet<string> = new Set(['sqlite', 'postgres', 'mysql']);

/** Expand `${VAR}` placeholders from the process environment. */
export function expandEnv(
  value: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (value === undefined) return undefined;
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => {
    const hit = env[name];
    if (hit === undefined || hit === '') {
      throw new DbConnectorError(
        ErrorCode.ConnectionFailed,
        `environment variable "${name}" referenced in a connection setting is not set`,
      );
    }
    return hit;
  });
}

/** Parse a numeric string with a driver default; throws on garbage. */
function toPort(raw: unknown, fallback: number, driver: DriverKind): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new DbConnectorError(
      ErrorCode.InvalidArgs,
      `invalid port "${String(raw)}" for ${driver} connection`,
    );
  }
  return value;
}

/** Turn a user-supplied spec into a resolved spec ready for drivers. */
export function resolveConnectionSpec(
  raw: ConnectionSpec,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedConnectionSpec {
  if (!raw || typeof raw !== 'object') {
    throw new DbConnectorError(ErrorCode.InvalidArgs, 'connection config must be an object');
  }
  if (typeof raw.name !== 'string' || raw.name.length === 0) {
    throw new DbConnectorError(ErrorCode.InvalidArgs, 'connection "name" is required');
  }
  if (raw.name.length > 128) {
    throw new DbConnectorError(ErrorCode.InvalidArgs, 'connection name is too long (max 128)');
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(raw.name)) {
    throw new DbConnectorError(
      ErrorCode.InvalidArgs,
      'connection name may contain only letters, digits, ".", "_" and "-"',
    );
  }
  if (!DRIVER_KINDS.has(raw.driver)) {
    throw new DbConnectorError(
      ErrorCode.UnsupportedDriver,
      `unsupported driver "${String(raw.driver)}" (expected sqlite, postgres or mysql)`,
    );
  }
  const driver = raw.driver as DriverKind;
  const connectionString = expandEnv(raw.connectionString, env);
  const database = expandEnv(raw.database, env);
  const portValue =
    raw.port === undefined || raw.port === null || raw.port === ''
      ? undefined
      : typeof raw.port === 'number'
        ? raw.port
        : expandEnv(String(raw.port), env);

  let password = '';
  let passwordSource: ResolvedConnectionSpec['passwordSource'] = 'none';
  const inlinePassword = raw.password !== undefined ? String(raw.password) : undefined;
  const passwordEnv = expandEnv(raw.passwordEnv, env);

  // Resolution priority: credentials ref is filled later by the caller when a
  // credentials provider is available; here we resolve env first, then inline.
  if (passwordEnv) {
    password = env[passwordEnv] ?? '';
    passwordSource = 'env';
    // See resolvePassword via setCredentialsPassword below for the ref path.
    if (password === '') {
      throw new DbConnectorError(
        ErrorCode.ConnectionFailed,
        `environment variable "${passwordEnv}" referenced by "passwordEnv" is not set`,
      );
    }
  } else if (inlinePassword !== undefined && inlinePassword !== '') {
    password = inlinePassword;
    passwordSource = 'inline';
  }

  const result: ResolvedConnectionSpec = {
    name: raw.name,
    driver,
    database,
    host: expandEnv(raw.host, env),
    user: expandEnv(raw.user, env),
    // SQLite has no network port; ignore any value the user carried over so a
    // leftover "port" (e.g. from a copied server connection) cannot fail a
    // local connection. Server drivers resolve and validate it below.
    port: driver === 'sqlite' ? undefined : toPort(portValue, driver === 'postgres' ? 5432 : 3306, driver),
    password,
    passwordSource,
    connectionString,
    schema: expandEnv(raw.schema, env),
    ssl: raw.ssl,
    options: raw.options ?? {},
    passwordEnv,
    passwordRef: raw.passwordRef,
  };

  if (driver === 'sqlite') {
    if (database !== undefined && database !== '' && database !== ':memory:') {
      // A path must exist or be creatable; we do not create it here.
      if (database.length === 0) {
        throw new DbConnectorError(ErrorCode.InvalidArgs, 'sqlite database path is empty');
      }
    }
    result.host = undefined;
    result.user = undefined;
    result.ssl = undefined;
    result.options = raw.options ?? {};
  } else {
    if (!connectionString && !database) {
      throw new DbConnectorError(
        ErrorCode.InvalidArgs,
        `${driver} connection requires "database" (or a "connectionString")`,
      );
    }
  }

  return result;
}

/**
 * Apply a password resolved from a dsh credentials provider onto a spec that
 * declared `passwordRef`. Returns a new spec; never mutates the input.
 */
export function applyCredentialPassword(
  spec: ResolvedConnectionSpec,
  resolveRef: (ref: string) => Promise<string | undefined> | string | undefined,
): Promise<ResolvedConnectionSpec> | ResolvedConnectionSpec {
  if (!spec.passwordRef) return spec;
  const ref = spec.passwordRef!;
  const resolved = resolveRef(ref);
  if (resolved && typeof (resolved as PromiseLike<unknown>).then === 'function') {
    return (resolved as Promise<string | undefined>).then((value) => {
      if (!value) {
        throw new DbConnectorError(
          ErrorCode.ConnectionFailed,
          `credentials reference "${ref}" resolved to an empty value`,
        );
      }
      return { ...spec, password: value, passwordSource: spec.passwordSource === 'env' ? 'env' : 'credentials' };
    });
  }
  const value = resolved as string | undefined;
  if (!value) {
    throw new DbConnectorError(
      ErrorCode.ConnectionFailed,
      `credentials reference "${ref}" resolved to an empty value`,
    );
  }
  return { ...spec, password: value, passwordSource: 'credentials' };
}

/** Secret-safe, one-line summary of a resolved spec (never includes password). */
export function summarizeSpec(spec: ResolvedConnectionSpec): string {
  const base = `${spec.name} (${spec.driver})`;
  const where =
    spec.driver === 'sqlite'
      ? spec.database || ':memory:'
      : `${spec.host ?? 'localhost'}:${spec.port}/${spec.database ?? ''}`;
  const auth =
    spec.passwordSource === 'none'
      ? 'no-password'
      : `password via ${spec.passwordSource}`;
  return `${base} ${where} auth=${auth}`;
}

/** Apply per-setting environment overrides onto user-provided config. */
function pickEnvNumber(key: string, fallback: number, env: NodeJS.ProcessEnv): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return value;
}

/**
 * Normalize the plugin config (second `apply` argument) plus environment
 * overrides into typed defaults. Unknown keys are ignored so bundles can
 * evolve without breaking older config layers.
 */
export function normalizeConfig(
  input: unknown,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedConfig {
  const cfg =
    input && typeof input === 'object' ? (input as Record<string, unknown>) : {};

  const auditIn =
    cfg.audit && typeof cfg.audit === 'object'
      ? (cfg.audit as Record<string, unknown>)
      : {};
  const queryIn =
    cfg.query && typeof cfg.query === 'object'
      ? (cfg.query as Record<string, unknown>)
      : {};
  const schemaIn =
    cfg.schema && typeof cfg.schema === 'object'
      ? (cfg.schema as Record<string, unknown>)
      : {};

  const defaultAuditPath = '.dsh-db/audit.jsonl';
  const auditPath =
    env.DSH_DB_CONNECTOR_AUDIT_PATH ||
    (typeof auditIn.path === 'string' && auditIn.path.length > 0
      ? auditIn.path
      : undefined);

  return {
    connections: normalizeConnections(cfg.connections),
    audit: {
      enabled: auditIn.enabled !== false,
      path: expandEnv(auditPath, env) ?? defaultAuditPath,
    },
    query: {
      maxRows: pickEnvNumber('DSH_DB_CONNECTOR_MAX_ROWS', num(queryIn.maxRows, 1000), env),
      timeoutMs: pickEnvNumber('DSH_DB_CONNECTOR_TIMEOUT_MS', num(queryIn.timeoutMs, 30000), env),
      maxSqlChars: num(queryIn.maxSqlChars, 512),
    },
    schema: {
      ttlMs: num(schemaIn.ttlMs, 60000),
    },
    defaultAllowWrite: cfg.defaultAllowWrite === true,
  };
}

/** Coerce a number-ish config value, falling back sanely. */
function num(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return fallback;
}

/** Copy the `connections` map verbatim (validation happens at define time). */
function normalizeConnections(raw: unknown): Record<string, import('./types.js').ConnectionSpec> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, import('./types.js').ConnectionSpec> = Object.create(null);
  for (const [name, fields] of Object.entries(raw as Record<string, unknown>)) {
    if (fields && typeof fields === 'object' && !Array.isArray(fields)) {
      out[name] = { ...(fields as Record<string, unknown>), name } as import('./types.js').ConnectionSpec;
    }
  }
  return out;
}
