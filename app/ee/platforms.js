// Platform connections in the Cloud edition, Zoom first: the user's Zoom account signed in through the relay's
// redirect (relay/connect.js), cloud recordings listed with the user's own token, and each finished transcript
// written as a meeting note with the transcript beside it. The relay holds the client secret and takes the webhooks;
// this side holds the user's tokens in the Keychain and does every download itself, so no recording passes through
// Quorum's servers.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { LOOPBACK_PORT, awaitLoopback, pkce } from '../sources/oauth.js';
import { createJobs } from '../sources/jobs.js';
import { createTokenStore } from '../sources/tokens.js';
import { scanExisting } from '../sources/index.js';
import { slug } from '../sources/granola.js';
import { SUBFOLDER, transcriptMarkdown } from '../sources/transcripts.js';
import { httpUrl, relayUrls, unreachable } from './relay.js';
import { plain } from './account.js';
import { setFrontmatterKey } from '../frontmatter.js';

// The Zoom app's public client id and the redirect URI registered for it. Development credentials pair with the
// railway.app redirect and serve the developer's own account until the app is published; both move to the
// production pair then. An environment variable overrides either for a build.
export const PLATFORMS = {
  zoom: {
    name: 'Zoom', folder: 'zoom', authorize: 'https://zoom.us/oauth/authorize', api: 'https://api.zoom.us/v2',
    clientId: process.env.QUORUM_ZOOM_CLIENT_ID || 'zy7lKyxyQSmPXc6rsNMzOQ',
    redirectUri: process.env.QUORUM_ZOOM_REDIRECT_URI || 'https://relay-production-e257.up.railway.app/v1/connect/zoom/callback',
  },
};
const DAY = 86400000;
const LOOKBACK_DAYS = 30;
const day = (d) => new Date(d).toISOString().slice(0, 10);
const daysAgo = (n, now) => new Date(now - n * DAY).toISOString();
// an error whose sentence is meant for the person; plain() passes those through
const said = (message) => { const e = new Error(message); e.code = 'P0001'; return e; };

// Zoom's transcript is WebVTT: cues of a few seconds each. One line per speaker turn, timestamped from the start,
// consecutive cues from the same speaker joined.
export function vttToText(vtt) {
  const lines = String(vtt).replace(/\r/g, '').split('\n');
  const turns = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\d{2}):(\d{2}):(\d{2})\.\d{3}\s+-->/.exec(lines[i]);
    if (!m) continue;
    const secs = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    const text = [];
    for (i += 1; i < lines.length && lines[i].trim() !== ''; i++) text.push(lines[i].trim());
    if (!text.length) continue;
    const joined = text.join(' ');
    const sp = /^([^:]{1,60}):\s*(.*)$/.exec(joined);
    const speaker = sp ? sp[1] : null, words = sp ? sp[2] : joined;
    const last = turns[turns.length - 1];
    if (last && speaker && last.speaker === speaker && secs - last.end <= 30) { last.text += ` ${words}`; last.end = secs; continue; }
    turns.push({ start: secs, end: secs, speaker, text: words });
  }
  const stamp = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  return turns.map((t) => `[${stamp(t.start)}] ${t.speaker ? `${t.speaker}: ` : ''}${t.text}`).join('\n\n');
}

// the note for a cloud recording: the same shape as every other imported meeting, the transcript beside it. The body
// stays empty so the reader offers to write the summary from the transcript.
export function recordingNote(m, { transcriptRel = null, host = null } = {}) {
  const title = m.topic || 'Zoom meeting';
  return [
    '---',
    `source_id: ${m.uuid}`,
    `title: ${JSON.stringify(title)}`,
    `date: ${m.start_time ?? new Date().toISOString()}`,
    'participants:',
    ...(host ? [`  - ${host} (recorder)`] : []),
    `participant_count: ${host ? 1 : 0}`,
    'source: zoom',
    'visibility: private',
    ...(m.share_url ? [`zoom_url: ${m.share_url}`] : []),
    ...(m.duration ? [`duration_minutes: ${m.duration}`] : []),
    ...(transcriptRel ? [`transcript: ${transcriptRel}`] : []),
    '---',
    '',
    `# ${title}`,
    '',
  ].join('\n');
}
export const fileNameFor = (m) => `${String(m.start_time ?? '').slice(0, 10) || 'undated'}-${slug(m.topic || 'zoom-meeting')}.md`;
export const transcriptFile = (m) => (m.recording_files ?? []).find((f) => f.file_type === 'TRANSCRIPT' && (f.status ?? 'completed') === 'completed' && f.download_url) ?? null;

export function createPlatforms({ account, settings, saveSettings = () => {}, meetingsDir, afterWrite = () => {}, keepKeys = (_prev, next) => next, log = () => {}, toUI = () => {}, openExternal = async () => {}, fetchImpl = globalThis.fetch, store = createTokenStore(), loopback = awaitLoopback, now = () => Date.now() }) {
  const conf = () => (settings.platforms ??= {});
  const stateOf = (id) => (conf()[id] ??= { connected: false, account: null, accountId: null, name: null, connectedAt: null, lastSyncAt: null, imported: 0, since: null });
  const jobs = createJobs({ emit: (job) => toUI('platform-job', job), now });
  const folderFor = (id) => { const root = meetingsDir(); return root ? path.join(root, PLATFORMS[id].folder) : null; };
  const countNotes = (dir) => { try { return readdirSync(dir).filter((f) => f.endsWith('.md')).length; } catch { return 0; } };
  const ready = () => {
    if (!account.client()) return 'Hosted accounts are not set up in this build.';
    const s = account.state();
    if (!s.signedIn) return 'Sign in first.';
    if (!s.workspace) return 'Pick a workspace first.';
    return null;
  };

  // the relay, signed with the user's session; GET carries the workspace in the query, the rest in the body
  const relay = async (p, { method = 'POST', body = null, query = {} } = {}) => {
    const { data: { session } = {} } = await account.client().auth.getSession();
    if (!session?.access_token) throw said('You are signed out. Sign in again.');
    const workspaceId = account.state().workspace.id;
    const urls = relayUrls({ source: account.envStatus?.().config });
    let res = null;
    for (const url of urls) {
      try {
        const u = new URL(`${httpUrl(url)}${p}`);
        if (method === 'GET') { u.searchParams.set('workspace', workspaceId); for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v); }
        res = await fetchImpl(u.toString(), { method, headers: { authorization: `Bearer ${session.access_token}`, 'content-type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify({ workspaceId, ...(body ?? {}) }) });
        break;
      } catch (err) { if (unreachable(err) && url !== urls[urls.length - 1]) continue; throw err; }
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw said(json.error || 'Connections are unavailable right now.');
    return json;
  };

  // the platform token from the Keychain, refreshed through the relay when it is about to expire or was refused
  const key = (id) => `platform-${id}`;
  const tokenFor = async (id, force = false) => {
    const t = await store.tokens.get(key(id));
    if (!t) throw said(`${PLATFORMS[id].name} is not connected.`);
    if (!force && (!t.expiresAt || t.expiresAt - now() > 60000)) return t.accessToken;
    if (!t.refreshToken) return t.accessToken;
    const fresh = await relay(`/v1/connect/${id}/token`, { body: { grant: 'refresh', refreshToken: t.refreshToken } });
    await store.tokens.set(key(id), { ...fresh, refreshToken: fresh.refreshToken ?? t.refreshToken });
    return fresh.accessToken;
  };
  const api = async (id, target, init = {}, retry = true) => {
    const token = await tokenFor(id);
    const r = await fetchImpl(target.startsWith('http') ? target : `${PLATFORMS[id].api}${target}`, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` } });
    if (r.status === 401 && retry) { await tokenFor(id, true); return api(id, target, init, false); }
    if (!r.ok) throw said(`${PLATFORMS[id].name} answered ${r.status}. Try again in a moment.`);
    return r;
  };

  // Zoom lists recordings a month at a time; one request per 30-day window, paged
  const listRecordings = async (id, sinceIso) => {
    const out = [];
    let from = new Date(sinceIso);
    const end = new Date(now());
    while (from <= end) {
      const to = new Date(Math.min(from.getTime() + 29 * DAY, end.getTime()));
      let next = '';
      do {
        const u = new URL(`${PLATFORMS[id].api}/users/me/recordings`);
        u.searchParams.set('from', day(from)); u.searchParams.set('to', day(to)); u.searchParams.set('page_size', '300');
        if (next) u.searchParams.set('next_page_token', next);
        const j = await (await api(id, u.toString())).json();
        out.push(...(j.meetings ?? []));
        next = j.next_page_token || '';
      } while (next);
      from = new Date(to.getTime() + DAY);
    }
    return [...new Map(out.map((m) => [m.uuid, m])).values()].sort((a, b) => String(a.start_time).localeCompare(String(b.start_time)));
  };

  const pendingEvents = async (id) => (await relay('/v1/connect/events', { method: 'GET', query: { provider: id } })).events ?? [];
  const ackEvents = async (id, events) => { if (events.length) await relay('/v1/connect/events/ack', { body: { provider: id, ids: events.map((e) => e.id) } }); };

  const sync = (id) => jobs.run(id, 'Importing', async (progress) => {
    const p = PLATFORMS[id];
    const s = stateOf(id);
    const dir = folderFor(id);
    if (!dir) throw said('Pick a meeting notes folder in Settings › Memory first.');
    const existing = scanExisting(meetingsDir());
    progress({ phase: 'list', message: `Checking ${p.name} recordings`, total: null });
    const events = await pendingEvents(id).catch(() => []);
    const meetings = await listRecordings(id, s.since ?? daysAgo(LOOKBACK_DAYS, now()));
    const todo = meetings.filter((m) => !existing.has(m.uuid));
    const readyNow = todo.filter((m) => transcriptFile(m));
    const waiting = todo.filter((m) => !transcriptFile(m));
    progress({ phase: 'import', phaseStartedAt: now(), total: readyNow.length, done: 0, message: readyNow.length ? `Importing ${readyNow.length} new of ${meetings.length} recordings` : waiting.length ? `${waiting.length} ${waiting.length === 1 ? 'recording is' : 'recordings are'} still processing in ${p.name}` : 'Nothing new' });
    const failed = [];
    let imported = 0, done = 0;
    for (const m of readyNow) {
      try {
        const text = vttToText(await (await api(id, transcriptFile(m).download_url)).text());
        const name = fileNameFor(m);
        mkdirSync(path.join(dir, SUBFOLDER), { recursive: true });
        const tFile = path.join(dir, SUBFOLDER, name);
        writeFileSync(tFile, transcriptMarkdown({ id: m.uuid, title: m.topic, date: m.start_time, source: id, recorder: s.name }, text));
        afterWrite(tFile);
        // a second meeting with the same title on the same day keeps the first file and gets the id in its own name
        let file = path.join(dir, name);
        if (existsSync(file) && !readFileSync(file, 'utf8').includes(m.uuid)) file = path.join(dir, name.replace(/\.md$/, `-${m.id}.md`));
        // the note names the Zoom account it came from, and a re-import keeps the person's share choice and the keys
        // the guardrails protect (keepKeys, from main.js)
        const note = recordingNote(m, { transcriptRel: `${SUBFOLDER}/${name}`, host: s.name });
        const own = s.account && !/[\r\n]/.test(s.account) ? setFrontmatterKey(note, 'source_account', JSON.stringify(String(s.account))) : note;
        writeFileSync(file, keepKeys(existsSync(file) ? readFileSync(file, 'utf8') : null, own));
        afterWrite(file);
        existing.add(m.uuid);
        imported += 1;
      } catch (err) { failed.push({ id: m.uuid, title: m.topic ?? '', error: err.message }); }
      done += 1;
      progress({ done, message: `Imported ${imported} of ${readyNow.length}` });
    }
    await ackEvents(id, events).catch((err) => log('platforms', id, 'ack', err.message));
    // next time: two days back, or far enough to see a recording whose transcript is still processing
    const oldestWaiting = waiting.map((m) => m.start_time).filter(Boolean).sort()[0];
    s.since = oldestWaiting && new Date(oldestWaiting).getTime() < now() - 2 * DAY ? new Date(new Date(oldestWaiting).getTime() - DAY).toISOString() : daysAgo(2, now());
    s.lastSyncAt = new Date(now()).toISOString();
    s.imported = (s.imported ?? 0) + imported;
    saveSettings();
    log('platforms', id, `listed ${meetings.length}, imported ${imported}, waiting ${waiting.length}, failed ${failed.length}`);
    if (failed.length) progress({ failed });
    if (imported) toUI('log', `${p.name}: ${imported} ${imported === 1 ? 'recording' : 'recordings'} added to your notes.`);
    return { listed: meetings.length, imported, skipped: meetings.length - todo.length, waiting: waiting.length, failed };
  });

  const connect = async (id) => {
    const p = PLATFORMS[id];
    if (!p) return { error: 'Unknown platform.' };
    const no = ready();
    if (no) return { error: no };
    if (!p.clientId) return { error: `${p.name} connections are not available in this build.` };
    const { verifier, challenge } = pkce();
    const state = `${randomBytes(12).toString('base64url')}.p${LOOPBACK_PORT}`;
    const waiting = loopback();
    const u = new URL(p.authorize);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', p.clientId);
    u.searchParams.set('redirect_uri', p.redirectUri);
    u.searchParams.set('code_challenge', challenge);
    u.searchParams.set('code_challenge_method', 'S256');
    u.searchParams.set('state', state);
    log('platforms', id, 'sign-in in the default browser');
    await openExternal(u.toString());
    const q = await waiting;
    const tell = (r) => { try { q.finish?.({ name: p.name, ...r }); } catch {} };
    try {
      if (q.error) throw said(q.error_description || q.error);
      if (q.state !== state) throw said('The sign-in answer did not match the request.');
      if (!q.code) throw said('The sign-in did not return a code.');
      const tokens = await relay(`/v1/connect/${id}/token`, { body: { grant: 'code', code: q.code, codeVerifier: verifier, redirectUri: p.redirectUri } });
      await store.tokens.set(key(id), tokens);
      const me = await (await api(id, '/users/me')).json();
      await relay(`/v1/connect/${id}/account`, { body: { accountId: me.account_id, externalUserId: me.id } });
      Object.assign(stateOf(id), { connected: true, account: me.email ?? null, accountId: me.account_id ?? null, name: [me.first_name, me.last_name].filter(Boolean).join(' ') || me.display_name || null, connectedAt: new Date(now()).toISOString(), since: null });
      saveSettings();
      tell({});
      sync(id).catch(() => {});
      return { ok: true };
    } catch (err) {
      tell({ failed: err.message });
      log('platforms', id, 'connect failed:', err.message);
      return { error: plain(err, `Quorum could not connect to ${p.name}. Try again.`) };
    }
  };

  const disconnect = async (id) => {
    if (!PLATFORMS[id]) return { error: 'Unknown platform.' };
    const s = stateOf(id);
    if (s.accountId && !ready()) await relay(`/v1/connect/${id}/account`, { method: 'DELETE', body: { accountId: s.accountId } }).catch((err) => log('platforms', id, 'forget', err.message));
    await store.tokens.set(key(id), null);
    Object.assign(s, { connected: false, account: null, accountId: null, name: null });
    saveSettings();
    return { ok: true };
  };

  const list = () => Object.entries(PLATFORMS).map(([id, p]) => {
    const s = stateOf(id);
    const dir = folderFor(id);
    return { id, name: p.name, available: !!p.clientId, connected: !!s.connected, account: s.account, accountName: s.name, lastSyncAt: s.lastSyncAt, imported: s.imported ?? 0, notes: dir ? countNotes(dir) : 0, folderPath: dir, job: jobs.snapshot(id) };
  });

  // the webhook queue says when a recording finished; a daily pass covers anything the queue missed
  const tick = async () => {
    for (const id of Object.keys(PLATFORMS)) {
      const s = stateOf(id);
      if (!s.connected || jobs.running(id) || ready()) continue;
      try {
        const events = await pendingEvents(id);
        const stale = !s.lastSyncAt || now() - new Date(s.lastSyncAt).getTime() > DAY;
        if (events.length || stale) await sync(id);
      } catch (err) { log('platforms', id, 'tick', err.message); }
    }
  };

  const handlers = {
    'platforms-list': () => list(),
    'platform-connect': (id) => connect(id),
    'platform-disconnect': (id) => disconnect(id),
    'platform-sync': async (id) => {
      if (!PLATFORMS[id]) return { error: 'Unknown platform.' };
      if (!stateOf(id).connected) return { error: 'Connect first.' };
      const no = ready(); if (no) return { error: no };
      sync(id).catch(() => {});
      return { ok: true };
    },
  };
  return { handlers, list, connect, disconnect, sync, tick, stateOf };
}

export function registerPlatforms({ ipcMain, ...rest }) {
  const p = createPlatforms(rest);
  for (const [name, fn] of Object.entries(p.handlers)) ipcMain.handle(name, (_e, ...a) => fn(...a));
  const timer = setInterval(() => p.tick().catch(() => {}), 30 * 60 * 1000);
  timer.unref?.();
  setTimeout(() => p.tick().catch(() => {}), 20000).unref?.();
  return { ...p, stop: () => clearInterval(timer) };
}
