/**
 * The `/db` human command (CLI) — registers on `ctx.commands` when that
 * service is present. It mirrors the five tools with the same engine and the
 * same safety gates; every call is audited with way="command".
 *
 * `runDbLine` is exported separately from registration so it can be tested
 * without a Cordis context.
 */

import type { ExecutionEngine } from './executor.js';
import type { DshContext } from './types.js';

const HELP = `db — SQL database operations
  /db status
  /db connect <name> --driver <sqlite|postgres|mysql> [--db <path|name>] [--host <h>] [--port <p>] [--user <u>] [--password-env <VAR>] [--connection-string <url>]
  /db close <name>
  /db schema <name> [--refresh] [--filter <substr>]
  /db query <name> --sql "SELECT ..." [--limit <n>] [--timeout <ms>] [--params a,b,c]
  /db exec <name> --sql "UPDATE ..." --allow-write [--params a,b,c] [--timeout <ms>]
  /db audit [name] [--kind <k>] [--limit <n>] [--since <ISO>]
  /db help`;

/** Split CLI input into tokens, honoring single/double quotes. */
export function tokenize(input: string): string[] {
  const regex = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|(\S+)/g;
  const out: string[] = [];
  for (const m of input.matchAll(regex)) {
    const value = m[1] ?? m[2] ?? m[3]!;
    const quote = m[1] !== undefined ? '"' : m[2] !== undefined ? "'" : undefined;
    out.push(quote === undefined ? value : decodeQuoted(value, quote));
  }
  return out;
}

function decodeQuoted(value: string, quote: '"' | "'"): string {
  const pattern = quote === '"' ? /\\(["\\])/g : /\\(['\\])/g;
  return value.replace(pattern, '$1');
}

/** Split into positional args and `--key value` / `--key=value` pairs. */
export function splitFlags(tokens: string[]): {
  positionals: string[];
  flags: Record<string, string | boolean>;
} {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      if (eq >= 0) {
        flags[t.slice(2, eq)] = t.slice(eq + 1);
      } else {
        const key = t.slice(2);
        const next = tokens[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[key] = next;
          i += 1;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positionals.push(t);
    }
  }
  return { positionals, flags };
}

function flagStr(flags: Record<string, string | boolean>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' ? v : undefined;
}

function flagBool(flags: Record<string, string | boolean>, key: string): boolean {
  return flags[key] === true || flagStr(flags, key) === 'true' || flagStr(flags, key) === '1';
}

/**
 * Execute a `/db` command line and return human-facing text.
 * Throws on failure (the command adapter renders it as an error result).
 */
export async function runDbLine(
  engine: ExecutionEngine,
  rawInput: string,
  signal: AbortSignal,
): Promise<string> {
  const { positionals, flags } = splitFlags(tokenize(rawInput));
  const sub = (positionals[0] ?? 'help').toLowerCase();

  switch (sub) {
    case 'help':
      return HELP;

    case 'status':
    case 'list': {
      const { connections } = await engine.listConnections();
      if (connections.length === 0) return 'No connections defined. Run /db connect <name> --driver ...';
      const lines = connections.map((c) =>
        `  ${c.name.padEnd(20)} ${c.driver.toString().padEnd(9)} ${c.status.padEnd(10)} executions=${c.executions}`,
      );
      return `Connections (${connections.length}):\n${lines.join('\n')}`;
    }

    case 'connect': {
      const name = positionals[1];
      if (!name) throw new Error('usage: /db connect <name> --driver ...');
      const driver = flagStr(flags, 'driver') ?? 'sqlite';
      const spec = {
        name,
        driver,
        database: flagStr(flags, 'db'),
        host: flagStr(flags, 'host'),
        port: flagStr(flags, 'port'),
        user: flagStr(flags, 'user'),
        passwordEnv: flagStr(flags, 'password-env'),
        connectionString: flagStr(flags, 'connection-string'),
        schema: flagStr(flags, 'schema'),
      } as const;
      const status = await engine.connect(spec as never);
      return `Connected ${name} (${status.driver}).`;
    }

    case 'close': {
      const name = positionals[1];
      if (!name) throw new Error('usage: /db close <name>');
      await engine.close(name);
      return `Connection "${name}" closed.`;
    }

    case 'schema': {
      const name = positionals[1];
      if (!name) throw new Error('usage: /db schema <name> [--refresh] [--filter ...]');
      const snapshot = await engine.schema(
        {
          connection: name,
          refresh: flagBool(flags, 'refresh'),
          filter: flagStr(flags, 'filter'),
          way: 'command',
        },
        signal,
      );
      const tables = snapshot.tables.map((t) => t.name);
      const views = snapshot.views.map((v) => v.name);
      const columns = snapshot.columns.length;
      const indexes = snapshot.indexes.length;
      const fks = snapshot.foreignKeys.length;
      const out: string[] = [
        `Schema for "${name}" (${snapshot.fromCache ? 'cache' : 'fresh'}):`,
        `  tables: ${tables.length}  views: ${views.length}  columns: ${columns}  indexes: ${indexes}  foreign keys: ${fks}`,
      ];
      if (tables.length > 0) out.push(`  tables: ${tables.join(', ')}`);
      if (views.length > 0) out.push(`  views: ${views.join(', ')}`);
      return out.join('\n');
    }

    case 'query': {
      const name = positionals[1];
      const sql = flagStr(flags, 'sql');
      if (!name) throw new Error('usage: /db query <name> --sql "SELECT ..."');
      if (!sql) throw new Error('missing --sql "..."');
      const paramsText = flagStr(flags, 'params');
      const params = paramsText !== undefined ? decodeCsv(paramsText) : undefined;
      const limit = flagNumber(flags, 'limit');
      const result = await engine.query(
        {
          connection: name,
          sql,
          params,
          limit,
          timeoutMs: flagNumber(flags, 'timeout'),
          way: 'command',
        },
        signal,
      );
      const sample = result.rows.slice(0, 10);
      return [
        `${result.rowCount} row(s)${result.truncated ? ` (truncated at ${result.limit})` : ''} in ${Math.round(result.durationMs)}ms`,
        `columns: ${result.columns.join(', ')}`,
        sample.length ? JSON.stringify({ columns: result.columns, rows: sample }, null, 2) : '(no rows)',
      ].join('\n');
    }

    case 'exec': {
      const name = positionals[1];
      const sql = flagStr(flags, 'sql');
      if (!name) throw new Error('usage: /db exec <name> --sql "..." --allow-write');
      if (!sql) throw new Error('missing --sql "..."');
      const paramsText = flagStr(flags, 'params');
      const params = paramsText !== undefined ? decodeCsv(paramsText) : undefined;
      const result = await engine.exec(
        {
          connection: name,
          sql,
          params,
          allowWrite: flagBool(flags, 'allow-write'),
          timeoutMs: flagNumber(flags, 'timeout'),
          way: 'command',
        },
        signal,
      );
      return `${result.kind}: ${result.affectedRows} row(s) affected in ${Math.round(result.durationMs)}ms\n${result.note}`;
    }

    case 'audit': {
      const name = positionals[1];
      const { records } = await engine.audit({
        connection: name,
        kind: flagStr(flags, 'kind') as 'query' | undefined,
        since: flagStr(flags, 'since'),
        limit: flagNumber(flags, 'limit'),
      });
      const lines = records.map(
        (r) =>
          `  ${r.ts}  ${r.connection.padEnd(16)} ${r.kind.padEnd(8)} ${r.status.padEnd(7)} rows=${r.rows} ${r.statement.summary.slice(0, 80)}`,
      );
      return `Audit records (${records.length}):\n${lines.join('\n') || '  (none)'}`;
    }

    default:
      if (positionals.length === 0) return 'Type "/db help" for usage.';
      return `unknown subcommand "${sub}" — type "/db help" for usage.`;
  }
}

function decodeCsv(text: string): unknown[] {
  return text.split(',').map((part) => {
    const t = part.trim();
    if (t === 'null') return null;
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
    return t;
  });
}

function flagNumber(flags: Record<string, string | boolean>, key: string): number | undefined {
  const v = flagStr(flags, key);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return n;
}

/** Register the `/db` command when a commands service is available. */
export function registerDbCommand(
  ctx: DshContext,
  engine: ExecutionEngine,
): (() => void) | undefined {
  const commands = ctx.commands;
  if (!commands) return undefined;
  return commands.register({
    name: 'db',
    description:
      'SQL database operations (status | connect | close | schema | query | exec | audit). Type "/db help" for usage.',
    input: { hint: 'db <status|connect|close|schema|query|exec|audit> ...' },
    async handler({ rawInput, signal }) {
      const text = await runDbLine(engine, rawInput, signal);
      return { kind: 'success', text };
    },
  });
}
