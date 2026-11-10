// OAuth for remote MCP servers (Granola, Wispr Notetaker, Fireflies, Read AI): protected-resource discovery (RFC 9728),
// authorization-server metadata (RFC 8414), dynamic client registration (RFC 7591), PKCE (RFC 7636) and the resource
// indicator (RFC 8707). The browser comes back to a loopback URL this process listens on for one visit. Pure Node, no
// electron import, so the same code runs under vitest against a fake server.
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';

export const LOOPBACK_PORT = 47832;
export const LOOPBACK_REDIRECT = `http://127.0.0.1:${LOOPBACK_PORT}/callback`;
export const CLIENT_NAME = 'Quorum';

const json = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return null; } };
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function pkce() {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

// 401 from the resource names its metadata URL; otherwise the well-known path, with and without the resource path
export function metadataUrls(resourceUrl, wwwAuthenticate = '') {
  const m = /resource_metadata="([^"]+)"/.exec(wwwAuthenticate || '');
  const u = new URL(resourceUrl);
  const out = [];
  if (m) out.push(m[1]);
  out.push(`${u.origin}/.well-known/oauth-protected-resource${u.pathname === '/' ? '' : u.pathname}`);
  out.push(`${u.origin}/.well-known/oauth-protected-resource`);
  return [...new Set(out)];
}

// resource metadata, then the authorization server's metadata; the result carries every endpoint the flow needs
export async function discover(resourceUrl, { fetchImpl = fetch, wwwAuthenticate = '' } = {}) {
  let resource = null;
  for (const url of metadataUrls(resourceUrl, wwwAuthenticate)) {
    try { const r = await fetchImpl(url, { signal: AbortSignal.timeout(15000) }); if (r.ok) { resource = await json(r); if (resource) break; } } catch {}
  }
  const issuer = resource?.authorization_servers?.[0] ?? new URL(resourceUrl).origin;
  const iss = new URL(issuer);
  const candidates = [
    `${iss.origin}/.well-known/oauth-authorization-server${iss.pathname === '/' ? '' : iss.pathname}`,
    `${iss.origin}/.well-known/openid-configuration${iss.pathname === '/' ? '' : iss.pathname}`,
    `${new URL(resourceUrl).origin}/.well-known/oauth-authorization-server`,
  ];
  let as = null;
  for (const url of candidates) {
    try { const r = await fetchImpl(url, { signal: AbortSignal.timeout(15000) }); if (r.ok) { as = await json(r); if (as?.authorization_endpoint && as?.token_endpoint) break; as = null; } } catch {}
  }
  if (!as) throw new Error('The service did not publish its sign-in endpoints.');
  if (!as.code_challenge_methods_supported?.includes('S256') && as.code_challenge_methods_supported) throw new Error('The service does not support PKCE.');
  const scopes = resource?.scopes_supported ?? [];
  if (as.scopes_supported?.includes('offline_access') && !scopes.includes('offline_access')) scopes.push('offline_access');
  return {
    resource: resource?.resource ?? resourceUrl,
    issuer: as.issuer ?? issuer,
    authorizationEndpoint: as.authorization_endpoint,
    tokenEndpoint: as.token_endpoint,
    registrationEndpoint: as.registration_endpoint ?? null,
    revocationEndpoint: as.revocation_endpoint ?? null,
    scopes,
    authMethods: as.token_endpoint_auth_methods_supported ?? ['client_secret_basic'],
  };
}

// a public client (no secret) when the server allows it, so nothing secret needs keeping for the registration
export async function register(meta, { redirectUri = LOOPBACK_REDIRECT, clientName = CLIENT_NAME, fetchImpl = fetch } = {}) {
  if (!meta.registrationEndpoint) throw new Error('The service does not allow apps to register themselves.');
  const body = {
    client_name: clientName,
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: meta.authMethods.includes('none') ? 'none' : 'client_secret_post',
    application_type: 'native',
  };
  const r = await fetchImpl(meta.registrationEndpoint, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const data = await json(r);
  if (!r.ok || !data?.client_id) throw new Error(data?.error_description || data?.error || `Registration failed (${r.status}).`);
  return { clientId: data.client_id, clientSecret: data.client_secret ?? null, redirectUri, authMethod: body.token_endpoint_auth_method };
}

// prompt=select_account asks the sign-in page to offer an account chooser instead of reusing the browser's session;
// servers that do not know the parameter ignore it
export function authorizeUrl(meta, { clientId, redirectUri, challenge, state, scopes = meta.scopes, prompt = 'select_account' }) {
  const u = new URL(meta.authorizationEndpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('state', state);
  u.searchParams.set('resource', meta.resource);
  if (scopes?.length) u.searchParams.set('scope', scopes.join(' '));
  if (prompt) u.searchParams.set('prompt', prompt);
  return u.toString();
}

const tokenRequest = async (meta, client, params, fetchImpl) => {
  const body = new URLSearchParams({ ...params, client_id: client.clientId, resource: meta.resource });
  const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  if (client.clientSecret) {
    if (client.authMethod === 'client_secret_basic') headers.authorization = `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString('base64')}`;
    else body.set('client_secret', client.clientSecret);
  }
  const r = await fetchImpl(meta.tokenEndpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(20000) });
  const data = await json(r);
  if (!r.ok || !data?.access_token) { const e = new Error(data?.error_description || data?.error || `Token request failed (${r.status}).`); e.code = data?.error ?? null; throw e; }
  return { accessToken: data.access_token, refreshToken: data.refresh_token ?? null, tokenType: data.token_type ?? 'Bearer', expiresAt: data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : null, scope: data.scope ?? null };
};

export const exchange = (meta, client, { code, verifier, redirectUri }, fetchImpl = fetch) =>
  tokenRequest(meta, client, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri }, fetchImpl);

export const refresh = (meta, client, refreshToken, fetchImpl = fetch) =>
  tokenRequest(meta, client, { grant_type: 'refresh_token', refresh_token: refreshToken }, fetchImpl).then((t) => ({ ...t, refreshToken: t.refreshToken ?? refreshToken }));

// one browser visit on the loopback: resolves with the query (code, state or error), answers the tab with a short page
export function awaitLoopback({ port = LOOPBACK_PORT, path = '/callback', timeoutMs = 5 * 60 * 1000, page = loopbackPage } = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, `http://127.0.0.1:${port}`);
      if (u.pathname !== path) { res.writeHead(404); res.end(); return; }
      const q = Object.fromEntries(u.searchParams.entries());
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page(q));
      finish(() => resolve(q));
    });
    const finish = (fn) => { if (done) return; done = true; clearTimeout(timer); server.close(); fn(); };
    const timer = setTimeout(() => finish(() => reject(new Error('The sign-in did not finish within five minutes.'))), timeoutMs);
    timer.unref?.();
    server.on('error', (err) => finish(() => reject(err.code === 'EADDRINUSE' ? new Error('Another sign-in is already waiting. Finish it or try again in a minute.') : err)));
    server.listen(port, '127.0.0.1');
  });
}

export const loopbackPage = (q) => `<!doctype html><title>Quorum</title><body style="font: 16px -apple-system, sans-serif; padding: 40px; color: #111"><p>${
  q.error ? `Sign-in did not finish: ${String(q.error_description || q.error).replace(/[<>&]/g, '')}.` : 'Connected. You can close this tab and go back to Quorum.'}</p>`;

// the whole flow: metadata, client (reused when one is saved), browser, loopback, token exchange
export async function connect({ resourceUrl, open, clients, fetchImpl = fetch, redirectUri = LOOPBACK_REDIRECT, loopback = awaitLoopback }) {
  const meta = await discover(resourceUrl, { fetchImpl });
  let client = await clients.get(meta.issuer);
  if (!client || client.redirectUri !== redirectUri) { client = await register(meta, { redirectUri, fetchImpl }); await clients.set(meta.issuer, client); }
  const { verifier, challenge } = pkce();
  const state = b64url(randomBytes(16));
  const waiting = loopback();
  await open(authorizeUrl(meta, { clientId: client.clientId, redirectUri, challenge, state }));
  const q = await waiting;
  if (q.error) throw new Error(q.error_description || q.error);
  if (q.state !== state) throw new Error('The sign-in answer did not match the request.');
  if (!q.code) throw new Error('The sign-in did not return a code.');
  let tokens;
  try { tokens = await exchange(meta, client, { code: q.code, verifier, redirectUri }, fetchImpl); }
  catch (err) {
    // a stale registration (server forgot the client) is the one failure worth one retry with a fresh client
    if (err.code === 'invalid_client') { await clients.set(meta.issuer, null); throw new Error('The service forgot this app. Click Connect again.'); }
    throw err;
  }
  return { meta, client, tokens };
}
