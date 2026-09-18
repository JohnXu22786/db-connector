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
  /** Recognize MySQL comment syntax when options are passed as an object. */
  mysqlComments?: boolean;
  /** Treat backslashes as escapes inside MySQL executable-comment bodies. */
  mysqlExecutableBackslashEscapes?: boolean;
  /** Recognize PostgreSQL `E'...'` escape string constants. */
  postgresEscapeStrings?: boolean;
}

function scanOptionsForDriver(driver: DriverKind): ScanOptions {
  if (driver === 'mysql') return { backslashEscapes: true };
  if (driver === 'postgres') return { postgresEscapeStrings: true };
  return {};
}

function findMySqlExecutableCommentEnd(
  sql: string,
  start: number,
  backslashEscapes: boolean,
): number {
  let i = start;
  while (i < sql.length) {
    const c = sql[i]!;

    if (c === "'" || c === '"') {
      const quote = c;
      i += 1;
      while (i < sql.length) {
        if (backslashEscapes && sql[i] === '\\') {
          i += 2;
          continue;
        }
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    if (c === '`') {
      i += 1;
      while (i < sql.length) {
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
      continue;
    }

    if (c === '*' && sql[i + 1] === '/') return i;
    i += 1;
  }
  return -1;
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
  const mysqlComments = options === 'mysql' || resolvedOptions.mysqlComments === true;
  const sqliteBracketIdentifiers = options === 'sqlite';
  const postgresDollarQuotes = !mysqlComments && options !== 'sqlite';
  const backslashEscapes = resolvedOptions.backslashEscapes === true;
  const executableBackslashEscapes = resolvedOptions.mysqlExecutableBackslashEscapes === true;
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
      (!mysqlComments || /[\u0000-\u0020\u007f]/.test(sql[i + 2] ?? ''))
    ) {
      i += 2;
      while (i < n && sql[i] !== '\n' && sql[i] !== '\r') i += 1;
      tokens.push({ type: 'comment', value: sql.slice(at, i), pos: at, depth });
      continue;
    }

    // MySQL # line comment
    if (mysqlComments && c === '#') {
      i += 1;
      while (i < n && sql[i] !== '\n' && sql[i] !== '\r') i += 1;
      tokens.push({ type: 'comment', value: sql.slice(at, i), pos: at, depth });
      continue;
    }

    // /* block comment */
    if (c === '/' && sql[i + 1] === '*') {
      if (mysqlComments && sql[i + 2] === '!') {
        i += 3;
        const versionStart = i;
        while (i < n && i - versionStart < 5 && /[0-9]/.test(sql[i]!)) i += 1;
        const bodyStart = i;
        // The primary scan uses conservative NO_BACKSLASH_ESCAPES semantics;
        // classification also reruns with normal MySQL escapes below because
        // the connection's SQL mode is not available here.
        const end = findMySqlExecutableCommentEnd(
          sql,
          bodyStart,
          executableBackslashEscapes,
        );
        const bodyEnd = end === -1 ? n : end;

        // MySQL executes the contents of `/*!...*/`; retain the wrapper as
        // symbols so placeholder rewriting and other reconstruction helpers
        // preserve the original executable comment text.
        tokens.push({ type: 'symbol', value: sql.slice(at, bodyStart), pos: at, depth });
        for (const token of scan(sql.slice(bodyStart, bodyEnd), {
          backslashEscapes: executableBackslashEscapes,
          mysqlComments: true,
          mysqlExecutableBackslashEscapes: executableBackslashEscapes,
        })) {
          tokens.push({
            ...token,
            pos: bodyStart + token.pos,
            depth,
          });
          if (token.type === 'symbol') {
            if (token.value === '(') depth += 1;
            else if (token.value === ')') depth = Math.max(0, depth - 1);
          }
        }
        if (end !== -1) {
          tokens.push({ type: 'symbol', value: '*/', pos: bodyEnd, depth });
          i = bodyEnd + 2;
        } else {
          i = n;
        }
        continue;
      }

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

  if (postgresEscapeStrings) markQuestionOperators(tokens);
  return tokens;
}

/**
 * PostgreSQL uses `?`, `?|`, `?&`, and `@?` as JSONB operators. A question
 * mark is a positional parameter everywhere else, so reclassify it only when
 * the surrounding tokens form a binary expression.
 */
function markQuestionOperators(tokens: Token[]): void {
  const meaningfulIndexes = tokens
    .map((token, index) => token.type === 'space' || token.type === 'comment' ? -1 : index)
    .filter((index) => index >= 0);

  for (let i = 0; i < meaningfulIndexes.length; i += 1) {
    const index = meaningfulIndexes[i]!;
    const token = tokens[index]!;
    if (token.type !== 'param' || token.value !== '?') continue;

    const previous = i > 0 ? tokens[meaningfulIndexes[i - 1]!] : undefined;
    const next = i + 1 < meaningfulIndexes.length
      ? tokens[meaningfulIndexes[i + 1]!] : undefined;
    const nextNext = i + 2 < meaningfulIndexes.length
      ? tokens[meaningfulIndexes[i + 2]!] : undefined;

    const isAdjacentToNext = next !== undefined && token.pos + token.value.length === next.pos;
    const isAdjacentToPrevious = previous !== undefined && previous.pos + previous.value.length === token.pos;
    const right = isAdjacentToNext && next?.type === 'symbol' && (next.value === '|' || next.value === '&')
      ? nextNext
      : next;
    const leftIndex = isAdjacentToPrevious && previous?.type === 'symbol' && previous.value === '@'
      ? i - 2
      : i - 1;
    const left = leftIndex >= 0 ? tokens[meaningfulIndexes[leftIndex]!] : undefined;
    const leftPrevious = leftIndex > 0
      ? tokens[meaningfulIndexes[leftIndex - 1]!]
      : undefined;

    if (
      !isFetchRowLimitParameter(tokens, meaningfulIndexes, i) &&
      !isByClauseParameter(tokens, meaningfulIndexes, i) &&
      isExpressionEnd(left, leftPrevious) &&
      isExpressionStart(right)
    ) {
      token.type = 'symbol';
    }
  }
}

const QUESTION_OPERATOR_BOUNDARIES = new Set([
  'SELECT', 'FROM', 'WHERE', 'GROUP', 'ORDER', 'LIMIT', 'OFFSET', 'FETCH',
  'FOR', 'UNION', 'INTERSECT', 'EXCEPT', 'RETURNING', 'INTO',
  'AND', 'OR', 'NOT', 'IS', 'IN', 'LIKE', 'ILIKE', 'SIMILAR', 'TO',
  'AS', 'ON', 'USING', 'JOIN', 'LEFT', 'RIGHT', 'FULL', 'INNER', 'OUTER', 'CROSS',
  'WHEN', 'THEN', 'ELSE', 'END', 'ASC', 'DESC', 'COLLATE',
  'WINDOW',
]);

/**
 * PostgreSQL permits non-reserved keywords as bare column names. Keep only
 * reserved/type-function keywords as unconditional expression-start
 * boundaries. Clause-specific checks above preserve parameters in FETCH and
 * GROUP/ORDER/PARTITION BY forms without rejecting keyword operands.
 */
const QUESTION_OPERATOR_START_BOUNDARIES = new Set([
  'SELECT', 'FROM', 'WHERE', 'GROUP', 'ORDER', 'OFFSET', 'FETCH',
  'FOR', 'UNION', 'INTERSECT', 'EXCEPT', 'INTO',
  'AND', 'OR', 'NOT', 'IS', 'IN', 'LIKE', 'ILIKE', 'SIMILAR', 'TO',
  'AS', 'ON', 'USING', 'JOIN', 'LEFT', 'RIGHT', 'FULL', 'INNER', 'OUTER', 'CROSS',
  'WHEN', 'THEN', 'ELSE', 'END', 'ASC', 'DESC', 'COLLATE', 'WINDOW',
]);

function isFetchRowLimitParameter(tokens: Token[], indexes: number[], index: number): boolean {
  const fetch = index >= 2 ? tokens[indexes[index - 2]!] : undefined;
  const direction = index >= 1 ? tokens[indexes[index - 1]!] : undefined;
  const row = index + 1 < indexes.length ? tokens[indexes[index + 1]!] : undefined;
  const only = index + 2 < indexes.length ? tokens[indexes[index + 2]!] : undefined;
  return fetch?.type === 'word' && fetch.value.toUpperCase() === 'FETCH' &&
    direction?.type === 'word' && ['FIRST', 'NEXT'].includes(direction.value.toUpperCase()) &&
    row?.type === 'word' && ['ROW', 'ROWS'].includes(row.value.toUpperCase()) &&
    only?.type === 'word' && only.value.toUpperCase() === 'ONLY';
}

function isByClauseParameter(tokens: Token[], indexes: number[], index: number): boolean {
  if (index < 2) return false;
  const by = tokens[indexes[index - 1]!];
  const clause = tokens[indexes[index - 2]!];
  return by?.type === 'word' && by.value.toUpperCase() === 'BY' &&
    clause?.type === 'word' && ['GROUP', 'ORDER', 'PARTITION'].includes(clause.value.toUpperCase());
}

function isExpressionEnd(token: Token | undefined, previous?: Token): boolean {
  if (!token) return false;
  if (token.type === 'string' || token.type === 'quotedid' || token.type === 'param') return true;
  if (token.type === 'word') {
    // PostgreSQL allows reserved words after a qualification dot, e.g.
    // `t.where`, so the final spelling alone cannot identify a clause.
    if (previous?.type === 'symbol' && previous.value === '.') return true;
    return token.value.toUpperCase() === 'END' ||
      !QUESTION_OPERATOR_BOUNDARIES.has(token.value.toUpperCase());
  }
  return token.type === 'symbol' && (/^[0-9.]$/.test(token.value) || /^[)\]}]$/.test(token.value));
}

function isExpressionStart(token: Token | undefined): boolean {
  if (!token) return false;
  if (token.type === 'string' || token.type === 'quotedid' || token.type === 'param') return true;
  if (token.type === 'word') return !QUESTION_OPERATOR_START_BOUNDARIES.has(token.value.toUpperCase());
  return token.type === 'symbol' && /^[([{0-9.]$/.test(token.value);
}

/** Meaningful tokens: everything except whitespace and comments. */
function meaningful(
  sql: string,
  driver?: DriverKind,
  scanOptions?: ScanOptions,
): Token[] {
  return scan(sql, scanOptions ?? driver ?? {}).filter(
    (t) => t.type !== 'space' && t.type !== 'comment',
  );
}

/** First data-statement keyword at paren depth 0 (WITH/CTE aware). */
function firstDataKeyword(
  sql: string,
  driver?: DriverKind,
  scanOptions?: ScanOptions,
): Token | undefined {
  const tokens = meaningful(sql, driver, scanOptions);
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
function containsWriteKeyword(
  sql: string,
  driver?: DriverKind,
  scanOptions?: ScanOptions,
): boolean {
  return meaningful(sql, driver, scanOptions).some(
    (t) => t.type === 'word' && WRITE_KEYWORDS.has(t.value.toUpperCase()),
  );
}

function hasTopLevelInto(
  sql: string,
  driver?: DriverKind,
  scanOptions?: ScanOptions,
): boolean {
  return meaningful(sql, driver, scanOptions).some(
    (t) => t.type === 'word' && t.depth === 0 && t.value.toUpperCase() === 'INTO',
  );
}

/** PostgreSQL's outer SELECT ... INTO creates a table and is therefore DDL. */
function isPostgresSelectInto(
  sql: string,
  driver?: DriverKind,
  scanOptions?: ScanOptions,
): boolean {
  if (driver !== 'postgres' || !hasTopLevelInto(sql, driver, scanOptions)) return false;
  return firstDataKeyword(sql, driver, scanOptions)?.value.toUpperCase() === 'SELECT';
}

/**
 * Classify an EXPLAIN ANALYZE statement. Bare EXPLAIN plans never execute;
 * EXPLAIN ANALYZE does (PostgreSQL executes the underlying DML), so the
 * statement must be classified by its real keyword. Any write keyword wins;
 * otherwise the first top-level data keyword decides; an unresolved case is
 * treated as a write (conservative: never admitted through a read path).
 */
function classifyAnalyzed(
  sql: string,
  driver?: DriverKind,
  scanOptions?: ScanOptions,
): 'select' | 'write' | 'ddl' {
  if (isPostgresSelectInto(sql, driver, scanOptions)) return 'ddl';
  if (hasTopLevelInto(sql, driver, scanOptions)) return 'write';
  if (containsWriteKeyword(sql, driver, scanOptions)) return 'write';
  const keyword = firstDataKeyword(sql, driver, scanOptions);
  const kw = keyword?.value.toUpperCase() ?? '';
  if (kw === 'SELECT' || kw === 'VALUES') return 'select';
  return 'write';
}

/**
 * Classify a single statement. Writes are never inferred from SELECT-shaped
 * input; anything unrecognized classifies as `unknown` (conservative — the
 * read-only path rejects it).
 */
type StatementClassification = {
  kind: 'select' | 'explain' | 'write' | 'ddl' | 'unknown';
  firstWord: string;
};

function classifyStatementWithOptions(
  sql: string,
  driver?: DriverKind,
  scanOptions?: ScanOptions,
): StatementClassification {
  const tokens = meaningful(sql, driver, scanOptions);
  const lead = tokens.find((t) => t.type === 'word');
  if (!lead) return { kind: 'unknown', firstWord: '' };
  const word = lead.value.toUpperCase();

  if (word === 'SELECT' || word === 'VALUES') {
    // PostgreSQL SELECT ... INTO creates a table and therefore invalidates
    // the schema cache like other DDL. Other dialects retain write handling
    // for their INTO forms (for example, MySQL INTO OUTFILE/DUMPFILE).
    const hasInto = word === 'SELECT' && hasTopLevelInto(sql, driver, scanOptions);
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
      if (hasAnalyze) {
        return {
          kind: classifyAnalyzed(sql, driver, scanOptions),
          firstWord: word,
        };
      }
    }
    return { kind: 'explain', firstWord: word };
  }

  if (word === 'WITH') {
    // WITH may be read (WITH ... SELECT) or a write: a PostgreSQL outer
    // SELECT ... INTO creates a table, while data-modifying CTEs remain writes.
    // Any other top-level INTO or write keyword marks the whole statement a
    // write.
    if (isPostgresSelectInto(sql, driver, scanOptions)) {
      return { kind: 'ddl', firstWord: word };
    }
    if (
      hasTopLevelInto(sql, driver, scanOptions) ||
      containsWriteKeyword(sql, driver, scanOptions)
    ) {
      return { kind: 'write', firstWord: word };
    }
    const next = firstDataKeyword(sql, driver, scanOptions);
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

export function classifyStatement(sql: string, driver?: DriverKind): StatementClassification {
  const primary = classifyStatementWithOptions(sql, driver);
  if (driver !== 'mysql') return primary;

  // A MySQL connection may use either backslash-escape mode. Reclassify with
  // the alternate executable-comment lexer and keep the more conservative
  // result so either mode cannot hide a write from the read-only gate.
  const alternate = classifyStatementWithOptions(sql, driver, {
    backslashEscapes: true,
    mysqlComments: true,
    mysqlExecutableBackslashEscapes: true,
  });
  if (alternate.kind === 'write' || alternate.kind === 'ddl') {
    return {
      kind: alternate.kind,
      firstWord: primary.firstWord || alternate.firstWord,
    };
  }
  if (primary.kind === 'write' || primary.kind === 'ddl') return primary;
  if (primary.kind === 'unknown' || alternate.kind === 'unknown') {
    return {
      kind: 'unknown',
      firstWord: primary.firstWord || alternate.firstWord,
    };
  }
  return primary;
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
    // The backslash-enabled pass preserves MySQL string redaction without
    // treating PostgreSQL `#>` / `#>>` operators as MySQL comments. A
    // driver-less audit cannot safely choose between those dialects.
    : [scan(sql), scan(sql, { backslashEscapes: true }), scan(sql, 'postgres')];
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
  const upper = Math.max(0, Math.floor(limit));
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
  if (driver === 'mysql') {
    const lockingStart = mysqlExecutableLockingSuffixStart(source, tokens);
    if (lockingStart !== undefined) return lockingStart;
  }
  const last = tokens[tokens.length - 1];
  if (!last) return source.length;
  if (last.type === 'symbol' && last.value === ';') return last.pos;
  return last.pos + last.value.length;
}

function mysqlExecutableLockingSuffixStart(
  source: string,
  tokens: Token[],
): number | undefined {
  for (let i = 0; i < tokens.length; i += 1) {
    const opener = tokens[i];
    if (
      opener?.type !== 'symbol' ||
      opener.depth !== 0 ||
      !opener.value.startsWith('/*!')
    ) {
      continue;
    }

    let hasForUpdate = false;
    let closerIndex = -1;
    for (let j = i + 1; j < tokens.length; j += 1) {
      const token = tokens[j]!;
      if (token.type === 'symbol' && token.value === '*/') {
        closerIndex = j;
        break;
      }
      if (
        token.type === 'word' &&
        token.depth === 0 &&
        token.value.toUpperCase() === 'FOR'
      ) {
        const next = tokens[j + 1];
        if (
          next?.type === 'word' &&
          next.depth === 0 &&
          next.value.toUpperCase() === 'UPDATE'
        ) {
          hasForUpdate = true;
        }
      }
    }

    if (
      !hasForUpdate ||
      closerIndex === -1 ||
      tokens.slice(closerIndex + 1).some(
        (token) => token.type !== 'symbol' || token.value !== ';',
      )
    ) {
      continue;
    }
    let start = opener.pos;
    while (start > 0 && /\s/.test(source[start - 1]!)) start -= 1;
    return start;
  }
  return undefined;
}
