import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OAUTH_APPS } from '../connectors/oauthApps.js';
import { authorizeUrl, configured, connectAccount, createAccounts, oauthClients, redirectFor, refreshTokens, tokenKey } from '../sources/accounts.js';
import { LOOPBACK_REDIRECT } from '../sources/oauth.js';

const RELAY = 'https://relay.example.com';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const idToken = (email) => `h.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.s`;
const clients = { google: { clientId: 'gid', clientSecret: 'gsec' }, notion: { clientId: 'nid' }, slack: { clientId: 'sid' }, github: { clientId: 'hid' } };
// a browser that returns to the loopback with the state from the page it was sent to, or with `over`
const browser = (over = {}) => {
  let opened = null;
  const finished = [];
  const loopback = () => new Promise((resolve) => { setTimeout(() => resolve({ code: 'good', state: new URL(opened).searchParams.get('state'), finish: (r) => finished.push(r), ...over }), 0); });
  return { open: async (u) => { opened = u; }, loopback, finished, url: () => new URL(opened) };
};
const store = () => { const m = new Map(); return { m, get: async (k) => m.get(k) ?? null, set: async (k, v) => { if (v === null) m.delete(k); else m.set(k, v); return true; } }; };

describe('client resolution', () => {
  it('reads each client id from the shell, the repo .env files or the packaged field, and Google from its own pair', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'quorum-oauth-'));
    writeFileSync(path.join(root, '.env'), 'QUORUM_NOTION_CLIENT_ID="from-file"\n');
    const c = oauthClients({ env: { QUORUM_SLACK_CLIENT_ID: 'from-shell' }, root, packaged: { github: { clientId: 'from-package' }, slack: { clientId: 'loses' } }, packagedGoogle: { clientSecret: 'gs' } });
    expect(c.notion.clientId).toBe('from-file');
    expect(c.slack.clientId).toBe('from-shell');
    expect(c.github.clientId).toBe('from-package');
    expect(c.google.clientSecret).toBe('gs');
  });
  it('a provider without a client id is not configured, and Google also needs its secret', () => {
    expect(configured('notion', { notion: { clientId: null } })).toBe(false);
    expect(configured('notion', clients)).toBe(true);
    expect(configured('google-drive', { google: { clientId: 'gid', clientSecret: null } })).toBe(false);
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
  it('relay providers redirect to the relay callback; Slack asks for user scopes, Notion for a user owner', () => {
    expect(redirectFor('slack', RELAY)).toBe('https://relay.example.com/v1/oauth/slack/callback');
    const s = new URL(authorizeUrl('slack', { clientId: 'sid', redirectUri: redirectFor('slack', RELAY), state: 's', challenge: 'ch' }));
    expect(s.searchParams.get('user_scope')).toBe('channels:read,groups:read,chat:write,users:read');
    expect(s.searchParams.get('code_challenge')).toBeNull();
    const n = new URL(authorizeUrl('notion', { clientId: 'nid', redirectUri: redirectFor('notion', RELAY), state: 's' }));
    expect(n.searchParams.get('owner')).toBe('user');
    expect(n.searchParams.get('scope')).toBeNull();
    const g = new URL(authorizeUrl('github', { clientId: 'hid', redirectUri: redirectFor('github', RELAY), state: 's', challenge: 'ch' }));
    expect(g.searchParams.get('scope')).toBe('repo read:user');
    expect(g.searchParams.get('code_challenge')).toBe('ch');
  });
  it('every provider has a name, an authorize endpoint and a scope note', () => {
    for (const [id, a] of Object.entries(OAUTH_APPS)) { expect(a.name, id).toBeTruthy(); expect(a.authorize, id).toMatch(/^https:\/\//); expect(a.scopeNote, id).toBeTruthy(); }
  });
});

describe('connectAccount', () => {
  it('sends a GitHub code and verifier to the relay, never a secret, and reads the login', async () => {
    const b = browser();
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      if (url === `${RELAY}/v1/oauth/token`) return json({ accessToken: 'gho', refreshToken: null, expiresAt: null, scope: 'repo', account: null });
      if (url === 'https://api.github.com/user') return json({ login: 'octo' });
      return json({}, 404);
    };
    const t = await connectAccount('github', { clients, open: b.open, loopback: b.loopback, relayBase: RELAY, fetchImpl });
    expect(t).toMatchObject({ accessToken: 'gho', account: 'octo' });
    const body = JSON.parse(calls[0].init.body);
    expect(body).toMatchObject({ provider: 'github', code: 'good', redirect_uri: `${RELAY}/v1/oauth/github/callback` });
    expect(body.code_verifier).toMatch(/^[\w-]{43}$/);
    expect(JSON.stringify(body)).not.toMatch(/secret/);
    expect(b.finished).toEqual([{ name: 'GitHub' }]);
  });
  it('exchanges Google Drive directly with the Desktop pair and takes the email from the id token', async () => {
    const b = browser();
    const fetchImpl = async (url, init) => { const p = new URLSearchParams(init.body); return url.startsWith('https://oauth2.googleapis.com/token') && p.get('client_secret') === 'gsec' && p.get('code_verifier') ? json({ access_token: 'ya', refresh_token: 'r', expires_in: 3600, id_token: idToken('me@example.com') }) : json({ error: 'invalid_grant' }, 400); };
    const t = await connectAccount('google-drive', { clients, open: b.open, loopback: b.loopback, relayBase: RELAY, fetchImpl });
    expect(t).toMatchObject({ accessToken: 'ya', refreshToken: 'r', account: 'me@example.com' });
  });
  it('refuses a mismatched state, a cancelled consent and an unconfigured provider', async () => {
    const never = async () => { throw new Error('no network expected'); };
    await expect(connectAccount('notion', { clients, ...browser({ state: 'forged' }), relayBase: RELAY, fetchImpl: never })).rejects.toThrow(/did not match/);
    await expect(connectAccount('notion', { clients, ...browser({ error: 'access_denied', code: undefined }), relayBase: RELAY, fetchImpl: never })).rejects.toThrow(/cancelled/);
    await expect(connectAccount('slack', { clients: { slack: { clientId: null } }, ...browser(), relayBase: RELAY, fetchImpl: never })).rejects.toThrow(/not available/);
  });
  it('passes the relay\'s refusal through', async () => {
    const fetchImpl = async () => json({ error: 'The provider did not accept the sign-in. Try connecting again.', code: 'connector' }, 400);
    await expect(connectAccount('notion', { clients, ...browser(), relayBase: RELAY, fetchImpl })).rejects.toThrow(/did not accept/);
  });
});

describe('refresh', () => {
  it('refreshes through the relay and keeps the old refresh token when none comes back', async () => {
    let sent = null;
    const fetchImpl = async (_url, init) => { sent = JSON.parse(init.body); return json({ accessToken: 'new', refreshToken: null, expiresAt: 99 }); };
    const t = await refreshTokens('slack', { accessToken: 'old', refreshToken: 'rt', account: 'Acme' }, { clients, relayBase: RELAY, fetchImpl });
    expect(sent).toEqual({ provider: 'slack', grant_type: 'refresh_token', refresh_token: 'rt' });
    expect(t).toMatchObject({ accessToken: 'new', refreshToken: 'rt', expiresAt: 99, account: 'Acme' });
  });
});

describe('createAccounts', () => {
  it('connects into the Keychain store, refreshes near expiry, and revokes and forgets on disconnect', async () => {
    const tokens = store();
    const saved = {};
    const b = browser();
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push(url);
      const body = init?.body ? JSON.parse(init.body) : {};
      if (url === `${RELAY}/v1/oauth/token` && body.code) return json({ accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 1000, account: 'Acme workspace' });
      if (url === `${RELAY}/v1/oauth/token` && body.refresh_token) return json({ accessToken: 'at2', refreshToken: 'rt2', expiresAt: Date.now() + 3600000 });
      if (url === `${RELAY}/v1/oauth/revoke`) return json({ ok: true });
      return json({}, 404);
    };
    const a = createAccounts({ tokens, clients, relayBase: () => RELAY, open: b.open, loopback: b.loopback, fetchImpl, state: (id) => saved[id] ?? null, save: (id, v) => { saved[id] = v; } });
    expect(a.status('notion')).toMatchObject({ configured: true, connected: false });
    const r = await a.connect('notion');
    expect(r).toMatchObject({ connected: true, account: 'Acme workspace', error: null });
    expect(tokens.m.get(tokenKey('notion')).accessToken).toBe('at');
    expect(JSON.stringify(saved)).not.toMatch(/"at"|"rt"/);
    expect(await a.accessToken('notion')).toBe('at2');
    expect(tokens.m.get(tokenKey('notion')).refreshToken).toBe('rt2');
    const d = await a.disconnect('notion');
    expect(d.connected).toBe(false);
    expect(tokens.m.has(tokenKey('notion'))).toBe(false);
    expect(calls).toContain(`${RELAY}/v1/oauth/revoke`);
  });
  it('lists every provider with its configured state and keeps a failed connect as the row error', async () => {
    const a = createAccounts({ tokens: store(), clients: { ...clients, github: { clientId: null } }, relayBase: RELAY, open: async () => {}, fetchImpl: async () => json({}), state: () => null, save: () => {} });
    const list = a.list();
    expect(list.map((x) => x.id)).toEqual(Object.keys(OAUTH_APPS));
    expect(list.find((x) => x.id === 'github').configured).toBe(false);
    const r = await a.connect('github');
    expect(r.error).toMatch(/not available/);
    expect(() => a.status('dropbox')).toThrow(/Unknown/);
  });
  it('still disconnects locally when the revoke cannot reach the provider', async () => {
    const tokens = store();
    await tokens.set(tokenKey('slack'), { accessToken: 'x' });
    const a = createAccounts({ tokens, clients, relayBase: RELAY, open: async () => {}, fetchImpl: async () => { throw new Error('offline'); }, state: () => ({ connected: true }), save: () => {} });
    await a.disconnect('slack');
    expect(tokens.m.has(tokenKey('slack'))).toBe(false);
  });
});
