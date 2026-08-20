/**
 * Configuration tests: env expansion, connection resolution, credentials
 * handling, and secret-safe summarization.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  applyCredentialPassword,
  expandEnv,
  normalizeConfig,
  resolveConnectionSpec,
  summarizeSpec,
} from '../dist/config.js';
import { DbConnectorError } from '../dist/errors.js';

const ENV = { DB_PASSWORD: 's3cret', DB_PORT: '5433' };

test('expandEnv substitutes ${VAR} and errors on missing variables', () => {
  assert.equal(expandEnv('host=${DB_HOST}', { DB_HOST: 'db.local' }), 'host=db.local');
  assert.equal(expandEnv('plain', {}) , 'plain');
  assert.equal(expandEnv(undefined, {}), undefined);
  assert.throws(
    () => expandEnv('${MISSING}', {}),
    (e) => (e as DbConnectorError).code === 'CONNECTION_FAILED',
  );
});

test('resolveConnectionSpec resolves sqlite defaults', () => {
  const spec = resolveConnectionSpec({ name: 'a', driver: 'sqlite' }, ENV);
  assert.equal(spec.driver, 'sqlite');
  assert.equal(spec.port, undefined);
  assert.equal(spec.host, undefined);
  assert.equal(spec.user, undefined);
});

test('resolveConnectionSpec requires database or connectionString for servers', () => {
  assert.throws(
    () => resolveConnectionSpec({ name: 'p', driver: 'postgres' }, ENV),
    (e) => (e as DbConnectorError).code === 'INVALID_ARGS',
  );
  const ok = resolveConnectionSpec(
    { name: 'p', driver: 'postgres', database: 'd', host: 'h', port: '${DB_PORT}', user: 'u' },
    ENV,
  );
  assert.equal(ok.port, 5433);
  assert.equal(ok.host, 'h');
});

test('resolveConnectionSpec validates ports and name characters', () => {
  assert.throws(
    () => resolveConnectionSpec({ name: 'p', driver: 'postgres', database: 'd', port: 99999 }, ENV),
    (e) => (e as DbConnectorError).code === 'INVALID_ARGS',
  );
  assert.throws(
    () => resolveConnectionSpec({ name: 'bad name!', driver: 'sqlite' }, ENV),
    (e) => (e as DbConnectorError).code === 'INVALID_ARGS',
  );
  assert.throws(
    () => resolveConnectionSpec({ name: 'x', driver: 'oracle' as never }, ENV),
    (e) => (e as DbConnectorError).code === 'UNSUPPORTED_DRIVER',
  );
});

test('sqlite ignores a port value while server drivers validate it', () => {
  // A leftover/copied port on a sqlite connection must not fail resolution.
  const local = resolveConnectionSpec({ name: 'a', driver: 'sqlite', port: 'not-a-number' }, ENV);
  assert.equal(local.port, undefined);
  // ...but server drivers still reject a garbage port loudly.
  assert.throws(
    () => resolveConnectionSpec({ name: 'p', driver: 'postgres', database: 'd', port: 'not-a-number' }, ENV),
    (e) => (e as DbConnectorError).code === 'INVALID_ARGS',
  );
});

test('password resolution: env above inline, ref applied later', () => {
  const spec = resolveConnectionSpec(
    { name: 'p', driver: 'postgres', database: 'd', password: 'inline', passwordEnv: 'DB_PASSWORD' },
    ENV,
  );
  assert.equal(spec.password, 's3cret');
  assert.equal(spec.passwordSource, 'env');

  const refSpec = resolveConnectionSpec(
    { name: 'p', driver: 'postgres', database: 'd', passwordRef: 'CRED' },
    ENV,
  );
  assert.equal(refSpec.password, '');
  const withCred = applyCredentialPassword(refSpec, () => 'from-cred') as typeof refSpec;
  assert.equal(withCred.password, 'from-cred');
  assert.equal(withCred.passwordSource, 'credentials');
});

test('applyCredentialPassword errors on empty resolved value', async () => {
  const refSpec = resolveConnectionSpec(
    { name: 'p', driver: 'postgres', database: 'd', passwordRef: 'CRED' },
    ENV,
  );
  await assert.rejects(
    async () => applyCredentialPassword(refSpec, () => ''),
    (e) => (e as DbConnectorError).code === 'CONNECTION_FAILED',
  );
});

test('passwordEnv missing variable is a loud failure', () => {
  assert.throws(
    () =>
      resolveConnectionSpec(
        { name: 'p', driver: 'postgres', database: 'd', passwordEnv: 'NOT_SET' },
        {},
      ),
    (e) => (e as DbConnectorError).code === 'CONNECTION_FAILED',
  );
});

test('summarizeSpec never reveals the password', () => {
  const spec = resolveConnectionSpec(
    { name: 'p', driver: 'postgres', database: 'd', host: 'h', password: 'hunter2', passwordEnv: 'DB_PASSWORD' },
    ENV,
  );
  const s = summarizeSpec(spec);
  assert.ok(!s.includes('hunter2'));
  assert.ok(!s.includes('s3cret'));
  assert.ok(s.includes('password via env'));
});

test('normalizeConfig defaults and env overrides', () => {
  const cfg = normalizeConfig({}, {});
  assert.equal(cfg.query.maxRows, 1000);
  assert.equal(cfg.query.timeoutMs, 30000);
  assert.equal(cfg.audit.enabled, true);
  assert.equal(cfg.defaultAllowWrite, false);

  const overridden = normalizeConfig({}, { DSH_DB_CONNECTOR_MAX_ROWS: '5' });
  assert.equal(overridden.query.maxRows, 5);

  const fromInput = normalizeConfig(
    { query: { maxRows: 21, timeoutMs: 7 }, audit: { enabled: false }, defaultAllowWrite: true },
    {},
  );
  assert.equal(fromInput.query.maxRows, 21);
  assert.equal(fromInput.query.timeoutMs, 7);
  assert.equal(fromInput.audit.enabled, false);
  assert.equal(fromInput.defaultAllowWrite, true);
});

test('normalizeConfig keeps pre-registered connections', () => {
  const cfg = normalizeConfig(
    { connections: { local: { driver: 'sqlite', database: './x.db' } } },
    {},
  );
  const local = cfg.connections.local!;
  assert.equal(local.driver, 'sqlite');
  assert.equal(local.name, 'local');
});
