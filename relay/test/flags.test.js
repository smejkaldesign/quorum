import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFlagsCache, flagsRoute, shapeFlags } from '../flags.js';

const anonWith = (rows, { fail = false } = {}) => { let calls = 0; return { calls: () => calls, rpc: async () => { calls++; return fail ? { data: null, error: new Error('down') } : { data: rows, error: null }; } }; };
const fakeRes = () => { const r = { status: 0, headers: {}, body: '' }; r.writeHead = (s, h) => { r.status = s; r.headers = h; }; r.end = (b) => { r.body = b ?? ''; }; return r; };

describe('shaping the rows', () => {
  it('keeps key and enabled only and skips malformed rows', () => {
    assert.deepEqual(shapeFlags([{ key: 'a', enabled: true, name: 'x' }, { key: 'b', enabled: 'yes' }, null, { enabled: true }]), { a: true, b: false });
    assert.deepEqual(shapeFlags(undefined), {});
  });
});

describe('the cache', () => {
  it('asks the project once a minute and answers from memory between', async () => {
    let t = 1000;
    const anon = anonWith([{ key: 'a', enabled: true }]);
    const cache = createFlagsCache({ anon, now: () => t });
    assert.deepEqual(await cache.get(), { a: true });
    t += 30_000;
    await cache.get();
    assert.equal(anon.calls(), 1);
    t += 31_000;
    await cache.get();
    assert.equal(anon.calls(), 2);
  });

  it('answers the empty set when the project fails before any answer, and the stale answer afterwards', async () => {
    const logged = [];
    const bad = createFlagsCache({ anon: anonWith([], { fail: true }), log: (e) => logged.push(e) });
    assert.deepEqual(await bad.get(), {});
    assert.equal(logged[0], 'flags_failed');
    let t = 0; let fail = false;
    const anon = { rpc: async () => (fail ? { data: null, error: new Error('down') } : { data: [{ key: 'a', enabled: false }], error: null }) };
    const cache = createFlagsCache({ anon, now: () => t });
    assert.deepEqual(await cache.get(), { a: false });
    fail = true; t += 120_000;
    assert.deepEqual(await cache.get(), { a: false });
  });
});

describe('the route', () => {
  it('answers GET with open CORS and refuses other methods', async () => {
    const handle = flagsRoute({ clients: { anon: anonWith([{ key: 'manual-listen', enabled: true }]) } });
    const res = fakeRes();
    await handle({ method: 'GET', headers: {} }, res);
    assert.equal(res.status, 200);
    assert.equal(res.headers['access-control-allow-origin'], '*');
    assert.deepEqual(JSON.parse(res.body), { flags: { 'manual-listen': true } });
    const pre = fakeRes();
    await handle({ method: 'OPTIONS', headers: {} }, pre);
    assert.equal(pre.status, 204);
    const post = fakeRes();
    await handle({ method: 'POST', headers: {} }, post);
    assert.equal(post.status, 405);
  });
});
