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
  static cancelTarget: PgClientStub | undefined;
  static lastCreated: PgClientStub | undefined;
  readonly configs: FakeQueryConfig[] = [];
  readonly statements: string[] = [];
  readonly queries: PgQueryStub[] = [];
  readonly pipeline: boolean;
  readonly connection: EventEmitter & {
    stream: { destroy(error?: Error): void };
    connect(portOrPath: number | string, host?: string): void;
    cancel(processID: number | null, secretKey: number | null): void;
  };
  readonly processID = 1;
  readonly secretKey = 2;
  readonly blockedControls: Set<string>;
  endCalls = 0;
  cancelled = 0;
  activeQuery: PgQueryStub | undefined;
  private readonly pending = new Map<PgQueryStub, FakeQueryCallback>();

  constructor(pipeline = false, blockedControls: string[] = []) {
    super();
    PgClientStub.lastCreated = this;
    this.pipeline = Boolean(pipeline);
    this.blockedControls = new Set(blockedControls);
    const connection = new EventEmitter() as EventEmitter & {
      stream: { destroy(error?: Error): void };
      connect(portOrPath: number | string, host?: string): void;
      cancel(processID: number | null, secretKey: number | null): void;
    };
    connection.stream = {
      destroy: (error?: Error) => {
        queueMicrotask(() => this.emit('error', error ?? new Error('connection destroyed')));
      },
    };
    connection.connect = () => {
      queueMicrotask(() => connection.emit('connect'));
    };
    connection.cancel = () => {
      const target = PgClientStub.cancelTarget;
      assert.ok(target, 'cancellation target should be registered');
      const query = target.activeQuery;
      const callback = query ? target.pending.get(query) : undefined;
      assert.ok(callback, 'cancel should receive a pending pg query handle');
      target.pending.delete(query!);
      target.activeQuery = undefined;
      target.cancelled += 1;
      callback(new Error('canceling statement due to user request'));
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
    if (
      (input.config.text === 'BEGIN' ||
        input.config.text === 'BEGIN TRANSACTION READ ONLY' ||
        input.config.text === 'ROLLBACK') &&
      !this.blockedControls.has(input.config.text)
    ) {
      queueMicrotask(() => {
        if (this.pending.has(input)) this.complete(input, { fields: [], rows: [], rowCount: 0 });
      });
    }
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

  async end(): Promise<void> {
    this.endCalls += 1;
  }
}

class FailingCancellationClient extends PgClientStub {
  constructor() {
    super();
    this.connection.cancel = () => {
      throw new Error('cancellation connection failed');
    };
  }
}

class DelayedCancellationClient extends PgClientStub {
  constructor() {
    super();
    this.connection.connect = () => {};
  }
}

class NativePipelineClient extends PgClientStub {
  _pipelineInFlight = false;
  nativeCancelled = 0;
  readonly native = {
    cancel: (_callback: (err?: unknown) => void): void => {
      this.nativeCancelled += 1;
    },
  };

  constructor() {
    super(true);
  }

  override cancel = (_query: PgClientStub | PgQueryStub): void => {};

  override query(input: string | FakeQueryConfig | PgQueryStub): Promise<FakeQueryResult> | PgQueryStub {
    const result = super.query(input);
    if (input instanceof PgQueryStub) {
      this.activeQuery = undefined;
      this._pipelineInFlight = true;
    }
    return result;
  }

  override complete(query: PgQueryStub, result: FakeQueryResult = {
    fields: [],
    rows: [],
    rowCount: 1,
  }): void {
    super.complete(query, result);
    this._pipelineInFlight = false;
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
  PgClientStub.cancelTarget = client;
  return driver;
}

async function assertPostgresCancellation(
  run: (driver: PgDriver, signal: AbortSignal) => Promise<unknown>,
  expectedQueryCount: number,
  expectedCancellationCount = expectedQueryCount,
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
  assert.equal(client.cancelled, expectedCancellationCount);
  assert.ok(client.configs.every((config) => !Object.hasOwn(config, 'signal')));
  assert.equal(client.statements.includes('COMMIT'), false);
  await driver.close();
}

test('PostgreSQL cancellation uses query handles for reads, writes, and introspection', async () => {
  await assertPostgresCancellation(
    (driver, signal) => driver.read('SELECT pg_sleep(10)', [], signal),
    2,
    1,
  );
  await assertPostgresCancellation(
    (driver, signal) => driver.write('UPDATE users SET name = ?', ['x'], false, signal),
    2,
    1,
  );
  await assertPostgresCancellation((driver, signal) => driver.introspect(signal), 6);
});

test('PostgreSQL abort during COMMIT rejects the write', async () => {
  const client = new PgClientStub();
  const driver = driverWithCancellationStub(client);
  const controller = new AbortController();
  const operation = driver.write('UPDATE users SET name = ?', ['x'], false, controller.signal);

  for (let attempt = 0; attempt < 20 && client.queries.length < 2; attempt += 1) {
    await Promise.resolve();
  }
  assert.equal(client.queries.length, 2);
  client.complete(client.queries[1]!);

  for (let attempt = 0; attempt < 20 && client.queries.length < 3; attempt += 1) {
    await Promise.resolve();
  }
  assert.equal(client.queries[2]?.config.text, 'COMMIT');

  controller.abort(new Error('query timeout'));
  const outcome = await operation.then(() => undefined, (err: unknown) => err);
  assert.ok(outcome instanceof DbConnectorError);
  assert.equal(outcome.code, ErrorCode.Timeout);
  assert.equal(client.cancelled, 1);
  assert.equal(client.queries.some((query) => query.config.text === 'ROLLBACK'), false);
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

test('PostgreSQL cancellation closes a delayed cancellation client', async () => {
  const client = new PgClientStub();
  const driver = driverWithCancellationStub(client);
  (driver as unknown as { clientConstructor: typeof DelayedCancellationClient }).clientConstructor =
    DelayedCancellationClient;
  const controller = new AbortController();
  const operation = driver.read('SELECT pg_sleep(10)', [], controller.signal);

  for (let attempt = 0; attempt < 20 && client.queries.length < 2; attempt += 1) {
    await Promise.resolve();
  }
  assert.equal(client.queries.length, 2);
  controller.abort(new Error('query timeout'));
  const cancellationClient = PgClientStub.lastCreated as DelayedCancellationClient;
  assert.ok(cancellationClient instanceof DelayedCancellationClient);

  client.complete(client.queries[1]!);
  const outcome = await operation.then(() => undefined, (err: unknown) => err);
  assert.ok(outcome instanceof DbConnectorError);
  assert.equal(outcome.code, ErrorCode.Timeout);
  assert.equal(cancellationClient.endCalls, 1);
  assert.equal(cancellationClient.connection.listenerCount('connect'), 0);

  cancellationClient.connection.emit('connect');
  assert.equal(client.cancelled, 0);
  await driver.close();
});

test('PostgreSQL native pipeline cancellation reaches the native client', async () => {
  const client = new NativePipelineClient();
  const driver = driverWithCancellationStub(client);
  (driver as unknown as { clientConstructor: typeof NativePipelineClient }).clientConstructor =
    NativePipelineClient;
  const controller = new AbortController();
  const operation = driver.read('SELECT pg_sleep(10)', [], controller.signal);

  for (let attempt = 0; attempt < 20 && client.queries.length < 2; attempt += 1) {
    await Promise.resolve();
  }
  assert.equal(client.queries.length, 2);
  controller.abort(new Error('query timeout'));
  await Promise.resolve();
  assert.equal(client.nativeCancelled, 1);

  client.complete(client.queries[1]!);
  const outcome = await operation.then(() => undefined, (err: unknown) => err);
  assert.ok(outcome instanceof DbConnectorError);
  assert.equal(outcome.code, ErrorCode.Timeout);
  await driver.close();
});

test('PostgreSQL abort cancels BEGIN and ROLLBACK control queries', async () => {
  const beginClient = new PgClientStub(false, ['BEGIN TRANSACTION READ ONLY']);
  const beginDriver = driverWithCancellationStub(beginClient);
  const beginController = new AbortController();
  const beginOperation = beginDriver.read('SELECT 1', [], beginController.signal);

  for (let attempt = 0; attempt < 20 && beginClient.queries.length < 1; attempt += 1) {
    await Promise.resolve();
  }
  beginController.abort(new Error('query timeout'));
  const beginOutcome = await beginOperation.then(() => undefined, (err: unknown) => err);
  assert.ok(beginOutcome instanceof DbConnectorError);
  assert.equal(beginOutcome.code, ErrorCode.Timeout);
  assert.equal(beginClient.cancelled, 1);
  await beginDriver.close();

  const rollbackClient = new PgClientStub(false, ['ROLLBACK']);
  const rollbackDriver = driverWithCancellationStub(rollbackClient);
  const rollbackController = new AbortController();
  const rollbackOperation = rollbackDriver.read('SELECT 1', [], rollbackController.signal);

  for (let attempt = 0; attempt < 20 && rollbackClient.queries.length < 2; attempt += 1) {
    await Promise.resolve();
  }
  rollbackClient.complete(rollbackClient.queries[1]!);
  for (let attempt = 0; attempt < 20 && rollbackClient.queries.length < 3; attempt += 1) {
    await Promise.resolve();
  }
  assert.equal(rollbackClient.queries[2]?.config.text, 'ROLLBACK');
  rollbackController.abort(new Error('query timeout'));
  const rollbackOutcome = await rollbackOperation.then(() => undefined, (err: unknown) => err);
  assert.ok(rollbackOutcome instanceof DbConnectorError);
  assert.equal(rollbackOutcome.code, ErrorCode.Timeout);
  assert.equal(rollbackClient.cancelled, 1);
  await rollbackDriver.close();
});

test('PostgreSQL cancellation connection failures do not become unhandled client errors', async () => {
  const client = new PgClientStub();
  const driver = driverWithCancellationStub(client);
  (driver as unknown as { clientConstructor: typeof FailingCancellationClient }).clientConstructor =
    FailingCancellationClient;
  const controller = new AbortController();
  const operation = driver.read('SELECT pg_sleep(10)', [], controller.signal);

  for (let attempt = 0; attempt < 20 && client.configs.length < 2; attempt += 1) {
    await Promise.resolve();
  }
  assert.equal(client.configs.length, 2);

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
