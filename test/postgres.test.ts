import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ErrorCode, DbConnectorError } from '../dist/errors.js';
import { PgDriver } from '../dist/drivers/postgres.js';
import type { ResolvedConnectionSpec } from '../dist/types.js';

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
}

type FakeQueryCallback = (err: Error | null, result?: FakeQueryResult) => void;

class Pg813Query {
  readonly id: number;
  readonly config: FakeQueryConfig;
  readonly callback: FakeQueryCallback;

  constructor(
    config: FakeQueryConfig,
    _values: unknown[] | undefined,
    callback: FakeQueryCallback,
  ) {
    this.config = config;
    this.callback = callback;
    this.id = ++nextQueryId;
  }
}

let nextQueryId = 0;

/** Models pg 8.13: config signals are ignored; cancellation uses Query handles. */
class Pg813ClientStub {
  readonly configs: FakeQueryConfig[] = [];
  readonly statements: string[] = [];
  cancelled = 0;
  activeQuery: Pg813Query | undefined;
  private readonly pending = new Map<Pg813Query, FakeQueryCallback>();

  query(input: string | FakeQueryConfig | Pg813Query): Promise<FakeQueryResult> | Pg813Query {
    if (typeof input === 'string') {
      this.statements.push(input);
      return Promise.resolve({ fields: [], rows: [], rowCount: 0 });
    }

    const config = input instanceof Pg813Query ? input.config : input;
    this.configs.push(config);
    if (!(input instanceof Pg813Query)) return new Promise<FakeQueryResult>(() => {});

    this.pending.set(input, input.callback);
    if (!this.activeQuery) this.activeQuery = input;
    return input;
  }

  cancel(client: Pg813ClientStub, query: Pg813Query): void {
    assert.equal(client, this);
    const callback = this.pending.get(query);
    assert.ok(callback, 'cancel should receive an active pg query handle');
    this.pending.delete(query);
    this.cancelled += 1;
    if (this.activeQuery === query) this.activeQuery = undefined;
    callback(new Error('canceling statement due to user request'));
  }

  async connect(): Promise<void> {}

  async end(): Promise<void> {}
}

const spec: ResolvedConnectionSpec = {
  name: 'pg-test',
  driver: 'postgres',
  database: 'db',
  host: 'localhost',
  port: 5432,
  user: 'user',
  password: '',
  passwordSource: 'none',
  options: {},
};

function driverWithStub(client: Pg813ClientStub): PgDriver {
  const driver = new PgDriver(spec, { debug() {}, info() {}, warn() {} });
  (driver as unknown as { client: Pg813ClientStub }).client = client;
  (driver as unknown as { queryConstructor: typeof Pg813Query }).queryConstructor = Pg813Query;
  return driver;
}

async function waitForConfigs(client: Pg813ClientStub, count: number): Promise<void> {
  for (let attempt = 0; attempt < 10 && client.configs.length < count; attempt += 1) {
    await Promise.resolve();
  }
  assert.equal(client.configs.length, count);
}

async function assertCancelled(
  run: (driver: PgDriver, signal: AbortSignal) => Promise<unknown>,
  configCount: number,
): Promise<void> {
  const client = new Pg813ClientStub();
  const driver = driverWithStub(client);
  const controller = new AbortController();
  const operation = run(driver, controller.signal);

  await waitForConfigs(client, configCount);
  controller.abort(new Error('query timeout'));

  const result = await Promise.race([
    operation.then(() => undefined, (err: unknown) => err),
    new Promise<symbol>((resolve) => setTimeout(() => resolve(Symbol('still-pending')), 100)),
  ]);
  assert.ok(result instanceof DbConnectorError, 'aborted PostgreSQL work should reject promptly');
  assert.equal(result.code, ErrorCode.Timeout);
  assert.equal(client.cancelled, configCount);
  assert.ok(client.configs.every((config) => !Object.hasOwn(config, 'signal')));
  await driver.close();
}

test('postgres cancellation uses pg 8.13 query handles for every cancellable path', async () => {
  await assertCancelled((driver, signal) => driver.read('SELECT pg_sleep(10)', [], signal), 1);
  await assertCancelled((driver, signal) => driver.write('UPDATE users SET name = ?', ['x'], false, signal), 1);
  await assertCancelled((driver, signal) => driver.introspect(signal), 6);
});
