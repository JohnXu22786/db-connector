import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { EventEmitter, once } from 'node:events';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { test } from 'node:test';
import { ErrorCode, DbConnectorError } from '../dist/errors.js';
import { PgDriver } from '../dist/drivers/postgres.js';
import type { ResolvedConnectionSpec } from '../dist/types.js';

interface PgQueryResult {
  fields: Array<{ name: string }>;
  rows: Array<Record<string, unknown>>;
  rowCount: number | null;
}

interface PgQuery {
  callback: (err: Error | null, result?: PgQueryResult) => void;
}

interface PgClient {
  query(input: unknown): unknown;
  cancel(...args: unknown[]): unknown;
  connect(): Promise<void>;
  end(): Promise<void>;
}

interface PgModule {
  Client: new (config?: Record<string, unknown>) => PgClient;
  Query: new (config: Record<string, unknown>, values?: unknown[], callback?: PgQuery['callback']) => object;
}

interface PgNamespace extends PgModule {
  native?: PgModule | null;
}

const require = createRequire(import.meta.url);
const pg = require('pg') as PgNamespace;

function loadNativePg(): { module: PgModule | null; reason: string } {
  try {
    const module = pg.native ?? null;
    return {
      module,
      reason: module ? '' : 'pg-native is not installed',
    };
  } catch (err) {
    return {
      module: null,
      reason: `pg-native is unavailable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

const nativePgResult = loadNativePg();
const nativePg = nativePgResult.module;

const spec: ResolvedConnectionSpec = {
  name: 'pg-test',
  driver: 'postgres',
  database: 'db',
  host: '127.0.0.1',
  port: 5432,
  user: 'user',
  password: '',
  passwordSource: 'none',
  options: {},
};

function int16(value: number): Buffer {
  const out = Buffer.alloc(2);
  out.writeInt16BE(value, 0);
  return out;
}

function int32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeInt32BE(value, 0);
  return out;
}

function cstring(value: string): Buffer {
  return Buffer.from(`${value}\0`);
}

function message(type: string, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from(type), int32(body.length + 4), body]);
}

class FakePostgresServer {
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private mainSocket: Socket | null = null;
  private longQueryResolve!: () => void;
  readonly longQueryStarted = new Promise<void>((resolve) => {
    this.longQueryResolve = resolve;
  });
  cancelRequests = 0;
  mainConnections = 0;
  port = 0;

  constructor() {
    this.server = createServer((socket) => this.accept(socket));
  }

  async listen(): Promise<void> {
    this.server.listen(0, '127.0.0.1');
    await once(this.server, 'listening');
    this.port = (this.server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => {
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let startupHandled = false;
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!startupHandled) {
        if (buffer.length < 8) return;
        const length = buffer.readInt32BE(0);
        if (buffer.length < length) return;
        const code = buffer.readInt32BE(4);
        if (length === 16 && code === 80877102) {
          this.cancelRequests += 1;
          socket.end();
          this.cancelMainQuery();
          return;
        }

        startupHandled = true;
        buffer = buffer.subarray(length);
        this.mainSocket = socket;
        this.mainConnections += 1;
        socket.write(Buffer.concat([
          message('R', int32(0)),
          message('K', Buffer.concat([int32(1234), int32(5678)])),
          message('Z', Buffer.from('I')),
        ]));
      }
      buffer = this.processMessages(socket, buffer);
    });
    socket.once('close', () => this.sockets.delete(socket));
  }

  private processMessages(socket: Socket, buffer: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> {
    while (buffer.length >= 5) {
      const length = buffer.readInt32BE(1);
      const total = length + 1;
      if (buffer.length < total) return buffer;
      const type = String.fromCharCode(buffer[0]!);
      const body = buffer.subarray(5, total);
      buffer = buffer.subarray(total);
      if (type === 'Q') this.handleQuery(socket, body.toString().replace(/\0$/, ''));
    }
    return buffer;
  }

  private handleQuery(socket: Socket, sql: string): void {
    const normalized = sql.trim().toUpperCase();
    if (normalized.includes('PG_SLEEP')) {
      this.longQueryResolve();
      return;
    }
    if (normalized === 'SELECT 1' || normalized === 'SELECT 42') {
      this.sendSelect(socket, normalized === 'SELECT 1' ? '1' : '42');
      return;
    }
    this.sendCommand(socket, normalized.split(/\s+/, 1)[0] || 'OK');
  }

  private sendCommand(socket: Socket, tag: string): void {
    socket.write(Buffer.concat([
      message('C', cstring(tag)),
      message('Z', Buffer.from('I')),
    ]));
  }

  private sendSelect(socket: Socket, value: string): void {
    const field = Buffer.concat([
      cstring('value'),
      int32(0),
      int16(0),
      int32(23),
      int16(4),
      int32(-1),
      int16(0),
    ]);
    const row = Buffer.concat([int16(1), int32(Buffer.byteLength(value)), Buffer.from(value)]);
    socket.write(Buffer.concat([
      message('T', Buffer.concat([int16(1), field])),
      message('D', row),
      message('C', cstring('SELECT 1')),
      message('Z', Buffer.from('I')),
    ]));
  }

  private cancelMainQuery(): void {
    if (!this.mainSocket) return;
    const error = Buffer.concat([
      cstring('S'), cstring('ERROR'),
      cstring('C'), cstring('57014'),
      cstring('M'), cstring('canceling statement due to user request'),
      Buffer.from([0]),
    ]);
    this.mainSocket.write(Buffer.concat([
      message('E', error),
      message('Z', Buffer.from('I')),
    ]));
  }
}

class NativeClientStub implements PgClient {
  _activeQuery: PgQuery | undefined;
  cancelled = 0;

  async connect(): Promise<void> {}

  query(input: unknown): unknown {
    if (typeof input === 'string') {
      return Promise.resolve({ fields: [], rows: [], rowCount: 0 });
    }
    this._activeQuery = input as PgQuery;
    return input;
  }

  cancel(query: PgQuery): void {
    if (this._activeQuery !== query) return;
    this.cancelled += 1;
    this._activeQuery = undefined;
    query.callback(new Error('canceling statement due to user request'));
  }

  async end(): Promise<void> {}
}

class PureJsClientStub implements PgClient {
  activeQuery: PgQuery | undefined;
  processID = 123;
  secretKey = 456;

  async connect(): Promise<void> {}

  query(input: unknown): unknown {
    if (typeof input === 'string') {
      return Promise.resolve({ fields: [], rows: [], rowCount: 0 });
    }
    this.activeQuery = input as PgQuery;
    return input;
  }

  cancel(_client: PgClient, _query: object): void {}

  async end(): Promise<void> {}
}

class FailingCancellationClient extends EventEmitter implements PgClient {
  static lastConfig: Record<string, unknown> | undefined;
  readonly connection = new EventEmitter();

  constructor(config?: Record<string, unknown>) {
    super();
    FailingCancellationClient.lastConfig = config ?? {};
  }

  async connect(): Promise<void> {}

  query(): unknown {
    return undefined;
  }

  cancel(_client: PgClient, _query: object): void {
    queueMicrotask(() => this.connection.emit('error', new Error('cancel connection failed')));
  }

  async end(): Promise<void> {}
}

class TlsCancellationConnection extends EventEmitter {
  requestSslCalls = 0;
  cancelCalls = 0;
  cancelledProcessID: number | null = null;
  cancelledSecretKey: number | null = null;
  private readonly client: PureJsClientStub;

  constructor(client: PureJsClientStub) {
    super();
    this.client = client;
  }

  connect(_port: number, _host?: string): void {
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
    const query = this.client.activeQuery;
    assert.ok(query, 'TLS cancellation should target the active query');
    this.client.activeQuery = undefined;
    query.callback(new Error('canceling statement due to user request'));
  }
}

class TlsCancellationClient extends EventEmitter implements PgClient {
  static lastInstance: TlsCancellationClient | undefined;
  readonly ssl = true;
  readonly connection: TlsCancellationConnection;

  constructor(_config?: Record<string, unknown>) {
    super();
    const target = tlsCancellationTarget;
    assert.ok(target, 'TLS cancellation target should be configured');
    this.connection = new TlsCancellationConnection(target);
    TlsCancellationClient.lastInstance = this;
  }

  async connect(): Promise<void> {}

  query(): unknown {
    return undefined;
  }

  cancel(_client: PgClient, _query: object): void {
    throw new Error('TLS cancellation should use the configured connection');
  }

  async end(): Promise<void> {}
}

let tlsCancellationTarget: PureJsClientStub | undefined;

function driverWithClient(
  client: PgClient,
  Client: PgModule['Client'],
  Query: PgModule['Query'],
  driverSpec: ResolvedConnectionSpec = spec,
  clientConfig: Record<string, unknown> = {},
): PgDriver {
  const driver = new PgDriver(driverSpec, { debug() {}, info() {}, warn() {} });
  const internals = driver as unknown as {
    client: PgClient;
    clientConstructor: PgModule['Client'];
    queryConstructor: PgModule['Query'];
    clientConfig: Record<string, unknown>;
  };
  internals.client = client;
  internals.clientConstructor = Client;
  internals.queryConstructor = Query;
  internals.clientConfig = clientConfig;
  return driver;
}

test('pure-JS cancellation preserves transport options and reports connection failures', async () => {
  const ssl = { rejectUnauthorized: false };
  const stream = () => new EventEmitter();
  const connection = new EventEmitter();
  const clientConfig = {
    host: 'db.example.test',
    port: 6543,
    ssl,
    stream,
    connection,
    customOption: 'preserved',
  };
  const client = new PureJsClientStub();
  const driver = driverWithClient(client, FailingCancellationClient, pg.Query, spec, clientConfig);
  const controller = new AbortController();
  const pending = driver.read('SELECT pg_sleep(30)', [], controller.signal);

  try {
    await Promise.resolve();
    assert.ok(client.activeQuery, 'the query should be active before cancellation');
    controller.abort(new Error('query timeout'));

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await assert.rejects(
        Promise.race([
          pending,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('cancellation hung')), 1000);
          }),
        ]),
        (err: unknown) =>
          err instanceof DbConnectorError &&
          err.code === ErrorCode.QueryFailed &&
          err.message.includes('cancel connection failed'),
      );
    } finally {
      if (timer) clearTimeout(timer);
    }

    assert.equal(FailingCancellationClient.lastConfig?.ssl, ssl);
    assert.equal(FailingCancellationClient.lastConfig?.stream, stream);
    assert.equal(FailingCancellationClient.lastConfig?.connection, connection);
    assert.equal(FailingCancellationClient.lastConfig?.customOption, 'preserved');
  } finally {
    await driver.close();
  }
});

test('TLS cancellation negotiates TLS before sending the CancelRequest', async () => {
  const client = new PureJsClientStub();
  tlsCancellationTarget = client;
  const driver = driverWithClient(
    client,
    TlsCancellationClient,
    pg.Query,
    spec,
    { host: 'db.example.test', port: 6543, ssl: true },
  );
  const controller = new AbortController();
  const pending = driver.read('SELECT pg_sleep(30)', [], controller.signal);

  try {
    await Promise.resolve();
    controller.abort(new Error('query timeout'));
    await assert.rejects(
      pending,
      (err: unknown) => err instanceof DbConnectorError && err.code === ErrorCode.Timeout,
    );

    const cancellationConnection = TlsCancellationClient.lastInstance?.connection;
    assert.ok(cancellationConnection);
    assert.equal(cancellationConnection.requestSslCalls, 1);
    assert.equal(cancellationConnection.cancelCalls, 1);
    assert.equal(cancellationConnection.cancelledProcessID, client.processID);
    assert.equal(cancellationConnection.cancelledSecretKey, client.secretKey);
  } finally {
    tlsCancellationTarget = undefined;
    await driver.close();
  }
});

test('pure-JS pg 8.13 cancellation uses a separate connection and preserves recovery', async () => {
  const server = new FakePostgresServer();
  await server.listen();
  const driver = new PgDriver(
    { ...spec, port: server.port },
    { debug() {}, info() {}, warn() {} },
  );

  try {
    await driver.connect();
    const controller = new AbortController();
    const pending = driver.read('SELECT pg_sleep(30)', [], controller.signal);
    await server.longQueryStarted;
    controller.abort(new Error('query timeout'));

    await assert.rejects(
      pending,
      (err: unknown) => err instanceof DbConnectorError && err.code === ErrorCode.Timeout,
    );
    assert.equal(server.cancelRequests, 1);
    assert.equal(server.mainConnections, 1);

    const recovered = await driver.read('SELECT 42', [], new AbortController().signal);
    assert.deepEqual(recovered.rows, [[42]]);
    assert.equal(server.mainConnections, 1);
  } finally {
    await driver.close();
    await server.close();
  }
});

test('native-shaped clients use cancel(query) and their active-query slot', async () => {
  const client = new NativeClientStub();
  class UnexpectedCancellationClient implements PgClient {
    constructor() {
      throw new Error('native cancellation must not create a second client');
    }

    async connect(): Promise<void> {}

    query(): unknown {
      return undefined;
    }

    cancel(): void {}

    async end(): Promise<void> {}
  }

  const driver = driverWithClient(client, UnexpectedCancellationClient, pg.Query);
  const controller = new AbortController();
  const pending = driver.read('SELECT pg_sleep(30)', [], controller.signal);
  await Promise.resolve();
  controller.abort(new Error('query timeout'));

  await assert.rejects(
    pending,
    (err: unknown) => err instanceof DbConnectorError && err.code === ErrorCode.Timeout,
  );
  assert.equal(client.cancelled, 1);
  await driver.close();
});

test('pg-native cancellation cancels an active query and preserves recovery', {
  skip: nativePg ? false : nativePgResult.reason,
}, async () => {
  if (!nativePg) return;

  const server = new FakePostgresServer();
  await server.listen();
  const client = new nativePg.Client({
    host: '127.0.0.1',
    port: server.port,
    user: 'user',
    database: 'db',
  });
  let driver: PgDriver | undefined;

  try {
    await client.connect();
    driver = driverWithClient(
      client,
      nativePg.Client,
      nativePg.Query,
      { ...spec, port: server.port },
      { host: '127.0.0.1', port: server.port, user: 'user', database: 'db' },
    );
    const controller = new AbortController();
    // NativeQuery treats an empty values array as a parameterized query. The
    // protocol fixture only needs a simple query for this cancellation test.
    const pending = driver.read('SELECT pg_sleep(30)', undefined as unknown as [], controller.signal);
    await server.longQueryStarted;
    controller.abort(new Error('query timeout'));

    await assert.rejects(
      pending,
      (err: unknown) => err instanceof DbConnectorError && err.code === ErrorCode.Timeout,
    );
    assert.equal(server.cancelRequests, 1);

    const recovered = await driver.read('SELECT 42', undefined as unknown as [], new AbortController().signal);
    assert.deepEqual(recovered.rows, [[42]]);
  } finally {
    if (driver) await driver.close();
    else await client.end();
    await server.close();
  }
});
