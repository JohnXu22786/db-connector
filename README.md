# dsh-db-connector

[![npm version](https://img.shields.io/npm/v/dsh-db-connector)](https://www.npmjs.com/package/dsh-db-connector)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[中文说明](./README.zh.md)

A database connector bundle for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(`dsh`, the "everything is a plugin" framework built on Cordis).

It gives your agent safe, audited access to **SQLite**, **PostgreSQL** and
**MySQL** through five model-facing tools, plus a human `/db` command, with a
deliberate focus on **read-only safety, schema intelligence, write approval,
and a durable SQL audit trail** — an area the official dsh tool set does not
cover.

> This bundle is an independent, from-scratch implementation. It does not
> reuse any existing open-source dsh tool code; the tool names, parameter
> shapes, and result formats are this bundle's own design and are not tied to
> any official dsh schema.

---

## Feature overview

| Concern | What the bundle provides |
| --- | --- |
| **Connections** | Named connections for SQLite / PostgreSQL / MySQL; lazy open, reuse, explicit close, one line of redacted status per connection. |
| **Credentials** | Secrets come from **environment variables** (`${VAR}` placeholders, `passwordEnv`) or the **dsh credentials service** (`passwordRef`). Never written to logs or audit records. |
| **Schema introspection** | Tables, views, columns (name/type/nullable/default/primary key), indexes, foreign keys; per-connection snapshot cache with TTL, `refresh` and `filter`. |
| **Read-only queries** | `db_query` runs **only** SELECT / EXPLAIN-style statements. Everything else is rejected *before* it touches a database. Row caps, SELECT guard-LIMIT, JSON-safe results. |
| **Write approval gate** | INSERT / UPDATE / DELETE / DDL require an explicit `allowWrite: true` confirmation. Writes run inside a transaction: COMMIT on success, ROLLBACK on failure. |
| **SQL audit** | Every call (including denials and failures) appends one JSONL record: time, connection, statement digest + summary, kind, rows, duration, status, error, and who asked (`tool`/`command`/`cli`). |
| **Injection safety** | Values are always bound as parameters (`?` or `:name`), never interpolated into SQL text. |
| **Timeouts** | Per-statement AbortSignal deadlines with real termination, even for synchronous SQLite (child-process isolation). |

---

## Minimum requirements

- Node.js **≥ 22.13** (uses the built-in, unflagged `node:sqlite`).
- A running `dsh` profile for the tools to show up on `ctx.tools`.
- **Optional** server drivers (peer dependencies, only needed for those engines):
  - PostgreSQL: `npm i pg`
  - MySQL: `npm i mysql2`

SQLite needs nothing extra. Development (`npm test`) is easiest on Node ≥ 23.6,
which runs the type-stripped test files natively.

---

## How it plugs into dsh (bundle format)

This package is a **bundle**: `package.json` declares
`dsh.bundle.patch → ./cordis.patch.yml`, and the patch inserts one plugin row
that resolves the package by name. The entry module exports the standard
`name` / `inject` / `apply(ctx, config)` contract.

Install the bundle into a profile:

```bash
dsh plugin --profile <name> add /path/to/dsh-db-connector
```

The package is also on npm for the standalone tooling / programmatic API:

```bash
npm install -g dsh-db-connector   # global CLI-style usage of the engine
npm install dsh-db-connector      # or add it as a local dependency
```

(Equivalently: add it to the profile's `dependencies`
(`"dsh-db-connector": "link:/path/to/dsh-db-connector"`) and append
`"dsh-db-connector"` to `dsh.profile.bundles`.)

On boot, `apply(ctx, config)`:

1. reads the plugin config (second `apply` argument, with `$DSH_HOME`
   overrides and `DSH_DB_CONNECTOR_*` environment fallbacks);
2. pre-registers any `connections` from config (opened lazily on first use);
3. registers the five tools on `ctx.tools`;
4. registers the `/db` command on `ctx.commands` when that service exists;
5. on context disposal, closes every connection and flushes the audit log.

All registrations are effect-based; unloading the row unwinds them.

---

## Plugin configuration

Configuration is the `config:` block of the plugin row (or a later patch layer
overriding row id `db-connector`).

```yaml
- insert:
    - id: db-connector
      name: 'dsh-db-connector'
      config:
        # Connections pre-registered at boot; each is opened lazily.
        connections:
          appdata:
            driver: sqlite
            database: ./data/app.db
          warehouse:
            driver: postgres
            host: db.internal
            database: warehouse
            user: readonly
            passwordEnv: WAREHOUSE_PG_PASSWORD   # env var NAME, not the value
            # ...or passwordRef: WAREHOUSE_PG_PASSWORD (dsh credentials service)

        audit:
          enabled: true
          path: .dsh-db/audit.jsonl        # default; supports ${ENV}

        query:
          maxRows: 1000                    # result row cap
          timeoutMs: 30000                 # per-statement deadline (ms)
          maxSqlChars: 512                 # statement text kept per audit record

        schema:
          ttlMs: 60000                     # snapshot cache lifetime

        defaultAllowWrite: false           # write gate global default (see below)
```

Environment overrides: `DSH_DB_CONNECTOR_AUDIT_PATH`,
`DSH_DB_CONNECTOR_MAX_ROWS`, `DSH_DB_CONNECTOR_TIMEOUT_MS`. Any `f"${VAR}"`
placeholder in a string value is expanded from the environment at connect time.

### Credentials — never in logs

Security posture: **secrets are referenced by name, never embedded.**

- `passwordEnv: PG_PASSWORD` reads the value from the environment with that name.
- `passwordRef: MY_REF` resolves through the dsh credentials service
  (`ctx.credentials`), falling back to a plain env lookup.
- Any field may use a `${VAR}` placeholder.
- Inline `password` is accepted but strongly discouraged.

The bundle never logs connection configs, passwords, or connection strings:
connection summaries carry only name / driver / host:port / database plus
`auth=env|credentials|inline|none`. Error messages report environment variable
**names**, not values. Audit records carry statement digests/summaries and
counts — never connection config.

---

## The tools

All five tools return a canonical JSON value and are rendered as formatted text
to the model.

### `db_connect`

Register, open, list or close a named connection.

```json
{ "action": "connect", "name": "app",
  "config": { "driver": "sqlite", "database": "./data/app.db" } }

{ "action": "connect", "name": "wh",
  "config": { "driver": "postgres", "host": "db.local", "database": "wh",
              "user": "readonly", "passwordEnv": "WH_PASSWORD" } }

{ "action": "list" }
{ "action": "close", "name": "app" }
```

Connecting a name that is already defined (config-provided or previously
connected) reopens it instead of failing; connecting a brand-new name fails
loudly if the database is unreachable. `list` returns redacted status.

### `db_schema`

Introspect a connection. Returns tables/views, columns, indexes and foreign
keys, cached per connection for `schema.ttlMs`; `refresh: true` bypasses the
cache and `filter` narrows to table/view names containing the given substring.

```json
{ "name": "app", "refresh": false, "filter": "user" }
```

### `db_query`

Run a **read-only** query (SELECT / EXPLAIN / DESCRIBE / SHOW).

- Enforced **read-only**: any write or DDL statement is rejected with
  `READ_ONLY_VIOLATION` and recorded as a `denied` audit entry — before any
  driver is touched. This covers INSERT/UPDATE/DELETE/DDL/PRAGMA, and also the
  sneaky forms: `EXPLAIN ANALYZE <dml>` (which executes its statement) and
  data-modifying CTEs (`WITH x AS (DELETE ...) SELECT ...`).
- **Result cap**: rows are capped at `limit` (or `query.maxRows`). For a plain
  top-level SELECT without its own LIMIT a guard `LIMIT` is appended.
- **Timeouts**: `timeoutMs` (or the default) is enforced through an
  AbortSignal; SQLite genuinely terminates via child-process teardown.

```json
{ "name": "app", "sql": "SELECT id, email FROM users WHERE age >= ? AND age < ?",
  "params": [26, 40], "limit": 100 }
```

Values can be positional (`params` array for `?`) or named
(`namedParams` object for `:name`); both are bound as parameters. Placeholder
count vs value count mismatches are a friendly `INVALID_PARAMS` error.

### `db_exec`

Execute a statement that **may write** (INSERT / UPDATE / DELETE / DDL, and
anything the classifier can't read).

- The **write approval gate** is ON by default: you must pass
  `"allowWrite": true` — the explicit confirmation — for anything that is not a
  pure read. Otherwise it is denied with `WRITE_NOT_ALLOWED` and audited.
- The statement runs inside a transaction: **COMMIT on success, ROLLBACK on
  failure** (no partial rows survive an error). The result includes affected
  rows and a rollback explanation.
- DDL invalidates that connection's schema cache automatically.

```json
{ "name": "app", "sql": "UPDATE users SET age = age + 1 WHERE id = ?",
  "params": [1], "allowWrite": true }
```

### `db_audit`

Read the audit trail back (metadata + statement digests/summaries; credentials
never appear). Filters: `name` (connection), `kind`, `since` (ISO), `limit`
(newest first, default 200).

```json
{ "kind": "denied", "limit": 50 }
```

---

## The human command (`/db`)

When a commands service is mounted (dsh-base mounts one), the bundle registers
one slash command mirroring the tools through the same engine and gates.

```
/db status
/db connect <name> --driver sqlite --db ./data/app.db
/db connect pg --driver postgres --host h --database d --user u --password-env PG_PASSWORD
/db close <name>
/db schema <name> [--refresh] [--filter sub]
/db query <name> --sql "SELECT ..." [--limit n] [--timeout ms] [--params a,b,c]
/db exec <name> --sql "UPDATE ..." --allow-write [--params a,b,c] [--timeout ms]
/db audit [name] [--kind k] [--limit n] [--since ISO]
/db help
```

---

## The SQL audit trail

Each entry is one JSON line:

```json
{"id":"m2x3st-abc123-1","ts":"2026-08-20T00:00:00.000Z","connection":"app",
 "kind":"write","way":"tool",
 "statement":{"summary":"UPDATE users SET age = age + 1 WHERE id = ?",
              "digest":"<sha256>","chars":47},
 "rows":1,"durationMs":14,"status":"ok"}
```

`kind` is `query | write | ddl | read | schema | denied`; `status` is
`ok | error | denied`. Denied and failed calls are recorded too. The file is
append-only JSONL at `audit.path` (default `.dsh-db/audit.jsonl` under the
working directory; `DSH_DB_CONNECTOR_AUDIT_PATH` / `${VAR}` work here too).

---

## Driver notes

- **SQLite** — built-in `node:sqlite`, no install needed. Each connection owns
  a persistent child process so a runaway synchronous statement can be
  **hard-terminated** on timeout (a worker thread stuck in native SQLite code
  cannot be joined, which would hang the host). File-backed databases survive a
  timeout teardown; `:memory:` connections are intentionally best-effort for
  testing.
- **PostgreSQL** — `npm i pg` (peer, optional). Reads run inside
  `BEGIN TRANSACTION READ ONLY … ROLLBACK`, writes inside
  `BEGIN/COMMIT/ROLLBACK`, all parameterized with `$1..$n`. AbortSignal is
  forwarded to the client. Note: the JSONB `?` operator is indistinguishable
  from a `?` placeholder; prefer `#>`, `->`, or `@>` for JSONB expressions.
- **MySQL** — `npm i mysql2` (peer, optional). Reads run inside a
  `READ ONLY` transaction; writes inside `beginTransaction/commit/rollback`,
  using server-side prepared statements. Cancellation destroys the connection;
  it reconnects on the next use.

---

## Development

```bash
npm install            # dev deps (typescript, @types/node); optional drivers via npm i pg / mysql2
npm run build          # tsc -> dist/
npm test               # build + full suite (node --test) — 90 tests
npm run check          # build + typecheck both src and test
```

The test suite covers: statement classification / read-only rejection, the
write approval gate, transaction rollback, parameter-injection safety, result
caps and SELECT guard-LIMIT, timeouts, the audit trail, connection lifecycle,
the tools, the `/db` command, and the plugin entry.

---

## Limitations and notes

- One SQL statement per call; multi-statement input is refused.
- The SQL scanner follows ANSI string escaping (`''`) and handles
  double-quoted identifiers, backtick identifiers, PostgreSQL dollar-quoted
  strings, `--` / `/* */` comments, and `::` / `:=`. Backslash-escaped quotes
  inside MySQL single-quoted strings are recognized only approximately; because
  classification is used to *reject* writes rather than to allow them, this
  cannot widen the write surface.
- `truncated: true` can also be reported when a query naturally returns exactly
  `limit` rows while the guard `LIMIT` applied (documented ambiguity).
- PostgreSQL/MySQL introspection and execution are implemented but exercised
  only against real servers; the SQLite path is fully covered by the tests.

## License

MIT — see [LICENSE](./LICENSE). Found a bug or want a new driver? Open an
issue at [github.com/JohnXu22786/db-connector](https://github.com/JohnXu22786/db-connector/issues).
