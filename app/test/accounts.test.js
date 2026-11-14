import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OAUTH_APPS } from '../connectors/oauthApps.js';
import { authorizeUrl, configured, connectAccount, createAccounts, installUrl, oauthClients, redirectFor, refreshTokens, tokenKey } from '../sources/accounts.js';
import { LOOPBACK_REDIRECT } from '../sources/oauth.js';

const RELAY = 'https://relay.example.com';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const idToken = (email) => `h.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.s`;
const clients = { google: { clientId: 'gid', clientSecret: 'gsec' }, notion: { clientId: 'nid' }, slack: { clientId: 'sid' }, github: { clientId: 'hid', slug: 'quorum-app' } };
// a browser that returns to the loopback with the state from the page it was sent to, or with `over`
const browser = (over = {}) => {
  let opened = null;
  const finished = [];
  const loopback = () => new Promise((resolve) => { setTimeout(() => resolve({ code: 'good', state: new URL(opened).searchParams.get('state'), finish: (r) => finished.push(r), ...over }), 0); });
  return { open: async (u) => { opened = u; }, loopback, finished, url: () => new URL(opened) };
};
const store = () => { const m = new Map(); return { m, get: async (k) => m.get(k) ?? null, set: async (k, v) => { if (v === null) m.delete(k); else m.set(k, v); return true; } }; };
// the relay as relayUrl.js's relayFetch sees it: a route and the request init
const relay = (answer) => { const calls = []; return { calls, relayFetch: async (route, init) => { const body = init?.body ? JSON.parse(init.body) : {}; calls.push({ route, body }); return answer(route, body); } }; };
const noNetwork = async () => { throw new Error('no network expected'); };

describe('client resolution', () => {
  it('reads each client id from the shell, the repo .env files or the packaged package.json, and Google from its own pair', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'quorum-oauth-'));
    writeFileSync(path.join(root, '.env'), 'QUORUM_NOTION_CLIENT_ID="from-file"\nQUORUM_GITHUB_APP_SLUG=quorum-dev\n');
    const c = oauthClients({ env: { QUORUM_SLACK_CLIENT_ID: 'from-shell' }, root, packaged: { quorumOAuth: { github: { clientId: 'from-package', slug: 'loses' }, slack: { clientId: 'loses' } }, quorumGoogle: { clientSecret: 'gs' } } });
    expect(c.notion.clientId).toBe('from-file');
    expect(c.slack.clientId).toBe('from-shell');
    expect(c.github).toEqual({ clientId: 'from-package', slug: 'quorum-dev' });
    expect(c.google.clientSecret).toBe('gs');
  });
  it('a provider without a client id is not configured, and Google also needs its secret', () => {
    expect(configured('notion', { notion: { clientId: null } })).toBe(false);
    expect(configured('notion', clients)).toBe(true);
    expect(configured('google-drive', { google: { clientId: 'gid', clientSecret: null } })).toBe(false);
    expect(configured('google-calendar', clients)).toBe(true);
  });
});

describe('authorize URLs', () => {
  it('Google Drive asks for drive.file only, offline, with PKCE, on the loopback', () => {
    const u = new URL(authorizeUrl('google-drive', { clientId: 'gid', redirectUri: redirectFor('google-drive', RELAY), state: 's', challenge: 'ch' }));
    expect(u.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/drive.file openid email');
    expect(u.searchParams.get('redirect_uri')).toBe(LOOPBACK_REDIRECT);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('access_type')).toBe('offline');
  });
  it('relay providers redirect to the relay callback; Slack asks for user scopes, Notion for a user owner, GitHub for no scope', () => {
    expect(redirectFor('slack', RELAY)).toBe('https://relay.example.com/v1/oauth/slack/callback');
    const s = new URL(authorizeUrl('slack', { clientId: 'sid', redirectUri: redirectFor('slack', RELAY), state: 's', challenge: 'ch' }));
    expect(s.searchParams.get('user_scope')).toBe('channels:read,groups:read,chat:write,users:read');
    expect(s.searchParams.get('code_challenge')).toBeNull();
    const n = new URL(authorizeUrl('notion', { clientId: 'nid', redirectUri: redirectFor('notion', RELAY), state: 's' }));
    expect(n.searchParams.get('owner')).toBe('user');
    expect(n.searchParams.get('scope')).toBeNull();
    // a GitHub App takes its permissions from the app settings: no scope parameter, PKCE still on
    const g = new URL(authorizeUrl('github', { clientId: 'hid', redirectUri: redirectFor('github', RELAY), state: 's', challenge: 'ch' }));
    expect(g.searchParams.get('scope')).toBeNull();
    expect(g.searchParams.get('code_challenge')).toBe('ch');
    expect(installUrl(clients)).toBe('https://github.com/apps/quorum-app/installations/new');
    expect(installUrl({ github: { clientId: 'hid', slug: null } })).toBeNull();
  });
  it('every provider has a name, an authorize endpoint and a scope note', () => {
    for (const [id, a] of Object.entries(OAUTH_APPS)) { expect(a.name, id).toBeTruthy(); expect(a.authorize, id).toMatch(/^https:\/\//); expect(a.scopeNote, id).toBeTruthy(); }
  });
});

describe('connectAccount', () => {
  it('sends a GitHub code and verifier to the relay, never a secret, and reads the login', async () => {
    const b = browser();
    const r = relay(() => json({ accessToken: 'ghu', refreshToken: 'ghr', expiresAt: 5, scope: '', account: null }));
    const fetchImpl = async (url) => (url === 'https://api.github.com/user' ? json({ login: 'octo' }) : json({}, 404));
    const t = await connectAccount('github', { clients, open: b.open, loopback: b.loopback, relayBase: RELAY, relayFetch: r.relayFetch, fetchImpl });
    expect(t).toMatchObject({ accessToken: 'ghu', account: 'octo' });
    expect(r.calls[0].route).toBe('/v1/oauth/token');
    expect(r.calls[0].body).toMatchObject({ provider: 'github', code: 'good', redirect_uri: `${RELAY}/v1/oauth/github/callback` });
    expect(r.calls[0].body.code_verifier).toMatch(/^[\w-]{43}$/);
    expect(JSON.stringify(r.calls[0].body)).not.toMatch(/secret/);
    expect(b.finished).toEqual([{ name: 'GitHub' }]);
  });
  it('exchanges Google Drive directly with the Desktop pair and takes the email from the id token', async () => {
    const b = browser();
    const fetchImpl = async (url, init) => { const p = new URLSearchParams(init.body); return url.startsWith('https://oauth2.googleapis.com/token') && p.get('client_secret') === 'gsec' && p.get('code_verifier') ? json({ access_token: 'ya', refresh_token: 'r', expires_in: 3600, id_token: idToken('me@example.com') }) : json({ error: 'invalid_grant' }, 400); };
    const t = await connectAccount('google-drive', { clients, open: b.open, loopback: b.loopback, relayBase: RELAY, relayFetch: noNetwork, fetchImpl });
    expect(t).toMatchObject({ accessToken: 'ya', refreshToken: 'r', account: 'me@example.com' });
  });
  it('refuses a mismatched state, a cancelled consent and an unconfigured provider', async () => {
    await expect(connectAccount('notion', { clients, ...browser({ state: 'forged' }), relayBase: RELAY, relayFetch: noNetwork, fetchImpl: noNetwork })).rejects.toThrow(/did not match/);
    await expect(connectAccount('notion', { clients, ...browser({ error: 'access_denied', code: undefined }), relayBase: RELAY, relayFetch: noNetwork, fetchImpl: noNetwork })).rejects.toThrow(/cancelled/);
    await expect(connectAccount('slack', { clients: { slack: { clientId: null } }, ...browser(), relayBase: RELAY, relayFetch: noNetwork, fetchImpl: noNetwork })).rejects.toThrow(/not available/);
  });
  it('passes the relay\'s refusal through, and reads an unreachable relay or a null answer plainly', async () => {
    const refused = relay(() => json({ error: 'The provider did not accept the sign-in. Try connecting again.', code: 'connector' }, 400));
    await expect(connectAccount('notion', { clients, ...browser(), relayBase: RELAY, relayFetch: refused.relayFetch, fetchImpl: noNetwork })).rejects.toThrow(/did not accept/);
    await expect(connectAccount('notion', { clients, ...browser(), relayBase: RELAY, relayFetch: noNetwork, fetchImpl: noNetwork })).rejects.toThrow(/could not be reached/);
    const empty = relay(() => new Response('null', { status: 200 }));
    await expect(connectAccount('notion', { clients, ...browser(), relayBase: RELAY, relayFetch: empty.relayFetch, fetchImpl: noNetwork })).rejects.toThrow(/could not read/);
  });
});

describe('refresh', () => {
  it('refreshes through the relay and keeps the old refresh token when none comes back', async () => {
    const r = relay(() => json({ accessToken: 'new', refreshToken: null, expiresAt: 99 }));
    const t = await refreshTokens('slack', { accessToken: 'old', refreshToken: 'rt', account: 'Acme' }, { clients, relayFetch: r.relayFetch });
    expect(r.calls[0].body).toEqual({ provider: 'slack', grant_type: 'refresh_token', refresh_token: 'rt' });
    expect(t).toMatchObject({ accessToken: 'new', refreshToken: 'rt', expiresAt: 99, account: 'Acme' });
  });
});

const make = (over = {}) => {
  const saved = {};
  const tokens = over.tokens ?? store();
  const a = createAccounts({ tokens, clients, relayBase: () => RELAY, open: async () => {}, fetchImpl: noNetwork, relayFetch: noNetwork, state: (id) => saved[id] ?? null, save: (id, v) => { saved[id] = v; }, ...over });
  return { a, saved, tokens };
};

describe('createAccounts', () => {
  it('connects into the Keychain store, refreshes near expiry, and revokes and forgets on disconnect', async () => {
    const b = browser();
    const r = relay((route, body) => {
      if (route === '/v1/oauth/token' && body.code) return json({ accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 1000, account: 'Acme workspace' });
      if (route === '/v1/oauth/token' && body.refresh_token) return json({ accessToken: 'at2', refreshToken: 'rt2', expiresAt: Date.now() + 3600000 });
      if (route === '/v1/oauth/revoke') return json({ ok: true });
      return json({}, 404);
    });
    const { a, saved, tokens } = make({ open: b.open, loopback: b.loopback, relayFetch: r.relayFetch });
    expect(a.list().find((x) => x.id === 'notion')).toMatchObject({ configured: true, connected: false });
    const c = await a.connect('notion');
    expect(c).toMatchObject({ connected: true, account: 'Acme workspace', error: null });
    expect(tokens.m.get(tokenKey('notion')).accessToken).toBe('at');
    expect(JSON.stringify(saved)).not.toMatch(/"at"|"rt"/);
    expect(await a.accessToken('notion')).toBe('at2');
    expect(tokens.m.get(tokenKey('notion')).refreshToken).toBe('rt2');
    const d = await a.disconnect('notion');
    expect(d.connected).toBe(false);
    expect(tokens.m.has(tokenKey('notion'))).toBe(false);
    expect(r.calls.map((x) => x.route)).toContain('/v1/oauth/revoke');
  });
  it('lists every provider with its configured state, the GitHub repository page, and keeps a failed connect as the row error', async () => {
    const { a } = make({ clients: { ...clients, slack: { clientId: null } } });
    const list = a.list();
    expect(list.map((x) => x.id)).toEqual(Object.keys(OAUTH_APPS));
    expect(list.find((x) => x.id === 'slack').configured).toBe(false);
    expect(list.find((x) => x.id === 'github').manageUrl).toBe('https://github.com/apps/quorum-app/installations/new');
    const r = await a.connect('slack');
    expect(r.error).toMatch(/not available/);
    await expect(a.connect('dropbox')).rejects.toThrow(/Unknown/);
  });
  it('still disconnects locally when the revoke cannot reach the provider', async () => {
    const tokens = store();
    await tokens.set(tokenKey('slack'), { accessToken: 'x' });
    const { a } = make({ tokens, state: () => ({ connected: true }) });
    await a.disconnect('slack');
    expect(tokens.m.has(tokenKey('slack'))).toBe(false);
  });
});

describe('refresh in createAccounts', () => {
  const expiring = async (tokens) => tokens.set(tokenKey('github'), { accessToken: 'old', refreshToken: 'r1', expiresAt: Date.now() + 1000 });
  it('runs one refresh for concurrent callers', async () => {
    const tokens = store();
    await expiring(tokens);
    let release;
    const gate = new Promise((r) => { release = r; });
    const r = relay(async () => { await gate; return json({ accessToken: 'new', refreshToken: 'r2', expiresAt: Date.now() + 3600000 }); });
    const { a } = make({ tokens, relayFetch: r.relayFetch });
    const both = Promise.all([a.accessToken('github'), a.accessToken('github'), a.accessToken('github')]);
    await new Promise((res) => setTimeout(res, 0));
    release();
    expect(await both).toEqual(['new', 'new', 'new']);
    expect(r.calls).toHaveLength(1);
  });
  it('clears the row error after a successful refresh', async () => {
    const tokens = store();
    await expiring(tokens);
    let fail = true;
    const r = relay(() => (fail ? json({ error: 'The provider no longer accepts this connection. Connect it again.' }, 400) : json({ accessToken: 'new', refreshToken: 'r2', expiresAt: Date.now() + 3600000 })));
    const { a } = make({ tokens, relayFetch: r.relayFetch, state: () => ({ connected: true }) });
    expect(await a.accessToken('github')).toBeNull();
    expect(a.list().find((x) => x.id === 'github').error).toMatch(/no longer accepts/);
    fail = false;
    expect(await a.accessToken('github')).toBe('new');
    expect(a.list().find((x) => x.id === 'github').error).toBeNull();
  });
  it('says so when the Keychain refuses the rotated tokens', async () => {
    const inner = store();
    await expiring(inner);
    const tokens = { get: inner.get, set: async (k, v) => (v?.accessToken === 'new' ? false : inner.set(k, v)) };
    const r = relay(() => json({ accessToken: 'new', refreshToken: 'r2', expiresAt: Date.now() + 3600000 }));
    const { a } = make({ tokens, relayFetch: r.relayFetch, state: () => ({ connected: true }) });
    expect(await a.accessToken('github')).toBe('new');
    expect(a.list().find((x) => x.id === 'github').error).toMatch(/Keychain/);
  });
});

describe('the shared Google client', () => {
  // Google Calendar as gcal.js presents it to accounts.js
  const calendar = (account) => {
    const s = { connected: true, account, revoked: null };
    return { s, status: () => ({ configured: true, connected: s.connected, account: s.account, error: null }), connect: async () => { s.connected = true; }, disconnect: async ({ revoke }) => { s.revoked = revoke; s.connected = false; } };
  };
  const googleSetup = async (driveAccount, calAccount) => {
    const tokens = store();
    await tokens.set(tokenKey('google-drive'), { accessToken: 'ya', refreshToken: 'gr' });
    const revokes = [];
    const fetchImpl = async (url, init) => { if (url === 'https://oauth2.googleapis.com/revoke') { revokes.push(new URLSearchParams(init.body).get('token')); return new Response('', { status: 200 }); } return json({}, 404); };
    const cal = calendar(calAccount);
    const saved = { 'google-drive': { connected: true, account: driveAccount } };
    const a = createAccounts({ tokens, clients, relayBase: RELAY, relayFetch: noNetwork, open: async () => {}, fetchImpl, state: (id) => saved[id] ?? null, save: (id, v) => { saved[id] = v; }, delegates: { 'google-calendar': cal } });
    return { a, cal, revokes, tokens };
  };
  it('Drive first: keeps the grant while Calendar uses it, then Calendar revokes it', async () => {
    const { a, cal, revokes, tokens } = await googleSetup('me@example.com', 'me@example.com');
    await a.disconnect('google-drive');
    expect(revokes).toEqual([]);
    expect(tokens.m.has(tokenKey('google-drive'))).toBe(false);
    await a.disconnect('google-calendar');
    expect(cal.s.revoked).toBe(true);
  });
  it('Calendar first: keeps the grant while Drive uses it, then Drive revokes it', async () => {
    const { a, cal, revokes } = await googleSetup('me@example.com', 'me@example.com');
    await a.disconnect('google-calendar');
    expect(cal.s.revoked).toBe(false);
    await a.disconnect('google-drive');
    expect(revokes).toEqual(['gr']);
  });
  it('revokes right away when the other Google connector is on a different account', async () => {
    const { a, revokes } = await googleSetup('me@example.com', 'other@example.com');
    await a.disconnect('google-drive');
    expect(revokes).toEqual(['gr']);
  });
  it('lists Google Calendar from its own module', async () => {
    const { a } = await googleSetup('me@example.com', 'me@example.com');
    expect(a.list().find((x) => x.id === 'google-calendar')).toMatchObject({ connected: true, account: 'me@example.com', configured: true });
  });
});
