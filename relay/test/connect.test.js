import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { handleAccount, handleCallback, handleConnect, handleEvents, handleToken, handleZoomWebhook, loopbackFor, tokenShape, verifyZoomSignature, zoomValidation } from '../connect.js';
import { baseTables, fakeAnon, fakeDb, TOKEN, USER, WS } from './helpers.js';

const SECRET = 'zoom-hook-secret';
const config = (over = {}) => ({ connect: { zoom: { clientId: 'cid', clientSecret: 'csecret', webhookSecret: SECRET } }, ...over });
const anon = fakeAnon({ [TOKEN]: { id: USER, email: 'me@example.com' } });

function fakeReq({ method = 'GET', url = '/', body = '', headers = {} } = {}) {
  const listeners = {};
  const req = { method, headers, url, on: (ev, fn) => { listeners[ev] = fn; return req; }, destroy() {} };
  setTimeout(() => { if (body) listeners.data?.(Buffer.from(body)); listeners.end?.(); }, 0);
  return req;
}
function fakeRes() {
  const res = { status: 0, headers: {}, body: '', writeHead(s, h) { this.status = s; this.headers = h ?? {}; }, end(b) { this.body = String(b ?? ''); this.done?.(); } };
  res.finished = new Promise((r) => { res.done = r; });
  return res;
}
const out = (res) => (res.body ? JSON.parse(res.body) : null);
const signed = (body, { ts = Math.floor(Date.now() / 1000), secret = SECRET } = {}) => ({ 'x-zm-request-timestamp': String(ts), 'x-zm-signature': `v0=${createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}` });
const deps = (over = {}) => ({ clients: { anon, db: fakeDb({ tables: baseTables() }) }, config: config(), log: () => {}, ...over });

describe('callback bounce', () => {
  it('sends the browser to the app loopback with code and state, on the default port', () => {
    const res = fakeRes();
    handleCallback({ method: 'GET', url: '/v1/connect/zoom/callback?code=abc&state=xyz' }, res, {});
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, 'http://127.0.0.1:47832/callback?code=abc&state=xyz');
  });
  it('honours a port in the state and forwards errors', () => {
    assert.equal(loopbackFor('nonce.p49152'), 49152);
    assert.equal(loopbackFor('nonce.p80'), 47832);
    assert.equal(loopbackFor('nonce.p99999'), 47832);
    assert.equal(loopbackFor(null), 47832);
    const res = fakeRes();
    handleCallback({ method: 'GET', url: '/v1/connect/zoom/callback?error=access_denied&error_description=User%20said%20no&state=n.p49152' }, res, {});
    assert.equal(res.headers.location, 'http://127.0.0.1:49152/callback?state=n.p49152&error=access_denied&error_description=User+said+no');
  });
  it('knows only the platforms it serves', () => {
    const res = fakeRes();
    handleCallback({ method: 'GET', url: '/v1/connect/webex/callback?code=1' }, res, {});
    assert.equal(res.status, 404);
  });
});

describe('token exchange', () => {
  it('trades the code for tokens with the client secret, for a paying member', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 'user:read:user' }) }; };
    const res = fakeRes();
    await handleToken(fakeReq({ method: 'POST', url: '/v1/connect/zoom/token', headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ workspaceId: WS, grant: 'code', code: 'c1', codeVerifier: 'v1', redirectUri: 'https://relay.quorum.watch/v1/connect/zoom/callback' }) }), res, deps({ fetchImpl }));
    assert.equal(res.status, 200, res.body);
    const t = out(res);
    assert.equal(t.accessToken, 'at');
    assert.equal(t.refreshToken, 'rt');
    assert.ok(t.expiresAt > Date.now());
    assert.equal(calls[0].url, 'https://zoom.us/oauth/token');
    assert.equal(calls[0].init.headers.authorization, `Basic ${Buffer.from('cid:csecret').toString('base64')}`);
    const form = new URLSearchParams(calls[0].init.body);
    assert.equal(form.get('grant_type'), 'authorization_code');
    assert.equal(form.get('code_verifier'), 'v1');
    assert.equal(form.get('redirect_uri'), 'https://relay.quorum.watch/v1/connect/zoom/callback');
  });
  it('refreshes with the refresh token', async () => {
    let form;
    const fetchImpl = async (_u, init) => { form = new URLSearchParams(init.body); return { ok: true, status: 200, json: async () => ({ access_token: 'at2', refresh_token: 'rt2', expires_in: 3600 }) }; };
    const res = fakeRes();
    await handleToken(fakeReq({ method: 'POST', url: '/v1/connect/zoom/token', headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ workspaceId: WS, grant: 'refresh', refreshToken: 'rt' }) }), res, deps({ fetchImpl }));
    assert.equal(res.status, 200, res.body);
    assert.equal(form.get('grant_type'), 'refresh_token');
    assert.equal(form.get('refresh_token'), 'rt');
  });
  it('refuses without a session, on the free plan, and when the relay has no Zoom credentials', async () => {
    const r1 = fakeRes();
    await handleToken(fakeReq({ method: 'POST', url: '/v1/connect/zoom/token', body: JSON.stringify({ workspaceId: WS, grant: 'refresh', refreshToken: 'rt' }) }), r1, deps());
    assert.equal(r1.status, 401);
    const free = fakeDb({ tables: { ...baseTables(), workspaces: [{ id: WS, seats: 1, hour_packs: 0, plan: 'free', deleted_at: null }] } });
    const r2 = fakeRes();
    await handleToken(fakeReq({ method: 'POST', url: '/v1/connect/zoom/token', headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ workspaceId: WS, grant: 'refresh', refreshToken: 'rt' }) }), r2, deps({ clients: { anon, db: free } }));
    assert.equal(r2.status, 402);
    const r3 = fakeRes();
    await handleToken(fakeReq({ method: 'POST', url: '/v1/connect/zoom/token', headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ workspaceId: WS, grant: 'refresh', refreshToken: 'rt' }) }), r3, deps({ config: { connect: { zoom: {} } } }));
    assert.equal(r3.status, 503);
  });
  it('turns a refusal from the platform into a plain message and never echoes the platform body', async () => {
    const fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({ reason: 'Invalid authorization code', error: 'invalid_grant' }) });
    const res = fakeRes();
    await handleToken(fakeReq({ method: 'POST', url: '/v1/connect/zoom/token', headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ workspaceId: WS, grant: 'code', code: 'bad', codeVerifier: 'v', redirectUri: 'https://r/cb' }) }), res, deps({ fetchImpl }));
    assert.equal(res.status, 400);
    assert.match(out(res).error, /did not accept the sign-in/);
    assert.doesNotMatch(res.body, /invalid_grant/);
  });
  it('maps the platform token shape', () => {
    assert.deepEqual(tokenShape({ access_token: 'a' }, 1000), { accessToken: 'a', refreshToken: null, expiresAt: null, scope: null });
    assert.equal(tokenShape({ access_token: 'a', expires_in: 10 }, 1000).expiresAt, 11000);
  });
});

describe('accounts', () => {
  it('remembers a platform account for the user and treats a repeat as fine', async () => {
    const db = fakeDb({ tables: baseTables(), failInsert: (row, inserted) => (inserted.some((r) => r.account_id === row.account_id) ? { code: '23505' } : null) });
    for (let i = 0; i < 2; i++) {
      const res = fakeRes();
      await handleAccount(fakeReq({ method: 'POST', url: '/v1/connect/zoom/account', headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ workspaceId: WS, accountId: 'acc1', externalUserId: 'zu1' }) }), res, deps({ clients: { anon, db } }));
      assert.equal(res.status, 200, res.body);
    }
    assert.equal(db.inserted.length, 1);
    assert.deepEqual(db.inserted[0], { user_id: USER, provider: 'zoom', account_id: 'acc1', external_user_id: 'zu1' });
  });
  it('forgets an account on DELETE, only the caller\'s own', async () => {
    const db = fakeDb({ tables: { ...baseTables(), connect_accounts: [{ user_id: USER, provider: 'zoom', account_id: 'acc1' }, { user_id: 'someone-else', provider: 'zoom', account_id: 'acc1' }] } });
    const res = fakeRes();
    await handleAccount(fakeReq({ method: 'DELETE', url: '/v1/connect/zoom/account', headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ workspaceId: WS, accountId: 'acc1' }) }), res, deps({ clients: { anon, db } }));
    assert.equal(res.status, 200, res.body);
    assert.deepEqual(db.deleted.map((r) => r.user_id), [USER]);
  });
});

describe('zoom webhook', () => {
  it('verifies signatures the way Zoom signs them', () => {
    const body = '{"event":"x"}';
    const h = signed(body);
    assert.equal(verifyZoomSignature(body, h, SECRET), true);
    assert.equal(verifyZoomSignature(body + ' ', h, SECRET), false);
    assert.equal(verifyZoomSignature(body, h, 'other'), false);
    assert.equal(verifyZoomSignature(body, signed(body, { ts: Math.floor(Date.now() / 1000) - 1000 }), SECRET), false);
    assert.equal(verifyZoomSignature(body, {}, SECRET), false);
  });
  it('answers the URL validation with the hashed token', async () => {
    const body = JSON.stringify({ event: 'endpoint.url_validation', payload: { plainToken: 'abc' } });
    const res = fakeRes();
    await handleZoomWebhook(fakeReq({ method: 'POST', url: '/v1/connect/zoom/webhook', headers: signed(body), body }), res, deps());
    assert.equal(res.status, 200, res.body);
    assert.deepEqual(out(res), zoomValidation('abc', SECRET));
    assert.equal(out(res).encryptedToken, createHmac('sha256', SECRET).update('abc').digest('hex'));
  });
  it('stores recording.completed for the account, swallows a retry, ignores other events', async () => {
    const db = fakeDb({ tables: baseTables(), failInsert: (row, inserted) => (inserted.some((r) => r.external_id === row.external_id) ? { code: '23505' } : null) });
    const body = JSON.stringify({ event: 'recording.completed', payload: { account_id: 'acc1', object: { uuid: 'u1', topic: 'Weekly', recording_files: [] } } });
    for (let i = 0; i < 2; i++) {
      const res = fakeRes();
      await handleZoomWebhook(fakeReq({ method: 'POST', url: '/v1/connect/zoom/webhook', headers: signed(body), body }), res, deps({ clients: { anon, db } }));
      assert.equal(res.status, 200, res.body);
    }
    assert.equal(db.inserted.length, 1);
    assert.equal(db.inserted[0].account_id, 'acc1');
    assert.equal(db.inserted[0].external_id, 'u1');
    assert.equal(db.inserted[0].payload.object.topic, 'Weekly');
    const other = JSON.stringify({ event: 'meeting.started', payload: { account_id: 'acc1', object: { uuid: 'u2' } } });
    const res = fakeRes();
    await handleZoomWebhook(fakeReq({ method: 'POST', url: '/v1/connect/zoom/webhook', headers: signed(other), body: other }), res, deps({ clients: { anon, db } }));
    assert.equal(out(res).ignored, true);
    assert.equal(db.inserted.length, 1);
  });
  it('refuses a bad signature and a relay without the webhook secret', async () => {
    const body = JSON.stringify({ event: 'recording.completed', payload: { account_id: 'acc1', object: { uuid: 'u1' } } });
    const r1 = fakeRes();
    await handleZoomWebhook(fakeReq({ method: 'POST', url: '/v1/connect/zoom/webhook', headers: signed(body, { secret: 'wrong' }), body }), r1, deps());
    assert.equal(r1.status, 401);
    const r2 = fakeRes();
    await handleZoomWebhook(fakeReq({ method: 'POST', url: '/v1/connect/zoom/webhook', headers: signed(body), body }), r2, deps({ config: { connect: { zoom: {} } } }));
    assert.equal(r2.status, 503);
  });
});

describe('events feed', () => {
  const tables = () => ({
    ...baseTables(),
    connect_accounts: [{ user_id: USER, provider: 'zoom', account_id: 'acc1' }],
    connect_events: [
      { id: 1, provider: 'zoom', account_id: 'acc1', event: 'recording.completed', external_id: 'u1', payload: { object: { uuid: 'u1' } }, received_at: '2026-11-09T20:00:00Z', delivered_at: null },
      { id: 2, provider: 'zoom', account_id: 'acc2', event: 'recording.completed', external_id: 'u2', payload: {}, received_at: '2026-11-09T20:01:00Z', delivered_at: null },
      { id: 3, provider: 'zoom', account_id: 'acc1', event: 'recording.completed', external_id: 'u3', payload: {}, received_at: '2026-11-09T19:00:00Z', delivered_at: '2026-11-09T19:30:00Z' },
    ],
  });
  it('lists only undelivered events for the caller\'s accounts', async () => {
    const res = fakeRes();
    await handleEvents(fakeReq({ method: 'GET', url: `/v1/connect/events?workspace=${WS}&provider=zoom`, headers: { authorization: `Bearer ${TOKEN}` } }), res, deps({ clients: { anon, db: fakeDb({ tables: tables() }) } }));
    assert.equal(res.status, 200, res.body);
    assert.deepEqual(out(res).events.map((e) => e.id), [1]);
  });
  it('acknowledges events, only the caller\'s own', async () => {
    const db = fakeDb({ tables: tables() });
    const res = fakeRes();
    await handleEvents(fakeReq({ method: 'POST', url: '/v1/connect/events/ack', headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ workspaceId: WS, provider: 'zoom', ids: [1, 2] }) }), res, deps({ clients: { anon, db } }));
    assert.equal(res.status, 200, res.body);
    assert.equal(db.updates.length, 1);
    assert.ok(db.updates[0].patch.delivered_at);
    assert.deepEqual(db.updates[0].rows.map((r) => r.id), [1]);
  });
  it('routes by path', async () => {
    const res = fakeRes();
    await handleConnect(fakeReq({ method: 'GET', url: '/v1/connect/zoom/nothing' }), res, deps());
    assert.equal(res.status, 404);
    const cb = fakeRes();
    handleConnect({ method: 'GET', url: '/v1/connect/zoom/callback?code=1&state=s' }, cb, deps());
    assert.equal(cb.status, 302);
  });
});
