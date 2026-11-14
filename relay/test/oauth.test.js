import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { allowedRedirects, cleanTokenRequest, createOAuthLimits, handleOAuth, handleOAuthCallback, handleOAuthRevoke, handleOAuthToken, oauthStatus } from '../oauth.js';
import { clientAddress } from '../platform.js';

const config = (over = {}) => ({
  publicUrl: 'https://relay.example.com',
  oauthExtraRedirects: [],
  oauth: { notion: { clientId: 'notion-id', clientSecret: 'notion-secret' }, slack: { clientId: 'slack-id', clientSecret: 'slack-secret' }, github: { clientId: 'gh-id', clientSecret: 'gh-secret' } },
  ...over,
});
const redirect = (p) => `https://relay.example.com/v1/oauth/${p}/callback`;

function fakeReq({ method = 'POST', url = '/v1/oauth/token', body = null, headers = {} } = {}) {
  const listeners = {};
  const req = { method, headers: { 'x-forwarded-for': '203.0.113.9', ...headers }, url, socket: {}, on: (ev, fn) => { listeners[ev] = fn; return req; }, destroy() {} };
  setTimeout(() => { if (body !== null) listeners.data?.(Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))); listeners.end?.(); }, 0);
  return req;
}
function fakeRes() {
  const res = { status: 0, headers: {}, body: '', writeHead(s, h) { this.status = s; this.headers = h ?? {}; }, end(b) { this.body = String(b ?? ''); this.done?.(); } };
  res.finished = new Promise((r) => { res.done = r; });
  return res;
}
const out = (res) => (res.body ? JSON.parse(res.body) : null);
// a provider that answers every call with `reply` and records what it was sent
function provider(reply, status = 200) {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: status >= 200 && status < 300, status, json: async () => reply }; };
  return { calls, fetchImpl };
}
const run = async (handler, req, deps) => { const res = fakeRes(); await handler(req, res, { config: config(), log: () => {}, limits: createOAuthLimits({ perAddress: 100, perProvider: 100 }), now: () => 1000, ...deps }); return res; };

describe('oauth callback bounce', () => {
  it('sends the browser to the app loopback with code and state', () => {
    const res = fakeRes();
    handleOAuthCallback({ method: 'GET', url: '/v1/oauth/notion/callback?code=abc&state=xyz' }, res, {});
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, 'http://127.0.0.1:47832/callback?code=abc&state=xyz');
  });
  it('passes a provider error through and refuses providers outside the allowlist', () => {
    const res = fakeRes();
    handleOAuthCallback({ method: 'GET', url: '/v1/oauth/slack/callback?error=access_denied&state=s' }, res, {});
    assert.match(res.headers.location, /error=access_denied/);
    const bad = fakeRes();
    handleOAuthCallback({ method: 'GET', url: '/v1/oauth/evil/callback?code=1' }, bad, {});
    assert.equal(bad.status, 404);
    const proto = fakeRes();
    handleOAuthCallback({ method: 'GET', url: '/v1/oauth/__proto__/callback?code=1' }, proto, {});
    assert.equal(proto.status, 404);
  });
});

describe('token request checks', () => {
  it('reads a code exchange and a refresh in OAuth field names', () => {
    assert.deepEqual(cleanTokenRequest({ provider: 'Notion', code: 'c', code_verifier: 'v', redirect_uri: 'r' }), { provider: 'notion', grant: 'code', code: 'c', codeVerifier: 'v', redirectUri: 'r' });
    assert.deepEqual(cleanTokenRequest({ provider: 'slack', grant_type: 'refresh_token', refresh_token: 'rt' }), { provider: 'slack', grant: 'refresh', refreshToken: 'rt' });
    assert.throws(() => cleanTokenRequest({ provider: 'notion', code: 'c' }), /incomplete/);
    assert.throws(() => cleanTokenRequest({ provider: 'notion', code: 'x'.repeat(5000), redirect_uri: 'r' }), /too long/);
  });
  it('allows only its own callback per provider plus the listed extras', () => {
    assert.deepEqual(allowedRedirects(config(), 'github'), [redirect('github')]);
    assert.deepEqual(allowedRedirects(config({ oauthExtraRedirects: ['http://127.0.0.1:8787/v1/oauth/github/callback'] }), 'github'), [redirect('github'), 'http://127.0.0.1:8787/v1/oauth/github/callback']);
  });
});

describe('POST /v1/oauth/token', () => {
  it('exchanges a Notion code with the secret in Basic auth and returns the tokens with the account', async () => {
    const p = provider({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, workspace_name: 'Acme', owner: { user: { person: { email: 'me@example.com' } } } });
    const res = await run(handleOAuthToken, fakeReq({ body: { provider: 'notion', code: 'c1', code_verifier: 'v1', redirect_uri: redirect('notion') } }), { fetchImpl: p.fetchImpl });
    assert.equal(res.status, 200);
    assert.deepEqual(out(res), { accessToken: 'at', refreshToken: 'rt', expiresAt: 1000 + 3600 * 1000, scope: null, account: 'me@example.com' });
    assert.equal(p.calls[0].url, 'https://api.notion.com/v1/oauth/token');
    assert.equal(p.calls[0].init.headers.authorization, `Basic ${Buffer.from('notion-id:notion-secret').toString('base64')}`);
    assert.deepEqual(JSON.parse(p.calls[0].init.body), { grant_type: 'authorization_code', code: 'c1', redirect_uri: redirect('notion') });
    assert.equal(res.headers['cache-control'], 'no-store');
  });
  it('reads the Slack user token from authed_user and the team name as the account', async () => {
    const p = provider({ ok: true, team: { name: 'Acme' }, authed_user: { access_token: 'xoxp', refresh_token: 'xoxe', expires_in: 43200, scope: 'chat:write' } });
    const res = await run(handleOAuthToken, fakeReq({ body: { provider: 'slack', code: 'c', redirect_uri: redirect('slack') } }), { fetchImpl: p.fetchImpl });
    assert.equal(res.status, 200);
    assert.deepEqual(out(res), { accessToken: 'xoxp', refreshToken: 'xoxe', expiresAt: 1000 + 43200 * 1000, scope: 'chat:write', account: 'Acme' });
    const sent = new URLSearchParams(p.calls[0].init.body);
    assert.equal(sent.get('client_secret'), 'slack-secret');
    assert.equal(sent.get('code'), 'c');
  });
  it('treats a Slack ok:false answer as a refusal even with HTTP 200', async () => {
    const p = provider({ ok: false, error: 'invalid_code' });
    const res = await run(handleOAuthToken, fakeReq({ body: { provider: 'slack', code: 'c', redirect_uri: redirect('slack') } }), { fetchImpl: p.fetchImpl });
    assert.equal(res.status, 400);
    assert.equal(out(res).code, 'connector');
  });
  it('sends GitHub the code verifier and the secret, and refreshes with the refresh token', async () => {
    const p = provider({ access_token: 'gho', scope: 'repo,read:user', token_type: 'bearer' });
    const res = await run(handleOAuthToken, fakeReq({ body: { provider: 'github', code: 'c', code_verifier: 'ver', redirect_uri: redirect('github') } }), { fetchImpl: p.fetchImpl });
    assert.equal(res.status, 200);
    assert.equal(out(res).accessToken, 'gho');
    const sent = new URLSearchParams(p.calls[0].init.body);
    assert.equal(sent.get('code_verifier'), 'ver');
    assert.equal(sent.get('client_secret'), 'gh-secret');
    const r2 = await run(handleOAuthToken, fakeReq({ body: { provider: 'github', grant_type: 'refresh_token', refresh_token: 'ghr' } }), { fetchImpl: p.fetchImpl });
    assert.equal(r2.status, 200);
    const sent2 = new URLSearchParams(p.calls[1].init.body);
    assert.equal(sent2.get('grant_type'), 'refresh_token');
    assert.equal(sent2.get('refresh_token'), 'ghr');
  });
  it('refuses a provider outside the allowlist and a redirect it did not issue', async () => {
    const p = provider({ access_token: 'x' });
    const unknown = await run(handleOAuthToken, fakeReq({ body: { provider: 'dropbox', code: 'c', redirect_uri: 'https://relay.example.com/v1/oauth/dropbox/callback' } }), { fetchImpl: p.fetchImpl });
    assert.equal(unknown.status, 404);
    const elsewhere = await run(handleOAuthToken, fakeReq({ body: { provider: 'notion', code: 'c', redirect_uri: 'https://evil.example.com/cb' } }), { fetchImpl: p.fetchImpl });
    assert.equal(elsewhere.status, 400);
    assert.match(out(elsewhere).error, /redirect/);
    const crossed = await run(handleOAuthToken, fakeReq({ body: { provider: 'notion', code: 'c', redirect_uri: redirect('slack') } }), { fetchImpl: p.fetchImpl });
    assert.equal(crossed.status, 400);
    assert.equal(p.calls.length, 0);
  });
  it('says the provider is not set up when the relay has no secret for it', async () => {
    const p = provider({ access_token: 'x' });
    const res = await run(handleOAuthToken, fakeReq({ body: { provider: 'notion', code: 'c', redirect_uri: redirect('notion') } }), { fetchImpl: p.fetchImpl, config: config({ oauth: { notion: { clientId: 'id' } } }) });
    assert.equal(res.status, 503);
    assert.equal(p.calls.length, 0);
  });
  it('rate limits by address', async () => {
    const p = provider({ access_token: 'x' });
    const limits = createOAuthLimits({ perAddress: 2, perProvider: 100 });
    const body = { provider: 'notion', code: 'c', redirect_uri: redirect('notion') };
    for (let i = 0; i < 2; i++) assert.equal((await run(handleOAuthToken, fakeReq({ body }), { fetchImpl: p.fetchImpl, limits })).status, 200);
    assert.equal((await run(handleOAuthToken, fakeReq({ body }), { fetchImpl: p.fetchImpl, limits })).status, 429);
    // a client that prepends its own X-Forwarded-For entry is still counted by the address the proxy appended
    assert.equal((await run(handleOAuthToken, fakeReq({ body, headers: { 'x-forwarded-for': '198.51.100.4, 203.0.113.9' } }), { fetchImpl: p.fetchImpl, limits })).status, 429);
    assert.equal((await run(handleOAuthToken, fakeReq({ body, headers: { 'x-forwarded-for': '198.51.100.4' } }), { fetchImpl: p.fetchImpl, limits })).status, 200);
  });
  it('caps each provider across all addresses, and counts the cap separately per provider', async () => {
    const p = provider({ access_token: 'x' });
    const limits = createOAuthLimits({ perAddress: 100, perProvider: 2 });
    const body = { provider: 'notion', code: 'c', redirect_uri: redirect('notion') };
    for (const ip of ['192.0.2.1', '192.0.2.2']) assert.equal((await run(handleOAuthToken, fakeReq({ body, headers: { 'x-forwarded-for': ip } }), { fetchImpl: p.fetchImpl, limits })).status, 200);
    assert.equal((await run(handleOAuthToken, fakeReq({ body, headers: { 'x-forwarded-for': '192.0.2.3' } }), { fetchImpl: p.fetchImpl, limits })).status, 429);
    assert.equal((await run(handleOAuthToken, fakeReq({ body: { provider: 'slack', code: 'c', redirect_uri: redirect('slack') }, headers: { 'x-forwarded-for': '192.0.2.3' } }), { fetchImpl: provider({ ok: true, authed_user: { access_token: 'u' } }).fetchImpl, limits })).status, 200);
  });
  it('answers a null or non-object body with a plain 400', async () => {
    for (const body of ['null', '[]', '"x"']) {
      const res = await run(handleOAuthToken, fakeReq({ body }), { fetchImpl: provider({}).fetchImpl });
      assert.equal(res.status, 400, body);
      assert.match(out(res).error, /JSON object/);
      const rv = await run(handleOAuthRevoke, fakeReq({ url: '/v1/oauth/revoke', body }), { fetchImpl: provider({}).fetchImpl });
      assert.equal(rv.status, 400, body);
    }
  });
  it('treats a null or unreadable provider answer as a refusal', async () => {
    const res = await run(handleOAuthToken, fakeReq({ body: { provider: 'github', code: 'c', redirect_uri: redirect('github') } }), { fetchImpl: provider(null).fetchImpl });
    assert.equal(res.status, 400);
    assert.match(out(res).error, /did not accept/);
  });
  it('never writes a token, code, verifier or secret to the log', async () => {
    const lines = [];
    const log = (event, fields) => lines.push(JSON.stringify({ event, ...fields }));
    const ok = provider({ access_token: 'secret-access', refresh_token: 'secret-refresh' });
    await run(handleOAuthToken, fakeReq({ body: { provider: 'github', code: 'secret-code', code_verifier: 'secret-verifier', redirect_uri: redirect('github') } }), { fetchImpl: ok.fetchImpl, log });
    const refused = provider({ error: 'bad_verification_code', error_description: 'secret-code is bad' }, 200);
    await run(handleOAuthToken, fakeReq({ body: { provider: 'github', code: 'secret-code', redirect_uri: redirect('github') } }), { fetchImpl: refused.fetchImpl, log });
    await run(handleOAuthRevoke, fakeReq({ url: '/v1/oauth/revoke', body: { provider: 'github', token: 'secret-access' } }), { fetchImpl: provider({}, 204).fetchImpl, log });
    assert.ok(lines.length >= 3);
    for (const l of lines) assert.doesNotMatch(l, /secret|gh-secret|notion-secret/);
  });
});

describe('POST /v1/oauth/revoke', () => {
  it('revokes a GitHub grant with the app credentials', async () => {
    const p = provider({}, 204);
    const res = await run(handleOAuthRevoke, fakeReq({ url: '/v1/oauth/revoke', body: { provider: 'github', token: 'gho' } }), { fetchImpl: p.fetchImpl });
    assert.equal(res.status, 200);
    assert.equal(p.calls[0].url, 'https://api.github.com/applications/gh-id/grant');
    assert.equal(p.calls[0].init.method, 'DELETE');
    assert.deepEqual(JSON.parse(p.calls[0].init.body), { access_token: 'gho' });
  });
  it('revokes a Notion token and refuses Slack, which the app revokes itself', async () => {
    const p = provider({}, 200);
    assert.equal((await run(handleOAuthRevoke, fakeReq({ url: '/v1/oauth/revoke', body: { provider: 'notion', token: 't' } }), { fetchImpl: p.fetchImpl })).status, 200);
    assert.equal(p.calls[0].url, 'https://api.notion.com/v1/oauth/revoke');
    assert.equal((await run(handleOAuthRevoke, fakeReq({ url: '/v1/oauth/revoke', body: { provider: 'slack', token: 't' } }), { fetchImpl: p.fetchImpl })).status, 400);
  });
  it('counts 404 as already revoked, and 401 or 403 as the provider refusing the relay, logged', async () => {
    assert.equal((await run(handleOAuthRevoke, fakeReq({ url: '/v1/oauth/revoke', body: { provider: 'github', token: 't' } }), { fetchImpl: provider({}, 404).fetchImpl })).status, 200);
    for (const status of [401, 403]) {
      const lines = [];
      const res = await run(handleOAuthRevoke, fakeReq({ url: '/v1/oauth/revoke', body: { provider: 'notion', token: 't' } }), { fetchImpl: provider({}, status).fetchImpl, log: (event, f) => lines.push({ event, ...f }) });
      assert.equal(res.status, 502, String(status));
      assert.match(out(res).error, /refused the relay/);
      assert.ok(lines.some((l) => l.event === 'oauth_revoke_rejected' && l.status === status));
    }
    assert.equal((await run(handleOAuthRevoke, fakeReq({ url: '/v1/oauth/revoke', body: { provider: 'github', token: 't' } }), { fetchImpl: provider({}, 500).fetchImpl })).status, 502);
  });
});

describe('caller address', () => {
  it('takes the last X-Forwarded-For entry, which the proxy appended, else the socket', () => {
    assert.equal(clientAddress({ headers: { 'x-forwarded-for': '10.0.0.1, 198.51.100.7' }, socket: {} }), '198.51.100.7');
    assert.equal(clientAddress({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }), '127.0.0.1');
    assert.equal(clientAddress({ headers: { 'x-real-ip': '203.0.113.9', 'x-forwarded-for': '1.2.3.4, 10.0.0.1' }, socket: {} }), '203.0.113.9');
  });
});

describe('routing and health', () => {
  it('routes the three paths and 404s the rest', async () => {
    const res = fakeRes();
    handleOAuth({ method: 'GET', url: '/v1/oauth/github/callback?code=1&state=s', headers: {} }, res, { config: config(), log: () => {} });
    assert.equal(res.status, 302);
    const nf = fakeRes();
    handleOAuth({ method: 'GET', url: '/v1/oauth/github/other', headers: {} }, nf, { config: config(), log: () => {} });
    assert.equal(nf.status, 404);
  });
  it('reports which providers have a full client pair', () => {
    assert.deepEqual(oauthStatus(config({ oauth: { notion: { clientId: 'a', clientSecret: 'b' }, slack: { clientId: 'a' } } })), { notion: true, slack: false, github: false });
  });
});
