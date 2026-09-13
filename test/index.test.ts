/**
 * Plugin entry tests: `apply` wires tools + the /db command + config-driven
 * connections onto a fake dsh context, and teardown closes everything.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { apply, inject, name } from '../dist/index.js';
import type { DshContext, DshTool } from '../dist/types.js';

function fakeContext(): {
  ctx: DshContext;
  tools: DshTool[];
  commands: Array<{ name: string; description: string }>;
  disposed: Array<() => void>;
  logs: string[];
} {
  const tools: DshTool[] = [];
  const commands: Array<{ name: string; description: string }> = [];
  const disposed: Array<() => void> = [];
  const logs: string[] = [];
  const ctx: DshContext = {
    logger: {
      error: (...a) => logs.push(a.join(' ')),
      info: (...a) => logs.push(a.join(' ')),
      warn: (...a) => logs.push(a.join(' ')),
      debug: (...a) => logs.push(a.join(' ')),
    },
    get: () => undefined,
    tools: {
      register: (def) => {
        tools.push(def);
        return () => {};
      },
    },
    commands: {
      register: (def) => {
        commands.push(def);
        return () => {};
      },
    },
    on: (event, fn) => {
      if (event === 'dispose') disposed.push(fn as () => void);
      return () => {};
    },
  };
  return { ctx, tools, commands, disposed, logs };
}

test('exports name and inject per the bundle contract', () => {
  assert.equal(name, 'db-connector');
  assert.deepEqual(inject, ['tools']);
});

test('bundle patch injects every service accessed during apply', () => {
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  const lines = patch.split(/\r?\n/);
  const rowStart = lines.findIndex((line) => line.trim() === '- id: db-connector');
  assert.notEqual(rowStart, -1);
  const configLine = lines.findIndex(
    (line, index) => index > rowStart && line.trim() === 'config:',
  );
  assert.ok(configLine > rowStart);
  const injectLine = lines
    .slice(rowStart, configLine)
    .find((line) => line.trim().startsWith('inject:'));
  assert.equal(injectLine?.trim(), 'inject: [tools, commands]');
});

test('apply registers five tools and the /db command', () => {
  const f = fakeContext();
  apply(f.ctx, {});
  assert.equal(f.tools.length, 5);
  assert.deepEqual(f.tools.map((t) => t.name), [
    'db_connect',
    'db_schema',
    'db_query',
    'db_exec',
    'db_audit',
  ]);
  assert.equal(f.commands.length, 1);
  assert.equal(f.commands[0]!.name, 'db');
});

test('apply pre-registers config connections lazily', async () => {
  const f = fakeContext();
  apply(f.ctx, {
    connections: {
      local: { driver: 'sqlite', database: ':memory:' },
    },
  });
  assert.equal(f.tools.length, 5);

  // open through the tool, then query
  const connect = f.tools[0]!;
  const execTool = f.tools[3]!;
  const queryTool = f.tools[2]!;
  const ex = { signal: new AbortController().signal, token: 't' };

  const made = (await connect.execute(
    { action: 'connect', name: 'local', config: { driver: 'sqlite', database: ':memory:' } },
    ex,
  )) as { status: { status: string } };
  assert.equal(made.status.status, 'connected');

  await execTool.execute(
    { name: 'local', sql: 'CREATE TABLE t(id INTEGER PRIMARY KEY)', allowWrite: true },
    ex,
  );
  const r = (await queryTool.execute(
    { name: 'local', sql: "SELECT name FROM sqlite_master WHERE type='table' AND name='t'" },
    ex,
  )) as { rowCount: number };
  assert.equal(r.rowCount, 1);

  // close the engine's workers so the test process can exit
  await f.disposed[0]!();
});

test('apply falls back to the environment for passwordRef', async () => {
  const envName = `DB_CONNECTOR_PASSWORD_REF_FALLBACK_${process.pid}`;
  const previous = process.env[envName];
  process.env[envName] = 'env-secret';
  try {
    const f = fakeContext();
    apply(f.ctx, {
      connections: {
        local: { driver: 'sqlite', database: ':memory:', passwordRef: envName },
      },
    });

    const connect = f.tools[0]!;
    const ex = { signal: new AbortController().signal, token: 't' };
    const made = (await connect.execute({ action: 'connect', name: 'local' }, ex)) as {
      status: { status: string };
    };

    assert.equal(made.status.status, 'connected');
    await f.disposed[0]!();
  } finally {
    if (previous === undefined) delete process.env[envName];
    else process.env[envName] = previous;
  }
});

test('apply teardown closes connections so later calls fail', async () => {
  const f = fakeContext();
  apply(f.ctx, {});
  const connect = f.tools[0]!;
  const queryTool = f.tools[2]!;
  const ex = { signal: new AbortController().signal, token: 't' };

  await connect.execute(
    { action: 'connect', name: 'm', config: { driver: 'sqlite', database: ':memory:' } },
    ex,
  );
  await queryTool.execute({ name: 'm', sql: 'SELECT 1' }, ex).then(() => {}, () => {});

  assert.equal(f.disposed.length, 1);
  await f.disposed[0]!();

  // after teardown the connection is gone
  await assert.rejects(queryTool.execute({ name: 'm', sql: 'SELECT 1' }, ex));
});

test('apply tolerates a missing commands service', () => {
  const f = fakeContext();
  const ctx = { ...f.ctx, commands: undefined };
  assert.doesNotThrow(() => apply(ctx, {}));
  assert.equal(f.commands.length, 0);
});
