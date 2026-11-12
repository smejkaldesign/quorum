import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { betaDecision, cleanCheck, cleanHeartbeat, handleBetaCheck, handleBetaHeartbeat, heartbeatDecision } from '../beta.js';

const now = Date.parse('2026-11-12T00:00:00Z');
const row = (over = {}) => ({ id: 'c1', email: 'x@example.com', plan: 'free', expires_at: '2026-12-12T00:00:00Z', revoked_at: null, redeemed_at: null, redeemed_machine_id: null, ...over });
const expired = { expires_at: '2026-11-11T00:00:00Z' };

describe('the beta requests', () => {
  it('normalizes the code, bounds the ids and keeps a real email only', () => {
    const c = cleanCheck({ code: 'k7pq-2mx9', machineId: ' mac-1 ', edition: 'Local', version: '0.2.9', email: 'X@Example.com' });
    assert.deepEqual(c, { code: 'K7PQ2MX9', machineId: 'mac-1', edition: 'local', version: '0.2.9', email: 'x@example.com' });
    assert.equal(cleanCheck({ code: 'K7PQ2MX9', machineId: 'm', edition: 'cloud', email: 'nope' }).email, null);
    assert.deepEqual(cleanHeartbeat({ code: 'k7pq 2mx9', machineId: 'mac-1 ', version: '' }), { code: 'K7PQ2MX9', machineId: 'mac-1', version: null });
  });
  it('refuses a bad code, a missing machine id or an unknown edition', () => {
    assert.throws(() => cleanCheck({ code: 'short', machineId: 'm', edition: 'local' }), /not an access code/);
    assert.throws(() => cleanCheck({ code: 'K7PQ2MX9', machineId: '', edition: 'local' }), /machine id/);
    assert.throws(() => cleanCheck({ code: 'K7PQ2MX9', machineId: 'm', edition: 'web' }), /local or cloud/);
    assert.throws(() => cleanHeartbeat({ code: 'K7PQ2MX9' }), /machine id/);
  });
});

describe('the check decision', () => {
  it('admits a live free code on its first Mac and asks to bind it; the same Mac again is admitted without a new bind', () => {
    assert.deepEqual(betaDecision({ row: row(), installs: [], machineId: 'mac-1', edition: 'local', now }), { ok: true, plan: 'free', bind: true });
    assert.deepEqual(betaDecision({ row: row({ redeemed_machine_id: 'mac-1', redeemed_at: '2026-11-10T00:00:00Z' }), installs: [], machineId: 'mac-1', edition: 'local', now }), { ok: true, plan: 'free', bind: false });
  });
  it('a free code bound to one Mac refuses another, and expiry no longer counts for the bound Mac', () => {
    const bound = row({ redeemed_machine_id: 'mac-1', redeemed_at: '2026-11-10T00:00:00Z', ...expired });
    assert.equal(betaDecision({ row: bound, installs: [], machineId: 'mac-2', edition: 'local', now }).reason, 'expired');
    assert.equal(betaDecision({ row: row({ redeemed_machine_id: 'mac-1', redeemed_at: '2026-11-10T00:00:00Z' }), installs: [], machineId: 'mac-2', edition: 'local', now }).reason, 'used');
    assert.equal(betaDecision({ row: bound, installs: [], machineId: 'mac-1', edition: 'local', now }).ok, true);
    assert.equal(betaDecision({ row: row(expired), installs: [{ machine_id: 'mac-1', edition: 'local' }], machineId: 'mac-1', edition: 'local', now }).ok, true);
  });
  it('a cloud check needs the email the code was issued to, and then follows the account to any Mac', () => {
    const cloud = row({ plan: 'cloud' });
    assert.equal(betaDecision({ row: cloud, installs: [], machineId: 'mac-1', edition: 'cloud', now }).reason, 'email');
    assert.equal(betaDecision({ row: cloud, installs: [], machineId: 'mac-1', edition: 'cloud', email: 'other@example.com', now }).reason, 'email');
    assert.deepEqual(betaDecision({ row: cloud, installs: [{ machine_id: 'mac-1', edition: 'cloud' }], machineId: 'mac-2', edition: 'cloud', email: 'x@example.com', now }), { ok: true, plan: 'cloud', bind: false });
  });
  it('refuses an unknown, revoked or expired code', () => {
    assert.equal(betaDecision({ row: null, machineId: 'm', edition: 'local', now }).reason, 'unknown');
    assert.equal(betaDecision({ row: row({ revoked_at: '2026-11-01T00:00:00Z', redeemed_machine_id: 'm' }), machineId: 'm', edition: 'local', now }).reason, 'revoked');
    assert.equal(betaDecision({ row: row(expired), machineId: 'm', edition: 'local', now }).reason, 'expired');
  });
});

describe('the heartbeat decision', () => {
  it('touches only a Mac the code is bound to, refuses a revoked code, and keeps a bound Mac past expiry', () => {
    const installs = [{ machine_id: 'mac-1', edition: 'local' }];
    assert.deepEqual(heartbeatDecision({ row: row(), installs, machineId: 'mac-1', now }), { ok: true });
    assert.equal(heartbeatDecision({ row: row(), installs, machineId: 'mac-9', now }).reason, 'unknown');
    assert.equal(heartbeatDecision({ row: row({ revoked_at: '2026-11-01T00:00:00Z' }), installs, machineId: 'mac-1', now }).reason, 'revoked');
    assert.equal(heartbeatDecision({ row: row(expired), installs, machineId: 'mac-1', now }).ok, true);
    assert.equal(heartbeatDecision({ row: null, installs, machineId: 'mac-1', now }).reason, 'unknown');
  });
});

// a request and response the handlers can read and write, and a store that remembers what it was asked
let addr = 0;
function call(handler, body, deps) {
  const req = new PassThrough();
  req.method = 'POST'; req.headers = { 'content-type': 'application/json', 'x-forwarded-for': `10.0.${Math.floor(addr / 250)}.${addr++ % 250}` }; req.socket = {};
  req.end(JSON.stringify(body));
  const out = { status: 0, body: '' };
  const res = { writeHead: (s) => { out.status = s; }, end: (b) => { out.body = String(b ?? ''); } };
  return handler(req, res, deps).then(() => ({ status: out.status, body: JSON.parse(out.body || '{}') }));
}
function fakeStore(codeRow, installs = []) {
  const calls = { upserts: [], touches: [], redeems: [] };
  return {
    calls,
    code: async (code) => (codeRow && code === 'K7PQ2MX9' ? codeRow : null),
    installs: async () => installs,
    upsert: async (i) => { calls.upserts.push(i); },
    redeemLocal: async (r) => { calls.redeems.push(r); },
    touch: async (t) => { calls.touches.push(t); return installs.some((i) => i.machine_id === t.machineId); },
  };
}
const deps = (store) => ({ clients: { db: null }, config: { corsOrigins: [] }, store });

describe('POST /v1/beta/check', () => {
  it('records a cloud install and answers the plan without binding the code', async () => {
    const store = fakeStore(row({ plan: 'cloud' }));
    const r = await call(handleBetaCheck, { code: 'K7PQ-2MX9', machineId: 'mac-1', edition: 'cloud', version: '0.2.9', email: 'x@example.com' }, deps(store));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, plan: 'cloud' });
    assert.deepEqual(store.calls.upserts, [{ codeId: 'c1', email: 'x@example.com', machineId: 'mac-1', edition: 'cloud', version: '0.2.9' }]);
    assert.equal(store.calls.redeems.length, 0);
  });
  it('a free code on its first Mac is recorded and redeemed for that Mac', async () => {
    const store = fakeStore(row());
    const r = await call(handleBetaCheck, { code: 'K7PQ2MX9', machineId: 'mac-1', edition: 'local', version: '0.2.9' }, deps(store));
    assert.deepEqual(r.body, { ok: true, plan: 'free' });
    assert.deepEqual(store.calls.redeems, [{ codeId: 'c1', machineId: 'mac-1' }]);
  });
  it('answers ok false with a reason and writes nothing when the code is refused', async () => {
    const store = fakeStore(row({ redeemed_machine_id: 'mac-1', redeemed_at: '2026-11-10T00:00:00Z' }), [{ machine_id: 'mac-1', edition: 'local' }]);
    const r = await call(handleBetaCheck, { code: 'K7PQ2MX9', machineId: 'mac-2', edition: 'local' }, deps(store));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: false, reason: 'used', error: 'That access code is already in use on another Mac.' });
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
  it('touches a known install and says so; an unknown Mac or a revoked code answers ok false with a reason and no touch', async () => {
    const store = fakeStore(row(), [{ machine_id: 'mac-1', edition: 'local' }]);
    const seen = await call(handleBetaHeartbeat, { code: 'K7PQ2MX9', machineId: 'mac-1', version: '0.3.0' }, deps(store));
    assert.deepEqual(seen.body, { ok: true });
    assert.deepEqual(store.calls.touches, [{ codeId: 'c1', machineId: 'mac-1', version: '0.3.0' }]);
    const unknown = await call(handleBetaHeartbeat, { code: 'K7PQ2MX9', machineId: 'mac-9' }, deps(store));
    assert.deepEqual(unknown.body, { ok: false, reason: 'unknown' });
    const revoked = fakeStore(row({ revoked_at: '2026-11-01T00:00:00Z' }), [{ machine_id: 'mac-1', edition: 'local' }]);
    const r = await call(handleBetaHeartbeat, { code: 'K7PQ2MX9', machineId: 'mac-1' }, deps(revoked));
    assert.deepEqual(r.body, { ok: false, reason: 'revoked' });
    assert.equal(revoked.calls.touches.length, 0);
  });
});
