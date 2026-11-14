// OAuth for remote MCP servers (Granola, Wispr Notetaker, Fireflies, Read AI): protected-resource discovery (RFC 9728),
// authorization-server metadata (RFC 8414), dynamic client registration (RFC 7591), PKCE (RFC 7636) and the resource
// indicator (RFC 8707). The browser comes back to a loopback URL this process listens on for one visit. Pure Node, no
// electron import, so the same code runs under vitest against a fake server.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';

export const LOOPBACK_PORT = 47832;
export const LOOPBACK_REDIRECT = `http://127.0.0.1:${LOOPBACK_PORT}/callback`;
export const CLIENT_NAME = 'Quorum';

// a response body as JSON, or null when it is not; shared with gcal.js and accounts.js
export const json = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return null; } };
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
// the random state every authorization request carries and checks on return
export const newState = () => b64url(randomBytes(16));
// the email claim of an id_token, when the server issued one; never verified here, only shown to the person
export const emailOf = (idToken) => { try { return JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString()).email ?? null; } catch { return null; } };

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
  const scopes = [...(resource?.scopes_supported ?? [])];
  // a refresh token when offered, and the signed-in email when offered, so a refusal can name the account it refused
  for (const extra of ['offline_access', 'openid', 'email']) if (as.scopes_supported?.includes(extra) && !scopes.includes(extra)) scopes.push(extra);
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
  if (prompt) { u.searchParams.set('prompt', prompt); u.searchParams.set('max_age', '0'); }
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
  return { accessToken: data.access_token, refreshToken: data.refresh_token ?? null, tokenType: data.token_type ?? 'Bearer', expiresAt: data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : null, scope: data.scope ?? null, email: emailOf(data.id_token) };
};

export const exchange = (meta, client, { code, verifier, redirectUri }, fetchImpl = fetch) =>
  tokenRequest(meta, client, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri }, fetchImpl);

export const refresh = (meta, client, refreshToken, fetchImpl = fetch) =>
  tokenRequest(meta, client, { grant_type: 'refresh_token', refresh_token: refreshToken }, fetchImpl).then((t) => ({ ...t, refreshToken: t.refreshToken ?? refreshToken }));

// one browser visit on the loopback: resolves with the query (code, state or error), answers the tab with a short page.
// Starting a new wait cancels one still pending, so a second Connect never fails on the busy port
let pending = null;
// ends a sign-in still waiting (a panel closed or its Cancel), which frees the port; the wait rejects with code canceled
export const cancelLoopback = () => { const p = pending; if (!p) return false; p(Object.assign(new Error('The sign-in was cancelled.'), { code: 'canceled' })); return true; };
export function awaitLoopback({ port = LOOPBACK_PORT, path = '/callback', timeoutMs = 5 * 60 * 1000, page = loopbackPage } = {}) {
  pending?.();
  return new Promise((resolve, reject) => {
    let done = false;
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, `http://127.0.0.1:${port}`);
      if (u.pathname !== path) { res.writeHead(404); res.end(); return; }
      const q = Object.fromEntries(u.searchParams.entries());
      // the tab waits for the outcome (token exchange, account check); after 45 s it gets a neutral page
      let answered = false;
      const answer = (html) => { if (answered) return; answered = true; clearTimeout(fallback); res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); };
      const fallback = setTimeout(() => answer(page({ ...q, pending: true })), 45000);
      finish(() => resolve({ ...q, finish: (r) => answer(page({ ...q, ...r })) }));
    });
    const finish = (fn) => { if (done) return; done = true; clearTimeout(timer); server.close(); if (pending === cancel) pending = null; fn(); };
    const cancel = (why) => finish(() => reject(why ?? new Error('Replaced by a newer sign-in.')));
    pending = cancel;
    const timer = setTimeout(() => finish(() => reject(new Error('The sign-in did not finish within five minutes.'))), timeoutMs);
    timer.unref?.();
    server.on('error', (err) => finish(() => reject(err.code === 'EADDRINUSE' ? new Error('Another sign-in is already waiting. Finish it or try again in a minute.') : err)));
    server.listen(port, '127.0.0.1');
  });
}

// the page the browser shows when the flow is over: the site's hero (black frame with dashed rails, drifting blue
// glow with grain, owl wordmark), one line of outcome, one line of what to do
const OWL = (() => { try { return readFileSync(new URL('../assets/quorum-owl.svg', import.meta.url), 'utf8').replace(/<\?xml[^>]*>/, '').replace('<svg ', '<svg class="owl" aria-hidden="true" '); } catch { return ''; } })();
const NOISE = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.12 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E") 0 0 / 180px 180px repeat`;
export const loopbackPage = (q) => {
  const esc = (s) => String(s ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const failed = q.error || q.failed;
  const reason = failed ? String(q.failed || q.error_description || q.error).trim() : '';
  const cut = reason.indexOf('. ');
  const title = q.pending ? 'Almost there' : failed ? esc(cut > 0 ? reason.slice(0, cut) : reason.replace(/\.$/, '')) : `Connected${q.name ? ` to ${esc(q.name)}` : ''}`;
  const body = q.pending ? 'Go back to Quorum to see the result.' : failed ? esc(cut > 0 ? reason.slice(cut + 2) : 'Go back to Quorum to try again.') : 'You can close this tab and go back to Quorum. Your meetings are on their way.';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Quorum</title>
<style>
html,body{height:100%;margin:0}body{background:#0b0b0c;color:#f2f2f3;font:16px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text",Helvetica,Arial,sans-serif}
.frame{position:relative;isolation:isolate;min-height:100vh;width:min(100%,1536px);margin:0 auto;border-left:1px dashed rgba(255,255,255,.16);border-right:1px dashed rgba(255,255,255,.16);display:flex;flex-direction:column;overflow:hidden}
.glow{position:absolute;inset:0;z-index:-1;overflow:hidden;clip-path:inset(0);pointer-events:none;opacity:.75;background:${NOISE},linear-gradient(180deg,#0b2a4d 0%,#0b2a4d 16%,#0066d9 58%,#3399ff 84%,#8ec5ff 100%)}
.glow::before,.glow::after{content:"";position:absolute;inset:-30%;filter:blur(48px);will-change:transform}
.glow::before{background:radial-gradient(closest-side at 28% 58%,rgba(51,153,255,.9),transparent),radial-gradient(closest-side at 74% 70%,rgba(0,102,217,.85),transparent);animation:a 28s ease-in-out infinite alternate}
.glow::after{background:radial-gradient(closest-side at 62% 44%,rgba(142,197,255,.55),transparent),radial-gradient(closest-side at 18% 82%,rgba(0,122,255,.7),transparent);animation:b 36s ease-in-out infinite alternate}
.shade{position:absolute;inset:0;z-index:-1;background:linear-gradient(180deg,rgba(6,14,30,.72),rgba(6,14,30,0) 45%);pointer-events:none}
@keyframes a{from{transform:translate3d(-6%,-4%,0) rotate(0) scale(1)}to{transform:translate3d(7%,5%,0) rotate(14deg) scale(1.12)}}
@keyframes b{from{transform:translate3d(6%,4%,0) rotate(0) scale(1.1)}to{transform:translate3d(-7%,-6%,0) rotate(-12deg) scale(1)}}
header{height:58px;display:flex;align-items:center;padding:0 32px}header a{display:inline-flex;align-items:center;gap:10px;color:inherit;text-decoration:none}.owl{width:22px;height:26px;display:block}header span{font:400 22px/1 "New York",ui-serif,Georgia,serif;letter-spacing:-.01em}
.btn{display:inline-flex;align-items:center;gap:8px;margin-top:28px;padding:0 18px;height:40px;border-radius:999px;background:#fff;color:#0b2a4d;font:500 14px/1 -apple-system,BlinkMacSystemFont,"SF Pro Text",Helvetica,Arial,sans-serif;text-decoration:none}.btn:hover{background:#e9f1ff}
main{flex:1;display:grid;place-items:center;padding:24px 32px 96px;text-align:center}.card{max-width:520px}
.icon{width:64px;height:64px;border-radius:50%;margin:0 auto 24px;display:grid;place-items:center;background:${failed ? 'rgba(255,255,255,.14)' : '#fff'};color:${failed ? '#fff' : '#0b2a4d'};font-size:30px;line-height:1;border:1px solid rgba(255,255,255,.25)}
h1{font:400 44px/1.1 "New York",ui-serif,Georgia,serif;margin:0 0 14px;letter-spacing:-.015em}p{margin:0;font-size:17px;color:rgba(242,242,243,.9)}
@media (prefers-reduced-motion: reduce){.glow::before,.glow::after{animation:none}}
</style></head>
<body><div class="frame"><div class="glow"></div><div class="shade"></div><header><a href="https://quorum.watch" aria-label="Quorum home">${OWL}<span>Quorum</span></a></header>
<main><div class="card"><div class="icon">${failed ? '!' : q.pending ? '…' : '✓'}</div><h1>${title}</h1><p>${body}</p><a class="btn" href="https://quorum.watch">Go to Quorum.watch</a></div></main></div></body></html>`;
};

// the whole flow: metadata, client (reused when one is saved), browser, loopback, token exchange
export async function connect({ resourceUrl, open, clients, fetchImpl = fetch, redirectUri = LOOPBACK_REDIRECT, loopback = awaitLoopback, verify = null, name = null }) {
  const meta = await discover(resourceUrl, { fetchImpl });
  let client = await clients.get(meta.issuer);
  if (!client || client.redirectUri !== redirectUri) { client = await register(meta, { redirectUri, fetchImpl }); await clients.set(meta.issuer, client); }
  const { verifier, challenge } = pkce();
  const state = newState();
  const waiting = loopback();
  await open(authorizeUrl(meta, { clientId: client.clientId, redirectUri, challenge, state }));
  const q = await waiting;
  const tell = (r) => { try { q.finish?.({ name, ...r }); } catch {} };
  const fail = (message, code) => { tell({ failed: message }); const e = new Error(message); if (code) e.code = code; throw e; };
  if (q.error) fail(q.error_description || q.error);
  if (q.state !== state) fail('The sign-in answer did not match the request.');
  if (!q.code) fail('The sign-in did not return a code.');
  let tokens;
  try { tokens = await exchange(meta, client, { code: q.code, verifier, redirectUri }, fetchImpl); }
  catch (err) {
    // a stale registration (server forgot the client) is the one failure worth one retry with a fresh client
    if (err.code === 'invalid_client') { await clients.set(meta.issuer, null); fail('The service forgot this app. Click Connect again.'); }
    fail(err.message);
  }
  if (verify) { try { await verify(tokens); } catch (err) { fail(tokens.email ? err.message.replace(/for this sign-in/, `for ${tokens.email}`) : err.message, 'wrong-account'); } }
  tell({});
  return { meta, client, tokens };
}
