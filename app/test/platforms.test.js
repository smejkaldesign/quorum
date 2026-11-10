import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PLATFORMS, createPlatforms, fileNameFor, recordingNote, transcriptFile, vttToText } from '../ee/platforms.js';

const VTT = `WEBVTT\r\n\r\n1\r\n00:00:01.000 --> 00:00:03.500\r\nAlex Rivera: Hi there.\r\n\r\n2\r\n00:00:03.600 --> 00:00:05.000\r\nAlex Rivera: Can you hear me?\r\n\r\n3\r\n00:00:06.000 --> 00:00:08.000\r\nDana Whitfield: Yes, loud and clear.\r\n\r\n4\r\n00:01:10.000 --> 00:01:12.000\r\nAlex Rivera: Let's start.\r\n`;

describe('zoom transcript and note shapes', () => {
  it('turns WebVTT into timestamped speaker turns, joining a speaker\'s consecutive cues', () => {
    const text = vttToText(VTT);
    expect(text.split('\n\n')).toEqual(['[0:01] Alex Rivera: Hi there. Can you hear me?', '[0:06] Dana Whitfield: Yes, loud and clear.', '[1:10] Alex Rivera: Let\'s start.']);
    expect(vttToText('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nno speaker here\n')).toBe('[0:01] no speaker here');
  });
  it('writes the note in the shared imported-meeting shape with the transcript linked', () => {
    const md = recordingNote({ uuid: 'abc/def==', topic: 'Weekly Sync', start_time: '2026-11-09T18:00:00Z', share_url: 'https://zoom.us/rec/share/x', duration: 42 }, { transcriptRel: 'transcripts/2026-11-09-weekly-sync.md', host: 'Alex Rivera' });
    expect(md).toContain('source_id: abc/def==');
    expect(md).toContain('source: zoom');
    expect(md).toContain('  - Alex Rivera (recorder)');
    expect(md).toContain('transcript: transcripts/2026-11-09-weekly-sync.md');
    expect(md).toContain('duration_minutes: 42');
    expect(md.trim().endsWith('# Weekly Sync')).toBe(true);
    expect(fileNameFor({ topic: 'Weekly Sync', start_time: '2026-11-09T18:00:00Z' })).toBe('2026-11-09-weekly-sync.md');
  });
  it('only a completed transcript file counts', () => {
    expect(transcriptFile({ recording_files: [{ file_type: 'MP4', download_url: 'u' }, { file_type: 'TRANSCRIPT', status: 'processing', download_url: 'u' }] })).toBeNull();
    expect(transcriptFile({ recording_files: [{ file_type: 'TRANSCRIPT', status: 'completed', download_url: 'u' }] })).toMatchObject({ download_url: 'u' });
  });
});

// a fake relay plus a fake Zoom, keyed by URL prefix; every call is recorded
function world({ recordings = [], vtt = VTT, tokenStatus = 200 } = {}) {
  const calls = [];
  let accessToken = 'zoom-at-1';
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null, auth: init.headers?.authorization ?? null });
    const u = new URL(url);
    if (u.pathname.endsWith('/v1/connect/zoom/token')) {
      if (tokenStatus !== 200) return new Response(JSON.stringify({ error: 'The platform did not accept the sign-in. Try connecting again.' }), { status: tokenStatus });
      const grant = JSON.parse(init.body).grant;
      accessToken = grant === 'refresh' ? 'zoom-at-2' : 'zoom-at-1';
      return new Response(JSON.stringify({ accessToken, refreshToken: 'zoom-rt', expiresAt: Date.now() + 3600000, scope: 's' }), { status: 200 });
    }
    if (u.pathname.endsWith('/v1/connect/zoom/account')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (u.pathname.endsWith('/v1/connect/events/ack')) return new Response(JSON.stringify({ ok: true, acked: 1 }), { status: 200 });
    if (u.pathname.endsWith('/v1/connect/events')) return new Response(JSON.stringify({ events: [{ id: 7, event: 'recording.completed' }] }), { status: 200 });
    if (init.headers?.authorization !== `Bearer ${accessToken}`) return new Response('{}', { status: 401 });
    if (u.pathname === '/v2/users/me') return new Response(JSON.stringify({ id: 'zu1', account_id: 'acc1', email: 'alex@example.com', first_name: 'Alex', last_name: 'Rivera' }), { status: 200 });
    if (u.pathname === '/v2/users/me/recordings') return new Response(JSON.stringify({ meetings: recordings, next_page_token: '' }), { status: 200 });
    if (u.hostname === 'download.zoom.example') return new Response(vtt, { status: 200 });
    return new Response('{}', { status: 404 });
  };
  const account = { client: () => ({ auth: { getSession: async () => ({ data: { session: { access_token: 'session-tok' } } }) } }), state: () => ({ signedIn: true, workspace: { id: 'ws1', role: 'owner' } }), envStatus: () => ({ config: 'production' }) };
  const saved = {};
  const store = { tokens: { get: async (k) => saved[k] ?? null, set: async (k, v) => { if (v === null) delete saved[k]; else saved[k] = v; } } };
  return { calls, fetchImpl, account, store, saved, setToken: (t) => { accessToken = t; } };
}
const recording = (over = {}) => ({ uuid: 'uuid-1', id: 111, topic: 'Weekly Sync', start_time: new Date(Date.now() - 2 * 86400000).toISOString(), duration: 30, share_url: 'https://zoom.us/rec/share/1', recording_files: [{ file_type: 'MP4', download_url: 'https://download.zoom.example/mp4' }, { file_type: 'TRANSCRIPT', status: 'completed', download_url: 'https://download.zoom.example/vtt' }], ...over });

describe('zoom platform connection', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'quorum-platforms-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('signs in through the relay bounce, exchanges the code on the relay, registers the account and imports', async () => {
    const w = world({ recordings: [recording()] });
    const settings = {};
    const opened = [];
    let page = null;
    const loopback = async () => {
      const url = new URL(opened[0]);
      expect(url.origin + url.pathname).toBe('https://zoom.us/oauth/authorize');
      expect(url.searchParams.get('client_id')).toBe(PLATFORMS.zoom.clientId);
      expect(url.searchParams.get('redirect_uri')).toBe(PLATFORMS.zoom.redirectUri);
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('state')).toMatch(/\.p47832$/);
      return { code: 'code-1', state: url.searchParams.get('state'), finish: (r) => { page = r; } };
    };
    const p = createPlatforms({ account: w.account, settings, meetingsDir: () => dir, fetchImpl: w.fetchImpl, store: w.store, openExternal: async (u) => { opened.push(u); }, loopback: () => new Promise((r) => setTimeout(() => r(loopback()), 0)) });
    expect(await p.connect('zoom')).toEqual({ ok: true });
    expect(page).toEqual({ name: 'Zoom' });
    const token = w.calls.find((c) => c.url.endsWith('/v1/connect/zoom/token'));
    expect(token.auth).toBe('Bearer session-tok');
    expect(token.body).toMatchObject({ workspaceId: 'ws1', grant: 'code', code: 'code-1', redirectUri: PLATFORMS.zoom.redirectUri });
    expect(token.body.codeVerifier).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(w.saved['platform-zoom'].accessToken).toBe('zoom-at-1');
    const reg = w.calls.find((c) => c.url.endsWith('/v1/connect/zoom/account'));
    expect(reg.body).toMatchObject({ accountId: 'acc1', externalUserId: 'zu1' });
    expect(settings.platforms.zoom).toMatchObject({ connected: true, account: 'alex@example.com', accountId: 'acc1', name: 'Alex Rivera' });
    await p.sync('zoom');
    const note = readFileSync(path.join(dir, 'zoom', fileNameFor(recording())), 'utf8');
    expect(note).toContain('source_id: uuid-1');
    expect(note).toContain('  - Alex Rivera (recorder)');
    expect(note).toMatch(/transcript: transcripts\/\d{4}-\d{2}-\d{2}-weekly-sync\.md/);
    const t = readFileSync(path.join(dir, 'zoom', 'transcripts', fileNameFor(recording())), 'utf8');
    expect(t).toContain('transcript_of: uuid-1');
    expect(t).toContain('[0:01] Alex Rivera: Hi there. Can you hear me?');
    expect(w.calls.some((c) => c.url.endsWith('/v1/connect/events/ack') && c.body.ids?.includes(7))).toBe(true);
    expect(p.list()[0]).toMatchObject({ id: 'zoom', connected: true, notes: 1, imported: 1 });
  });

  it('skips recordings it already has and ones whose transcript is still processing, and keeps looking back far enough', async () => {
    const pending = recording({ uuid: 'uuid-2', topic: 'Pending', start_time: new Date(Date.now() - 10 * 86400000).toISOString(), recording_files: [{ file_type: 'MP4', download_url: 'u' }] });
    const w = world({ recordings: [recording(), pending] });
    const settings = { platforms: { zoom: { connected: true, name: 'Alex Rivera', since: null } } };
    w.saved['platform-zoom'] = { accessToken: 'zoom-at-1', refreshToken: 'zoom-rt', expiresAt: Date.now() + 3600000 };
    mkdirSync(path.join(dir, 'zoom'), { recursive: true });
    writeFileSync(path.join(dir, 'zoom', 'old.md'), '---\nsource_id: uuid-1\ntitle: "Weekly Sync"\nsource: zoom\n---\n');
    const p = createPlatforms({ account: w.account, settings, meetingsDir: () => dir, fetchImpl: w.fetchImpl, store: w.store });
    const r = await p.sync('zoom');
    expect(r).toMatchObject({ listed: 2, imported: 0, skipped: 1, waiting: 1 });
    expect(existsSync(path.join(dir, 'zoom', 'transcripts'))).toBe(false);
    // the next listing starts before the pending recording, so it is picked up once its transcript exists
    expect(new Date(settings.platforms.zoom.since).getTime()).toBeLessThan(new Date(pending.start_time).getTime());
  });

  it('refreshes the token through the relay when Zoom refuses it', async () => {
    const w = world({ recordings: [] });
    const settings = { platforms: { zoom: { connected: true } } };
    w.saved['platform-zoom'] = { accessToken: 'stale', refreshToken: 'zoom-rt', expiresAt: Date.now() + 3600000 };
    w.setToken('zoom-at-2');
    const p = createPlatforms({ account: w.account, settings, meetingsDir: () => dir, fetchImpl: w.fetchImpl, store: w.store });
    const r = await p.sync('zoom');
    expect(r.listed).toBe(0);
    const refresh = w.calls.find((c) => c.url.endsWith('/v1/connect/zoom/token'));
    expect(refresh.body).toMatchObject({ grant: 'refresh', refreshToken: 'zoom-rt' });
    expect(w.saved['platform-zoom'].accessToken).toBe('zoom-at-2');
  });

  it('passes the relay\'s refusal through in plain words and keeps nothing', async () => {
    const w = world({ tokenStatus: 402 });
    const settings = {};
    const p = createPlatforms({ account: w.account, settings, meetingsDir: () => dir, fetchImpl: w.fetchImpl, store: w.store, loopback: async () => ({ code: 'c', state: 'wrong' }) });
    expect((await p.connect('zoom')).error).toMatch(/did not match/);
    expect(w.saved['platform-zoom']).toBeUndefined();
    expect(settings.platforms?.zoom?.connected ?? false).toBe(false);
  });

  it('refuses when signed out and forgets the account on disconnect', async () => {
    const w = world();
    const signedOut = { ...w.account, state: () => ({ signedIn: false }) };
    const p = createPlatforms({ account: signedOut, settings: {}, meetingsDir: () => dir, fetchImpl: w.fetchImpl, store: w.store });
    expect(await p.connect('zoom')).toEqual({ error: 'Sign in first.' });
    const settings = { platforms: { zoom: { connected: true, accountId: 'acc1', account: 'alex@example.com' } } };
    w.saved['platform-zoom'] = { accessToken: 'x' };
    const q = createPlatforms({ account: w.account, settings, meetingsDir: () => dir, fetchImpl: w.fetchImpl, store: w.store });
    expect(await q.disconnect('zoom')).toEqual({ ok: true });
    expect(w.saved['platform-zoom']).toBeUndefined();
    expect(settings.platforms.zoom).toMatchObject({ connected: false, account: null, accountId: null });
    expect(w.calls.find((c) => c.method === 'DELETE').body).toMatchObject({ accountId: 'acc1' });
  });
});
