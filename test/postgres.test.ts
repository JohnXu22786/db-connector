/** PostgreSQL-specific introspection query regressions. */

import { strict as assert } from 'node:assert';
import { Client } from 'pg';
import { test } from 'node:test';
import { resolveConnectionSpec } from '../dist/config.js';
import { PgDriver } from '../dist/drivers/postgres.js';

const connectionString = process.env.DSH_DB_CONNECTOR_POSTGRES_TEST_URL;

test(
  'PostgreSQL introspection returns mixed regular and expression index columns',
  { skip: connectionString ? false : 'set DSH_DB_CONNECTOR_POSTGRES_TEST_URL to run' },
  async () => {
    assert.ok(connectionString);

    const suffix = `${process.pid}_${Date.now()}`;
    const schema = `dsh_expression_index_${suffix}`;
    const indexName = `events_status_lower_email_${suffix}`;
    const setup = new Client({ connectionString });
    const spec = resolveConnectionSpec(
      {
        name: 'postgres-expression-index-test',
        driver: 'postgres',
        connectionString,
        schema,
      },
      process.env,
    );
    const driver = new PgDriver(spec, { debug() {}, info() {}, warn() {} });

    try {
      await setup.connect();
      await setup.query(`CREATE SCHEMA "${schema}"`);
      await setup.query(`
        CREATE TABLE "${schema}".events (
          id integer PRIMARY KEY,
          email text NOT NULL,
          status text NOT NULL
        )
      `);
      await setup.query(
        `CREATE INDEX "${indexName}" ON "${schema}".events (status, lower(email))`,
      );

      await driver.connect();
      const introspection = await driver.introspect(new AbortController().signal);
      const index = introspection.indexes.find((item) => item.name === indexName);

      assert.ok(index, `expected ${indexName} in PostgreSQL introspection`);
      assert.deepEqual(index.columns[0], 'status');
      assert.equal(index.columns.length, 2);
      assert.match(index.columns[1]!, /lower.*email/);
    } finally {
      await driver.close();
      await setup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
      await setup.end().catch(() => {});
    }
  },
);

test(
  'PostgreSQL introspection returns ordinary and partitioned-parent indexes once',
  { skip: connectionString ? false : 'set DSH_DB_CONNECTOR_POSTGRES_TEST_URL to run' },
  async (t) => {
    assert.ok(connectionString);

    const suffix = `${process.pid}_${Date.now()}`;
    const schema = `dsh_partitioned_index_${suffix}`;
    const regularTable = 'regular_events';
    const regularIndex = `${regularTable}_email_idx`;
    const partitionedTable = 'partitioned_events';
    const partitionTable = `${partitionedTable}_p0`;
    const partitionedIndex = `${partitionedTable}_status_idx`;
    const setup = new Client({ connectionString });
    const spec = resolveConnectionSpec(
      {
        name: 'postgres-partitioned-index-test',
        driver: 'postgres',
        connectionString,
        schema,
      },
      process.env,
    );
    const driver = new PgDriver(spec, { debug() {}, info() {}, warn() {} });
    let schemaCreated = false;

    try {
      await setup.connect();
      const version = await setup.query<{ server_version_num: string }>('SHOW server_version_num');
      if (Number(version.rows[0]?.server_version_num) < 110000) {
        t.skip('partitioned indexes require PostgreSQL 11 or newer');
        return;
      }
      await setup.query(`CREATE SCHEMA "${schema}"`);
      schemaCreated = true;
      await setup.query(`
        CREATE TABLE "${schema}"."${regularTable}" (
          id integer,
          email text NOT NULL
        )
      `);
      await setup.query(
        `CREATE INDEX "${regularIndex}" ON "${schema}"."${regularTable}" (email)`,
      );
      await setup.query(`
        CREATE TABLE "${schema}"."${partitionedTable}" (
          id integer NOT NULL,
          status text NOT NULL
        ) PARTITION BY RANGE (id)
      `);
      await setup.query(`
        CREATE TABLE "${schema}"."${partitionTable}"
        PARTITION OF "${schema}"."${partitionedTable}"
        FOR VALUES FROM (0) TO (100)
      `);
      await setup.query(
        `CREATE INDEX "${partitionedIndex}" ON "${schema}"."${partitionedTable}" (status)`,
      );
      const childIndexes = await setup.query<{ indexname: string }>(
        'SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = $2',
        [schema, partitionTable],
      );
      assert.equal(childIndexes.rows.length, 1);
      const childIndex = childIndexes.rows[0]?.indexname;
      assert.ok(childIndex);

      await driver.connect();
      const introspection = await driver.introspect(new AbortController().signal);
      const expected = [
        {
          name: partitionedIndex,
          table: partitionedTable,
          columns: ['status'],
          unique: false,
          primary: false,
        },
        {
          name: childIndex,
          table: partitionTable,
          columns: ['status'],
          unique: false,
          primary: false,
        },
        {
          name: regularIndex,
          table: regularTable,
          columns: ['email'],
          unique: false,
          primary: false,
        },
      ];

      assert.deepEqual(introspection.indexes, expected);
    } finally {
      await driver.close();
      if (schemaCreated) {
        await setup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
      }
      await setup.end().catch(() => {});
    }
  },
);
