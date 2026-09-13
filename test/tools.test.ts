/**
 * Tool definition tests: names/descriptions, argument validation, and each
 * handler bridged to the real execution engine.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { DbConnectorError } from '../dist/errors.js';
import { buildTools, validateArgs } from '../dist/tools.js';
import type { DshTool, ToolRunContext } from '../dist/types.js';
import { freshSignal, makeHarness, seedSqlite, type Harness } from './helpers.ts';

function run(h: Harness): DshTool[] {
  return buildTools(h.engine);
}

function fakeExec(): ToolRunContext {
  return { signal: freshSignal(), token: 'tok' };
}

test('buildTools returns the five expected tools with metadata', async () => {
  const h = makeHarness();
  const tools = run(h);
  assert.deepEqual(
    tools.map((t) => t.name),
    ['db_connect', 'db_schema', 'db_query', 'db_exec', 'db_audit'],
  );
  for (const t of tools) {
    assert.ok(t.description.length > 20, `${t.name} description`);
    assert.equal(t.parameters.type, 'object');
    assert.equal(t.parameters.additionalProperties, false);
    assert.ok(typeof t.execute === 'function');
    assert.ok(t.output.schema && typeof t.output.render === 'function');
  }
  assert.ok(tools[2]!.parameters as object);
  const queryParams = (tools[2]!.parameters as { properties?: Record<string, unknown> }).properties;
  const execParams = (tools[3]!.parameters as { properties?: Record<string, unknown> }).properties;
  assert.ok(queryParams?.sql);
  assert.ok(execParams?.allowWrite);
});

test('validateArgs enforces types, required, enums and extra keys', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: { name: { type: 'string' }, n: { type: 'integer' }, mode: { type: 'string', enum: ['a', 'b'] } },
    required: ['name'],
  };
  assert.doesNotThrow(() => validateArgs(schema, { name: 'x', n: 2, mode: 'a' }));
  assert.throws(() => validateArgs(schema, { n: 2 }), (e: DbConnectorError) => e.code === 'INVALID_ARGS');
  assert.throws(() => validateArgs(schema, { name: 'x', n: 2.5 }), (e: DbConnectorError) => e.code === 'INVALID_ARGS');
  assert.throws(() => validateArgs(schema, { name: 'x', mode: 'z' }), (e: DbConnectorError) => e.code === 'INVALID_ARGS');
  assert.throws(() => validateArgs(schema, { name: 'x', extra: 1 }), (e: DbConnectorError) => e.code === 'INVALID_ARGS');
});

test('db_query and db_exec reject negative timeoutMs during tool validation', async () => {
  const h = makeHarness();
  const tools = run(h);

  for (const tool of [tools[2]!, tools[3]!]) {
    await assert.rejects(
      tool.execute({ name: 'missing', sql: 'SELECT 1', timeoutMs: -1 }, fakeExec()),
      (e: DbConnectorError) => e.code === 'INVALID_ARGS',
    );
  }
});

test('db_connect list/close/connect through the engine', async () => {
  const h = await makeHarness();
  await seedSqlite(h);
  const connect = run(h)[0]!;

  const list = await connect.execute({ action: 'list' }, fakeExec()) as { connections: unknown[] };
  assert.equal(list.connections.length, 1);

  const closed = await connect.execute({ action: 'close', name: 'sample' }, fakeExec()) as { closed: boolean };
  assert.equal(closed.closed, true);

  const made = await connect.execute(
    { action: 'connect', name: 'n2', config: { driver: 'sqlite', database: ':memory:' } },
    fakeExec(),
  ) as { status: { status: string } };
  assert.equal(made.status.status, 'connected');
});

test('db_connect rejects a null database with INVALID_ARGS', async () => {
  const h = makeHarness();
  const connect = run(h)[0]!;

  await assert.rejects(
    connect.execute(
      { action: 'connect', name: 'invalid', config: { driver: 'sqlite', database: null } },
      fakeExec(),
    ),
    (e: DbConnectorError) => e.code === 'INVALID_ARGS',
  );
});

test('db_query handler validates and runs read-only', async () => {
  const h = await makeHarness();
  await seedSqlite(h);
  const query = run(h)[2]!;

  const result = await query.execute(
    { name: 'sample', sql: 'SELECT COUNT(*) AS n FROM users' },
    fakeExec(),
  ) as { rowCount: number; rows: unknown[][] };
  assert.equal(result.rowCount, 1);
  assert.equal(result.rows[0]![0], 2);

  await assert.rejects(
    query.execute({ name: 'sample', sql: 'DELETE FROM users' }, fakeExec()),
    (e: DbConnectorError) => e.code === 'READ_ONLY_VIOLATION',
  );
  await assert.rejects(
    query.execute({ name: 'sample' }, fakeExec()),
    (e: DbConnectorError) => e.code === 'INVALID_ARGS',
  );
});

test('db_exec handler enforces allowWrite and executes writes', async () => {
  const h = await makeHarness();
  await seedSqlite(h);
  const exec = run(h)[3]!;

  await assert.rejects(
    exec.execute(
      { name: 'sample', sql: 'UPDATE users SET age = age + 1' },
      fakeExec(),
    ),
    (e: DbConnectorError) => e.code === 'WRITE_NOT_ALLOWED',
  );

  const ok = await exec.execute(
    { name: 'sample', sql: 'UPDATE users SET age = age + 1', allowWrite: true },
    fakeExec(),
  ) as { affectedRows: number };
  assert.equal(ok.affectedRows, 2);
});

test('db_schema and db_audit handlers bridge to the engine', async () => {
  const h = await makeHarness();
  await seedSqlite(h);
  const tools = run(h);

  const schema = await tools[1]!.execute({ name: 'sample' }, fakeExec()) as { tables: Array<{ name: string }> };
  assert.ok(schema.tables.some((t) => t.name === 'users'));

  const audit = await tools[4]!.execute({}, fakeExec()) as { records: Array<{ connection: string }> };
  assert.ok(audit.records.length > 0);
  assert.equal(audit.records[0]!.connection, 'sample');
});

test('raw output renders canonical JSON content blocks', async () => {
  const h = await makeHarness();
  await seedSqlite(h);
  const tools = run(h);
  const value = { ok: true };
  const blocks = tools[0]!.output.render({}, value);
  assert.equal(blocks[0]!.type, 'text');
  assert.equal(JSON.parse(blocks[0]!.text).ok, true);
});
