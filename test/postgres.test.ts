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

interface QueryConfig {
  name?: string;
  text?: string;
}

interface QueryResult {
  fields: Array<{ name: string }>;
  rows: Array<Record<string, unknown>>;
  rowCount: number | null;
}

test('PostgreSQL composite foreign keys do not duplicate source columns', async () => {
  const spec = resolveConnectionSpec({ name: 'pg', driver: 'postgres', database: 'app' }, {});
  const foreignKeyRows: QueryResult = {
    fields: [],
    rows: [{
      constraint_name: 'orders_customer_fk',
      table_name: 'orders',
      column_names: ['customer_id', 'customer_region'],
      referenced_table: 'customers',
      referenced_columns: ['id', 'region'],
      on_update: 'NO ACTION',
      on_delete: 'NO ACTION',
    }],
    rowCount: 1,
  };
  const emptyResult: QueryResult = { fields: [], rows: [], rowCount: 0 };
  const captured: QueryConfig[] = [];
  const client = {
    async query(query: string | QueryConfig): Promise<QueryResult> {
      if (typeof query === 'string') return emptyResult;
      captured.push(query);
      return query.name === 'dsh-db-connector.foreign-keys' ? foreignKeyRows : emptyResult;
    },
    async connect() {},
    async end() {},
  };
  const driver = new PgDriver(spec, { debug() {}, info() {}, warn() {} });
  (driver as unknown as { client: typeof client }).client = client;

  const introspection = await driver.introspect(new AbortController().signal);
  const foreignKeyQuery = captured.find((query) => query.name === 'dsh-db-connector.foreign-keys');

  assert.ok(foreignKeyQuery);
  assert.match(
    foreignKeyQuery!.text!,
    /JOIN\s+\(\s*SELECT DISTINCT constraint_schema, constraint_name, table_name\s+FROM information_schema\.constraint_column_usage\s+WHERE constraint_schema = \$1\s*\) AS ccu/s,
  );
  assert.deepEqual(introspection.foreignKeys, [{
    name: 'orders_customer_fk',
    table: 'orders',
    columns: ['customer_id', 'customer_region'],
    referencedTable: 'customers',
    referencedColumns: ['id', 'region'],
    onUpdate: 'NO ACTION',
    onDelete: 'NO ACTION',
  }]);
});
