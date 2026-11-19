import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { cleanReport, createErrorPurge, errorsRoute, hashInstall, LIMITS, MAX_ERROR_BODY, reporterWorkspace, storedReport } from '../errors.js';
import { createLimiter } from '../platform.js';
import { fakeAnon } from './helpers.js';

const INSTALL = '3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b';
const FP = 'ab'.repeat(32);
const now = Date.parse('2026-11-19T12:00:00Z');
const report = (over = {}) => ({ install: INSTALL, edition: 'local', version: '0.4.2', os: 'macOS 26.4 arm64', view: 'settings/connectors', kind: 'render', repeat: false, message: 'Cannot read properties of undefined', stack: 'src/ConnectorsPage.tsx:120:14', componentStack: 'at ConnectorsPage', fingerprint: FP, at: '2026-11-19T11:59:00Z', ...over });

describe('the report shape', () => {
  it('keeps the contract fields, lowercases the ids and drops anything else', () => {
    const r = cleanReport(report({ install: INSTALL.toUpperCase(), fingerprint: FP.toUpperCase(), email: 'x@example.com', path: '/Users/x' }), now);
    assert.deepEqual(Object.keys(r).sort(), ['at', 'componentStack', 'edition', 'fingerprint', 'install', 'kind', 'message', 'os', 'repeat', 'stack', 'version', 'view']);
    assert.equal(r.install, INSTALL);
    assert.equal(r.fingerprint, FP);
    assert.equal(r.at, '2026-11-19T11:59:00.000Z');
  });
  it('clamps every string to its limit and reads a time ahead of the relay as now', () => {
    const r = cleanReport(report({ message: 'm'.repeat(900), stack: 's'.repeat(9000), componentStack: 'c'.repeat(5000), view: 'v'.repeat(300), at: '2027-01-01T00:00:00Z' }), now);
    assert.equal(r.message.length, LIMITS.message);
    assert.equal(r.stack.length, LIMITS.stack);
    assert.equal(r.componentStack.length, LIMITS.componentStack);
    assert.equal(r.view.length, LIMITS.view);
    assert.equal(r.at, new Date(now).toISOString());
  });
  it('fills missing optional strings with empty ones and repeat with false', () => {
    const r = cleanReport({ install: INSTALL, edition: 'cloud', kind: 'render', fingerprint: FP, at: '2026-11-19T11:00:00Z' }, now);
    assert.deepEqual([r.version, r.os, r.view, r.message, r.stack, r.componentStack, r.repeat], ['', '', '', '', '', '', false]);
  });
  it('refuses a bad shape', () => {
    assert.throws(() => cleanReport(null), /JSON object/);
    assert.throws(() => cleanReport([]), /JSON object/);
    assert.throws(() => cleanReport(report({ install: 'mac-1' })), /UUID v4/);
    assert.throws(() => cleanReport(report({ install: '3f2b8c1e-9a4d-1e6f-8b2a-1c3d5e7f9a0b' })), /UUID v4/);
    assert.throws(() => cleanReport(report({ edition: 'web' })), /local or cloud/);
    assert.throws(() => cleanReport(report({ kind: 'crash' })), /kind/);
    assert.throws(() => cleanReport(report({ fingerprint: 'abc' })), /64 hex/);
    assert.throws(() => cleanReport(report({ repeat: 'yes' })), /repeat/);
    assert.throws(() => cleanReport(report({ at: 'yesterday' })), /ISO time/);
    assert.throws(() => cleanReport(report({ message: { text: 'x' } })), /message must be a string/);
  });
});

describe('the install hash', () => {
  it('is stable for one salt, differs across salts, and is never the install id', () => {
    const a = hashInstall('salt-one', INSTALL);
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.equal(a, hashInstall('salt-one', INSTALL));
    assert.notEqual(a, hashInstall('salt-two', INSTALL));
    assert.ok(!a.includes(INSTALL.replace(/-/g, '')));
  });
  it('the stored row carries the hash and no install id', () => {
    const row = storedReport(cleanReport(report(), now), 'h'.repeat(64), null);
    assert.equal(row.install_hash, 'h'.repeat(64));
    assert.ok(!JSON.stringify(row).includes(INSTALL));
    assert.equal(row.component_stack, 'at ConnectorsPage');
  });
});

describe('the workspace behind a token', () => {
  const db = (rows) => {
    const q = { filters: {}, select() { return q; }, eq(k, v) { q.filters[k] = v; return q; }, is() { return q; }, order() { return q; }, limit() { return q; }, maybeSingle: async () => ({ data: rows.find((r) => r.user_id === q.filters.user_id) ?? null, error: null }) };
    return { from: () => q };
  };
  it('is the member workspace for a live token and null otherwise', async () => {
    const clients = { anon: fakeAnon({ good: { id: 'u1' } }), db: db([{ user_id: 'u1', workspace_id: '01J0000000000000000000000A' }]) };
    assert.equal(await reporterWorkspace(clients, 'good'), '01J0000000000000000000000A');
    assert.equal(await reporterWorkspace(clients, 'stale'), null);
    assert.equal(await reporterWorkspace(clients, null), null);
    assert.equal(await reporterWorkspace({ anon: fakeAnon({ good: { id: 'u2' } }), db: clients.db }, 'good'), null);
  });
});

let addr = 0;
function call(handler, body, { headers = {}, raw, method = 'POST', ip } = {}) {
  const req = new PassThrough();
  req.method = method; req.headers = { 'content-type': 'application/json', 'x-real-ip': ip ?? `10.1.${Math.floor(addr / 250)}.${addr++ % 250}`, ...headers }; req.socket = {};
  req.end(raw ?? JSON.stringify(body));
  const out = { status: 0, body: '' };
  const res = { writeHead: (s) => { out.status = s; }, end: (b) => { out.body = String(b ?? ''); } };
  return handler(req, res).then(() => ({ status: out.status, body: JSON.parse(out.body || '{}') }));
}
function setup({ salt = 'test-salt', fail = false, anon = fakeAnon(), db = null } = {}) {
  const rows = []; const logs = [];
  const store = { record: async (row) => { if (fail) { const { RelayError } = await import('../lib/auth.js'); throw new RelayError('server', 'The report could not be stored.', 500); } rows.push(row); return { reopened: false }; } };
  const handler = errorsRoute({ clients: { anon, db }, config: { errors: { salt } }, store, now: () => now, log: (event, fields) => logs.push({ event, ...fields }), installLimit: createLimiter({ max: 30, now: () => now }), addressLimit: createLimiter({ max: 120, now: () => now }) });
  return { handler, rows, logs };
}

describe('POST /v1/errors', () => {
  it('answers 202 and stores the hashed report', async () => {
    const { handler, rows, logs } = setup();
    const r = await call(handler, report());
    assert.deepEqual(r, { status: 202, body: { ok: true } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].install_hash, hashInstall('test-salt', INSTALL));
    assert.equal(rows[0].workspace_id, null);
    assert.ok(!JSON.stringify(rows).includes(INSTALL));
    assert.ok(!JSON.stringify(logs).includes(INSTALL));
  });
  it('without the salt answers 202, stores nothing and warns once', async () => {
    const { handler, rows, logs } = setup({ salt: '' });
    assert.equal((await call(handler, report())).status, 202);
    assert.equal((await call(handler, report())).status, 202);
    assert.equal(rows.length, 0);
    assert.equal(logs.filter((l) => l.event === 'errors_no_salt').length, 1);
  });
  it('records the workspace for a signed-in app and still stores the report for a bad token', async () => {
    const db = { from: () => { const q = { select: () => q, eq: () => q, is: () => q, order: () => q, limit: () => q, maybeSingle: async () => ({ data: { workspace_id: '01J0000000000000000000000A' }, error: null }) }; return q; } };
    const { handler, rows } = setup({ anon: fakeAnon({ tok: { id: 'u1' } }), db });
    await call(handler, report(), { headers: { authorization: 'Bearer tok' } });
    await call(handler, report(), { headers: { authorization: 'Bearer expired' } });
    assert.deepEqual(rows.map((r) => r.workspace_id), ['01J0000000000000000000000A', null]);
  });
  it('answers 400 for a bad shape, 413 for a body over 32 KB, 405 for another method', async () => {
    const { handler, rows } = setup();
    assert.equal((await call(handler, report({ edition: 'web' }))).status, 400);
    assert.equal((await call(handler, null, { raw: 'not json' })).status, 400);
    assert.equal((await call(handler, null, { raw: JSON.stringify(report({ stack: 'x'.repeat(MAX_ERROR_BODY) })) })).status, 413);
    assert.equal((await call(handler, null, { method: 'GET', raw: '' })).status, 405);
    assert.equal(rows.length, 0);
  });
  it('limits one install to 30 an hour and one address to 120', async () => {
    const { handler, rows } = setup();
    for (let i = 0; i < 30; i++) assert.equal((await call(handler, report())).status, 202);
    assert.equal((await call(handler, report())).status, 429);
    const other = setup();
    const installs = Array.from({ length: 121 }, (_, i) => `3f2b8c1e-9a4d-4e6f-8b2a-${String(i).padStart(12, '0')}`);
    for (let i = 0; i < 120; i++) assert.equal((await call(other.handler, report({ install: installs[i] }), { ip: '10.9.9.9' })).status, 202);
    assert.equal((await call(other.handler, report({ install: installs[120] }), { ip: '10.9.9.9' })).status, 429);
    assert.equal(rows.length, 30);
  });
  it('answers 500 when the store fails', async () => {
    const { handler } = setup({ fail: true });
    const r = await call(handler, report());
    assert.equal(r.status, 500);
    assert.equal(r.body.ok, false);
  });
});

describe('the hourly purge', () => {
  it('calls the purge function and logs what it removed', async () => {
    const logs = [];
    const calls = [];
    const db = { rpc: async (name) => { calls.push(name); return { data: { events: 3, groups: 1, cleared: 2 }, error: null }; } };
    const p = createErrorPurge({ db, log: (event, fields) => logs.push({ event, ...fields }) });
    assert.deepEqual(await p.run(), { events: 3, groups: 1, cleared: 2 });
    assert.deepEqual(calls, ['error_reports_purge']);
    assert.deepEqual(logs, [{ event: 'errors_purged', events: 3, groups: 1, cleared: 2 }]);
  });
  it('stays quiet when nothing was removed and logs a failure without throwing', async () => {
    const logs = [];
    const quiet = createErrorPurge({ db: { rpc: async () => ({ data: { events: 0, groups: 0, cleared: 0 }, error: null }) }, log: (e) => logs.push(e) });
    await quiet.run();
    assert.deepEqual(logs, []);
    const broken = createErrorPurge({ db: { rpc: async () => ({ data: null, error: { message: 'function does not exist' } }) }, log: (e, f) => logs.push({ e, ...f }) });
    assert.equal(await broken.run(), null);
    assert.deepEqual(logs, [{ e: 'errors_purge_failed', message: 'function does not exist' }]);
  });
  it('runs on start and stops cleanly', async () => {
    let n = 0;
    const p = createErrorPurge({ db: { rpc: async () => { n++; return { data: {}, error: null }; } }, everyMs: 60000 });
    p.start(); p.start(); p.stop();
    await new Promise((r) => setImmediate(r));
    assert.equal(n, 1);
  });
});
