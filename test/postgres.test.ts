/** PostgreSQL-specific introspection query regressions. */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { POSTGRES_INDEXES_QUERY } from '../dist/drivers/postgres.js';

test('PostgreSQL index introspection retains expression-index columns', () => {
  const sql = POSTGRES_INDEXES_QUERY.text.replace(/\s+/g, ' ');

  assert.match(
    sql,
    /LEFT JOIN pg_attribute a ON a\.attrelid = t\.oid AND a\.attnum = k\.attnum/,
  );
  assert.match(
    sql,
    /CASE WHEN k\.attnum = 0 THEN pg_get_indexdef\(idx\.indexrelid, k\.ord::integer, true\) ELSE a\.attname END/,
  );
});
