/** PostgreSQL-specific introspection query regressions. */

import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { Client } from 'pg';
import { test } from 'node:test';
import { resolveConnectionSpec } from '../dist/config.js';
import { DbConnectorError, ErrorCode } from '../dist/errors.js';
import { PgDriver } from '../dist/drivers/postgres.js';

const connectionString = process.env.DSH_DB_CONNECTOR_POSTGRES_TEST_URL;

interface FakeQueryResult {
  fields: Array<{ name: string }>;
  rows: Array<Record<string, unknown>>;
  rowCount: number | null;
}

interface FakeQueryConfig {
  text: string;
  values?: unknown[];
  signal?: AbortSignal;
  name?: string;
  rowMode?: 'array';
}

type FakeQueryCallback = (err: Error | null, result?: FakeQueryResult) => void;

class PgQueryStub {
  readonly config: FakeQueryConfig;
  readonly callback: FakeQueryCallback;

  constructor(
    config: FakeQueryConfig,
    _values: unknown[] | undefined,
    callback: FakeQueryCallback,
  ) {
    this.config = config;
    this.callback = callback;
  }
}

/** Models pg's behavior: QueryConfig.signal is ignored, but Query handles can be cancelled. */
class PgClientStub extends EventEmitter {
  readonly configs: FakeQueryConfig[] = [];
  readonly statements: string[] = [];
  readonly queries: PgQueryStub[] = [];
  readonly pipeline: boolean;
  readonly connection: EventEmitter & {
    stream: { destroy(error?: Error): void };
  };
  cancelled = 0;
  activeQuery: PgQueryStub | undefined;
  private readonly pending = new Map<PgQueryStub, FakeQueryCallback>();

  constructor(pipeline = false) {
    super();
    this.pipeline = Boolean(pipeline);
    const connection = new EventEmitter() as EventEmitter & {
      stream: { destroy(error?: Error): void };
    };
    connection.stream = {
      destroy: (error?: Error) => {
        queueMicrotask(() => this.emit('error', error ?? new Error('connection destroyed')));
      },
    };
    this.connection = connection;
  }

  query(input: string | FakeQueryConfig | PgQueryStub): Promise<FakeQueryResult> | PgQueryStub {
    if (typeof input === 'string') {
      this.statements.push(input);
      return Promise.resolve({ fields: [], rows: [], rowCount: 0 });
    }

    const config = input instanceof PgQueryStub ? input.config : input;
    this.configs.push(config);
    if (!(input instanceof PgQueryStub)) return new Promise<FakeQueryResult>(() => {});

    this.queries.push(input);
    this.pending.set(input, input.callback);
    if (!this.activeQuery) this.activeQuery = input;
    return input;
  }

  complete(query: PgQueryStub, result: FakeQueryResult = {
    fields: [],
    rows: [],
    rowCount: 1,
  }): void {
    const callback = this.pending.get(query);
    assert.ok(callback, 'complete should receive a pending pg query handle');
    this.pending.delete(query);
    if (this.activeQuery === query) this.activeQuery = undefined;
    callback(null, result);
  }

  cancel(client: PgClientStub, query: PgQueryStub): void {
    if (client.activeQuery === query) {
      assert.notEqual(this, client, 'active pure-JS queries need a separate cancellation client');
    }
    const callback = client.pending.get(query);
    assert.ok(callback, 'cancel should receive a pending pg query handle');
    client.pending.delete(query);
    if (client.activeQuery === query) client.activeQuery = undefined;
    client.cancelled += 1;
    callback(new Error('canceling statement due to user request'));
  }

  async connect(): Promise<void> {}

  async end(): Promise<void> {}
}

class FailingCancellationClient extends PgClientStub {
  override cancel(_client: PgClientStub, _query: PgQueryStub): Promise<void> {
    return Promise.reject(new Error('cancellation connection failed'));
  }
}

const cancellationSpec = resolveConnectionSpec({
  name: 'pg-cancellation-test',
  driver: 'postgres',
  database: 'test',
});

function driverWithCancellationStub(client: PgClientStub): PgDriver {
  const driver = new PgDriver(cancellationSpec, { debug() {}, info() {}, warn() {} });
  const internals = driver as unknown as {
    client: PgClientStub;
    clientConstructor: typeof PgClientStub;
    queryConstructor: typeof PgQueryStub;
    clientConfig: Record<string, unknown>;
  };
  internals.client = client;
  internals.clientConstructor = PgClientStub;
  internals.queryConstructor = PgQueryStub;
  internals.clientConfig = {};
  return driver;
}

async function assertPostgresCancellation(
  run: (driver: PgDriver, signal: AbortSignal) => Promise<unknown>,
  expectedQueryCount: number,
): Promise<void> {
  const client = new PgClientStub();
  const driver = driverWithCancellationStub(client);
  const controller = new AbortController();
  const operation = run(driver, controller.signal);

  for (let attempt = 0; attempt < 20 && client.configs.length < expectedQueryCount; attempt += 1) {
    await Promise.resolve();
  }
  assert.equal(client.configs.length, expectedQueryCount);
  controller.abort(new Error('query timeout'));

  const outcome = await Promise.race([
    operation.then(() => undefined, (err: unknown) => err),
    new Promise<symbol>((resolve) => setTimeout(() => resolve(Symbol('still-pending')), 100)),
  ]);
  assert.ok(outcome instanceof DbConnectorError, 'aborted PostgreSQL work should reject promptly');
  assert.equal(outcome.code, ErrorCode.Timeout);
  assert.equal(client.cancelled, expectedQueryCount);
  assert.ok(client.configs.every((config) => !Object.hasOwn(config, 'signal')));
  assert.equal(client.statements.includes('COMMIT'), false);
  await driver.close();
}

test('PostgreSQL cancellation uses query handles for reads, writes, and introspection', async () => {
  await assertPostgresCancellation(
    (driver, signal) => driver.read('SELECT pg_sleep(10)', [], signal),
    1,
  );
  await assertPostgresCancellation(
    (driver, signal) => driver.write('UPDATE users SET name = ?', ['x'], false, signal),
    1,
  );
  await assertPostgresCancellation((driver, signal) => driver.introspect(signal), 6);
});

test('PostgreSQL abort during COMMIT rejects the write', async () => {
  const client = new PgClientStub();
  const driver = driverWithCancellationStub(client);
  const controller = new AbortController();
  const operation = driver.write('UPDATE users SET name = ?', ['x'], false, controller.signal);

  for (let attempt = 0; attempt < 20 && client.queries.length < 1; attempt += 1) {
    await Promise.resolve();
  }
  assert.equal(client.queries.length, 1);
  client.complete(client.queries[0]!);

  for (let attempt = 0; attempt < 20 && client.queries.length < 2; attempt += 1) {
    await Promise.resolve();
  }
  assert.equal(client.queries[1]?.config.text, 'COMMIT');

  controller.abort(new Error('query timeout'));
  const outcome = await operation.then(() => undefined, (err: unknown) => err);
  assert.ok(outcome instanceof DbConnectorError);
  assert.equal(outcome.code, ErrorCode.Timeout);
  assert.equal(client.cancelled, 1);
  assert.equal(client.statements.includes('COMMIT'), false);
  assert.equal(client.statements.includes('ROLLBACK'), true);
  await driver.close();
});

test('PostgreSQL pipeline introspection does not submit later queries after abort', async () => {
  const client = new PgClientStub(true);
  const driver = driverWithCancellationStub(client);
  const controller = new AbortController();
  const operation = driver.introspect(controller.signal);

  for (let attempt = 0; attempt < 20 && client.configs.length < 1; attempt += 1) {
    await Promise.resolve();
  }
  assert.equal(client.configs.length, 1);

  controller.abort(new Error('query timeout'));
  const outcome = await operation.then(() => undefined, (err: unknown) => err);
  assert.ok(outcome instanceof DbConnectorError);
  assert.equal(outcome.code, ErrorCode.Timeout);
  assert.equal(client.cancelled, 1);
  assert.equal(client.configs.length, 1);
  await driver.close();
});

test('PostgreSQL cancellation connection failures do not become unhandled client errors', async () => {
  const client = new PgClientStub();
  const driver = driverWithCancellationStub(client);
  (driver as unknown as { clientConstructor: typeof FailingCancellationClient }).clientConstructor =
    FailingCancellationClient;
  const controller = new AbortController();
  const operation = driver.read('SELECT pg_sleep(10)', [], controller.signal);

  for (let attempt = 0; attempt < 20 && client.configs.length < 1; attempt += 1) {
    await Promise.resolve();
  }
  assert.equal(client.configs.length, 1);

  controller.abort(new Error('query timeout'));
  const outcome = await operation.then(() => undefined, (err: unknown) => err);
  assert.ok(outcome instanceof DbConnectorError);
  assert.equal(outcome.code, ErrorCode.QueryFailed);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await driver.close();
});

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
