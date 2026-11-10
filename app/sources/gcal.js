// Google Calendar as a calendar source: upcoming events for Home's Up next and for the people on a call, read with the
// person's own Google account. Desktop-type OAuth client with PKCE and the same loopback the MCP sources use. Google
// requires the client secret in the token request for Desktop clients even with PKCE (its docs treat the value as a
// public identifier for installed apps), so the pair comes from the environment, the repo's .env files, or the
// quorumGoogle field electron-builder writes into the packaged package.json, never from this file. Tokens live in the
// Keychain under the source token store. Pure Node apart from the caller-supplied `open`, so vitest runs it as is.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOOPBACK_REDIRECT, awaitLoopback, emailOf, pkce } from './oauth.js';

export const SOURCE_ID = 'google-calendar';
export const SCOPES = ['https://www.googleapis.com/auth/calendar.readonly', 'openid', 'email'];
export const DEFAULT_CLIENT_ID = '247537775138-ms93108a3kv4a50ulnnia80ipfs1hha6.apps.googleusercontent.com';
const AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/calendar/v3';
const MAX_CALENDARS = 10;

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const json = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return null; } };

export function readEnvFile(file) {
  const out = {};
  if (!file || !existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

// the OAuth client, in order: the shell, the repo's .env then .env.development, the packaged package.json. The id has
// a public default; the secret has none, and without it the connector says what to set
export function googleClient({ env = process.env, root = null, packaged = null } = {}) {
  const files = root ? [readEnvFile(path.join(root, '.env')), readEnvFile(path.join(root, '.env.development'))] : [];
  const pick = (key, field) => env[key] || files.map((f) => f[key]).find(Boolean) || packaged?.[field] || null;
  return { clientId: pick('QUORUM_GOOGLE_CLIENT_ID', 'clientId') || DEFAULT_CLIENT_ID, clientSecret: pick('QUORUM_GOOGLE_CLIENT_SECRET', 'clientSecret') };
}

export function authorizeUrl({ clientId, challenge, state, redirectUri = LOOPBACK_REDIRECT, scopes = SCOPES }) {
  const u = new URL(AUTHORIZE);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('state', state);
  u.searchParams.set('scope', scopes.join(' '));
  // a refresh token comes only with offline access and only on a consent screen; select_account lets a second Google
  // account be picked without signing the first out
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent select_account');
  return u.toString();
}

async function tokenRequest(client, params, fetchImpl) {
  const body = new URLSearchParams({ ...params, client_id: client.clientId, client_secret: client.clientSecret ?? '' });
  const r = await fetchImpl(TOKEN, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body, signal: AbortSignal.timeout(20000) });
  const data = await json(r);
  if (!r.ok || !data?.access_token) { const e = new Error(data?.error_description || data?.error || `Google token request failed (${r.status}).`); e.code = data?.error ?? null; throw e; }
  return { accessToken: data.access_token, refreshToken: data.refresh_token ?? null, expiresAt: data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : null, scope: data.scope ?? null, email: emailOf(data.id_token) };
}

export const exchange = (client, { code, verifier, redirectUri = LOOPBACK_REDIRECT }, fetchImpl = fetch) =>
  tokenRequest(client, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri }, fetchImpl);
export const refresh = (client, tokens, fetchImpl = fetch) =>
  tokenRequest(client, { grant_type: 'refresh_token', refresh_token: tokens.refreshToken }, fetchImpl).then((t) => ({ ...t, refreshToken: t.refreshToken ?? tokens.refreshToken, email: t.email ?? tokens.email ?? null }));

// the browser round trip: resolves with the tokens (and the account's email when Google sent an id_token)
export async function connect({ client, open, loopback = awaitLoopback, fetchImpl = fetch, redirectUri = LOOPBACK_REDIRECT }) {
  if (!client?.clientSecret) throw new Error('Google Calendar needs the app\'s Google client secret. Set QUORUM_GOOGLE_CLIENT_SECRET (docs/self-hosting.md, Google Calendar).');
  const { verifier, challenge } = pkce();
  const state = b64url(randomBytes(16));
  const waiting = loopback();
  await open(authorizeUrl({ clientId: client.clientId, challenge, state, redirectUri }));
  const q = await waiting;
  const tell = (r) => { try { q.finish?.({ name: 'Google Calendar', ...r }); } catch {} };
  const fail = (message) => { tell({ failed: message }); throw new Error(message); };
  if (q.error) fail(q.error === 'access_denied' ? 'Google sign-in was cancelled.' : q.error_description || q.error);
  if (q.state !== state) fail('The sign-in answer did not match the request.');
  if (!q.code) fail('The sign-in did not return a code.');
  let tokens;
  try { tokens = await exchange(client, { code: q.code, verifier, redirectUri }, fetchImpl); } catch (err) { fail(err.message); }
  if (!tokens.refreshToken) fail('Google did not issue a refresh token. Remove Quorum under Google Account, Third-party access, then connect again.');
  tell({});
  return tokens;
}

// one Google event in the shape the Calendar app reader emits, so everything downstream (Up next, the call-link
// detection, the invitee list) treats both sources alike. All-day and cancelled entries are not meetings
export function mapEvent(e, calendarId, calendarName = '') {
  if (!e || e.status === 'cancelled' || !e.start?.dateTime || !e.end?.dateTime) return null;
  const video = (e.conferenceData?.entryPoints ?? []).find((p) => p.entryPointType === 'video')?.uri ?? null;
  return {
    id: `google:${calendarId}:${e.id}`,
    title: e.summary || 'Untitled',
    start: new Date(e.start.dateTime).toISOString(),
    end: new Date(e.end.dateTime).toISOString(),
    calendar: calendarName,
    attendees: (e.attendees ?? []).filter((a) => !a.resource).map((a) => ({ name: a.displayName ?? '', email: a.email ?? '' })),
    item: null,
    link: e.htmlLink ?? null,
    recurring: !!e.recurringEventId,
    location: e.location ?? '',
    url: e.hangoutLink ?? video ?? '',
    notes: String(e.description ?? '').slice(0, 1500),
  };
}

// the same meeting seen through the Calendar app and through Google is one row: the first source listed wins
export function mergeEvents(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) for (const e of list ?? []) {
    const key = `${(e.title ?? '').trim().toLowerCase()}|${e.start}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out.sort((a, b) => new Date(a.start) - new Date(b.start));
}

async function api(client, tokens, url, { fetchImpl, onTokens }) {
  const go = (t) => fetchImpl(url, { headers: { authorization: `Bearer ${t.accessToken}`, accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  let current = tokens;
  if (current.expiresAt && current.expiresAt - Date.now() < 60000 && current.refreshToken) { current = await refresh(client, current, fetchImpl); await onTokens?.(current); }
  let r = await go(current);
  if (r.status === 401 && current.refreshToken) { current = await refresh(client, current, fetchImpl); await onTokens?.(current); r = await go(current); }
  if (r.status === 401 || r.status === 403) { const d = await json(r); const e = new Error(d?.error?.message || 'Google refused the request. Connect Google Calendar again.'); e.code = 'reauth'; throw e; }
  if (!r.ok) throw new Error(`Google Calendar answered ${r.status}.`);
  return { data: await json(r), tokens: current };
}

// upcoming events across the calendars the person has selected in Google Calendar, from now to `days` ahead
export async function listEvents({ client, tokens, days = 3, fetchImpl = fetch, onTokens = null, now = Date.now() }) {
  let current = tokens;
  const list = await api(client, current, `${API}/users/me/calendarList?minAccessRole=reader&showHidden=false`, { fetchImpl, onTokens: async (t) => { current = t; await onTokens?.(t); } });
  const calendars = (list.data?.items ?? []).filter((c) => c.selected !== false && !c.deleted).slice(0, MAX_CALENDARS);
  const timeMin = new Date(now).toISOString();
  const timeMax = new Date(now + days * 86400000).toISOString();
  const events = [];
  for (const cal of calendars) {
    const q = new URLSearchParams({ timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: '100' });
    const r = await api(client, current, `${API}/calendars/${encodeURIComponent(cal.id)}/events?${q}`, { fetchImpl, onTokens: async (t) => { current = t; await onTokens?.(t); } });
    for (const e of r.data?.items ?? []) { const m = mapEvent(e, cal.id, cal.summaryOverride || cal.summary || ''); if (m) events.push(m); }
  }
  return { events: mergeEvents(events), calendars: calendars.length, tokens: current };
}

// the connector as the app sees it: connect, disconnect, status for the renderer, and events(days) for Home. State
// (account, calendar count, last read) is what the caller stores in settings; tokens stay in the Keychain
export function createGoogleCalendar({ tokens, client, open, log = () => {}, fetchImpl = fetch, state, save, loopback = awaitLoopback }) {
  let cache = { at: 0, days: 0, events: [] };
  let lastError = null;
  // the read time lives here, not in settings: a successful read every few minutes must not rewrite settings.json
  let lastSyncAt = null;
  const current = () => state() ?? null;
  const status = () => { const s = current(); return { configured: !!client?.clientSecret, connected: !!s?.connected, account: s?.account ?? null, calendars: s?.calendars ?? 0, lastSyncAt: lastSyncAt ?? s?.lastSyncAt ?? null, error: lastError }; };
  return {
    status,
    async connect() {
      lastError = null;
      try {
        const t = await connect({ client, open, loopback, fetchImpl });
        await tokens.set(SOURCE_ID, t);
        save({ connected: true, account: t.email ?? null, calendars: 0, lastSyncAt: null });
        cache = { at: 0, days: 0, events: [] };
        log('google calendar connected', t.email ?? 'account');
        // the first read fills the calendar count and surfaces a consent problem right away
        await this.events(1).catch(() => {});
      } catch (err) { lastError = err.message; log('google calendar connect failed', err.message); }
      return { ...status(), error: lastError };
    },
    async disconnect() {
      await tokens.set(SOURCE_ID, null);
      save(null);
      cache = { at: 0, days: 0, events: [] };
      lastError = null;
      return status();
    },
    // events from now to `days` ahead; one read a minute at most, since Home, the guard and the invitee list all ask
    async events(days) {
      const s = current();
      if (!s?.connected) return { connected: false, events: [] };
      if (cache.days >= days && Date.now() - cache.at < 60000) return { connected: true, events: cache.events.filter((e) => new Date(e.start) < new Date(Date.now() + days * 86400000)) };
      const t = await tokens.get(SOURCE_ID);
      if (!t) { save(null); return { connected: false, events: [] }; }
      try {
        const r = await listEvents({ client, tokens: t, days, fetchImpl, onTokens: (nt) => tokens.set(SOURCE_ID, nt) });
        cache = { at: Date.now(), days, events: r.events };
        lastError = null;
        lastSyncAt = new Date().toISOString();
        const next = { connected: true, calendars: r.calendars, account: s.account ?? t.email ?? null };
        if (next.calendars !== s.calendars || next.account !== s.account || !s.connected) save({ ...s, ...next, lastSyncAt });
        return { connected: true, events: r.events };
      } catch (err) {
        lastError = err.message;
        log('google calendar read failed', err.message);
        // a refused token leaves the account connected in name only; the status says so and Connect again fixes it
        return { connected: true, events: cache.events, error: err.message };
      }
    },
  };
}

export const repoRoot = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
