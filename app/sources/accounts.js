// Personal OAuth connectors (connectors/oauthApps.js) in both editions: authorization code with PKCE where the provider
// supports it, a random state checked on return, the loopback redirect the MCP sources already use (directly for
// Google, through the relay's callback bounce for providers whose apps need a server-held secret), token refresh, and
// revoke on disconnect. Tokens live in the Keychain only (sources/tokens.js, service ...-source-account-<id>); settings
// keep whether an account is connected and its label. Pure Node apart from the caller-supplied `open`.
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { CLIENT_ID_ENV, OAUTH_APPS, isOAuthApp } from '../connectors/oauthApps.js';
import { exchange as googleExchange, googleClient, readEnvFile, refresh as googleRefresh } from './gcal.js';
import { LOOPBACK_REDIRECT, awaitLoopback, pkce } from './oauth.js';

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const json = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return null; } };
export const tokenKey = (id) => `account-${id}`;

// every provider's client, in the order gcal.js uses: the shell, the repo's .env then .env.development, the packaged
// package.json (quorumOAuth.<client>.clientId, and quorumGoogle for the Google pair). A provider without a client id
// is not configured and its row says "Not available yet"
export function oauthClients({ env = process.env, root = null, packaged = null, packagedGoogle = null } = {}) {
  const files = root ? [readEnvFile(path.join(root, '.env')), readEnvFile(path.join(root, '.env.development'))] : [];
  const pick = (key) => env[key] || files.map((f) => f[key]).find(Boolean) || null;
  const out = { google: googleClient({ env, root, packaged: packagedGoogle }) };
  for (const c of ['notion', 'slack', 'github']) out[c] = { clientId: pick(CLIENT_ID_ENV[c]) || packaged?.[c]?.clientId || null };
  return out;
}

// configured means Connect can work: a client id, and for Google the Desktop secret as well
export const configured = (id, clients) => {
  const app = OAUTH_APPS[id];
  const c = clients?.[app?.client];
  return !!c?.clientId && (app.client !== 'google' || !!c.clientSecret);
};

export const redirectFor = (id, relayBase) => (OAUTH_APPS[id].exchange === 'relay' ? `${relayBase}/v1/oauth/${id}/callback` : LOOPBACK_REDIRECT);

export function authorizeUrl(id, { clientId, redirectUri, state, challenge = null }) {
  const app = OAUTH_APPS[id];
  const u = new URL(app.authorize);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('state', state);
  if (app.scopeParam && app.scopes.length) u.searchParams.set(app.scopeParam, app.scopes.join(app.scopeSep));
  if (app.pkce && challenge) { u.searchParams.set('code_challenge', challenge); u.searchParams.set('code_challenge_method', 'S256'); }
  for (const [k, v] of Object.entries(app.params ?? {})) u.searchParams.set(k, v);
  return u.toString();
}

async function relayPost(relayBase, route, body, fetchImpl) {
  let r;
  try { r = await fetchImpl(`${relayBase}/v1/oauth/${route}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(25000) }); }
  catch { throw new Error('Quorum\'s relay could not be reached. Check the connection and try again.'); }
  const data = await json(r);
  if (!r.ok) { const e = new Error(data?.error || `The relay answered ${r.status}.`); e.code = data?.code ?? null; throw e; }
  return data;
}

// code for tokens: Google directly with its Desktop pair, the others through the relay
export async function exchangeCode(id, { clients, code, verifier, redirectUri, relayBase, fetchImpl = fetch }) {
  const app = OAUTH_APPS[id];
  if (app.exchange === 'direct') { const t = await googleExchange(clients.google, { code, verifier, redirectUri }, fetchImpl); return { ...t, account: t.email ?? null }; }
  return relayPost(relayBase, 'token', { provider: id, code, code_verifier: app.pkce ? verifier : undefined, redirect_uri: redirectUri }, fetchImpl);
}

export async function refreshTokens(id, tokens, { clients, relayBase, fetchImpl = fetch }) {
  const app = OAUTH_APPS[id];
  if (!tokens?.refreshToken) throw Object.assign(new Error(`${app.name} needs to be connected again.`), { code: 'reauth' });
  const t = app.exchange === 'direct'
    ? await googleRefresh(clients.google, tokens, fetchImpl)
    : await relayPost(relayBase, 'token', { provider: id, grant_type: 'refresh_token', refresh_token: tokens.refreshToken }, fetchImpl);
  return { ...tokens, ...t, refreshToken: t.refreshToken ?? tokens.refreshToken, account: tokens.account ?? t.account ?? null };
}

// best effort: a provider that already forgot the token, or a relay that cannot be reached, still ends in a disconnect
export async function revokeTokens(id, tokens, { relayBase, fetchImpl = fetch }) {
  const token = tokens?.refreshToken || tokens?.accessToken;
  if (!token) return false;
  try {
    if (id === 'google-drive') return (await fetchImpl('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }), signal: AbortSignal.timeout(15000) })).ok;
    if (id === 'slack') return (await json(await fetchImpl('https://slack.com/api/auth.revoke', { method: 'POST', headers: { authorization: `Bearer ${tokens.accessToken}` }, signal: AbortSignal.timeout(15000) })))?.ok === true;
    await relayPost(relayBase, 'revoke', { provider: id, token: tokens.accessToken }, fetchImpl);
    return true;
  } catch { return false; }
}

// the account label for providers whose token answer carries none
export async function accountLabel(id, tokens, fetchImpl = fetch) {
  if (tokens.account) return tokens.account;
  if (id !== 'github') return null;
  try {
    const r = await fetchImpl('https://api.github.com/user', { headers: { authorization: `Bearer ${tokens.accessToken}`, accept: 'application/vnd.github+json', 'user-agent': 'Quorum' }, signal: AbortSignal.timeout(15000) });
    return r.ok ? (await json(r))?.login ?? null : null;
  } catch { return null; }
}

// the browser sign-in for one provider: resolves with the tokens and the account label
export async function connectAccount(id, { clients, open, relayBase, loopback = awaitLoopback, fetchImpl = fetch }) {
  const app = OAUTH_APPS[id];
  if (!configured(id, clients)) throw new Error(`${app.name} is not available in this build yet.`);
  const { verifier, challenge } = pkce();
  const state = b64url(randomBytes(16));
  const redirectUri = redirectFor(id, relayBase);
  const waiting = loopback();
  await open(authorizeUrl(id, { clientId: clients[app.client].clientId, redirectUri, state, challenge }));
  const q = await waiting;
  const tell = (r) => { try { q.finish?.({ name: app.name, ...r }); } catch {} };
  const fail = (message) => { tell({ failed: message }); throw new Error(message); };
  if (q.error) fail(q.error === 'access_denied' ? `${app.name} sign-in was cancelled.` : q.error_description || q.error);
  if (q.state !== state) fail('The sign-in answer did not match the request.');
  if (!q.code) fail('The sign-in did not return a code.');
  let tokens;
  try { tokens = await exchangeCode(id, { clients, code: q.code, verifier, redirectUri, relayBase, fetchImpl }); } catch (err) { fail(err.message); }
  if (!tokens?.accessToken) fail(`${app.name} did not return a token.`);
  if (app.exchange === 'direct' && !tokens.refreshToken) fail(`${app.name} did not issue a refresh token. Remove Quorum under your Google Account, Third-party access, then connect again.`);
  const account = await accountLabel(id, tokens, fetchImpl);
  tell({});
  return { ...tokens, account };
}

// the connectors as the app sees them. state(id) and save(id, value) are the caller's settings (connected, account,
// connectedAt); tokens are the Keychain store
export function createAccounts({ tokens, clients, relayBase, open, log = () => {}, fetchImpl = fetch, state, save, loopback = awaitLoopback }) {
  const errors = {};
  const base = () => (typeof relayBase === 'function' ? relayBase() : relayBase);
  const info = (id) => {
    const s = state(id);
    return { id, name: OAUTH_APPS[id].name, configured: configured(id, clients), connected: !!s?.connected, account: s?.account ?? null, connectedAt: s?.connectedAt ?? null, scope: OAUTH_APPS[id].scopeNote, error: errors[id] ?? null };
  };
  const known = (id) => { if (!isOAuthApp(id)) throw new Error('Unknown connector.'); return id; };
  return {
    list: () => Object.keys(OAUTH_APPS).map(info),
    status: (id) => info(known(id)),
    async connect(id) {
      known(id);
      errors[id] = null;
      try {
        const t = await connectAccount(id, { clients, open, relayBase: base(), loopback, fetchImpl });
        if (!(await tokens.set(tokenKey(id), t))) throw new Error('The Keychain did not accept the token. Try again.');
        save(id, { connected: true, account: t.account ?? null, connectedAt: new Date().toISOString() });
        log('account connected', id);
      } catch (err) { errors[id] = err.message; log('account connect failed', id, err.message); }
      return info(id);
    },
    async disconnect(id) {
      known(id);
      const t = await tokens.get(tokenKey(id));
      const revoked = t ? await revokeTokens(id, t, { relayBase: base(), fetchImpl }) : false;
      await tokens.set(tokenKey(id), null);
      save(id, null);
      errors[id] = null;
      log('account disconnected', id, revoked ? 'revoked' : 'local only');
      return info(id);
    },
    // a fresh access token for the features that use the account; refreshes a minute before expiry
    async accessToken(id) {
      known(id);
      const t = await tokens.get(tokenKey(id));
      if (!t) return null;
      if (!t.expiresAt || t.expiresAt - Date.now() > 60000) return t.accessToken;
      try {
        const next = await refreshTokens(id, t, { clients, relayBase: base(), fetchImpl });
        await tokens.set(tokenKey(id), next);
        return next.accessToken;
      } catch (err) { errors[id] = err.message; log('account refresh failed', id, err.message); return null; }
    },
  };
}
