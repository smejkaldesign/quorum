import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_CLIENT_ID, authorizeUrl, connect, createGoogleCalendar, googleClient, listEvents, mapEvent, mergeEvents } from '../sources/gcal.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const client = { clientId: 'cid', clientSecret: 'sec' };
const idToken = (email) => `h.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.s`;

const event = (over = {}) => ({
  id: 'ev1', status: 'confirmed', summary: 'Design review', htmlLink: 'https://calendar.google.com/event?eid=1', recurringEventId: 'r1',
  start: { dateTime: '2026-11-12T14:00:00-08:00' }, end: { dateTime: '2026-11-12T14:45:00-08:00' },
  hangoutLink: 'https://meet.google.com/abc-defg-hij', location: 'Room 4', description: 'Agenda',
  attendees: [{ email: 'maya@example.com', displayName: 'Maya Chen' }, { email: 'room@example.com', resource: true }],
  ...over,
});

describe('google client resolution', () => {
  it('reads the shell first, then the repo .env files, then the packaged field, with a public default id', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'gcal-'));
    writeFileSync(path.join(root, '.env'), 'QUORUM_GOOGLE_CLIENT_SECRET="from-env-file"\n');
    expect(googleClient({ env: {}, root })).toEqual({ clientId: DEFAULT_CLIENT_ID, clientSecret: 'from-env-file' });
    expect(googleClient({ env: { QUORUM_GOOGLE_CLIENT_SECRET: 'shell' }, root }).clientSecret).toBe('shell');
    expect(googleClient({ env: {}, root: null, packaged: { clientId: 'packaged-id', clientSecret: 'packaged-secret' } })).toEqual({ clientId: 'packaged-id', clientSecret: 'packaged-secret' });
    expect(googleClient({ env: {}, root: null }).clientSecret).toBeNull();
  });
});

describe('authorize url', () => {
  it('asks for read-only calendar access, offline access and a consent screen with PKCE', () => {
    const u = new URL(authorizeUrl({ clientId: 'cid', challenge: 'ch', state: 'st' }));
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(u.searchParams.get('scope')).toContain('calendar.readonly');
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('prompt')).toBe('consent select_account');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:47832/callback');
  });
});

describe('mapEvent', () => {
  it('turns a Google event into the Calendar app reader shape, with the call link where the detector looks', () => {
    const m = mapEvent(event(), 'primary', 'Work');
    expect(m).toMatchObject({ id: 'google:primary:ev1', title: 'Design review', calendar: 'Work', recurring: true, url: 'https://meet.google.com/abc-defg-hij', location: 'Room 4', notes: 'Agenda', item: null, link: 'https://calendar.google.com/event?eid=1' });
    expect(m.start).toBe('2026-11-12T22:00:00.000Z');
    expect(m.attendees).toEqual([{ name: 'Maya Chen', email: 'maya@example.com' }]);
  });
  it('skips all-day and cancelled entries, and reads a conference entry point when there is no hangout link', () => {
    expect(mapEvent(event({ start: { date: '2026-11-12' }, end: { date: '2026-11-13' } }), 'primary')).toBeNull();
    expect(mapEvent(event({ status: 'cancelled' }), 'primary')).toBeNull();
    const m = mapEvent(event({ hangoutLink: undefined, conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'https://zoom.us/j/123' }] } }), 'primary');
    expect(m.url).toBe('https://zoom.us/j/123');
  });
});

describe('mergeEvents', () => {
  it('keeps one row for the same meeting seen through two calendars and sorts by start', () => {
    const a = { title: 'Standup', start: '2026-11-12T16:00:00.000Z' };
    const b = { title: 'standup ', start: '2026-11-12T16:00:00.000Z', id: 'dup' };
    const c = { title: 'Earlier', start: '2026-11-12T15:00:00.000Z' };
    expect(mergeEvents([a], [b, c]).map((e) => e.title)).toEqual(['Earlier', 'Standup']);
  });
});

describe('listEvents', () => {
  const fake = (log = []) => async (url, init = {}) => {
    log.push({ url: String(url), auth: init.headers?.authorization ?? null, body: init.body ? String(init.body) : null });
    if (String(url).startsWith('https://oauth2.googleapis.com/token')) return json({ access_token: 'at2', expires_in: 3600, id_token: idToken('maya@example.com') });
    if (init.headers?.authorization === 'Bearer stale') return json({ error: { message: 'Invalid Credentials' } }, 401);
    if (String(url).includes('/users/me/calendarList')) return json({ items: [{ id: 'primary', summary: 'Maya', selected: true }, { id: 'hidden', summary: 'Hidden', selected: false }, { id: 'team', summary: 'Team' }] });
    if (String(url).includes('/calendars/primary/events')) return json({ items: [event(), event({ id: 'allday', start: { date: '2026-11-13' }, end: { date: '2026-11-14' } })] });
    if (String(url).includes('/calendars/team/events')) return json({ items: [event({ id: 'ev2', summary: 'Team sync', start: { dateTime: '2026-11-12T10:00:00-08:00' }, end: { dateTime: '2026-11-12T10:30:00-08:00' } })] });
    return new Response('nope', { status: 404 });
  };
  it('reads every selected calendar, skips the unselected one, and refreshes a refused token once', async () => {
    const log = [];
    const saved = [];
    const r = await listEvents({ client, tokens: { accessToken: 'stale', refreshToken: 'rt' }, days: 3, fetchImpl: fake(log), onTokens: (t) => saved.push(t), now: Date.parse('2026-11-12T00:00:00Z') });
    expect(r.calendars).toBe(2);
    expect(r.events.map((e) => e.title)).toEqual(['Team sync', 'Design review']);
    expect(saved[0]).toMatchObject({ accessToken: 'at2', refreshToken: 'rt', email: 'maya@example.com' });
    const token = log.find((l) => l.url.startsWith('https://oauth2.googleapis.com/token'));
    expect(new URLSearchParams(token.body).get('grant_type')).toBe('refresh_token');
    expect(new URLSearchParams(token.body).get('client_secret')).toBe('sec');
    expect(log.filter((l) => l.url.includes('/events')).every((l) => l.auth === 'Bearer at2')).toBe(true);
  });
});

describe('connect', () => {
  it('refuses to start without the client secret and names the setting', async () => {
    await expect(connect({ client: { clientId: 'cid', clientSecret: null }, open: async () => {} })).rejects.toThrow(/QUORUM_GOOGLE_CLIENT_SECRET/);
  });
  it('opens the consent page, checks the state, exchanges the code and insists on a refresh token', async () => {
    let opened = null;
    const finished = [];
    const loopback = () => { const q = { code: 'good', finish: (r) => finished.push(r) }; return new Promise((resolve) => { setTimeout(() => { q.state = new URL(opened).searchParams.get('state'); resolve(q); }, 0); }); };
    const fetchImpl = async (url, init) => { const p = new URLSearchParams(init.body); return p.get('code') === 'good' && p.get('code_verifier') ? json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, id_token: idToken('maya@example.com') }) : json({ error: 'invalid_grant' }, 400); };
    const t = await connect({ client, open: async (u) => { opened = u; }, loopback, fetchImpl });
    expect(t).toMatchObject({ accessToken: 'at', refreshToken: 'rt', email: 'maya@example.com' });
    expect(finished).toEqual([{ name: 'Google Calendar' }]);
  });
});

describe('createGoogleCalendar', () => {
  const store = () => { const m = new Map(); return { get: async (k) => m.get(k) ?? null, set: async (k, v) => { if (v === null) m.delete(k); else m.set(k, v); return true; } }; };
  it('reports not connected, then connects, reads, caches for a minute and disconnects cleanly', async () => {
    let state = null;
    const tokens = store();
    let reads = 0;
    const fetchImpl = async (url, init) => {
      if (String(url).startsWith('https://oauth2.googleapis.com/token')) return json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, id_token: idToken('maya@example.com') });
      if (String(url).includes('/calendarList')) { reads += 1; return json({ items: [{ id: 'primary', summary: 'Maya' }] }); }
      if (String(url).includes('/events')) return json({ items: [event()] });
      return new Response('nope', { status: 404 });
    };
    const loopback = () => Promise.resolve({ code: 'good', state: null, finish: () => {} });
    // the state check needs the real state; patch it through open
    let opened = '';
    const g = createGoogleCalendar({ tokens, client, open: async (u) => { opened = u; }, state: () => state, save: (s) => { state = s; }, fetchImpl, loopback: () => loopback().then((q) => ({ ...q, state: new URL(opened).searchParams.get('state') })) });
    expect(g.status()).toMatchObject({ configured: true, connected: false });
    expect(await g.events(3)).toEqual({ connected: false, events: [] });
    const after = await g.connect();
    expect(after).toMatchObject({ connected: true, account: 'maya@example.com', calendars: 1, error: null });
    expect(await tokens.get('google-calendar')).toMatchObject({ refreshToken: 'rt' });
    const first = await g.events(3);
    expect(first.events.map((e) => e.title)).toEqual(['Design review']);
    await g.events(3);
    expect(reads).toBe(2); // one on connect, one for days 3; the third call came from the cache
    await g.disconnect();
    expect(g.status().connected).toBe(false);
    expect(await tokens.get('google-calendar')).toBeNull();
  });
  it('keeps the account connected in name and reports the error when Google refuses the token', async () => {
    let state = { connected: true, account: 'maya@example.com', calendars: 1, lastSyncAt: null };
    const tokens = store();
    await tokens.set('google-calendar', { accessToken: 'bad', refreshToken: null });
    const fetchImpl = async () => json({ error: { message: 'Invalid Credentials' } }, 401);
    const g = createGoogleCalendar({ tokens, client, open: async () => {}, state: () => state, save: (s) => { state = s; }, fetchImpl });
    const r = await g.events(1);
    expect(r).toMatchObject({ connected: true, events: [] });
    expect(r.error).toMatch(/Invalid Credentials|Connect Google Calendar again/);
    expect(g.status().error).toBe(r.error);
  });
  it('revokes the Google grant on disconnect only when asked to', async () => {
    const tokens = store();
    const revoked = [];
    const fetchImpl = async (url, init) => { if (url === 'https://oauth2.googleapis.com/revoke') revoked.push(new URLSearchParams(init.body).get('token')); return new Response('', { status: 200 }); };
    let state = { connected: true };
    const g = createGoogleCalendar({ tokens, client, open: async () => {}, fetchImpl, state: () => state, save: (v) => { state = v; } });
    await tokens.set('google-calendar', { accessToken: 'a', refreshToken: 'r1' });
    await g.disconnect();
    expect(revoked).toEqual([]);
    await tokens.set('google-calendar', { accessToken: 'a', refreshToken: 'r2' });
    await g.disconnect({ revoke: true });
    expect(revoked).toEqual(['r2']);
    expect(await tokens.get('google-calendar')).toBeNull();
  });
});
