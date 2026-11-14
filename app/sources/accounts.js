// Personal OAuth connectors (connectors/oauthApps.js) in both editions: authorization code with PKCE where the provider
// supports it, a random state checked on return, the loopback redirect the MCP sources already use (directly for
// Google, through the relay's callback for providers whose apps need a server-held secret), token refresh, and revoke
// on disconnect. Tokens live in the Keychain only (sources/tokens.js, service ...-source-account-<id>); settings keep
// whether an account is connected and its label. Google Calendar signs in through gcal.js and is listed, connected and
// disconnected here, so the one Google client the two Google connectors share is revoked only when neither uses it.
// Pure Node apart from the caller-supplied `open`.
import { CLIENT_ID_ENV, GITHUB_APP_SLUG_ENV, OAUTH_APPS, isOAuthApp } from '../connectors/oauthApps.js';
import { pickerConfig } from './drive.js';
import { envLookup } from './env.js';
import { exchange as googleExchange, googleClient, refresh as googleRefresh, revoke as googleRevoke } from './gcal.js';
import { LOOPBACK_REDIRECT, awaitLoopback, json, newState, pkce } from './oauth.js';

export const tokenKey = (id) => `account-${id}`;

// every provider's client: the shell, the repo's .env files, then the packaged package.json (quorumOAuth.<client>, and
// quorumGoogle for the Google pair). A provider without a client id is not configured and shows "Not available yet"
export function oauthClients({ env = process.env, root = null, packaged = null } = {}) {
  const lookup = envLookup({ env, root });
  const from = packaged?.quorumOAuth ?? {};
  const id = (c) => lookup(CLIENT_ID_ENV[c]) || from[c]?.clientId || null;
  const google = googleClient({ lookup, packaged: packaged?.quorumGoogle ?? null });
  return {
    google,
    // the Google Picker for Google Drive (sources/drive.js): its API key, and the app id that defaults to the project
    // number in the Google client id
    googlePicker: pickerConfig({ lookup, packaged, clientId: google.clientId }),
    notion: { clientId: id('notion') },
    slack: { clientId: id('slack') },
    github: { clientId: id('github'), slug: lookup(GITHUB_APP_SLUG_ENV) || from.github?.slug || null },
  };
}

// configured means Connect can work: a client id, and for Google the Desktop secret as well
export const configured = (id, clients) => {
  const app = OAUTH_APPS[id];
  const c = clients?.[app?.client];
  return !!c?.clientId && (app.client !== 'google' || !!c.clientSecret);
};

export const redirectFor = (id, relayBase) => (OAUTH_APPS[id].exchange === 'relay' ? `${relayBase}/v1/oauth/${id}/callback` : LOOPBACK_REDIRECT);
// where the person picks the repositories the GitHub App may read
export const installUrl = (clients) => (clients?.github?.slug ? `https://github.com/apps/${encodeURIComponent(clients.github.slug)}/installations/new` : null);

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

// one call to the relay's /v1/oauth routes; relayFetch is relayUrl.js's, which moves to the fallback address only when
// the first cannot be reached
async function relayPost(relayFetch, route, body) {
  let r;
  try { r = await relayFetch(`/v1/oauth/${route}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(25000) }); }
  catch { throw new Error('Quorum\'s relay could not be reached. Check the connection and try again.'); }
  const data = await json(r);
  if (!r.ok) { const e = new Error(data?.error || `The relay answered ${r.status}.`); e.code = data?.code ?? null; throw e; }
  if (!data || typeof data !== 'object') throw new Error('The relay sent an answer Quorum could not read. Try again.');
  return data;
}

// code for tokens: Google directly with its Desktop pair, the others through the relay
export async function exchangeCode(id, { clients, code, verifier, redirectUri, relayFetch, fetchImpl = fetch }) {
  const app = OAUTH_APPS[id];
  if (app.exchange === 'direct') { const t = await googleExchange(clients.google, { code, verifier, redirectUri }, fetchImpl); return { ...t, account: t.email ?? null }; }
  return relayPost(relayFetch, 'token', { provider: id, code, code_verifier: app.pkce ? verifier : undefined, redirect_uri: redirectUri });
}

export async function refreshTokens(id, tokens, { clients, relayFetch, fetchImpl = fetch }) {
  const app = OAUTH_APPS[id];
  if (!tokens?.refreshToken) throw Object.assign(new Error(`${app.name} needs to be connected again.`), { code: 'reauth' });
  const t = app.exchange === 'direct'
    ? await googleRefresh(clients.google, tokens, fetchImpl)
    : await relayPost(relayFetch, 'token', { provider: id, grant_type: 'refresh_token', refresh_token: tokens.refreshToken });
  if (!t?.accessToken) throw new Error(`${app.name} did not return a token. Connect it again.`);
  return { ...tokens, ...t, refreshToken: t.refreshToken ?? tokens.refreshToken, account: tokens.account ?? t.account ?? null };
}

// best effort: a provider that already forgot the token, or a relay that cannot be reached, still ends in a disconnect
export async function revokeTokens(id, tokens, { relayFetch, fetchImpl = fetch }) {
  if (!tokens?.accessToken && !tokens?.refreshToken) return false;
  try {
    if (OAUTH_APPS[id].client === 'google') return googleRevoke(tokens, fetchImpl);
    if (id === 'slack') return (await json(await fetchImpl('https://slack.com/api/auth.revoke', { method: 'POST', headers: { authorization: `Bearer ${tokens.accessToken}` }, signal: AbortSignal.timeout(15000) })))?.ok === true;
    await relayPost(relayFetch, 'revoke', { provider: id, token: tokens.accessToken });
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
export async function connectAccount(id, { clients, open, relayBase, relayFetch, loopback = awaitLoopback, fetchImpl = fetch }) {
  const app = OAUTH_APPS[id];
  if (!configured(id, clients)) throw new Error(`${app.name} is not available in this build yet.`);
  const { verifier, challenge } = pkce();
  const state = newState();
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
  try { tokens = await exchangeCode(id, { clients, code: q.code, verifier, redirectUri, relayFetch, fetchImpl }); } catch (err) { fail(err.message); }
  if (!tokens?.accessToken) fail(`${app.name} did not return a token.`);
  if (app.exchange === 'direct' && !tokens.refreshToken) fail(`${app.name} did not issue a refresh token. Remove Quorum under your Google Account, Third-party access, then connect again.`);
  const account = await accountLabel(id, tokens, fetchImpl);
  tell({});
  return { ...tokens, account };
}

// the connectors as the app sees them. state(id) and save(id, value) are the caller's settings (connected, account,
// connectedAt); tokens are the Keychain store. delegates maps a connector with its own sign-in module to that module's
// { status(), connect(), disconnect({ revoke }) } (gcal.js for Google Calendar)
export function createAccounts({ tokens, clients, relayBase, relayFetch, open, log = () => {}, fetchImpl = fetch, state, save, loopback = awaitLoopback, delegates = {} }) {
  const errors = {};
  const refreshing = new Map();
  const base = () => (typeof relayBase === 'function' ? relayBase() : relayBase);
  const delegateOf = (id) => (OAUTH_APPS[id].delegate ? delegates[id] ?? null : null);
  const info = (id) => {
    const app = OAUTH_APPS[id];
    const d = delegateOf(id);
    const s = d ? d.status() : state(id);
    return {
      id, name: app.name, configured: configured(id, clients), connected: !!s?.connected, account: s?.account ?? null, connectedAt: s?.connectedAt ?? null, scope: app.scopeNote,
      manageUrl: id === 'github' ? installUrl(clients) : null,
      error: (d ? s?.error : errors[id]) ?? null,
    };
  };
  const known = (id) => { if (!isOAuthApp(id)) throw new Error('Unknown connector.'); return id; };
  // revoking a Google token ends the person's whole grant to the shared client, so it waits until the last Google
  // connector on that account disconnects; an unknown account on either side counts as the same account
  const sharedGrantInUse = (id, account) => Object.keys(OAUTH_APPS).some((other) => {
    if (other === id || OAUTH_APPS[other].client !== OAUTH_APPS[id].client || OAUTH_APPS[id].client !== 'google') return false;
    const o = info(other);
    return o.connected && (!account || !o.account || o.account === account);
  });
  return {
    list: () => Object.keys(OAUTH_APPS).map(info),
    async connect(id) {
      known(id);
      const d = delegateOf(id);
      if (d) { await d.connect(); return info(id); }
      errors[id] = null;
      try {
        const t = await connectAccount(id, { clients, open, relayBase: base(), relayFetch, loopback, fetchImpl });
        if (!(await tokens.set(tokenKey(id), t))) throw new Error('The Keychain did not accept the token. Try again.');
        save(id, { connected: true, account: t.account ?? null, connectedAt: new Date().toISOString() });
        log('account connected', id);
      } catch (err) { errors[id] = err.message; log('account connect failed', id, err.message); }
      return info(id);
    },
    async disconnect(id) {
      known(id);
      const revoke = !sharedGrantInUse(id, info(id).account);
      const d = delegateOf(id);
      if (d) { await d.disconnect({ revoke }); log('account disconnected', id, revoke ? 'revoked' : 'local only'); return info(id); }
      const t = await tokens.get(tokenKey(id));
      const revoked = t && revoke ? await revokeTokens(id, t, { relayFetch, fetchImpl }) : false;
      await tokens.set(tokenKey(id), null);
      save(id, null);
      errors[id] = null;
      log('account disconnected', id, revoked ? 'revoked' : 'local only');
      return info(id);
    },
    // the refresh token, for a feature that hands it to the relay once (KB folder sync, ee/kbSync.js); null when the
    // account is not connected or signs in through its own module
    async refreshToken(id) {
      known(id);
      if (delegateOf(id)) return null;
      return (await tokens.get(tokenKey(id)))?.refreshToken ?? null;
    },
    // a fresh access token for the features that use the account; refreshes a minute before expiry, one refresh per
    // provider at a time (a rotated refresh token works once, so a second concurrent refresh would fail)
    async accessToken(id) {
      known(id);
      if (delegateOf(id)) throw new Error(`${OAUTH_APPS[id].name} reads its own tokens.`);
      if (refreshing.has(id)) return refreshing.get(id);
      const t = await tokens.get(tokenKey(id));
      if (!t) return null;
      if (refreshing.has(id)) return refreshing.get(id);
      if (!t.expiresAt || t.expiresAt - Date.now() > 60000) return t.accessToken;
      const run = (async () => {
        try {
          const next = await refreshTokens(id, t, { clients, relayFetch, fetchImpl });
          errors[id] = null;
          if (!(await tokens.set(tokenKey(id), next))) { errors[id] = 'The Keychain did not accept the refreshed token. Connect again if this keeps happening.'; log('account refresh not stored', id); }
          return next.accessToken;
        } catch (err) { errors[id] = err.message; log('account refresh failed', id, err.message); return null; }
        finally { refreshing.delete(id); }
      })();
      refreshing.set(id, run);
      return run;
    },
  };
}
