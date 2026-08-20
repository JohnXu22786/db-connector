# Changelog

All notable changes to **dsh-db-connector** are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-08-20

### Added

- Named connections for SQLite / PostgreSQL / MySQL with lazy open, reuse, and
  explicit close.
- Environment (`${VAR}`, `passwordEnv`) and credentials-service (`passwordRef`)
  credential resolution; secrets never appear in logs or audit records.
- Schema introspection (tables, views, columns, indexes, foreign keys) with a
  per-connection TTL cache, `refresh` and `filter`.
- Read-only `db_query` (SELECT / EXPLAIN only) with row caps, SELECT guard
  LIMIT, and parameter binding — never interpolation.
- Write approval gate (`allowWrite`) with transaction-wrapped execution
  (COMMIT on success, ROLLBACK on failure).
- Append-only JSONL SQL audit trail recording every call including denials and
  failures.
- Five dsh tools (`db_connect`, `db_schema`, `db_query`, `db_exec`, `db_audit`)
  plus the `/db` slash command.

[0.1.0]: https://github.com/JohnXu22786/db-connector/releases/tag/v0.1.0
