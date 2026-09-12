import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { ErrorCode, DbConnectorError } from '../dist/errors.js';
import { PgDriver } from '../dist/drivers/postgres.js';
import type { ResolvedConnectionSpec } from '../dist/types.js';

interface FakeQueryResult {
  fields: Array<{ name: string }>;
  rows: Array<Record<string, unknown>>;
  rowCount: number | null;
}

type FakeQueryCallback = (err: Error | null, result?: FakeQueryResult) => void;

class FakeQuery {
  readonly config: Record<string, unknown>;
  readonly values: unknown[] | undefined;
  readonly callback: FakeQueryCallback;

  constructor(
    config: Record<string, unknown>,
    values: unknown[] | undefined,
    callback: FakeQueryCallback,
  ) {
    this.config = config;
    this.values = values;
    this.callback = callback;
  }
}

class TargetClient {
  readonly host: string;
  readonly port: number;
  readonly ssl: unknown;
  readonly processID = 123;
  readonly secretKey = 456;
  activeQuery: FakeQuery | undefined;

  constructor(config: Record<string, unknown>) {
    this.host = String(config.host ?? '127.0.0.1');
    this.port = Number(config.port ?? 5432);
    this.ssl = config.ssl;
  }

  query(input: string | FakeQuery): Promise<FakeQueryResult> | FakeQuery {
    if (typeof input === 'string') {
      return Promise.resolve({ fields: [], rows: [], rowCount: 0 });
    }
    this.activeQuery = input;
    return input;
  }

  cancel(_client: TargetClient, _query: FakeQuery): void {
    throw new Error('the target client must not send the cancellation connection');
  }

  async connect(): Promise<void> {}

  async end(): Promise<void> {}
}

class TlsCancellationConnection extends EventEmitter {
  readonly connectCalls: Array<[number | string, string | undefined]> = [];
  requestSslCalls = 0;
  cancelCalls = 0;
  cancelledProcessID: number | null = null;
  cancelledSecretKey: number | null = null;

  private readonly target: TargetClient;

  constructor(target: TargetClient) {
    super();
    this.target = target;
  }

  connect(portOrPath: number | string, host?: string): void {
    this.connectCalls.push([portOrPath, host]);
    this.emit('connect');
    this.emit('sslconnect');
  }

  requestSsl(): void {
    this.requestSslCalls += 1;
  }

  cancel(processID: number | null, secretKey: number | null): void {
    this.cancelCalls += 1;
    this.cancelledProcessID = processID;
    this.cancelledSecretKey = secretKey;
    const query = this.target.activeQuery;
    assert.ok(query, 'TLS cancellation should target the active query');
    this.target.activeQuery = undefined;
    query.callback(new Error('canceling statement due to user request'));
  }
}

class TlsCancellationClient extends EventEmitter {
  static lastInstance: TlsCancellationClient | undefined;
  readonly ssl = true;
  readonly host: string;
  readonly port: number;
  readonly connection: TlsCancellationConnection;

  constructor(config: Record<string, unknown>) {
    super();
    assert.ok(cancellationTarget);
    this.host = String(config.host);
    this.port = Number(config.port);
    this.connection = new TlsCancellationConnection(cancellationTarget);
    TlsCancellationClient.lastInstance = this;
  }

  cancel(): void {
    throw new Error('TLS cancellation should use the configured connection');
  }
}

class PlainCancellationClient extends EventEmitter {
  readonly ssl = false;
  readonly host: string;
  readonly port: number;
  static lastConfig: Record<string, unknown> | undefined;

  constructor(config: Record<string, unknown>) {
    super();
    PlainCancellationClient.lastConfig = config;
    this.host = String(config.host);
    this.port = Number(config.port);
  }

  cancel(_client: TargetClient, query: FakeQuery): void {
    assert.ok(cancellationTarget?.activeQuery === query, 'cancellation should target the active query');
    cancellationTarget!.activeQuery = undefined;
    query.callback(new Error('canceling statement due to user request'));
  }
}

const baseSpec: ResolvedConnectionSpec = {
  name: 'postgres-cancellation-test',
  driver: 'postgres',
  database: 'db',
  host: '127.0.0.1',
  port: 5432,
  user: 'user',
  password: '',
  passwordSource: 'none',
  options: {},
};

let cancellationTarget: TargetClient | undefined;

function driverWithClient(
  client: TargetClient,
  Client: new (config: Record<string, unknown>) => unknown,
  clientConfig: Record<string, unknown>,
  driverSpec: ResolvedConnectionSpec,
): PgDriver {
  const driver = new PgDriver(driverSpec, { debug() {}, info() {}, warn() {} });
  const internals = driver as unknown as {
    client: TargetClient;
    clientConstructor: new (config: Record<string, unknown>) => unknown;
    queryConstructor: typeof FakeQuery;
    clientConfig: Record<string, unknown>;
  };
  internals.client = client;
  internals.clientConstructor = Client;
  internals.queryConstructor = FakeQuery;
  internals.clientConfig = clientConfig;
  return driver;
}

async function waitForActiveQuery(client: TargetClient): Promise<void> {
  for (let attempt = 0; attempt < 10 && !client.activeQuery; attempt += 1) {
    await Promise.resolve();
  }
  assert.ok(client.activeQuery, 'the query should be active before cancellation');
}

test('TLS cancellation uses PostgreSQL Unix-socket path form', async () => {
  const clientConfig = {
    host: '/var/run/postgresql',
    port: 6543,
    ssl: true,
  };
  const client = new TargetClient(clientConfig);
  cancellationTarget = client;
  const driver = driverWithClient(
    client,
    TlsCancellationClient,
    clientConfig,
    { ...baseSpec, host: clientConfig.host, port: clientConfig.port, ssl: true },
  );
  const controller = new AbortController();
  const pending = driver.read('SELECT pg_sleep(30)', [], controller.signal);

  try {
    await waitForActiveQuery(client);
    controller.abort(new Error('query timeout'));

    await assert.rejects(
      pending,
      (err: unknown) => err instanceof DbConnectorError && err.code === ErrorCode.Timeout,
    );

    const connection = TlsCancellationClient.lastInstance?.connection;
    assert.ok(connection);
    assert.deepEqual(connection.connectCalls, [['/var/run/postgresql/.s.PGSQL.6543', undefined]]);
    assert.equal(connection.requestSslCalls, 1);
    assert.equal(connection.cancelCalls, 1);
    assert.equal(connection.cancelledProcessID, client.processID);
    assert.equal(connection.cancelledSecretKey, client.secretKey);
  } finally {
    const connection = (driver as unknown as { client: TargetClient }).client;
    await driver.close();
    cancellationTarget = undefined;
    assert.equal(connection.activeQuery, undefined);
  }
});

test('pure-JavaScript cancellation uses a separate client and preserves timeout errors', async () => {
  const clientConfig = {
    host: 'db.example.test',
    port: 6543,
    ssl: false,
    customOption: 'preserved',
  };
  const client = new TargetClient(clientConfig);
  cancellationTarget = client;
  const driver = driverWithClient(
    client,
    PlainCancellationClient,
    clientConfig,
    { ...baseSpec, host: clientConfig.host, port: clientConfig.port },
  );
  const controller = new AbortController();
  const pending = driver.read('SELECT pg_sleep(30)', [], controller.signal);

  try {
    await waitForActiveQuery(client);
    controller.abort(new Error('query timeout'));

    await assert.rejects(
      pending,
      (err: unknown) => err instanceof DbConnectorError && err.code === ErrorCode.Timeout,
    );
    assert.notEqual(PlainCancellationClient.lastConfig, clientConfig);
    assert.equal(PlainCancellationClient.lastConfig?.customOption, 'preserved');
  } finally {
    await driver.close();
    cancellationTarget = undefined;
  }
});
