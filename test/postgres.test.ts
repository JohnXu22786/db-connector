/** PostgreSQL-specific introspection query regressions. */

import { strict as assert } from 'node:assert';
import { Client } from 'pg';
import { DatabaseSync } from 'node:sqlite';
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
  values?: unknown[];
}

interface QueryResult {
  rows: Array<Record<string, unknown>>;
  rowCount: number | null;
}

test('PostgreSQL composite foreign-key introspection keeps constraint associations and ordering', async () => {
  const spec = resolveConnectionSpec({ name: 'pg', driver: 'postgres', database: 'app' }, {});
  const catalog = new DatabaseSync(':memory:');
  let catalogClosed = false;
  const closeCatalog = () => {
    if (!catalogClosed) {
      catalog.close();
      catalogClosed = true;
    }
  };

  try {
    for (const sql of [
      `CREATE TABLE fixture_referential_constraints (
         constraint_name TEXT,
         constraint_schema TEXT,
         unique_constraint_schema TEXT,
         unique_constraint_name TEXT,
         update_rule TEXT,
         delete_rule TEXT
       )`,
      `CREATE TABLE fixture_table_constraints (
         constraint_name TEXT,
         constraint_schema TEXT,
         table_name TEXT
       )`,
      `CREATE TABLE fixture_key_column_usage (
         constraint_name TEXT,
         constraint_schema TEXT,
         table_name TEXT,
         column_name TEXT,
         ordinal_position INTEGER,
         position_in_unique_constraint INTEGER
       )`,
      `CREATE TABLE fixture_constraint_column_usage (
         constraint_name TEXT,
         constraint_schema TEXT,
         table_name TEXT,
         column_name TEXT
       )`,
      `CREATE TABLE fixture_pg_namespace (
         oid INTEGER PRIMARY KEY,
         nspname TEXT
       )`,
      `CREATE TABLE fixture_pg_class (
         oid INTEGER PRIMARY KEY,
         relname TEXT,
         relnamespace INTEGER
       )`,
      `CREATE TABLE fixture_pg_constraint (
         oid INTEGER PRIMARY KEY,
         conname TEXT,
         contype TEXT,
         conrelid INTEGER,
         confrelid INTEGER,
         connamespace INTEGER,
         conindid INTEGER,
         confupdtype TEXT,
         confdeltype TEXT
       )`,
    ]) {
      catalog.exec(sql);
    }

    catalog.exec(`
      INSERT INTO fixture_referential_constraints VALUES
        ('orders_local_fk', 'public', 'public', 'customers_pkey', 'NO ACTION', 'NO ACTION'),
        ('orders_local_fk', 'archive', 'legacy', 'customers_pkey', 'CASCADE', 'NO ACTION'),
        ('orders_legacy_fk', 'public', 'legacy', 'customers_pkey', 'NO ACTION', 'NO ACTION'),
        ('same_name_fk', 'public', 'public', 'customers_pkey', 'NO ACTION', 'NO ACTION'),
        ('same_name_fk', 'public', 'public', 'customers_code_key', 'CASCADE', 'SET NULL')
    `);
    catalog.exec(`
      INSERT INTO fixture_table_constraints VALUES
        ('orders_local_fk', 'public', 'orders'),
        ('orders_legacy_fk', 'public', 'orders'),
        ('same_name_fk', 'public', 'orders'),
        ('same_name_fk', 'public', 'invoices')
    `);
    catalog.exec(`
      INSERT INTO fixture_key_column_usage VALUES
        ('orders_local_fk', 'public', 'orders', 'customer_region', 2, 2),
        ('orders_local_fk', 'public', 'orders', 'customer_id', 1, 1),
        ('orders_legacy_fk', 'public', 'orders', 'legacy_region', 2, 2),
        ('orders_legacy_fk', 'public', 'orders', 'legacy_id', 1, 1),
        ('same_name_fk', 'public', 'orders', 'billing_region', 2, 2),
        ('same_name_fk', 'public', 'orders', 'billing_id', 1, 1),
        ('same_name_fk', 'public', 'invoices', 'region_code', 1, 1),
        ('customers_pkey', 'public', 'customers', 'id', 1, NULL),
        ('customers_pkey', 'public', 'customers', 'region', 2, NULL),
        ('customers_pkey', 'legacy', 'legacy_customers', 'id', 1, NULL),
        ('customers_pkey', 'legacy', 'legacy_customers', 'region', 2, NULL),
        ('customers_code_key', 'public', 'customers', 'code', 1, NULL)
    `);
    catalog.exec(`
      INSERT INTO fixture_constraint_column_usage VALUES
        ('customers_pkey', 'public', 'customers', 'id'),
        ('customers_pkey', 'public', 'customers', 'region'),
        ('customers_pkey', 'legacy', 'legacy_customers', 'id'),
        ('customers_pkey', 'legacy', 'legacy_customers', 'region'),
        ('customers_code_key', 'public', 'customers', 'code')
    `);
    catalog.exec(`
      INSERT INTO fixture_pg_namespace VALUES
        (1, 'public'),
        (2, 'legacy')
    `);
    catalog.exec(`
      INSERT INTO fixture_pg_class VALUES
        (10, 'orders', 1),
        (11, 'invoices', 1),
        (20, 'customers', 1),
        (21, 'legacy_customers', 2)
    `);
    catalog.exec(`
      INSERT INTO fixture_pg_constraint VALUES
        (100, 'orders_local_fk', 'f', 10, 20, 1, 2000, 'a', 'a'),
        (101, 'orders_legacy_fk', 'f', 10, 21, 1, 2001, 'a', 'a'),
        (102, 'same_name_fk', 'f', 10, 20, 1, 2000, 'a', 'a'),
        (103, 'same_name_fk', 'f', 11, 20, 1, 2003, 'c', 'n'),
        (200, 'customers_pkey', 'p', 20, NULL, 1, 2000, NULL, NULL),
        (201, 'customers_pkey', 'p', 21, NULL, 2, 2001, NULL, NULL),
        (202, 'customers_code_key', 'u', 20, NULL, 1, 2003, NULL, NULL)
    `);

    const emptyResult: QueryResult = { rows: [], rowCount: 0 };
    const captured: QueryConfig[] = [];
    const client = {
      async query(query: string | QueryConfig): Promise<QueryResult> {
        if (typeof query === 'string' || query.name !== 'dsh-db-connector.foreign-keys') {
          return emptyResult;
        }
        captured.push(query);

        // SQLite executes the catalog joins and aggregation. These small
        // rewrites adapt PostgreSQL array_agg and $1 syntax to SQLite while
        // preserving the query structure under test.
        const executableText = query.text!
          .replace(
            /array_agg\((kcu|x|rku)\.column_name( ORDER BY (kcu|x|rku)\.ordinal_position)?\)/g,
            (_match: string, alias: string, orderBy: string | undefined) =>
              `json_group_array(${alias}.column_name${orderBy ?? ''})`,
          )
          .replaceAll('information_schema.', 'fixture_')
          .replaceAll('pg_catalog.', 'fixture_')
          .replaceAll('$1', '?');
        const parameterCount = (query.text!.match(/\$1/g) ?? []).length;
        const rawRows = catalog
          .prepare(executableText)
          .all(...Array.from({ length: parameterCount }, () => 'public')) as Array<Record<string, unknown>>;
        const parseArray = (value: unknown): string[] =>
          Array.isArray(value) ? value as string[] : JSON.parse(String(value)) as string[];
        return {
          rows: rawRows.map((row) => ({
            ...row,
            column_names: parseArray(row.column_names),
            referenced_columns: parseArray(row.referenced_columns),
          })),
          rowCount: rawRows.length,
        };
      },
      async connect() {},
      async end() {
        closeCatalog();
      },
    };
    const driver = new PgDriver(spec, { debug() {}, info() {}, warn() {} });
    (driver as unknown as { client: typeof client }).client = client;

    try {
      const introspection = await driver.introspect(new AbortController().signal);
      const foreignKeys = introspection.foreignKeys;
      assert.equal(foreignKeys.length, 4, 'same-named constraints must remain separate by source table');

      const local = foreignKeys.find((foreignKey) => foreignKey.name === 'orders_local_fk');
      const legacy = foreignKeys.find((foreignKey) => foreignKey.name === 'orders_legacy_fk');
      assert.ok(local);
      assert.ok(legacy);
      assert.deepEqual(local.columns, ['customer_id', 'customer_region']);
      assert.deepEqual(legacy.columns, ['legacy_id', 'legacy_region']);
      assert.deepEqual(local.referencedColumns, ['id', 'region']);
      assert.deepEqual(legacy.referencedColumns, ['id', 'region']);
      assert.equal(local.referencedTable, 'customers');
      assert.equal(legacy.referencedTable, 'legacy_customers');

      const sameName = foreignKeys.filter((foreignKey) => foreignKey.name === 'same_name_fk');
      assert.equal(sameName.length, 2);
      const sameNameByTable = new Map(sameName.map((foreignKey) => [foreignKey.table, foreignKey]));
      assert.deepEqual(sameNameByTable.get('orders'), {
        name: 'same_name_fk',
        table: 'orders',
        columns: ['billing_id', 'billing_region'],
        referencedTable: 'customers',
        referencedColumns: ['id', 'region'],
        onUpdate: 'NO ACTION',
        onDelete: 'NO ACTION',
      });
      assert.deepEqual(sameNameByTable.get('invoices'), {
        name: 'same_name_fk',
        table: 'invoices',
        columns: ['region_code'],
        referencedTable: 'customers',
        referencedColumns: ['code'],
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      });

      assert.equal(captured.length, 1);
      assert.match(captured[0]!.text!, /array_agg\(kcu\.column_name ORDER BY kcu\.ordinal_position\)/);
      assert.match(captured[0]!.text!, /array_agg\(rku\.column_name ORDER BY kcu\.ordinal_position\)/);
      assert.match(captured[0]!.text!, /pg_catalog\.pg_constraint/);
      assert.match(captured[0]!.text!, /target_constraint\.conindid = con\.conindid/);
      assert.match(captured[0]!.text!, /kcu\.table_name = fkc\.table_name/);
      assert.match(captured[0]!.text!, /rku\.table_name = fkc\.referenced_table/);
      assert.match(captured[0]!.text!, /ccu\.table_name = fkc\.referenced_table/);
    } finally {
      await driver.close();
    }
  } finally {
    closeCatalog();
  }
});
