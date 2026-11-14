// Personal connectors in both editions: the token exchange for providers whose OAuth apps need a server-held client
// secret (Notion, Slack, and the GitHub App's user tokens). Three routes, all stateless and open to the free edition (no Quorum sign-in):
//   GET  /v1/oauth/<provider>/callback  the provider lands here and the browser is sent on to the app's loopback
//   POST /v1/oauth/token                { provider, code, code_verifier, redirect_uri } or { provider, grant_type:
//                                       'refresh_token', refresh_token }: the relay adds the client secret, calls the
//                                       provider and returns the tokens to the app
//   POST /v1/oauth/revoke               { provider, token }: for providers whose revoke call needs the secret
// Nothing is stored. Tokens, codes and verifiers never reach the log: the log carries the provider, the grant and the
// provider's HTTP status only.
import { RelayError } from './lib/auth.js';
import { bounceToLoopback } from './connect.js';
import { clientAddress, createLimiter } from './platform.js';
import { readJson } from './summary.js';

const basic = (c) => `Basic ${Buffer.from(`${c.clientId}:${c.clientSecret}`).toString('base64')}`;
const form = (o) => new URLSearchParams(Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''))).toString();
const expiry = (s, now) => (s ? now + Number(s) * 1000 : null);

// each provider: how to swap a code, how to refresh, how to revoke (null when the app revokes on its own), and the
// account label the provider's token answer already carries
export const OAUTH_PROVIDERS = {
  notion: {
    token: (c, b) => ({
      url: 'https://api.notion.com/v1/oauth/token',
      init: { method: 'POST', headers: { authorization: basic(c), 'content-type': 'application/json', accept: 'application/json', 'notion-version': '2022-06-28' }, body: JSON.stringify(b.grant === 'refresh' ? { grant_type: 'refresh_token', refresh_token: b.refreshToken } : { grant_type: 'authorization_code', code: b.code, redirect_uri: b.redirectUri }) },
    }),
    ok: (t) => !!t.access_token,
    shape: (t, now) => ({ accessToken: t.access_token, refreshToken: t.refresh_token ?? null, expiresAt: expiry(t.expires_in, now), scope: null, account: t.owner?.user?.person?.email ?? t.workspace_name ?? null }),
    revoke: (c, token) => ({ url: 'https://api.notion.com/v1/oauth/revoke', init: { method: 'POST', headers: { authorization: basic(c), 'content-type': 'application/json', 'notion-version': '2022-06-28' }, body: JSON.stringify({ token }) } }),
  },
  slack: {
    // user scopes only: the user token sits under authed_user, with its own refresh token when rotation is on
    token: (c, b) => ({
      url: 'https://slack.com/api/oauth.v2.access',
      init: { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form(b.grant === 'refresh' ? { client_id: c.clientId, client_secret: c.clientSecret, grant_type: 'refresh_token', refresh_token: b.refreshToken } : { client_id: c.clientId, client_secret: c.clientSecret, code: b.code, redirect_uri: b.redirectUri }) },
    }),
    ok: (t) => t.ok === true && !!(t.authed_user?.access_token || t.access_token),
    shape: (t, now) => {
      const u = t.authed_user?.access_token ? t.authed_user : t;
      return { accessToken: u.access_token, refreshToken: u.refresh_token ?? null, expiresAt: expiry(u.expires_in, now), scope: u.scope ?? null, account: t.team?.name ?? null };
    },
    revoke: null,
  },
  github: {
    token: (c, b) => ({
      url: 'https://github.com/login/oauth/access_token',
      init: { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form(b.grant === 'refresh' ? { client_id: c.clientId, client_secret: c.clientSecret, grant_type: 'refresh_token', refresh_token: b.refreshToken } : { client_id: c.clientId, client_secret: c.clientSecret, code: b.code, redirect_uri: b.redirectUri, code_verifier: b.codeVerifier }) },
    }),
    ok: (t) => !!t.access_token,
    shape: (t, now) => ({ accessToken: t.access_token, refreshToken: t.refresh_token ?? null, expiresAt: expiry(t.expires_in, now), scope: t.scope ?? null, account: null }),
    revoke: (c, token) => ({ url: `https://api.github.com/applications/${encodeURIComponent(c.clientId)}/grant`, init: { method: 'DELETE', headers: { authorization: basic(c), accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'quorum-relay' }, body: JSON.stringify({ access_token: token }) } }),
  },
};

const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
const fail = (res, err, log, what) => {
  const status = err instanceof RelayError ? err.status : 500;
  log(`${what}_failed`, { status, code: err.code ?? 'server' });
  json(res, status, { error: err instanceof RelayError ? err.message : 'Connections are unavailable right now.', code: err.code ?? 'server' });
};

const providerName = (p) => String(p ?? '').trim().toLowerCase();
function requireProvider(name) {
  if (!Object.hasOwn(OAUTH_PROVIDERS, name)) throw new RelayError('bad_request', 'Unknown provider.', 404);
  return OAUTH_PROVIDERS[name];
}
function requireCredentials(config, name) {
  const c = config.oauth?.[name];
  if (!c?.clientId || !c?.clientSecret) throw new RelayError('connector', `${name[0].toUpperCase()}${name.slice(1)} is not set up on this relay.`, 503);
  return c;
}

// the redirect URIs a code may have been issued for: this relay's own callback for the provider, plus any the
// operator lists in OAUTH_EXTRA_REDIRECT_URIS (a self-hosted or development relay)
export function allowedRedirects(config, provider) {
  const base = String(config.publicUrl ?? '').replace(/\/+$/, '');
  return [...(base ? [`${base}/v1/oauth/${provider}/callback`] : []), ...(config.oauthExtraRedirects ?? [])];
}

// GET /v1/oauth/<provider>/callback: only the app's loopback can be the destination, so a forged state cannot send
// the browser anywhere else
export function handleOAuthCallback(req, res, { log = () => {} } = {}) {
  const url = new URL(req.url, 'http://relay');
  const provider = providerName(url.pathname.split('/')[3]);
  if (!Object.hasOwn(OAUTH_PROVIDERS, provider)) return json(res, 404, { error: 'Unknown provider.', code: 'bad_request' });
  if (req.method !== 'GET') return json(res, 405, { error: 'GET only.', code: 'bad_request' });
  log('oauth_callback', { provider, ok: !!url.searchParams.get('code') });
  bounceToLoopback(url, res);
}

// a JSON body that is an object, or a 400 with a plain message (null, an array or a bare value is not a request)
const objectBody = (b) => { if (!b || typeof b !== 'object' || Array.isArray(b)) throw new RelayError('bad_request', 'The body must be a JSON object.', 400); return b; };

// the body the app sent, checked and bounded; snake_case on the wire as OAuth names the fields
export function cleanTokenRequest(raw) {
  const b = objectBody(raw);
  const provider = providerName(b.provider);
  const str = (v, max = 4096) => { const s = String(v ?? ''); if (s.length > max) throw new RelayError('bad_request', 'The sign-in details are too long.', 400); return s; };
  if (b.grant_type === 'refresh_token') {
    const refreshToken = str(b.refresh_token);
    if (!refreshToken) throw new RelayError('bad_request', 'The refresh token is missing.', 400);
    return { provider, grant: 'refresh', refreshToken };
  }
  const code = str(b.code), codeVerifier = str(b.code_verifier, 256), redirectUri = str(b.redirect_uri, 512);
  if (!code || !redirectUri) throw new RelayError('bad_request', 'The sign-in details are incomplete.', 400);
  return { provider, grant: 'code', code, codeVerifier: codeVerifier || null, redirectUri };
}

// two limits on the token and revoke routes (the callback is not counted): per caller address, plenty for people
// connecting accounts and little for a script; and per provider across all callers, so many addresses together cannot
// spend the relay's standing with one provider
export function createOAuthLimits({ perAddress = 30, perProvider = 600, windowMs = 10 * 60 * 1000, now = Date.now } = {}) {
  const address = createLimiter({ max: perAddress, windowMs, now });
  const provider = createLimiter({ max: perProvider, windowMs, now });
  return {
    address: (req) => { if (!address.allow(clientAddress(req))) throw new RelayError('rate_limit', 'Too many requests from this connection. Try again in a few minutes.', 429); },
    provider: (name) => { if (!provider.allow(name)) throw new RelayError('rate_limit', 'Too many sign-ins for this provider right now. Try again in a few minutes.', 429); },
  };
}
const sharedLimits = createOAuthLimits();

// the provider's answer as an object; anything else (null, text, an array) reads as an empty answer, which fails ok()
const providerBody = async (r) => { const t = await r.json().catch(() => null); return t && typeof t === 'object' && !Array.isArray(t) ? t : {}; };

export async function handleOAuthToken(req, res, { config, log = () => {}, fetchImpl = fetch, limits = sharedLimits, now = Date.now }) {
  try {
    if (req.method !== 'POST') throw new RelayError('bad_request', 'POST only.', 405);
    limits.address(req);
    const b = cleanTokenRequest(await readJson(req, 32 * 1024));
    const p = requireProvider(b.provider);
    limits.provider(b.provider);
    if (b.grant === 'code' && !allowedRedirects(config, b.provider).includes(b.redirectUri)) throw new RelayError('bad_request', 'That redirect address is not allowed.', 400);
    const creds = requireCredentials(config, b.provider);
    const { url, init } = p.token(creds, b);
    const r = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(20000) });
    const t = await providerBody(r);
    if (!r.ok || !p.ok(t)) {
      log('oauth_token_refused', { provider: b.provider, grant: b.grant, status: r.status });
      throw new RelayError('connector', b.grant === 'refresh' ? 'The provider no longer accepts this connection. Connect it again.' : 'The provider did not accept the sign-in. Try connecting again.', 400);
    }
    log('oauth_token', { provider: b.provider, grant: b.grant });
    json(res, 200, p.shape(t, now()));
  } catch (err) { fail(res, err, log, 'oauth_token'); }
}

export async function handleOAuthRevoke(req, res, { config, log = () => {}, fetchImpl = fetch, limits = sharedLimits }) {
  try {
    if (req.method !== 'POST') throw new RelayError('bad_request', 'POST only.', 405);
    limits.address(req);
    const b = objectBody(await readJson(req, 16 * 1024));
    const provider = providerName(b.provider);
    const p = requireProvider(provider);
    if (!p.revoke) throw new RelayError('bad_request', 'This provider is revoked from the app.', 400);
    limits.provider(provider);
    const token = String(b.token ?? '');
    if (!token || token.length > 4096) throw new RelayError('bad_request', 'The token is missing.', 400);
    const { url, init } = p.revoke(requireCredentials(config, provider), token);
    const r = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(20000) });
    // 200 and 204 confirm the revoke and 404 means the provider already forgot the token. 401 and 403 mean the provider
    // refused this relay's client credentials, so the token is still live: that is a failure the operator must see
    if (r.status === 401 || r.status === 403) { log('oauth_revoke_rejected', { provider, status: r.status }); throw new RelayError('connector', 'The provider refused the relay\'s credentials, so the token was not revoked.', 502); }
    if (![200, 204, 404].includes(r.status)) { log('oauth_revoke_refused', { provider, status: r.status }); throw new RelayError('connector', 'The provider did not confirm the revoke.', 502); }
    log('oauth_revoke', { provider, status: r.status });
    json(res, 200, { ok: true });
  } catch (err) { fail(res, err, log, 'oauth_revoke'); }
}

// /v1/oauth/token, /v1/oauth/revoke and /v1/oauth/<provider>/callback
export function handleOAuth(req, res, deps) {
  const parts = new URL(req.url, 'http://relay').pathname.split('/').filter(Boolean); // v1, oauth, token|revoke|<provider>, callback
  if (parts.length === 3 && parts[2] === 'token') return handleOAuthToken(req, res, deps);
  if (parts.length === 3 && parts[2] === 'revoke') return handleOAuthRevoke(req, res, deps);
  if (parts.length === 4 && parts[3] === 'callback') return handleOAuthCallback(req, res, deps);
  json(res, 404, { error: 'not found', code: 'bad_request' });
}

// which providers this relay can serve, for /healthz
export const oauthStatus = (config) => Object.fromEntries(Object.keys(OAUTH_PROVIDERS).map((k) => [k, !!(config.oauth?.[k]?.clientId && config.oauth?.[k]?.clientSecret)]));
