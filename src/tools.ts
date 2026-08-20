/**
 * The five model-facing dsh tools: db_connect / db_schema / db_query /
 * db_exec / db_audit. Raw-registered ToolDefinition objects (no dependency on
 * `@deepseek-ai/dsh-tools`), each owning its own input validation. Bodies are
 * thin envelopes around the ExecutionEngine; all policy lives in the engine.
 */

import { ErrorCode, DbConnectorError } from './errors.js';
import type { ExecutionEngine } from './executor.js';
import type { ConnectionSpec, ContentBlock, DshTool } from './types.js';

/** Minimal JSON-schema subset used to validate tool arguments. */
interface Prop {
  type?: string;
  minLength?: number;
  description?: string;
  enum?: readonly unknown[];
}

interface Schema {
  type?: string;
  additionalProperties?: boolean;
  properties?: Record<string, Prop>;
  required?: string[];
}

function invalid(message: string): DbConnectorError {
  return new DbConnectorError(ErrorCode.InvalidArgs, message);
}

function checkValue(spec: Prop, value: unknown, key: string): void {
  switch (spec.type) {
    case 'string':
      if (typeof value !== 'string') throw invalid(`"${key}" must be a string`);
      if (spec.minLength !== undefined && (value as string).length < spec.minLength) {
        throw invalid(`"${key}" must be at least ${spec.minLength} character(s)`);
      }
      break;
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw invalid(`"${key}" must be an integer`);
      }
      break;
    case 'number':
      if (typeof value !== 'number') throw invalid(`"${key}" must be a number`);
      break;
    case 'boolean':
      if (typeof value !== 'boolean') throw invalid(`"${key}" must be a boolean`);
      break;
    case 'array':
      if (!Array.isArray(value)) throw invalid(`"${key}" must be an array`);
      break;
    case 'object':
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw invalid(`"${key}" must be an object`);
      }
      break;
    default:
      break;
  }
  if (spec.enum !== undefined && !spec.enum.includes(value)) {
    throw invalid(
      `"${key}" must be one of ${spec.enum.map((e) => JSON.stringify(e)).join(', ')}`,
    );
  }
}

/** Validate parsed model arguments against the tool's parameter schema. */
export function validateArgs(schema: Schema, raw: unknown): asserts raw is Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalid('arguments must be an object');
  }
  const props = schema.properties ?? {};
  const allowed = new Set(Object.keys(props));
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(raw)) {
      if (!allowed.has(key)) throw invalid(`unknown property "${key}"`);
    }
  }
  for (const key of schema.required ?? []) {
    if (!(key in raw)) throw invalid(`missing required property "${key}"`);
  }
  for (const [key, spec] of Object.entries(props)) {
    if (!(key in raw)) continue;
    checkValue(spec, (raw as Record<string, unknown>)[key], key);
  }
}

function render(_args: unknown, value: unknown): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
}

const OUTPUT = {
  schema: { type: 'object' },
  render,
};

function parameters(props: Record<string, Prop>, required: string[] = [], additionalProperties = false) {
  return {
    type: 'object',
    additionalProperties,
    properties: props,
    required,
  };
}

const REQUIRED_NAME_SQL = { type: 'string', minLength: 1, description: 'Name of an existing connection (see db_connect).' };
const SQL_FIELD = { type: 'string', minLength: 1, description: 'Single SQL statement to run.' };
const PARAMS_FIELD = { type: 'array', description: 'Positional values for "?" placeholders. Values are bound as parameters, never interpolated into SQL text.' };
const NAMED_FIELD = { type: 'object', description: 'Binding for ":name" placeholders. Values are bound as parameters, never interpolated into SQL text.' };
const TIMEOUT_FIELD = { type: 'integer', description: 'Per-statement deadline in milliseconds (AbortSignal-based).' };

const CONNECT_PARAMS = parameters(
  {
    name: { type: 'string', minLength: 1, description: 'Unique connection name.' },
    action: {
      type: 'string',
      enum: ['connect', 'close', 'list'],
      description: '"connect" (default) | "close" | "list"',
    },
    config: {
      type: 'object',
      description: 'Connection fields for "connect": { driver, database, host, port, user, passwordEnv, passwordRef, connectionString, schema, ssl, options }.',
    },
  },
  [],
);

const SCHEMA_PARAMS = parameters(
  {
    name: { type: 'string', minLength: 1, description: 'Connection name.' },
    refresh: { type: 'boolean', description: 'Bypass the cached snapshot and re-introspect.' },
    filter: { type: 'string', description: 'Only include tables/views whose name contains this value (case-insensitive).' },
  },
  ['name'],
);

const QUERY_PARAMS = parameters(
  {
    name: REQUIRED_NAME_SQL,
    sql: SQL_FIELD,
    params: PARAMS_FIELD,
    namedParams: NAMED_FIELD,
    limit: { type: 'integer', description: 'Result row cap for this query (default: plugin maxRows).' },
    timeoutMs: TIMEOUT_FIELD,
  },
  ['name', 'sql'],
);

const EXEC_PARAMS = parameters(
  {
    name: REQUIRED_NAME_SQL,
    sql: SQL_FIELD,
    params: PARAMS_FIELD,
    namedParams: NAMED_FIELD,
    allowWrite: {
      type: 'boolean',
      description: 'Explicit confirmation to run a write/DDL statement (INSERT/UPDATE/DELETE/CREATE/DROP/ALTER). The gate is ON by default — set true to confirm.',
    },
    timeoutMs: TIMEOUT_FIELD,
  },
  ['name', 'sql'],
);

const AUDIT_PARAMS = parameters(
  {
    name: { type: 'string', minLength: 1, description: 'Restrict to one connection.' },
    kind: {
      type: 'string',
      enum: ['query', 'write', 'ddl', 'read', 'schema', 'denied'],
      description: 'Restrict by audit record kind.',
    },
    since: { type: 'string', description: 'Only records at or after this ISO timestamp.' },
    limit: { type: 'integer', description: 'Max records to return (default 200).' },
  },
  [],
);

/** Build the five tools. `engine` is injected at plugin load. */
export function buildTools(engine: ExecutionEngine): DshTool[] {
  const connect: DshTool = {
    name: 'db_connect',
    description: `Register and open a named database connection (sqlite / postgres / mysql).
Returns redacted status; connection credentials should come from environment variables (passwordEnv or \${VAR} placeholders) and are never logged.
Use action "list" to show connections, action "close" to release one.
Examples:
  - connect: {"name":"app","config":{"driver":"sqlite","database":"./data/app.db"}}
  - connect: {"name":"analytics","config":{"driver":"postgres","host":"db.local","database":"warehouse","user":"readonly","passwordEnv":"PG_PASSWORD"}}
  - list / close: {"action":"list"} or {"action":"close","name":"app"}`,
    parameters: CONNECT_PARAMS,
    output: OUTPUT,
    async execute(args, exec) {
      validateArgs(CONNECT_PARAMS as unknown as Schema, args);
      void exec.signal;
      const action = (args.action as string | undefined) ?? 'connect';
      if (action === 'list') {
        return { action, ...(await engine.listConnections()) };
      }
      if (action === 'close') {
        const name = args.name as string;
        if (!name) throw invalid('"name" is required for action "close"');
        await engine.close(name);
        return { action, connection: name, closed: true };
      }
      const name = args.name as string;
      if (!name) throw invalid('"name" is required when connecting');
      const config = (args.config ?? {}) as Record<string, unknown>;
      if (typeof config !== 'object' || config === null || Array.isArray(config)) {
        throw invalid('"config" must be an object');
      }
      // The explicit top-level "name" wins over any name inside "config".
      const spec: ConnectionSpec = { ...(config as unknown as ConnectionSpec), name };
      const status = await engine.connect(spec);
      return { action: 'connect', connection: status.name, driver: status.driver, status };
    },
  };

  const schema: DshTool = {
    name: 'db_schema',
    description: `Introspect a connection: tables, views, columns (name/type/nullable/default/primary key), indexes and foreign keys.
The snapshot is cached per connection (configurable TTL); pass "refresh":true to force a fresh read.
Use "filter" to narrow by table/view name substring. All output is credential-free.`,
    parameters: SCHEMA_PARAMS,
    output: OUTPUT,
    async execute(args, exec) {
      validateArgs(SCHEMA_PARAMS as unknown as Schema, args);
      return engine.schema(
        {
          connection: args.name as string,
          refresh: (args.refresh as boolean | undefined) ?? false,
          filter: args.filter as string | undefined,
          way: 'tool',
        },
        exec.signal,
      );
    },
  };

  const query: DshTool = {
    name: 'db_query',
    description: `Run a read-only query (SELECT / EXPLAIN / DESCRIBE / SHOW) on a connection.
Read-only is enforced: any write statement (INSERT/UPDATE/DELETE/DDL/PRAGMA) is rejected here — including EXPLAIN ANALYZE and data-modifying CTEs. Results are capped at a row limit ("limit" or the plugin default).
Use "params" (array for "?") or "namedParams" (object for ":name") to pass values — bound as parameters, never interpolated into SQL text.
Uses "timeoutMs" or the default deadline; aborts on timeout.`,
    parameters: QUERY_PARAMS,
    output: OUTPUT,
    async execute(args, exec) {
      validateArgs(QUERY_PARAMS as unknown as Schema, args);
      return engine.query(
        {
          connection: args.name as string,
          sql: args.sql as string,
          params: args.params as unknown[] | undefined,
          namedParams: args.namedParams as Record<string, unknown> | undefined,
          limit: args.limit as number | undefined,
          timeoutMs: args.timeoutMs as number | undefined,
          way: 'tool',
        },
        exec.signal,
      );
    },
  };

  const exec: DshTool = {
    name: 'db_exec',
    description: `Execute a statement that may write data: INSERT / UPDATE / DELETE / DDL (and unknown statements).
The write approval gate is ON by default: you MUST pass "allowWrite":true to run anything that is not a pure read — this is the explicit confirmation. The statement runs inside a transaction: COMMIT on success, ROLLBACK on failure (no partial rows).
Reads routed here simply execute read-only. Returns affected rows and a rollback explanation. Every call is audited.`,
    parameters: EXEC_PARAMS,
    output: OUTPUT,
    async execute(args, execCtx) {
      validateArgs(EXEC_PARAMS as unknown as Schema, args);
      return engine.exec(
        {
          connection: args.name as string,
          sql: args.sql as string,
          params: args.params as unknown[] | undefined,
          namedParams: args.namedParams as Record<string, unknown> | undefined,
          allowWrite: (args.allowWrite as boolean | undefined) ?? false,
          timeoutMs: args.timeoutMs as number | undefined,
          way: 'tool',
        },
        execCtx.signal,
      );
    },
  };

  const audit: DshTool = {
    name: 'db_audit',
    description: `Read the SQL audit trail (JSONL). Every executed (and denied) statement appends one record: time, connection, statement summary + sha256 digest, kind (query/write/ddl/read/schema/denied), rows, duration, status, and the way it ran (tool/command/cli).
Filter with "name" (connection), "kind", "since" (ISO timestamp), "limit" (default 200, newest first). Credentials never appear.`,
    parameters: AUDIT_PARAMS,
    output: OUTPUT,
    async execute(args, exec) {
      validateArgs(AUDIT_PARAMS as unknown as Schema, args);
      void exec.signal;
      return engine.audit({
        connection: args.name as string | undefined,
        kind: args.kind as 'query' | undefined,
        since: args.since as string | undefined,
        limit: args.limit as number | undefined,
      });
    },
  };

  return [connect, schema, query, exec, audit];
}

/** Injectable references so integration tests can inspect the tool set. */
export const TOOL_NAMES = ['db_connect', 'db_schema', 'db_query', 'db_exec', 'db_audit'] as const;
