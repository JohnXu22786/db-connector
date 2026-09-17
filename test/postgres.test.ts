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
  'PostgreSQL introspection includes indexes defined on partitioned parent tables',
  { skip: connectionString ? false : 'set DSH_DB_CONNECTOR_POSTGRES_TEST_URL to run' },
  async () => {
    assert.ok(connectionString);

    const suffix = `${process.pid}_${Date.now()}`;
    const schema = `dsh_partitioned_index_${suffix}`;
    const indexName = `events_occurred_at_${suffix}`;
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

    try {
      await setup.connect();
      await setup.query(`CREATE SCHEMA "${schema}"`);
      await setup.query(`
        CREATE TABLE "${schema}".events (
          id integer NOT NULL,
          occurred_at timestamptz NOT NULL
        ) PARTITION BY RANGE (occurred_at)
      `);
      await setup.query(`
        CREATE TABLE "${schema}".events_2026
        PARTITION OF "${schema}".events
        FOR VALUES FROM ('2026-01-01') TO ('2027-01-01')
      `);
      await setup.query(
        `CREATE INDEX "${indexName}" ON "${schema}".events (occurred_at)`,
      );

      await driver.connect();
      const introspection = await driver.introspect(new AbortController().signal);
      const index = introspection.indexes.find((item) => item.name === indexName);

      assert.ok(index, `expected ${indexName} in PostgreSQL introspection`);
      assert.equal(index.table, 'events');
      assert.deepEqual(index.columns, ['occurred_at']);
    } finally {
      await driver.close();
      await setup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
      await setup.end().catch(() => {});
    }
  },
);

test(
  'PostgreSQL introspection preserves composite foreign-key column pairs',
  { skip: connectionString ? false : 'set DSH_DB_CONNECTOR_POSTGRES_TEST_URL to run' },
  async () => {
    assert.ok(connectionString);

    const suffix = `${process.pid}_${Date.now()}`;
    const sourceSchema = `dsh_fk_source_${suffix}`;
    const targetSchema = `dsh_fk_target_${suffix}`;
    const constraintName = `same_fk_${suffix}`;
    const indexName = `referenced_pair_${suffix}`;
    const setup = new Client({ connectionString });
    const spec = resolveConnectionSpec(
      {
        name: 'postgres-foreign-key-test',
        driver: 'postgres',
        connectionString,
        schema: sourceSchema,
      },
      process.env,
    );
    const driver = new PgDriver(spec, { debug() {}, info() {}, warn() {} });

    try {
      await setup.connect();
      await setup.query(`CREATE SCHEMA "${sourceSchema}"`);
      await setup.query(`CREATE SCHEMA "${targetSchema}"`);
      await setup.query(`
        CREATE TABLE "${targetSchema}".referenced_rows (
          target_first integer NOT NULL,
          target_second integer NOT NULL
        )
      `);
      await setup.query(
        `CREATE UNIQUE INDEX "${indexName}" ON "${targetSchema}".referenced_rows (target_first, target_second)`,
      );
      await setup.query(`
        CREATE TABLE "${sourceSchema}".child_a (
          source_alpha integer,
          source_beta integer
        )
      `);
      await setup.query(`
        CREATE TABLE "${sourceSchema}".child_b (
          source_alpha integer,
          source_beta integer
        )
      `);
      await setup.query(`
        ALTER TABLE "${sourceSchema}".child_a
        ADD CONSTRAINT "${constraintName}"
        FOREIGN KEY (source_alpha, source_beta)
        REFERENCES "${targetSchema}".referenced_rows (target_first, target_second)
      `);
      await setup.query(`
        ALTER TABLE "${sourceSchema}".child_b
        ADD CONSTRAINT "${constraintName}"
        FOREIGN KEY (source_beta, source_alpha)
        REFERENCES "${targetSchema}".referenced_rows (target_first, target_second)
      `);

      await driver.connect();
      const introspection = await driver.introspect(new AbortController().signal);
      const foreignKeys = introspection.foreignKeys
        .filter((item) => item.name === constraintName)
        .sort((left, right) => left.table.localeCompare(right.table));

      assert.deepEqual(
        foreignKeys.map(({ table, columns, referencedTable, referencedColumns }) => ({
          table,
          columns,
          referencedTable,
          referencedColumns,
        })),
        [
          {
            table: 'child_a',
            columns: ['source_alpha', 'source_beta'],
            referencedTable: 'referenced_rows',
            referencedColumns: ['target_first', 'target_second'],
          },
          {
            table: 'child_b',
            columns: ['source_beta', 'source_alpha'],
            referencedTable: 'referenced_rows',
            referencedColumns: ['target_first', 'target_second'],
          },
        ],
      );
    } finally {
      await driver.close();
      await setup.query(`DROP SCHEMA IF EXISTS "${sourceSchema}" CASCADE`).catch(() => {});
      await setup.query(`DROP SCHEMA IF EXISTS "${targetSchema}" CASCADE`).catch(() => {});
      await setup.end().catch(() => {});
    }
  },
);
