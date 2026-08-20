/**
 * SQL text analysis: a small lexer plus classification and rewriting helpers.
 *
 * This module is the trust boundary for the "default read-only" guarantee.
 * It never executes SQL and never interpolates user data — it only inspects
 * text. All recognition is string-literal / comment aware so a crafted value
 * like `'INSERT'` or a `SELECT ... -- DROP` comment can never fool the gate.
 *
 * Scanner limitation note: single-quoted strings follow ANSI doubling (`''`)
 * and a bare `'` in MySQL with backslash-escaped quotes is recognized only
 * approximately. Classification only ever uses recognition to REJECT writes,
 * never to allow them, so this cannot widen the write surface.
 */

import { ErrorCode, DbConnectorError } from './errors.js';
import { sha256, truncateMiddle } from './util.js';

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

/** Data-statement keywords valid at the top level of a statement. */
const DATA_KEYWORDS = new Set([
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'VALUES',
]);

/** Keywords that always mutate data when they appear in a statement. */
const WRITE_KEYWORDS = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'REPLACE']);

/**
 * Scan SQL into tokens, tracking strings, quoted identifiers, comments, and
 * parameter markers. Paren depth is recorded on each token so callers can
 * distinguish a top-level LIMIT from a subquery LIMIT.
 */
export function scan(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = sql.length;
  let depth = 0;

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
    if (c === '-' && sql[i + 1] === '-') {
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

    // 'single-quoted string' (supports ANSI '' doubling)
    if (c === "'") {
      i += 1;
      while (i < n) {
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
      while (i < n && sql[i] !== '`') i += 1;
      if (i < n) i += 1;
      tokens.push({ type: 'quotedid', value: sql.slice(at, i), pos: at, depth });
      continue;
    }

    // PostgreSQL dollar-quoted string: $$...$$ or $tag$...$tag$
    if (c === '$') {
      let j = i + 1;
      while (j < n && isIdentPart(sql[j]!)) j += 1;
      if (j < n && sql[j] === '$') {
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
function meaningful(sql: string): Token[] {
  return scan(sql).filter((t) => t.type !== 'space' && t.type !== 'comment');
}

/** First data-statement keyword at paren depth 0 (WITH/CTE aware). */
function firstDataKeyword(sql: string): Token | undefined {
  const tokens = meaningful(sql);
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
function containsWriteKeyword(sql: string): boolean {
  return meaningful(sql).some(
    (t) => t.type === 'word' && WRITE_KEYWORDS.has(t.value.toUpperCase()),
  );
}

/**
 * Classify an EXPLAIN ANALYZE statement. Bare EXPLAIN plans never execute;
 * EXPLAIN ANALYZE does (PostgreSQL executes the underlying DML), so the
 * statement must be classified by its real keyword. Any write keyword wins;
 * otherwise the first top-level data keyword decides; an unresolved case is
 * treated as a write (conservative: never admitted through a read path).
 */
function classifyAnalyzed(sql: string): 'select' | 'write' {
  if (containsWriteKeyword(sql)) return 'write';
  const keyword = firstDataKeyword(sql);
  const kw = keyword?.value.toUpperCase() ?? '';
  if (kw === 'SELECT' || kw === 'VALUES') return 'select';
  return 'write';
}

/**
 * Classify a single statement. Writes are never inferred from SELECT-shaped
 * input; anything unrecognized classifies as `unknown` (conservative — the
 * read-only path rejects it).
 */
export function classifyStatement(sql: string): {
  kind: 'select' | 'explain' | 'write' | 'ddl' | 'unknown';
  firstWord: string;
} {
  const tokens = meaningful(sql);
  const lead = tokens.find((t) => t.type === 'word');
  if (!lead) return { kind: 'unknown', firstWord: '' };
  const word = lead.value.toUpperCase();

  if (word === 'SELECT' || word === 'VALUES') {
    // SELECT ... INTO creates a table (PostgreSQL) or writes a file
    // (MySQL INTO OUTFILE/DUMPFILE) — a top-level INTO makes it a write.
    const hasInto = word === 'SELECT' && tokens.some(
      (t) => t.type === 'word' && t.depth === 0 && t.value.toUpperCase() === 'INTO',
    );
    return hasInto ? { kind: 'write', firstWord: word } : { kind: 'select', firstWord: word };
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
      if (hasAnalyze) return { kind: classifyAnalyzed(sql), firstWord: word };
    }
    return { kind: 'explain', firstWord: word };
  }

  if (word === 'WITH') {
    // WITH may be read (WITH ... SELECT) or a write: the outer keyword can
    // SELECT while a data-modifying CTE (PostgreSQL) writes. Any write
    // keyword anywhere marks the whole statement a write.
    if (containsWriteKeyword(sql)) return { kind: 'write', firstWord: word };
    const next = firstDataKeyword(sql);
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
 * True when a statement may be sent through a read-only path.
 * Only plain SELECTs and EXPLAIN-style plans qualify.
 */
export function isReadStatement(sql: string): boolean {
  const { kind } = classifyStatement(sql);
  return kind === 'select' || kind === 'explain';
}

/**
 * Assert the input holds exactly one top-level statement. Semicolons inside
 * strings, quoted identifiers, and comments are ignored by the scanner.
 */
export function assertSingleStatement(sql: string): void {
  const tokens = scan(sql);
  const separator = tokens
    .map((t, idx) => ({ t, idx }))
    .filter(({ t }) => t.type === 'symbol' && t.value === ';')
    .map(({ idx }) => idx);
  if (separator.length === 0) return;
  const last = separator[separator.length - 1]!;
  const tail = tokens.slice(last + 1).filter(
    (t) => t.type !== 'space' && t.type !== 'comment',
  );
  if (tail.length > 0) {
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
export function stripComments(sql: string): string {
  let out = '';
  for (const t of scan(sql)) {
    if (t.type === 'comment') out += ' ';
    else if (t.type === 'string') out += `'x'`;
    else if (t.type === 'quotedid') out += `"x"`;
    else out += t.value;
  }
  return out;
}

/** Collapse whitespace, dropping comments. Used for summaries/digests. */
export function normalizeText(sql: string): string {
  return stripComments(sql).replace(/\s+/g, ' ').trim();
}

/**
 * Build the audit-safe statement summary: whitespace-collapsed text capped at
 * `maxChars` characters, plus a stable sha256 digest of the collapsed text.
 */
export function summarizeSql(
  sql: string,
  maxChars: number,
): { summary: string; digest: string; chars: number } {
  const normalized = normalizeText(sql);
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
): RewriteState {
  const state: RewriteState = { out: '', count: 0 };
  for (const t of scan(sql)) {
    if (t.type === 'param') onParam(state, t);
    else state.out += t.value;
  }
  return state;
}

/**
 * Rewrite `?` markers to `$1..$n` for PostgreSQL's client, preserving all
 * other text verbatim.
 */
export function toDollarPlaceholders(sql: string): { sql: string; count: number } {
  const state = rewritePlaceholders(sql, (s) => {
    s.count += 1;
    s.out += `$${s.count}`;
  });
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
): { sql: string; order: string[] } {
  const known = new Set(provided.map((n) => n.toUpperCase()));
  const order: string[] = [];
  const state = rewritePlaceholders(sql, (s, t) => {
    if (!t.value.startsWith(':')) {
      // lone '?' untouched by the named-param path
      s.out += t.value;
      return;
    }
    const name = t.value.slice(1);
    if (!known.has(name.toUpperCase())) {
      throw new DbConnectorError(
        ErrorCode.InvalidParams,
        `named parameter ":${name}" was not provided in "namedParams"`,
      );
    }
    order.push(name);
    s.count += 1;
    s.out += '?';
  });
  void state.count;
  return { sql: state.out, order };
}

/**
 * Append `LIMIT <n>` to a single top-level SELECT that has no top-level LIMIT
 * already. Used only as a courtesy guard: the executor always caps rows on the
 * consuming side no matter what this returns.
 */
export function ensureSelectLimit(
  sql: string,
  limit: number,
): { sql: string; applied: boolean } {
  const { kind } = classifyStatement(sql);
  if (kind !== 'select') return { sql, applied: false };

  const tokens = meaningful(sql);
  const hasTopLevelLimit = tokens.some(
    (t) => t.type === 'word' && t.depth === 0 && t.value.toUpperCase() === 'LIMIT',
  );
  if (hasTopLevelLimit) return { sql, applied: false };

  assertSingleStatement(sql);
  const upper = Math.max(1, Math.floor(limit));
  const insertAt = insertionPoint(sql);
  const out =
    sql.slice(0, insertAt) + ` LIMIT ${upper}` + sql.slice(insertAt);
  return { sql: out, applied: true };
}

/**
 * Locate the insertion offset for an appended clause at the end of a single
 * statement, derived from the scanner's TOKENS so trailing comments can never
 * swallow the appended text:
 *  - before a trailing `;` token (so it stays the terminator), or
 *  - after the last meaningful token.
 */
function insertionPoint(source: string): number {
  const tokens = scan(source).filter(
    (t) => t.type !== 'space' && t.type !== 'comment',
  );
  const last = tokens[tokens.length - 1];
  if (!last) return source.length;
  if (last.type === 'symbol' && last.value === ';') return last.pos;
  return last.pos + last.value.length;
}
