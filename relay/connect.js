// Platform connections for Quorum Cloud, Zoom first. Four jobs: bounce the platform's OAuth callback back to the app
// on the user's Mac (platforms refuse loopback redirect URIs, so the relay is the registered one); exchange and
// refresh tokens with the client secret, which stays here; remember which platform accounts belong to a user; and
// take the platform's webhooks (recording.completed, an AI Companion summary or a My Notes note finished) until the
// user's app fetches and acknowledges them. Recordings and notes never pass through here: the app downloads them from
// the platform itself. An event is stored as routing data only (eventRoute: ids, host or operator, start time); a
// summary's text, a recording's download links and a meeting's password are dropped before the insert, and the
// hourly purge deletes delivered events and anything older than seven days (connect_events_purge, migration 0048).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { bearer, RelayError, requireMember, requirePlan, verifyToken } from './lib/auth.js';
import { readJson } from './summary.js';

export const PROVIDERS = {
  zoom: {
    tokenUrl: 'https://zoom.us/oauth/token',
    meUrl: 'https://api.zoom.us/v2/users/me',
    events: ['recording.completed', 'recording.transcript_completed', 'meeting.summary_completed', 'my_notes.note_completed', 'my_notes.transcript_generated'],
  },
};
// the fields the app needs to route an event to its owner and find the meeting; everything else Zoom sends (summary
// text, recording links, passwords, topics, emails) never reaches the database
const ROUTE_TOP = ['account_id', 'operator_id'];
const ROUTE_OBJECT = ['id', 'uuid', 'host_id', 'start_time', 'meeting_uuid', 'meeting_id', 'meeting_host_id', 'meeting_start_time', 'note_id'];
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o?.[k] != null && typeof o[k] !== 'object').map((k) => [k, o[k]]));
export const eventRoute = (payload = {}) => ({ ...pick(payload, ROUTE_TOP), object: pick(payload?.object, ROUTE_OBJECT) });
// the id an event is stored once under: the recording's uuid, the summarized meeting's uuid, or the note's id
export const eventExternalId = (object = {}) => {
  const v = object.uuid ?? object.meeting_uuid ?? object.note_id;
  return v ? String(v) : null;
};
export const LOOPBACK_PORT = 47832;
// the only loopback ports a callback may send the browser to: the one the app listens on for every sign-in
export const LOOPBACK_PORTS = [LOOPBACK_PORT];
const MAX_BODY = 512 * 1024;

const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
const fail = (res, err, log, what) => {
  const status = err instanceof RelayError ? err.status : 500;
  log(`${what}_failed`, { status, message: err.message });
  json(res, status, { error: err instanceof RelayError ? err.message : 'Connections are unavailable right now.', code: err.code ?? 'server' });
};
// an RFC 7636 code verifier: 43 to 128 unreserved characters
export const isVerifier = (v) => typeof v === 'string' && /^[A-Za-z0-9._~-]{43,128}$/.test(v);
const providerOf = (pathname) => pathname.split('/')[3] ?? '';
const requireProvider = (name) => { if (!PROVIDERS[name]) throw new RelayError('bad_request', 'Unknown platform.', 404); return PROVIDERS[name]; };
const requireCredentials = (config, name) => {
  const c = config.connect?.[name];
  if (!c?.clientId || !c?.clientSecret) throw new RelayError('connector', `${name[0].toUpperCase()}${name.slice(1)} connections are not set up on this relay.`, 503);
  return c;
};

// the app's loopback listener; the state the app made may end in .p<port>, which counts only for a port in
// LOOPBACK_PORTS, so a crafted state cannot send a code to another local listener
export function loopbackFor(state) {
  const m = /\.p(\d{4,5})$/.exec(String(state ?? ''));
  const port = m ? Number(m[1]) : LOOPBACK_PORT;
  return LOOPBACK_PORTS.includes(port) ? port : LOOPBACK_PORT;
}

// GET /v1/connect/<provider>/callback: the platform lands here with code and state (or an error) and the browser is
// sent on to the app. Only the loopback can be the destination, so a forged state buys nothing.
export function handleCallback(req, res, { log = () => {} } = {}) {
  const url = new URL(req.url, 'http://relay');
  const provider = providerOf(url.pathname);
  if (!PROVIDERS[provider]) return json(res, 404, { error: 'Unknown platform.', code: 'bad_request' });
  if (req.method !== 'GET') return json(res, 405, { error: 'GET only.', code: 'bad_request' });
  log('connect_callback', { provider, ok: !!url.searchParams.get('code') });
  bounceToLoopback(url, res);
}

// the redirect both callback routes answer with (this file's platforms, oauth.js's personal connectors): the app's
// loopback with the code, state or error the provider sent, bounded in length
export function bounceToLoopback(url, res) {
  const out = new URL(`http://127.0.0.1:${loopbackFor(url.searchParams.get('state'))}/callback`);
  for (const k of ['code', 'state', 'error', 'error_description']) { const v = url.searchParams.get(k); if (v) out.searchParams.set(k, v.slice(0, 2048)); }
  res.writeHead(302, { location: out.toString(), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
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
    if (body.grant !== 'refresh' && !isVerifier(body.codeVerifier)) throw new RelayError('bad_request', 'The sign-in verifier is not valid.', 400);
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

// the platform account behind an access token, asked of the platform itself. The ids a client sends are never used:
// a caller who could name any account id would receive that account's recording events.
export async function platformIdentity(p, accessToken, fetchImpl = fetch) {
  if (!accessToken) throw new RelayError('bad_request', 'Connect the platform again: the relay needs the access token to confirm the account.', 400);
  const r = await fetchImpl(p.meUrl, { headers: { authorization: `Bearer ${accessToken}` } });
  const me = await r.json().catch(() => ({}));
  if (!r.ok || !me?.id || !me?.account_id) throw new RelayError('connector', 'The platform did not confirm the account. Connect it again.', 400);
  return { accountId: String(me.account_id), externalUserId: String(me.id) };
}

// POST /v1/connect/<provider>/account { workspaceId, accessToken } remembers the account the token belongs to; DELETE
// { workspaceId, accountId } forgets the caller's own row for that account
export async function handleAccount(req, res, deps) {
  const { clients, log = () => {}, fetchImpl = fetch } = deps;
  try {
    const provider = providerOf(new URL(req.url, 'http://relay').pathname);
    const p = requireProvider(provider);
    if (req.method !== 'POST' && req.method !== 'DELETE') throw new RelayError('bad_request', 'POST or DELETE.', 405);
    const body = await readJson(req, MAX_BODY);
    const user = await caller(req, deps, body);
    if (req.method === 'DELETE') {
      const accountId = String(body.accountId ?? '').trim();
      if (!accountId) throw new RelayError('bad_request', 'The platform account id is missing.', 400);
      const { error } = await clients.db.from('connect_accounts').delete().eq('user_id', user.userId).eq('provider', provider).eq('account_id', accountId);
      if (error) throw new RelayError('server', 'The connection could not be removed.', 500);
      log('connect_account_removed', { provider });
      return json(res, 200, { ok: true });
    }
    const { accountId, externalUserId } = await platformIdentity(p, String(body.accessToken ?? '').trim(), fetchImpl);
    const { error } = await clients.db.from('connect_accounts').insert({ user_id: user.userId, provider, account_id: accountId, external_user_id: externalUserId });
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
    const { error } = await clients.db.from('connect_events').insert({ provider: 'zoom', account_id: String(accountId), event: body.event, external_id: eventExternalId(body.payload?.object), payload: eventRoute(body.payload) });
    if (error && error.code !== '23505') throw new RelayError('server', 'The event could not be stored.', 500);
    log('connect_webhook', { provider: 'zoom', event: body.event, repeat: error?.code === '23505' });
    json(res, 200, { ok: true });
  } catch (err) { fail(res, err, log, 'connect_webhook'); }
}

// GET /v1/connect/events?workspace=&provider=zoom: what the platforms sent for this user's accounts and the app has not
// acknowledged; POST /v1/connect/events/ack { workspaceId, ids } once the app has acted on them. An account id names a
// whole Zoom organization, so an event belongs to the caller only when it names the Zoom user the relay verified: as the
// host of a recording (host_id) or of a summarized meeting (meeting_host_id), or as the operator of a My Notes event
// (those carry no host)
const OWNER_PATHS = ['payload->object->>host_id', 'payload->object->>meeting_host_id', 'payload->>operator_id'];
async function pendingFor(db, provider, owned) {
  const byId = new Map();
  for (const a of owned) {
    for (const who of OWNER_PATHS) {
      const { data, error } = await db.from('connect_events').select('id, event, external_id, payload, received_at').eq('provider', provider).eq('account_id', a.account_id).eq(who, a.external_user_id).is('delivered_at', null).order('received_at');
      if (error) throw new RelayError('server', 'The events could not be read.', 500);
      for (const e of data ?? []) byId.set(e.id, e);
    }
  }
  return [...byId.values()].sort((x, y) => String(x.received_at).localeCompare(String(y.received_at)));
}
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
    const accounts = await clients.db.from('connect_accounts').select('account_id, external_user_id').eq('user_id', user.userId).eq('provider', provider);
    if (accounts.error) throw new RelayError('server', 'The connections could not be read.', 500);
    const owned = (accounts.data ?? []).filter((a) => a.account_id && a.external_user_id);
    if (ack) {
      const wanted = new Set(Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isFinite) : []);
      if (!wanted.size || !owned.length) return json(res, 200, { ok: true, acked: 0 });
      // only ids this caller could have listed are marked delivered
      const ids = (await pendingFor(clients.db, provider, owned)).map((e) => e.id).filter((id) => wanted.has(id));
      if (ids.length) {
        const { error } = await clients.db.from('connect_events').update({ delivered_at: new Date().toISOString() }).in('id', ids).eq('provider', provider).is('delivered_at', null);
        if (error) throw new RelayError('server', 'The events could not be acknowledged.', 500);
      }
      log('connect_events_ack', { provider, count: ids.length });
      return json(res, 200, { ok: true, acked: ids.length });
    }
    if (!owned.length) return json(res, 200, { events: [] });
    json(res, 200, { events: await pendingFor(clients.db, provider, owned) });
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

export const EVENTS_PURGE_EVERY_MS = 60 * 60 * 1000;
// the hourly sweep: delivered events, and undelivered ones older than seven days, are deleted (migration 0048). A
// failure (the migration not applied yet) is logged and the next tick tries again
export function createConnectEventsPurge({ db, log = () => {}, everyMs = EVENTS_PURGE_EVERY_MS }) {
  let timer = null;
  async function run() {
    try {
      const { data, error } = await db.rpc('connect_events_purge');
      if (error) throw new Error(error.message || 'connect_events_purge failed');
      if (data?.deleted) log('connect_events_purged', { deleted: data.deleted });
      return data ?? null;
    } catch (err) { log('connect_events_purge_failed', { message: err.message }); return null; }
  }
  return {
    run,
    start() { if (timer) return; run(); timer = setInterval(run, everyMs); timer.unref?.(); },
    stop() { clearInterval(timer); timer = null; },
  };
}
