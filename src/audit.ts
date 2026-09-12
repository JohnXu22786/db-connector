/**
 * SQL audit log: append-only JSONL on disk.
 *
 * Every entry carries a stable schema (time / connection / statement digest +
 * summary / kind / way / rows / status / error). Credentials are structurally
 * excluded: the log API only accepts already-sanitized fields and no
 * connection config ever passes through it. Appends are serialized so
 * concurrent tool calls cannot interleave partial lines.
 */

import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ErrorCode, DbConnectorError } from './errors.js';
import type { AuditRecord, WayKind } from './types.js';
import { sha256, uid } from './util.js';

export interface AuditInput {
  connection: string;
  kind: AuditRecord['kind'];
  way: WayKind;
  sql: string;
  maxSqlChars: number;
  rows: number;
  durationMs: number;
  status: AuditRecord['status'];
  error?: { code: string; message: string };
}

const FILE_MODE = 0o600;

export class AuditLog {
  readonly path: string;
  readonly enabled: boolean;
  /** Appends submitted (correlation/debug). */
  submitted = 0;
  /** Background write failures (durability is best-effort, never fatal). */
  failed = 0;

  /** Last background write failure, for diagnostics (never thrown). */
  lastError: unknown = null;

  private chain: Promise<void> = Promise.resolve();

  constructor(path: string, enabled = true) {
    this.path = path;
    this.enabled = enabled;
  }

  private get nextId(): string {
    this.submitted += 1;
    return `${Date.now().toString(36)}-${sha256(uid()).slice(0, 10)}-${this.submitted.toString(36)}`;
  }

  /**
   * Append one record. The write is serialized onto an internal chain; a
   * failed write is counted and recorded (exposed via `failed`/`lastError`)
   * but NEVER throws — audit durability must not turn a successfully executed
   * database statement into an error, and one lost write must not poison the
   * appends that follow.
   */
  async append(input: AuditInput): Promise<string> {
    if (!this.enabled) return '';

    const record: AuditRecord = {
      id: this.nextId,
      ts: new Date().toISOString(),
      connection: input.connection,
      kind: input.kind,
      way: input.way,
      statement: summarize(sqlSummary(input.sql), input.maxSqlChars),
      rows: Math.max(0, Math.floor(input.rows) || 0),
      durationMs: Math.max(0, Math.round(input.durationMs)),
      status: input.status,
    };
    if (input.error) {
      record.error = { code: input.error.code, message: input.error.message };
    }

    const line = `${JSON.stringify(record)}\n`;
    // The write itself is chained (not just its resolution): mkdir+open+write
    // for this record starts only after every earlier write settles, so
    // concurrent appends stay byte-ordered and can never interleave lines.
    const write = async (): Promise<unknown> => {
      try {
        await mkdir(dirname(this.path), { recursive: true });
        const handle = await open(this.path, 'a', FILE_MODE);
        try {
          await handle.chmod(FILE_MODE);
          await handle.appendFile(line, { encoding: 'utf8' });
        } finally {
          await handle.close();
        }
      } catch (err: unknown) {
        this.failed += 1;
        this.lastError = err;
      }
      return undefined;
    };
    const previous = this.chain;
    this.chain = previous.then(write).then(() => undefined);
    await this.chain;
    return record.id;
  }

  /** Wait for every enqueued write to settle. */
  async flush(): Promise<void> {
    await this.chain;
  }

  /** Read the log, newest first, with optional filters. */
  async query(opts: {
    connection?: string;
    kind?: AuditRecord['kind'];
    since?: string;
    limit?: number;
  } = {}): Promise<AuditRecord[]> {
    await this.flush();
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return [];
      throw new DbConnectorError(
        ErrorCode.AuditUnavailable,
        `audit log read failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const limit =
      opts.limit === undefined || !Number.isFinite(opts.limit)
        ? 200
        : Math.max(0, Math.floor(opts.limit));
    const since = opts.since ? Date.parse(opts.since) : undefined;
    const out: AuditRecord[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      let rec: AuditRecord;
      try {
        rec = JSON.parse(trimmed) as AuditRecord;
      } catch {
        continue; // tolerate one malformed line instead of failing the read
      }
      if (opts.connection && rec.connection !== opts.connection) continue;
      if (opts.kind && rec.kind !== opts.kind) continue;
      if (since !== undefined && Number.isFinite(since)) {
        const recordTime = Date.parse(rec.ts);
        if (Number.isFinite(recordTime) && recordTime < since) continue;
      }
      out.push(rec);
    }
    out.reverse();
    return out.slice(0, limit);
  }
}

/** Collapse raw SQL to a single line of readable text for logging. */
function sqlSummary(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function summarize(
  collapsed: string,
  maxChars: number,
): AuditRecord['statement'] {
  const max = Math.max(1, maxChars);
  return {
    summary: collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed,
    digest: sha256(collapsed),
    chars: collapsed.length,
  };
}
