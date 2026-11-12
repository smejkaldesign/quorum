import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { betaDecision, cleanCheck, handleBetaCheck, handleBetaHeartbeat } from '../beta.js';

const now = Date.parse('2026-11-12T00:00:00Z');
const row = (over = {}) => ({ id: 'c1', email: 'x@example.com', plan: 'free', expires_at: '2026-12-12T00:00:00Z', revoked_at: null, redeemed_at: null, ...over });

describe('the beta check request', () => {
  it('normalizes the code, bounds the ids and keeps a real email only', () => {
    const c = cleanCheck({ code: 'k7pq-2mx9', machineId: ' mac-1 ', edition: 'Local', version: '0.2.9', email: 'X@Example.com' });
    assert.deepEqual(c, { code: 'K7PQ2MX9', machineId: 'mac-1', edition: 'local', version: '0.2.9', email: 'x@example.com' });
    assert.equal(cleanCheck({ code: 'K7PQ2MX9', machineId: 'm', edition: 'cloud', email: 'nope' }).email, null);
  });
  it('refuses a bad code, a missing machine id or an unknown edition', () => {
    assert.throws(() => cleanCheck({ code: 'short', machineId: 'm', edition: 'local' }), /not an access code/);
    assert.throws(() => cleanCheck({ code: 'K7PQ2MX9', machineId: '', edition: 'local' }), /machine id/);
    assert.throws(() => cleanCheck({ code: 'K7PQ2MX9', machineId: 'm', edition: 'web' }), /local or cloud/);
  });
});

describe('the beta decision', () => {
  it('admits a live code and names its plan', () => {
    assert.deepEqual(betaDecision({ row: row(), installs: [], machineId: 'mac-1', edition: 'local', now }), { ok: true, plan: 'free' });
    assert.deepEqual(betaDecision({ row: row({ plan: 'cloud' }), installs: [], machineId: 'mac-1', edition: 'cloud', now }), { ok: true, plan: 'cloud' });
  });
  it('refuses an unknown, revoked or expired code, and a code issued to another email', () => {
    assert.equal(betaDecision({ row: null, machineId: 'm', edition: 'local', now }).reason, 'unknown');
    assert.equal(betaDecision({ row: row({ revoked_at: '2026-11-01T00:00:00Z' }), machineId: 'm', edition: 'local', now }).reason, 'revoked');
    assert.equal(betaDecision({ row: row({ expires_at: '2026-11-11T00:00:00Z' }), machineId: 'm', edition: 'local', now }).reason, 'expired');
    assert.equal(betaDecision({ row: row(), machineId: 'm', edition: 'local', email: 'other@example.com', now }).reason, 'email');
  });
  it('a free code is good for one Mac; the same Mac again is fine; a cloud code follows the account to a second Mac', () => {
    const taken = [{ machine_id: 'mac-1', edition: 'local' }];
    assert.equal(betaDecision({ row: row(), installs: taken, machineId: 'mac-2', edition: 'local', now }).reason, 'used');
    assert.equal(betaDecision({ row: row(), installs: taken, machineId: 'mac-1', edition: 'local', now }).ok, true);
    assert.equal(betaDecision({ row: row({ plan: 'cloud' }), installs: taken, machineId: 'mac-2', edition: 'cloud', now }).ok, true);
  });
});

// a request and response the handlers can read and write, and a store that remembers what it was asked
function call(handler, body, deps) {
  const req = new PassThrough();
  req.method = 'POST'; req.headers = { 'content-type': 'application/json', 'x-forwarded-for': `10.0.0.${Math.floor(Math.random() * 250)}` }; req.socket = {};
  req.end(JSON.stringify(body));
  const out = { status: 0, body: '' };
  const res = { writeHead: (s) => { out.status = s; }, end: (b) => { out.body = String(b ?? ''); } };
  return handler(req, res, deps).then(() => ({ status: out.status, body: JSON.parse(out.body || '{}') }));
}
function fakeStore(codeRow, installs = []) {
  const calls = { upserts: [], touches: [] };
  return {
    calls,
    code: async (code) => (codeRow && code === 'K7PQ2MX9' ? codeRow : null),
    installs: async () => installs,
    upsert: async (i) => { calls.upserts.push(i); },
    touch: async (t) => { calls.touches.push(t); return installs.some((i) => i.machine_id === t.machineId); },
  };
}
const deps = (store) => ({ clients: { db: null }, config: { corsOrigins: [] }, store });

describe('POST /v1/beta/check', () => {
  it('records the install and answers the plan', async () => {
    const store = fakeStore(row({ plan: 'cloud' }));
    const r = await call(handleBetaCheck, { code: 'K7PQ-2MX9', machineId: 'mac-1', edition: 'cloud', version: '0.2.9', email: 'x@example.com' }, deps(store));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, plan: 'cloud' });
    assert.deepEqual(store.calls.upserts, [{ codeId: 'c1', email: 'x@example.com', machineId: 'mac-1', edition: 'cloud', version: '0.2.9' }]);
  });
  it('answers ok false with a reason and writes nothing when the code is refused', async () => {
    const store = fakeStore(row(), [{ machine_id: 'mac-1', edition: 'local' }]);
    const r = await call(handleBetaCheck, { code: 'K7PQ2MX9', machineId: 'mac-2', edition: 'local' }, deps(store));
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.reason, 'used');
    assert.equal(store.calls.upserts.length, 0);
    const unknown = await call(handleBetaCheck, { code: 'ZZZZ2222', machineId: 'mac-2', edition: 'local' }, deps(store));
    assert.equal(unknown.body.reason, 'unknown');
  });
  it('a malformed body is a 400 with ok false', async () => {
    const r = await call(handleBetaCheck, { code: 'nope', machineId: 'mac-2', edition: 'local' }, deps(fakeStore(null)));
    assert.equal(r.status, 400);
    assert.equal(r.body.ok, false);
  });
});

describe('POST /v1/beta/heartbeat', () => {
  it('touches a known install and says so; an unknown one answers ok false', async () => {
    const store = fakeStore(row(), [{ machine_id: 'mac-1', edition: 'local' }]);
    const seen = await call(handleBetaHeartbeat, { code: 'K7PQ2MX9', machineId: 'mac-1', version: '0.3.0' }, deps(store));
    assert.deepEqual(seen.body, { ok: true });
    assert.deepEqual(store.calls.touches, [{ codeId: 'c1', machineId: 'mac-1', version: '0.3.0' }]);
    const unknown = await call(handleBetaHeartbeat, { code: 'K7PQ2MX9', machineId: 'mac-9' }, deps(store));
    assert.deepEqual(unknown.body, { ok: false });
  });
});
