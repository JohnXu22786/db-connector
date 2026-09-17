/**
 * SQL text analysis: a small lexer plus classification and rewriting helpers.
 *
 * This module is the trust boundary for the "default read-only" guarantee.
 * It never executes SQL and never interpolates user data — it only inspects
 * text. All recognition is string-literal / comment aware so a crafted value
 * like `'INSERT'` or a `SELECT ... -- DROP` comment can never fool the gate.
 *
 * The default scanner follows ANSI string escaping (`''`). Dialect-aware scans
 * additionally recognize MySQL backslash escapes and PostgreSQL `E'...'`
 * escape strings. Classification only ever uses recognition to REJECT writes,
 * never to allow them, so this cannot widen the write surface.
 */

import { ErrorCode, DbConnectorError } from './errors.js';
import { sha256, truncateMiddle } from './util.js';
import type { DriverKind } from './types.js';

export type TokenType =
  | 'word'
  | 'string'
  | 'quotedid'
  | 'param'
  | 'symbol'
  | 'space'
  | 'comment';

export interface Token {
  type: TokenType;
  value: string;
  /** Start offset of the token in the source text. */
  pos: number;
  /** Paren depth at the token (symbols only, 0-based). */
  depth: number;
}

export interface ScanOptions {
  /** Treat backslashes as escapes inside quoted strings. */
  backslashEscapes?: boolean;
  /** Recognize PostgreSQL `E'...'` escape string constants. */
  postgresEscapeStrings?: boolean;
}

function scanOptionsForDriver(driver: DriverKind): ScanOptions {
  if (driver === 'mysql') return { backslashEscapes: true };
  if (driver === 'postgres') return { postgresEscapeStrings: true };
  return {};
}

/** Data-statement keywords valid at the top level of a statement. */
const DATA_KEYWORDS = new Set([
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'VALUES',
]);

/** Keywords that always mutate data when they appear in a statement. */
const WRITE_KEYWORDS = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'REPLACE']);

/**
 * Scan SQL into tokens, tracking strings, quoted identifiers, comments, and
 * parameter markers. Paren depth is recorded on each token so callers can
 * distinguish a top-level LIMIT from a subquery LIMIT. A driver selects the
 * dialect-specific string rules; an options object is also accepted for
 * dialect-independent callers such as audit redaction.
 */
export function scan(sql: string, options: ScanOptions | DriverKind = {}): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = sql.length;
  let depth = 0;
  const resolvedOptions = typeof options === 'string' ? scanOptionsForDriver(options) : options;
  const mysqlDashComments = options === 'mysql';
  const sqliteBracketIdentifiers = options === 'sqlite';
  const postgresDollarQuotes = options !== 'sqlite' && options !== 'mysql';
  const backslashEscapes = resolvedOptions.backslashEscapes === true;
  const postgresEscapeStrings = resolvedOptions.postgresEscapeStrings === true;

  const isIdentStart = (c: string): boolean => /[A-Za-z_\u0080-\uffff]/.test(c);
  const isIdentPart = (c: string): boolean =>
    /[A-Za-z0-9_$\u0080-\uffff]/.test(c);

  while (i < n) {
    const at = i;
    const c = sql[i]!;

    // whitespace
    if (/\s/.test(c)) {
      while (i < n && /\s/.test(sql[i]!)) i += 1;
      tokens.push({ type: 'space', value: sql.slice(at, i), pos: at, depth });
      continue;
    }

    // -- line comment
    if (
      c === '-' &&
      sql[i + 1] === '-' &&
      (!mysqlDashComments || /[\s\u0000-\u001f]/.test(sql[i + 2] ?? ''))
    ) {
      i += 2;
      while (i < n && sql[i] !== '\n' && sql[i] !== '\r') i += 1;
      tokens.push({ type: 'comment', value: sql.slice(at, i), pos: at, depth });
      continue;
    }

    // /* block comment */
    if (c === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
      i = Math.min(n, i + 2);
      tokens.push({ type: 'comment', value: sql.slice(at, i), pos: at, depth });
      continue;
    }

    // PostgreSQL escape string constant: E'...' / e'...'. Backslashes have
    // special meaning only in this prefixed form (not ordinary PG strings).
    if (
      postgresEscapeStrings &&
      (c === 'E' || c === 'e') &&
      sql[i + 1] === "'"
    ) {
      i += 2;
      while (i < n) {
        if (sql[i] === '\\') {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      tokens.push({ type: 'string', value: sql.slice(at, i), pos: at, depth });
      continue;
    }

    // 'single-quoted string' (supports ANSI '' doubling)
    if (c === "'") {
      i += 1;
      while (i < n) {
        if (backslashEscapes && sql[i] === '\\') {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      tokens.push({ type: 'string', value: sql.slice(at, i), pos: at, depth });
      continue;
    }

    // "double-quoted identifier" (ANSI "" doubling)
    if (c === '"') {
      i += 1;
      while (i < n) {
        if (backslashEscapes && sql[i] === '\\') {
          i += 2;
          continue;
        }
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      tokens.push({ type: 'quotedid', value: sql.slice(at, i), pos: at, depth });
      continue;
    }

    // `mysql backtick identifier`
    if (c === '`') {
      i += 1;
      while (i < n) {
        if (sql[i] !== '`') {
          i += 1;
          continue;
        }
        if (sql[i + 1] === '`') {
          i += 2;
          continue;
        }
        i += 1;
        break;
      }
      tokens.push({ type: 'quotedid', value: sql.slice(at, i), pos: at, depth });
      continue;
    }

    // SQLite bracket-quoted identifier
    if (sqliteBracketIdentifiers && c === '[') {
      i += 1;
      while (i < n && sql[i] !== ']') i += 1;
      if (i < n) i += 1;
      tokens.push({ type: 'quotedid', value: sql.slice(at, i), pos: at, depth });
      continue;
    }

    // PostgreSQL dollar-quoted string: $$...$$ or $tag$...$tag$
    if (postgresDollarQuotes && c === '$') {
      let j = i + 1;
      const emptyTag = sql[j] === '$';
      const namedTag = isIdentStart(sql[j] ?? '');
      if (namedTag) {
        j += 1;
        while (j < n && sql[j] !== '$' && isIdentPart(sql[j]!)) j += 1;
      }
      if (emptyTag || (namedTag && j < n && sql[j] === '$')) {
        const delim = sql.slice(i, j + 1);
        const end = sql.indexOf(delim, j + 1);
        i = end === -1 ? n : end + delim.length;
        tokens.push({ type: 'string', value: sql.slice(at, i), pos: at, depth });
        continue;
      }
      tokens.push({ type: 'symbol', value: '$', pos: at, depth });
      i += 1;
      continue;
    }

    // positional parameter marker
    if (c === '?') {
      tokens.push({ type: 'param', value: '?', pos: at, depth });
      i += 1;
      continue;
    }

    // PostgreSQL cast / assignment operators are two-char symbols, not
    // parameter markers. Consume both characters so `::text` / `:=` can
    // never be parsed as a `:name` parameter.
    if (c === ':' && (sql[i + 1] === ':' || sql[i + 1] === '=')) {
      tokens.push({ type: 'symbol', value: c + sql[i + 1]!, pos: at, depth });
      i += 2;
      continue;
    }

    // named parameter marker :name
    if (
      c === ':' &&
      sql[i + 1] !== ':' &&
      sql[i + 1] !== '=' &&
      isIdentStart(sql[i + 1] ?? '')
    ) {
      i += 1;
      while (i < n && isIdentPart(sql[i]!)) i += 1;
      tokens.push({ type: 'param', value: sql.slice(at, i), pos: at, depth });
      continue;
    }

    // identifier / keyword
    if (isIdentStart(c)) {
      i += 1;
      while (i < n && isIdentPart(sql[i]!)) i += 1;
      tokens.push({ type: 'word', value: sql.slice(at, i), pos: at, depth });
      continue;
    }

    // parens adjust depth; everything else is a symbol
    if (c === '(') depth += 1;
    else if (c === ')') depth = Math.max(0, depth - 1);
    tokens.push({ type: 'symbol', value: c, pos: at, depth });
    i += 1;
  }

  return tokens;
}

/** Meaningful tokens: everything except whitespace and comments. */
function meaningful(sql: string, driver?: DriverKind): Token[] {
  return scan(sql, driver ?? {}).filter((t) => t.type !== 'space' && t.type !== 'comment');
}

/** First data-statement keyword at paren depth 0 (WITH/CTE aware). */
function firstDataKeyword(sql: string, driver?: DriverKind): Token | undefined {
  const tokens = meaningful(sql, driver);
  return tokens.find(
    (t) => t.type === 'word' && t.depth === 0 && DATA_KEYWORDS.has(t.value.toUpperCase()),
  );
}

const LEADING_READ = new Set([
  'EXPLAIN', 'DESCRIBE', 'DESC', 'SHOW',
]);

/**
 * TRUE when a write keyword (INSERT/UPDATE/DELETE/MERGE) appears anywhere in
 * the statement at any paren depth. These are reserved words, so an
 * unquoted occurrence is never a plain identifier, and the scanner never
 * emits them from strings, comments, or quoted identifiers.
 */
function containsWriteKeyword(sql: string, driver?: DriverKind): boolean {
  return meaningful(sql, driver).some(
    (t) => t.type === 'word' && WRITE_KEYWORDS.has(t.value.toUpperCase()),
  );
}

function hasTopLevelInto(sql: string, driver?: DriverKind): boolean {
  return meaningful(sql, driver).some(
    (t) => t.type === 'word' && t.depth === 0 && t.value.toUpperCase() === 'INTO',
  );
}

/** PostgreSQL's outer SELECT ... INTO creates a table and is therefore DDL. */
function isPostgresSelectInto(sql: string, driver?: DriverKind): boolean {
  if (driver !== 'postgres' || !hasTopLevelInto(sql, driver)) return false;
  return firstDataKeyword(sql, driver)?.value.toUpperCase() === 'SELECT';
}

/**
 * Classify an EXPLAIN ANALYZE statement. Bare EXPLAIN plans never execute;
 * EXPLAIN ANALYZE does (PostgreSQL executes the underlying DML), so the
 * statement must be classified by its real keyword. Any write keyword wins;
 * otherwise the first top-level data keyword decides; an unresolved case is
 * treated as a write (conservative: never admitted through a read path).
 */
function classifyAnalyzed(sql: string, driver?: DriverKind): 'select' | 'write' | 'ddl' {
  if (isPostgresSelectInto(sql, driver)) return 'ddl';
  if (hasTopLevelInto(sql, driver)) return 'write';
  if (containsWriteKeyword(sql, driver)) return 'write';
  const keyword = firstDataKeyword(sql, driver);
  const kw = keyword?.value.toUpperCase() ?? '';
  if (kw === 'SELECT' || kw === 'VALUES') return 'select';
  return 'write';
}

/**
 * Classify a single statement. Writes are never inferred from SELECT-shaped
 * input; anything unrecognized classifies as `unknown` (conservative — the
 * read-only path rejects it).
 */
export function classifyStatement(sql: string, driver?: DriverKind): {
  kind: 'select' | 'explain' | 'write' | 'ddl' | 'unknown';
  firstWord: string;
} {
  const tokens = meaningful(sql, driver);
  const lead = tokens.find((t) => t.type === 'word');
  if (!lead) return { kind: 'unknown', firstWord: '' };
  const word = lead.value.toUpperCase();

  if (word === 'SELECT' || word === 'VALUES') {
    // PostgreSQL SELECT ... INTO creates a table and therefore invalidates
    // the schema cache like other DDL. Other dialects retain write handling
    // for their INTO forms (for example, MySQL INTO OUTFILE/DUMPFILE).
    const hasInto = word === 'SELECT' && hasTopLevelInto(sql, driver);
    if (hasInto) {
      return {
        kind: driver === 'postgres' ? 'ddl' : 'write',
        firstWord: word,
      };
    }
    return { kind: 'select', firstWord: word };
  }

  // EXPLAIN / DESCRIBE / DESC / SHOW are plans or descriptions that never
  // mutate data on their own. EXPLAIN ANALYZE is the exception (it executes).
  // NOTE: PRAGMA is deliberately NOT in the read set — a PRAGMA may write
  // (journal_mode =, user_version =, optimize, ...) so it needs the write
  // gate (see the unknown branch below).
  if (LEADING_READ.has(word)) {
    if (word === 'EXPLAIN') {
      const hasAnalyze = tokens.some(
        (t) => t.type === 'word' && t.value.toUpperCase() === 'ANALYZE',
      );
      if (hasAnalyze) return { kind: classifyAnalyzed(sql, driver), firstWord: word };
    }
    return { kind: 'explain', firstWord: word };
  }

  if (word === 'WITH') {
    // WITH may be read (WITH ... SELECT) or a write: a PostgreSQL outer
    // SELECT ... INTO creates a table, while data-modifying CTEs remain writes.
    // Any other top-level INTO or write keyword marks the whole statement a
    // write.
    if (isPostgresSelectInto(sql, driver)) {
      return { kind: 'ddl', firstWord: word };
    }
    if (hasTopLevelInto(sql, driver) || containsWriteKeyword(sql, driver)) {
      return { kind: 'write', firstWord: word };
    }
    const next = firstDataKeyword(sql, driver);
    if (next) return { kind: 'select', firstWord: word };
    return { kind: 'unknown', firstWord: word };
  }

  const WRITE = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'REPLACE', 'UPSERT', 'CALL']);
  if (WRITE.has(word)) return { kind: 'write', firstWord: word };

  const DDL = new Set([
    'CREATE', 'DROP', 'ALTER', 'TRUNCATE', 'RENAME', 'GRANT', 'REVOKE',
    'VACUUM', 'ANALYZE', 'ATTACH', 'DETACH', 'REINDEX', 'BEGIN', 'COMMIT',
    'ROLLBACK', 'START', 'CLUSTER', 'COMMENT', 'LOCK', 'SNAPSHOT',
  ]);
  if (DDL.has(word)) return { kind: 'ddl', firstWord: word };

  return { kind: 'unknown', firstWord: word };
}

/**
 * Return whether a statement must be sent outside an explicit transaction for
 * the target database. Only statements known to have that requirement are
 * included; all other writes retain transaction protection.
 */
export function isNonTransactionalStatement(sql: string, driver: DriverKind): boolean {
  const words = scan(sql, driver)
    .filter((token) => token.type === 'word' && token.depth === 0)
    .map((token) => token.value.toUpperCase());

  if (words[0] === 'VACUUM') return driver === 'sqlite' || driver === 'postgres';
  // SQLite PRAGMAs are intentionally opaque to the read classifier. Some
  // write forms, notably `PRAGMA journal_mode = WAL`, cannot run inside an
  // explicit transaction, so execute all PRAGMAs directly once approved.
  if (words[0] === 'PRAGMA') return driver === 'sqlite';
  if (driver !== 'postgres') return false;

  if (words[0] === 'ALTER' && words[1] === 'SYSTEM') return true;
  if (words[0] === 'CREATE' && (words[1] === 'DATABASE' || words[1] === 'TABLESPACE')) return true;
  if (words[0] === 'DROP' && (words[1] === 'DATABASE' || words[1] === 'TABLESPACE')) return true;

  if (words[0] === 'CREATE') {
    return (
      (words[1] === 'INDEX' && words[2] === 'CONCURRENTLY') ||
      (words[1] === 'UNIQUE' && words[2] === 'INDEX' && words[3] === 'CONCURRENTLY')
    );
  }
  if (words[0] === 'DROP') {
    return words[1] === 'INDEX' && words[2] === 'CONCURRENTLY';
  }
  if (words[0] === 'REINDEX') {
    const objectType = new Set(['INDEX', 'TABLE', 'SCHEMA', 'DATABASE', 'SYSTEM']);
    return words[1] === 'CONCURRENTLY' ||
      (objectType.has(words[1] ?? '') && words[2] === 'CONCURRENTLY');
  }
  if (words[0] === 'REFRESH') {
    return words[1] === 'MATERIALIZED' && words[2] === 'VIEW' && words[3] === 'CONCURRENTLY';
  }
  return false;
}

/**
 * True when a statement may be sent through a read-only path.
 * Only plain SELECTs and EXPLAIN-style plans qualify.
 */
export function isReadStatement(sql: string, driver?: DriverKind): boolean {
  const { kind } = classifyStatement(sql, driver);
  return kind === 'select' || kind === 'explain';
}

/**
 * Assert the input holds exactly one top-level statement. Semicolons inside
 * strings, quoted identifiers, comments, and trigger bodies are ignored.
 */
export function assertSingleStatement(sql: string, driver?: DriverKind): void {
  const tokens = scan(sql, driver ?? {});
  const meaningful = tokens
    .map((t, idx) => ({ t, idx }))
    .filter(({ t }) => t.type !== 'space' && t.type !== 'comment');
  const isWord = (
    entry: { t: Token; idx: number } | undefined,
    word: string,
  ): boolean => entry?.t.type === 'word' && entry.t.value.toUpperCase() === word;
  let triggerBodyStart: number | undefined;
  let triggerBodyEnd: number | undefined;
  if (isWord(meaningful[0], 'CREATE')) {
    let triggerIndex = 1;
    if (isWord(meaningful[triggerIndex], 'TEMP') || isWord(meaningful[triggerIndex], 'TEMPORARY')) {
      triggerIndex += 1;
    }
    if (isWord(meaningful[triggerIndex], 'TRIGGER')) {
      const bodyStart = meaningful.findIndex(
        (entry, idx) => idx > triggerIndex && entry.t.depth === 0 && isWord(entry, 'BEGIN'),
      );
      if (bodyStart !== -1) {
        const bodyEnd = meaningful.findIndex(
          (entry, idx) =>
            idx > bodyStart &&
            entry.t.depth === 0 &&
            isWord(entry, 'END') &&
            meaningful[idx - 1]?.t.type === 'symbol' &&
            meaningful[idx - 1]?.t.value === ';',
        );
        if (bodyEnd !== -1) {
          triggerBodyStart = meaningful[bodyStart]!.idx;
          triggerBodyEnd = meaningful[bodyEnd]!.idx;
        }
      }
    }
  }
  const separator = tokens
    .map((t, idx) => ({ t, idx }))
    .filter(({ t, idx }) =>
      t.type === 'symbol' &&
      t.value === ';' &&
      !(triggerBodyStart !== undefined && triggerBodyEnd !== undefined &&
        idx > triggerBodyStart && idx < triggerBodyEnd),
    )
    .map(({ idx }) => idx);
  if (separator.length === 0) return;
  const last = separator[separator.length - 1]!;
  const tail = tokens.slice(last + 1).filter(
    (t) => t.type !== 'space' && t.type !== 'comment',
  );
  if (separator.length > 1 || tail.length > 0) {
    throw new DbConnectorError(
      ErrorCode.MultiStatements,
      'multiple statements in one call are not supported; send them one at a time',
    );
  }
}

/**
 * Return a copy of the SQL with comments removed and string-literal bodies /
 * quoted identifiers replaced by `x`, so callers can reason about structure.
 */
export function stripComments(sql: string, options: ScanOptions | DriverKind = {}): string {
  return renderSanitized(sql, [scan(sql, options)]);
}

interface RedactionSpan {
  start: number;
  end: number;
  replacement: string;
}

function renderSanitized(sql: string, tokenSets: Token[][]): string {
  const literals = mergeSpans(
    tokenSets.flatMap((tokens) => tokens
      .filter((token) => token.type === 'string' || token.type === 'quotedid')
      .map((token) => ({
        start: token.pos,
        end: token.pos + token.value.length,
        replacement: token.type === 'string' ? `'x'` : `"x"`,
      }))),
  );
  const comments = mergeSpans(
    tokenSets.flatMap((tokens) => tokens
      .filter((token) => token.type === 'comment')
      .flatMap((token) => subtractSpans({
        start: token.pos,
        end: token.pos + token.value.length,
        replacement: ' ',
      }, literals))),
  );
  const spans = [...literals, ...comments].sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    if (span.start < cursor) continue;
    out += sql.slice(cursor, span.start);
    out += span.replacement;
    cursor = span.end;
  }
  return out + sql.slice(cursor);
}

function subtractSpans(span: RedactionSpan, blockers: RedactionSpan[]): RedactionSpan[] {
  const pieces: RedactionSpan[] = [];
  let start = span.start;
  for (const blocker of blockers) {
    if (blocker.end <= start) continue;
    if (blocker.start >= span.end) break;
    if (blocker.start > start) {
      pieces.push({ start, end: blocker.start, replacement: span.replacement });
    }
    start = Math.max(start, blocker.end);
    if (start >= span.end) break;
  }
  if (start < span.end) {
    pieces.push({ start, end: span.end, replacement: span.replacement });
  }
  return pieces;
}

function mergeSpans(spans: RedactionSpan[]): RedactionSpan[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: RedactionSpan[] = [];
  for (const span of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && span.start <= previous.end) {
      previous.end = Math.max(previous.end, span.end);
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

/** Collapse whitespace, dropping comments. Used for summaries/digests. */
export function normalizeText(sql: string, driver?: DriverKind): string {
  const tokenSets = driver
    ? [scan(sql, driver)]
    : [scan(sql), scan(sql, 'mysql'), scan(sql, 'postgres')];
  return renderSanitized(sql, tokenSets)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build the audit-safe statement summary: whitespace-collapsed text capped at
 * `maxChars` characters, plus a stable sha256 digest of the collapsed text.
 */
export function summarizeSql(
  sql: string,
  maxChars: number,
  driver?: DriverKind,
): { summary: string; digest: string; chars: number } {
  const normalized = normalizeText(sql, driver);
  return {
    summary: truncateMiddle(normalized, Math.max(1, maxChars)),
    digest: sha256(normalized),
    chars: normalized.length,
  };
}

interface RewriteState {
  out: string;
  count: number;
}

/**
 * Run `onParam` for each `?`/`:name` marker (outside strings/comments) and
 * reconstruct the SQL with the returned text substituted in order.
 */
function rewritePlaceholders(
  sql: string,
  onParam: (state: RewriteState, token: Token) => void,
  driver?: DriverKind,
): RewriteState {
  const state: RewriteState = { out: '', count: 0 };
  for (const t of scan(sql, driver ?? {})) {
    if (t.type === 'param') onParam(state, t);
    else state.out += t.value;
  }
  return state;
}

/**
 * Rewrite `?` markers to `$1..$n` for PostgreSQL's client, preserving all
 * other text verbatim.
 */
export function toDollarPlaceholders(
  sql: string,
  driver?: DriverKind,
): { sql: string; count: number } {
  const state = rewritePlaceholders(sql, (s) => {
    s.count += 1;
    s.out += `$${s.count}`;
  }, driver);
  return { sql: state.out, count: state.count };
}

/**
 * Rewrite named `:param` markers to `?` using occurrence order. `order` lists
 * the parameter names in the order their values must be supplied. A `:name`
 * that was not provided is a hard error rather than a silent mis-bind.
 */
export function rewriteNamedToPositional(
  sql: string,
  provided: string[],
  driver?: DriverKind,
): { sql: string; order: string[] } {
  const known = new Map(provided.map((n) => [n.toUpperCase(), n]));
  const order: string[] = [];
  const state = rewritePlaceholders(sql, (s, t) => {
    if (!t.value.startsWith(':')) {
      // lone '?' untouched by the named-param path
      s.out += t.value;
      return;
    }
    const name = t.value.slice(1);
    const providedName = known.get(name.toUpperCase());
    if (providedName === undefined) {
      throw new DbConnectorError(
        ErrorCode.InvalidParams,
        `named parameter ":${name}" was not provided in "namedParams"`,
      );
    }
    order.push(providedName);
    s.count += 1;
    s.out += '?';
  }, driver);
  void state.count;
  return { sql: state.out, order };
}

/**
 * Append `LIMIT <n>` to a single top-level SELECT that has no top-level LIMIT
 * or PostgreSQL FETCH row limit already. Used only as a courtesy guard: the
 * executor always caps rows on the consuming side no matter what this returns.
 */
export function ensureSelectLimit(
  sql: string,
  limit: number,
  driver?: DriverKind,
): { sql: string; applied: boolean } {
  const { kind } = classifyStatement(sql, driver);
  if (kind !== 'select') return { sql, applied: false };

  const tokens = meaningful(sql, driver);
  const hasTopLevelLimit = tokens.some(
    (t) => t.type === 'word' && t.depth === 0 && t.value.toUpperCase() === 'LIMIT',
  );
  if (hasTopLevelLimit || hasTopLevelFetchLimit(tokens, driver)) {
    return { sql, applied: false };
  }

  assertSingleStatement(sql, driver);
  const upper = Math.max(1, Math.floor(limit));
  const insertAt = insertionPoint(sql, driver);
  const out =
    sql.slice(0, insertAt) + ` LIMIT ${upper}` + sql.slice(insertAt);
  return { sql: out, applied: true };
}

function hasTopLevelFetchLimit(tokens: Token[], driver?: DriverKind): boolean {
  if (driver !== 'postgres') return false;

  for (let i = 0; i < tokens.length - 1; i += 1) {
    const fetch = tokens[i];
    const direction = tokens[i + 1];
    if (
      fetch?.type !== 'word' ||
      fetch.depth !== 0 ||
      fetch.value.toUpperCase() !== 'FETCH' ||
      direction?.type !== 'word' ||
      direction.depth !== 0 ||
      !['FIRST', 'NEXT'].includes(direction.value.toUpperCase())
    ) {
      continue;
    }

    for (let j = i + 2; j < tokens.length - 1; j += 1) {
      const row = tokens[j];
      const only = tokens[j + 1];
      if (row?.type === 'symbol' && row.depth === 0 && row.value === ';') break;
      if (
        row?.type === 'word' &&
        row.depth === 0 &&
        (row.value.toUpperCase() === 'ROW' || row.value.toUpperCase() === 'ROWS') &&
        only?.type === 'word' &&
        only.depth === 0 &&
        only.value.toUpperCase() === 'ONLY'
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Locate the insertion offset for an appended clause at the end of a single
 * statement, derived from the scanner's TOKENS so trailing comments can never
 * swallow the appended text:
 *  - before a trailing `;` token (so it stays the terminator), or
 *  - after the last meaningful token.
 */
function insertionPoint(source: string, driver?: DriverKind): number {
  const tokens = scan(source, driver ?? {}).filter(
    (t) => t.type !== 'space' && t.type !== 'comment',
  );
  const last = tokens[tokens.length - 1];
  if (!last) return source.length;
  if (last.type === 'symbol' && last.value === ';') return last.pos;
  return last.pos + last.value.length;
}
