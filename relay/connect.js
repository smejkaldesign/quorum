// Platform connections for Quorum Cloud, Zoom first. Four jobs: bounce the platform's OAuth callback back to the app
// on the user's Mac (platforms refuse loopback redirect URIs, so the relay is the registered one); exchange and
// refresh tokens with the client secret, which stays here; remember which platform accounts belong to a user; and
// take the platform's webhooks (recording.completed) until the user's app fetches and acknowledges them. Recordings
// never pass through here: the app downloads them from the platform itself.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { bearer, RelayError, requireMember, requirePlan, verifyToken } from './lib/auth.js';
import { readJson } from './summary.js';

export const PROVIDERS = {
  zoom: { tokenUrl: 'https://zoom.us/oauth/token', events: ['recording.completed', 'recording.transcript_completed'] },
};
export const LOOPBACK_PORT = 47832;
const MAX_BODY = 512 * 1024;

const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
const fail = (res, err, log, what) => {
  const status = err instanceof RelayError ? err.status : 500;
  log(`${what}_failed`, { status, message: err.message });
  json(res, status, { error: err instanceof RelayError ? err.message : 'Connections are unavailable right now.', code: err.code ?? 'server' });
};
const providerOf = (pathname) => pathname.split('/')[3] ?? '';
const requireProvider = (name) => { if (!PROVIDERS[name]) throw new RelayError('bad_request', 'Unknown platform.', 404); return PROVIDERS[name]; };
const requireCredentials = (config, name) => {
  const c = config.connect?.[name];
  if (!c?.clientId || !c?.clientSecret) throw new RelayError('connector', `${name[0].toUpperCase()}${name.slice(1)} connections are not set up on this relay.`, 503);
  return c;
};

// the app's loopback listener; the state the app made ends in .p<port> when it listens somewhere other than the default
export function loopbackFor(state) {
  const m = /\.p(\d{4,5})$/.exec(String(state ?? ''));
  const port = m ? Number(m[1]) : LOOPBACK_PORT;
  return port >= 1024 && port <= 65535 ? port : LOOPBACK_PORT;
}

// GET /v1/connect/<provider>/callback: the platform lands here with code and state (or an error) and the browser is
// sent on to the app. Only the loopback can be the destination, so a forged state buys nothing.
export function handleCallback(req, res, { log = () => {} } = {}) {
  const url = new URL(req.url, 'http://relay');
  const provider = providerOf(url.pathname);
  if (!PROVIDERS[provider]) return json(res, 404, { error: 'Unknown platform.', code: 'bad_request' });
  if (req.method !== 'GET') return json(res, 405, { error: 'GET only.', code: 'bad_request' });
  const out = new URL(`http://127.0.0.1:${loopbackFor(url.searchParams.get('state'))}/callback`);
  for (const k of ['code', 'state', 'error', 'error_description']) { const v = url.searchParams.get(k); if (v) out.searchParams.set(k, v); }
  log('connect_callback', { provider, ok: !!url.searchParams.get('code') });
  res.writeHead(302, { location: out.toString(), 'cache-control': 'no-store' });
  res.end();
}

// who is asking, on a workspace that pays for Cloud
async function caller(req, { clients }, body) {
  const workspaceId = body.workspaceId ?? new URL(req.url, 'http://relay').searchParams.get('workspace');
  if (!workspaceId) throw new RelayError('bad_request', 'Pick a workspace first.', 400);
  const user = await verifyToken(clients.anon, bearer(req.headers.authorization));
  await requireMember(clients.db, workspaceId, user.userId);
  await requirePlan(clients.db, workspaceId);
  return { ...user, workspaceId };
}

// the platform's token response in the app's shape
export const tokenShape = (t, now = Date.now()) => ({
  accessToken: t.access_token,
  refreshToken: t.refresh_token ?? null,
  expiresAt: t.expires_in ? now + Number(t.expires_in) * 1000 : null,
  scope: t.scope ?? null,
});

// POST /v1/connect/<provider>/token: { grant: 'code', code, codeVerifier, redirectUri } or { grant: 'refresh', refreshToken }
export async function handleToken(req, res, deps) {
  const { config, log = () => {}, fetchImpl = fetch } = deps;
  try {
    if (req.method !== 'POST') throw new RelayError('bad_request', 'POST only.', 405);
    const provider = providerOf(new URL(req.url, 'http://relay').pathname);
    const p = requireProvider(provider);
    const body = await readJson(req, MAX_BODY);
    await caller(req, deps, body);
    const creds = requireCredentials(config, provider);
    const form = new URLSearchParams(body.grant === 'refresh'
      ? { grant_type: 'refresh_token', refresh_token: String(body.refreshToken ?? '') }
      : { grant_type: 'authorization_code', code: String(body.code ?? ''), redirect_uri: String(body.redirectUri ?? ''), code_verifier: String(body.codeVerifier ?? '') });
    if (body.grant === 'refresh' ? !body.refreshToken : !(body.code && body.codeVerifier && body.redirectUri)) throw new RelayError('bad_request', 'The sign-in details are incomplete.', 400);
    const r = await fetchImpl(p.tokenUrl, {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const t = await r.json().catch(() => ({}));
    if (!r.ok || !t.access_token) {
      log('connect_token_refused', { provider, status: r.status, reason: t.reason ?? t.error ?? null });
      throw new RelayError('connector', body.grant === 'refresh' ? 'The platform no longer accepts this connection. Connect it again.' : 'The platform did not accept the sign-in. Try connecting again.', 400);
    }
    log('connect_token', { provider, grant: body.grant === 'refresh' ? 'refresh' : 'code' });
    json(res, 200, tokenShape(t));
  } catch (err) { fail(res, err, log, 'connect_token'); }
}

// POST /v1/connect/<provider>/account { workspaceId, accountId, externalUserId } remembers the account; DELETE forgets it
export async function handleAccount(req, res, deps) {
  const { clients, log = () => {} } = deps;
  try {
    const provider = providerOf(new URL(req.url, 'http://relay').pathname);
    requireProvider(provider);
    if (req.method !== 'POST' && req.method !== 'DELETE') throw new RelayError('bad_request', 'POST or DELETE.', 405);
    const body = await readJson(req, MAX_BODY);
    const user = await caller(req, deps, body);
    const accountId = String(body.accountId ?? '').trim();
    if (!accountId) throw new RelayError('bad_request', 'The platform account id is missing.', 400);
    if (req.method === 'DELETE') {
      const { error } = await clients.db.from('connect_accounts').delete().eq('user_id', user.userId).eq('provider', provider).eq('account_id', accountId);
      if (error) throw new RelayError('server', 'The connection could not be removed.', 500);
      log('connect_account_removed', { provider });
      return json(res, 200, { ok: true });
    }
    const { error } = await clients.db.from('connect_accounts').insert({ user_id: user.userId, provider, account_id: accountId, external_user_id: body.externalUserId ? String(body.externalUserId) : null });
    if (error && error.code !== '23505') throw new RelayError('server', 'The connection could not be saved.', 500);
    log('connect_account', { provider, existed: error?.code === '23505' });
    json(res, 200, { ok: true });
  } catch (err) { fail(res, err, log, 'connect_account'); }
}

// Zoom signs every delivery: x-zm-signature is v0=HMAC-SHA256(secret, "v0:<timestamp>:<body>")
export function verifyZoomSignature(body, headers, secret, { now = Date.now(), toleranceSec = 300 } = {}) {
  const ts = Number(headers['x-zm-request-timestamp']);
  const sig = String(headers['x-zm-signature'] ?? '');
  if (!secret || !ts || !sig.startsWith('v0=')) return false;
  if (Math.abs(now / 1000 - ts) > toleranceSec) return false;
  const expected = Buffer.from(`v0=${createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`);
  const got = Buffer.from(sig);
  return got.length === expected.length && timingSafeEqual(expected, got);
}
// Zoom checks the endpoint is ours by sending a token to hash with the secret
export const zoomValidation = (plainToken, secret) => ({ plainToken, encryptedToken: createHmac('sha256', secret).update(String(plainToken)).digest('hex') });

const readText = (req, limit = MAX_BODY) => new Promise((resolve, reject) => {
  let size = 0; const chunks = [];
  req.on('data', (c) => { size += c.length; if (size > limit) { reject(new RelayError('bad_request', 'The request is too large.', 413)); req.destroy(); return; } chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

// POST /v1/connect/zoom/webhook: answer the URL check, keep the events the app wants, drop the rest. Zoom retries a
// delivery it did not get a 2xx for, so a repeat of the same recording is fine (the unique index swallows it).
export async function handleZoomWebhook(req, res, deps) {
  const { clients, config, log = () => {}, now = () => Date.now() } = deps;
  try {
    if (req.method !== 'POST') throw new RelayError('bad_request', 'POST only.', 405);
    const secret = config.connect?.zoom?.webhookSecret;
    if (!secret) throw new RelayError('connector', 'Zoom webhooks are not set up on this relay.', 503);
    const raw = await readText(req);
    if (!verifyZoomSignature(raw, req.headers, secret, { now: now() })) throw new RelayError('unauthorized', 'The signature does not match.', 401);
    let body;
    try { body = JSON.parse(raw); } catch { throw new RelayError('bad_request', 'The body must be JSON.', 400); }
    if (body.event === 'endpoint.url_validation') return json(res, 200, zoomValidation(body.payload?.plainToken ?? '', secret));
    if (!PROVIDERS.zoom.events.includes(body.event)) { log('connect_webhook_ignored', { provider: 'zoom', event: body.event }); return json(res, 200, { ok: true, ignored: true }); }
    const accountId = body.payload?.account_id;
    if (!accountId) throw new RelayError('bad_request', 'The event names no account.', 400);
    const { error } = await clients.db.from('connect_events').insert({ provider: 'zoom', account_id: String(accountId), event: body.event, external_id: body.payload?.object?.uuid ? String(body.payload.object.uuid) : null, payload: body.payload });
    if (error && error.code !== '23505') throw new RelayError('server', 'The event could not be stored.', 500);
    log('connect_webhook', { provider: 'zoom', event: body.event, repeat: error?.code === '23505' });
    json(res, 200, { ok: true });
  } catch (err) { fail(res, err, log, 'connect_webhook'); }
}

// GET /v1/connect/events?workspace=&provider=zoom: what the platforms sent for this user's accounts and the app has not
// acknowledged; POST /v1/connect/events/ack { workspaceId, ids } once the app has acted on them
export async function handleEvents(req, res, deps) {
  const { clients, log = () => {} } = deps;
  try {
    const url = new URL(req.url, 'http://relay');
    const ack = url.pathname.endsWith('/ack');
    if (ack ? req.method !== 'POST' : req.method !== 'GET') throw new RelayError('bad_request', ack ? 'POST only.' : 'GET only.', 405);
    const body = ack ? await readJson(req, MAX_BODY) : {};
    const user = await caller(req, deps, body);
    const provider = ack ? String(body.provider ?? 'zoom') : (url.searchParams.get('provider') ?? 'zoom');
    requireProvider(provider);
    const accounts = await clients.db.from('connect_accounts').select('account_id').eq('user_id', user.userId).eq('provider', provider);
    if (accounts.error) throw new RelayError('server', 'The connections could not be read.', 500);
    const ids = (accounts.data ?? []).map((a) => a.account_id);
    if (ack) {
      const wanted = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isFinite) : [];
      if (!wanted.length || !ids.length) return json(res, 200, { ok: true, acked: 0 });
      const { error } = await clients.db.from('connect_events').update({ delivered_at: new Date().toISOString() }).in('id', wanted).in('account_id', ids).is('delivered_at', null);
      if (error) throw new RelayError('server', 'The events could not be acknowledged.', 500);
      log('connect_events_ack', { provider, count: wanted.length });
      return json(res, 200, { ok: true, acked: wanted.length });
    }
    if (!ids.length) return json(res, 200, { events: [] });
    const { data, error } = await clients.db.from('connect_events').select('id, event, external_id, payload, received_at').eq('provider', provider).in('account_id', ids).is('delivered_at', null).order('received_at');
    if (error) throw new RelayError('server', 'The events could not be read.', 500);
    json(res, 200, { events: data ?? [] });
  } catch (err) { fail(res, err, log, 'connect_events'); }
}

// /v1/connect/<provider>/callback|token|account|webhook and /v1/connect/events[/ack]
export function handleConnect(req, res, deps) {
  const { pathname } = new URL(req.url, 'http://relay');
  const parts = pathname.split('/').filter(Boolean); // v1, connect, <provider>|events, <action>
  if (parts[2] === 'events') return handleEvents(req, res, deps);
  const action = parts[3];
  if (action === 'callback') return handleCallback(req, res, deps);
  if (action === 'token') return handleToken(req, res, deps);
  if (action === 'account') return handleAccount(req, res, deps);
  if (action === 'webhook' && parts[2] === 'zoom') return handleZoomWebhook(req, res, deps);
  json(res, 404, { error: 'not found', code: 'bad_request' });
}
