/**
 * Plugin entry (bundle format): `name` + `inject` + `apply(ctx, config)`.
 *
 * Wires the ExecutionEngine to the dsh surface: five model-facing tools on
 * `ctx.tools`, the `/db` command on `ctx.commands` when present, and teardown
 * (close connections + flush the audit log) on context disposal.
 *
 * This plugin is intentionally independent of the official dsh schema: tool
 * names, parameter shapes, and results are this bundle's own design.
 */

import { AuditLog } from './audit.js';
import { registerDbCommand } from './commands.js';
import { normalizeConfig } from './config.js';
import { Connectors } from './connectors.js';
import { ExecutionEngine } from './executor.js';
import { SchemaService } from './schema.js';
import { buildTools, TOOL_NAMES } from './tools.js';
import type { DshContext, ResolvedConfig } from './types.js';

export const name = 'db-connector';

export const inject = ['tools'];

export interface BundleConfig {
  connections?: Record<string, Record<string, unknown>>;
  audit?: { enabled?: boolean; path?: string | null };
  query?: { maxRows?: number; timeoutMs?: number; maxSqlChars?: number };
  schema?: { ttlMs?: number };
  defaultAllowWrite?: boolean;
}

/** Resolve a credential through dsh, falling back to a plain env lookup. */
async function resolveCredential(
  ctx: DshContext,
  ref: string,
): Promise<string | undefined> {
  const provider = ctx.get?.('credentials') as
    | {
        resolve?(r: unknown): Promise<unknown> | unknown;
      }
    | undefined;
  if (!provider?.resolve) return process.env[ref];
  const read = (out: unknown): string | undefined => {
    if (typeof out === 'string') return out;
    if (out && typeof out === 'object' && 'value' in out) {
      const v = (out as { value?: unknown }).value;
      return typeof v === 'string' ? v : undefined;
    }
    return undefined;
  };
  try {
    const a = await provider.resolve({ key: ref } as never);
    const value = read(a);
    if (value) return value;
  } catch {
    /* fall through to the plain-string form */
  }
  try {
    const b = await provider.resolve(ref as never);
    const value = read(b);
    return value || process.env[ref];
  } catch {
    return process.env[ref];
  }
}

export function apply(ctx: DshContext, config?: BundleConfig): void {
  const cfg = normalizeConfig(config, process.env);
  const logger = ctx.logger;

  const audit = new AuditLog(cfg.audit.path, cfg.audit.enabled);
  const connectors = new Connectors({
    debug: (...a) => logger.debug(...a),
    info: (...a) => logger.info(...a),
    warn: (...a) => logger.warn(...a),
  });
  const schema = new SchemaService(cfg.schema.ttlMs);
  const engine = new ExecutionEngine({
    connectors,
    audit,
    config: cfg,
    schema,
    resolveCredentials: (ref) => resolveCredential(ctx, ref),
    logger: {
      debug: (...a) => logger.debug(...a),
      info: (...a) => logger.info(...a),
      warn: (...a) => logger.warn(...a),
    },
  });

  // Pre-register config-provided connections (opened lazily on first use).
  predefine(cfg, connectors, logger);

  const tools = buildTools(engine);
  for (const tool of tools) {
    ctx.tools!.register(tool);
  }
  logger.info(
    'db-connector: registered %s tools (%s)',
    tools.length,
    TOOL_NAMES.join(', '),
  );

  registerDbCommand(ctx, engine);

  const teardown = (): void => {
    void engine.dispose().finally(() => audit.flush());
  };
  ctx.on?.('dispose', teardown);
  if (typeof process !== 'undefined') {
    // Best-effort for bare runs; disposed reliably through Cordis in dsh.
    process.once?.('exit', () => void audit.flush());
  }
}

function predefine(
  cfg: ResolvedConfig,
  connectors: Connectors,
  logger: { warn(...a: unknown[]): void },
): void {
  const entries = cfg.connections ?? {};
  for (const [name, fields] of Object.entries(entries)) {
    try {
      connectors.define(fields);
    } catch (err) {
      logger.warn(
        'db-connector: could not pre-register connection "%s": %s',
        name,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}
