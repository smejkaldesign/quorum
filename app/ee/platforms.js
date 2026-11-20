// Platform connections in the Cloud edition, Zoom first: the user's Zoom account signed in through the relay's
// redirect (relay/connect.js), and each finished meeting written as a meeting note: the AI Companion summary for a
// meeting the user hosted, the user's own My Notes for any meeting they joined (zoomAi.js), and the transcript beside
// the note when the user turned transcript filing on. The relay holds the client secret and takes the webhooks; this
// side holds the user's tokens in the Keychain and does every download itself, so no recording or note passes through
// Quorum's servers.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { LOOPBACK_PORT, awaitLoopback, pkce } from '../sources/oauth.js';
import { createJobs } from '../sources/jobs.js';
import { createTokenStore } from '../sources/tokens.js';
import { scanExisting } from '../sources/index.js';
import { slug } from '../sources/granola.js';
import { SUBFOLDER, transcriptMarkdown, vaultRemote } from '../sources/transcripts.js';
import { meetingIndex, sameMeeting } from '../sources/sameMeeting.js';
import { CAPABILITIES, encodeUuid, fileNameFor as aiFileName, meetingNumberFromUrl, missingScope, noteTranscriptText, summaryText, zoomNote } from './zoomAi.js';
import { httpUrl, relayUrls, unreachable } from './relay.js';
import { plain } from './account.js';
import { oneLine, setFrontmatterKey } from '../frontmatter.js';

// Where each platform signs in and reads from. The client id and redirect URI come from platformClients().
export const PLATFORMS = {
  zoom: { name: 'Zoom', folder: 'zoom', authorize: 'https://zoom.us/oauth/authorize', api: 'https://api.zoom.us/v2' },
};
// The development Zoom app pairs with the railway.app redirect and serves the developer's own account; only a build
// run from source uses it. A packaged build reads the production pair the release workflow writes into its
// package.json (quorumOAuth.zoom), and its redirect defaults to the relay's own address.
export const ZOOM_DEV = { clientId: 'zy7lKyxyQSmPXc6rsNMzOQ', redirectUri: 'https://relay-production-e257.up.railway.app/v1/connect/zoom/callback' };
export const ZOOM_REDIRECT = 'https://relay.quorum.watch/v1/connect/zoom/callback';
// the shell first (QUORUM_ZOOM_CLIENT_ID, QUORUM_ZOOM_REDIRECT_URI), then the packaged package.json, then the
// development pair for a build from source. A packaged build without a client id shows Zoom as not available
export function platformClients({ env = process.env, packaged = null, dev = false } = {}) {
  const from = packaged?.quorumOAuth?.zoom ?? {};
  return {
    zoom: {
      clientId: env.QUORUM_ZOOM_CLIENT_ID || from.clientId || (dev ? ZOOM_DEV.clientId : null),
      redirectUri: env.QUORUM_ZOOM_REDIRECT_URI || from.redirectUri || (dev ? ZOOM_DEV.redirectUri : ZOOM_REDIRECT),
    },
  };
}
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
    `source_id: ${oneLine(m.uuid)}`,
    `title: ${JSON.stringify(title)}`,
    `date: ${oneLine(m.start_time ?? new Date().toISOString())}`,
    'participants:',
    ...(host ? [`  - ${oneLine(host)} (recorder)`] : []),
    `participant_count: ${host ? 1 : 0}`,
    'source: zoom',
    'visibility: private',
    ...(m.share_url ? [`zoom_url: ${oneLine(m.share_url)}`] : []),
    ...(m.duration ? [`duration_minutes: ${oneLine(m.duration)}`] : []),
    ...(transcriptRel ? [`transcript: ${oneLine(transcriptRel)}`] : []),
    '---',
    '',
    `# ${title}`,
    '',
  ].join('\n');
}
export const fileNameFor = (m) => `${String(m.start_time ?? '').slice(0, 10) || 'undated'}-${slug(m.topic || 'zoom-meeting')}.md`;
export const transcriptFile = (m) => (m.recording_files ?? []).find((f) => f.file_type === 'TRANSCRIPT' && (f.status ?? 'completed') === 'completed' && f.download_url) ?? null;

// the sentence a note carries for each part Zoom did not give this account
const NOT_HOST = 'AI Companion summary: Zoom gives it only to the meeting\'s host, so this account cannot read it. Ask the host to share it, or keep My Notes on so Zoom writes your own.';
const NO_MY_NOTES = 'My Notes: none in your Zoom account for this meeting. Turn on Auto-start My Notes so Zoom takes them in every meeting you join.';
// a meeting's notes, read from a filed note: its source_id and whether it has the AI Companion summary section
const filedNotes = (dir) => {
  const out = new Map();
  let names;
  try { names = readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { return out; }
  for (const f of names) {
    let text;
    try { text = readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    const sid = /^source_id:\s*"?([^"\n]+?)"?\s*$/m.exec(text.slice(0, 2000))?.[1];
    if (sid) out.set(sid, { file: path.join(dir, f), text });
  }
  return out;
};
// adds the summary section under the note's heading, above the sections already there; nothing else in the note changes
export function addSummarySection(text, summary) {
  const lines = text.split('\n');
  const close = lines.indexOf('---', 1);
  let at = lines.findIndex((l, i) => i > close && l.startsWith('## '));
  if (at < 0) at = lines.length;
  const block = ['## Summary', '', summary.trim(), ''];
  if (at === lines.length && lines[lines.length - 1] !== '') block.unshift('');
  lines.splice(at, 0, ...block);
  return lines.join('\n');
}
const cannot = (cap) => `${cap === 'summary' || cap === 'summaries' ? 'AI Companion summary' : cap === 'transcript' ? 'Transcript' : 'My Notes'}: Quorum's Zoom app cannot ${CAPABILITIES[cap].label} yet, so this part was skipped.`;
const HOUR = 3600000;
// Zoom rate-limits these endpoints and has outages: a 429, a 5xx or no answer is retried later, never treated as "no notes"
const retryable = (status) => status === 429 || status >= 500;
const busy = (status, retryAfter = null) => { const e = said(status ? `Zoom answered ${status}. Quorum tries again later.` : 'Zoom could not be reached. Quorum tries again later.'); e.busy = true; e.status = status; e.retryAfter = Number(retryAfter) > 0 ? Number(retryAfter) * 1000 : null; return e; };
// after a refusal the next automatic run waits 5, 10, 20 ... minutes, at most six hours, or as long as Zoom asked
const backoffMs = (failures, asked) => Math.max(asked ?? 0, Math.min(5 * 60000 * 2 ** Math.max(0, failures - 1), 6 * HOUR));
// a meeting whose My Notes or summary Zoom may still be writing is looked at again until this long after it was seen
const SETTLE_MS = 6 * HOUR;

// pastZoomMeetings: the Zoom calls on the calendar that ended in the last twelve hours, [{ url or number, title, start }],
// how Quorum finds My Notes for meetings the user joined but did not host when no webhook named them.
// withheldMeeting({ title, start }): a reason when the meeting's invite names someone on the never-listen list or an
// opted-out company (main.js), so its notes are never filed
export function createPlatforms({ account, clients = {}, settings, saveSettings = () => {}, meetingsDir, afterWrite = () => {}, keepKeys = (_prev, next) => next, log = () => {}, toUI = () => {}, openExternal = async () => {}, fetchImpl = globalThis.fetch, store = createTokenStore(), loopback = awaitLoopback, now = () => Date.now(), pastZoomMeetings = async () => [], withheldMeeting = async () => null }) {
  const conf = () => (settings.platforms ??= {});
  // transcript filing is off for a new connection; a connection made before the setting existed always filed them, so it keeps doing so
  // it also gets the privacy text once on the Zoom page (transcriptNotice), with a one-click turn-off
  if (conf().zoom?.connected && conf().zoom.syncTranscripts === undefined) Object.assign(conf().zoom, { syncTranscripts: true, legacyTranscripts: true });
  const stateOf = (id) => (conf()[id] ??= { connected: false, account: null, accountId: null, name: null, connectedAt: null, lastSyncAt: null, imported: 0, since: null, syncTranscripts: false });
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
    let r;
    try { r = await fetchImpl(target.startsWith('http') ? target : `${PLATFORMS[id].api}${target}`, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` } }); }
    catch { throw busy(0); }
    if (r.status === 401 && retry) { await tokenFor(id, true); return api(id, target, init, false); }
    if (retryable(r.status)) throw busy(r.status, r.headers.get('retry-after'));
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

  // a request that may be refused: { status, body } instead of an error, so a missing scope or a meeting this account
  // cannot see is an answer and not a failed import. A 429, a 5xx or no answer throws busy: try again later
  const ask = async (id, target) => {
    const go = async (t) => { try { return await fetchImpl(target.startsWith('http') ? target : `${PLATFORMS[id].api}${target}`, { headers: { authorization: `Bearer ${t}` } }); } catch { throw busy(0); } };
    let r = await go(await tokenFor(id));
    let body = await r.json().catch(() => ({}));
    if (r.status === 401 && !missingScope(r.status, body)) { r = await go(await tokenFor(id, true)); body = await r.json().catch(() => ({})); }
    if (retryable(r.status)) throw busy(r.status, r.headers.get('retry-after'));
    return { status: r.status, ok: r.ok, body };
  };

  // the summaries of meetings the user hosted, a month at a time like the recordings
  const listSummaries = async (id, sinceIso, missing) => {
    const out = [];
    let from = new Date(sinceIso);
    const end = new Date(now());
    while (from <= end) {
      const to = new Date(Math.min(from.getTime() + 29 * DAY, end.getTime()));
      let next = '';
      do {
        const u = new URL(`${PLATFORMS[id].api}/users/me/meeting_summaries`);
        u.searchParams.set('from', `${day(from)}T00:00:00Z`); u.searchParams.set('to', `${day(to)}T23:59:59Z`); u.searchParams.set('page_size', '300');
        if (next) u.searchParams.set('next_page_token', next);
        const r = await ask(id, u.toString());
        if (missingScope(r.status, r.body)) { missing.add('summaries'); return []; }
        if (!r.ok) { log('platforms', id, 'summaries', r.status); return out; }
        out.push(...(r.body.summaries ?? []));
        next = r.body.next_page_token || '';
      } while (next);
      from = new Date(to.getTime() + DAY);
    }
    return out;
  };

  // One entry per meeting, from everything that names one: cloud recordings, hosted summaries and their events carry
  // the meeting's uuid. A My Notes event's meeting_id is the meeting uuid in Zoom's examples and a number in older
  // payloads, so both are accepted; a calendar entry carries only the number from its join link. An entry keeps the
  // relay events that named it, which are acknowledged only once the meeting is settled.
  const gather = ({ recordings, summaries, events, calendar }) => {
    const list = [];
    const byUuid = new Map();
    const add = (uuid, patch = {}) => {
      let c = uuid ? byUuid.get(uuid) : null;
      if (!c) { c = { uuid: uuid ?? null, number: null, title: null, start: null, seenAt: null, duration: null, url: null, recording: null, hosted: false, summarized: false, noteIds: new Set(), events: [] }; list.push(c); if (uuid) byUuid.set(uuid, c); }
      for (const [k, v] of Object.entries(patch)) if (v != null && c[k] == null) c[k] = v;
      return c;
    };
    const num = (v) => (v != null && /^\d{9,12}$/.test(String(v)) ? String(v) : null);
    const byNumber = (number, start) => list.find((c) => c.number === number && (!c.start || !start || Math.abs(new Date(c.start) - new Date(start)) < 12 * HOUR)) ?? null;
    for (const m of recordings) add(m.uuid, { number: num(m.id), title: m.topic, start: m.start_time, duration: m.duration, url: m.share_url, recording: m }).hosted = true;
    for (const x of summaries) Object.assign(add(x.meeting_uuid, { number: num(x.meeting_id), title: x.meeting_topic, start: x.meeting_start_time }), { hosted: true, summarized: true });
    const loose = [];
    for (const e of events) {
      const o = e.payload?.object ?? {};
      let c = null;
      if (e.event === 'meeting.summary_completed' && o.meeting_uuid) c = Object.assign(add(o.meeting_uuid, { number: num(o.meeting_id), start: o.meeting_start_time }), { hosted: true, summarized: true });
      else if (e.event?.startsWith('recording.') && o.uuid) { c = add(o.uuid, { number: num(o.id), start: o.start_time }); c.hosted = true; }
      else if (e.event?.startsWith('my_notes.') && o.note_id) {
        const ref = o.meeting_id != null ? String(o.meeting_id) : null;
        const number = num(ref);
        c = number ? (byNumber(number, null) ?? add(null, { number })) : add(ref);
        c.noteIds.add(String(o.note_id));
        c.seenAt ??= e.received_at ?? null;
      }
      if (c) c.events.push(e); else loose.push(e);
    }
    for (const x of calendar) { const number = x.number ? String(x.number) : meetingNumberFromUrl(x.url); if (number && !byNumber(number, x.start)) add(null, { number, title: x.title, start: x.start }); }
    return { list, loose };
  };

  // the user's My Notes for one meeting: [{ id, url, name, created, manual, generated, transcript }]. Zoom lists them
  // by the meeting's uuid; a meeting known only by its number (a calendar entry) is asked by number
  const myNotesFor = async (id, c, { transcripts, missing }) => {
    const ids = new Map([...c.noteIds].map((n) => [n, null]));
    if (!missing.has('myNotes')) {
      for (const ref of [c.uuid, c.number].filter(Boolean)) {
        const r = await ask(id, `/my_notes/notes?meeting_id=${encodeURIComponent(ref)}`);
        if (missingScope(r.status, r.body)) { missing.add('myNotes'); break; }
        if (!r.ok) { log('platforms', id, 'my notes list', r.status); continue; }
        // a personal meeting room reuses its number every day; asked by number, only the notes made around this meeting count
        const at = ref === c.number && c.start ? new Date(c.start).getTime() : null;
        for (const n of r.body.notes ?? []) if (!at || Math.abs(new Date(n.created_time).getTime() - at) < 12 * HOUR) ids.set(String(n.note_id), n);
        if (ids.size) break;
      }
    }
    const out = [];
    for (const [noteId, meta] of ids) {
      if (missing.has('myNotesContent')) break;
      const r = await ask(id, `/my_notes/notes/${encodeURIComponent(noteId)}/content${transcripts ? '?include=transcript' : ''}`);
      if (missingScope(r.status, r.body)) { missing.add('myNotesContent'); break; }
      if (!r.ok) { log('platforms', id, 'my note', r.status); continue; }
      out.push({ id: noteId, url: r.body.note_url ?? meta?.note_link ?? null, name: r.body.note_name ?? meta?.note_name ?? null, created: meta?.created_time ?? null, manual: r.body.manual_note_content ?? '', generated: r.body.generated_note_content ?? '', transcript: r.body.transcript ? noteTranscriptText(r.body.transcript) : '' });
    }
    return out;
  };

  // the AI Companion summary: { text } when Zoom gave it, { wait } when the host's summary may still come, or { gone }
  // when this account cannot have it
  const summaryFor = async (id, c, missing) => {
    if (!c.uuid) return { gone: NOT_HOST };
    if (missing.has('summary')) return { gone: cannot('summary') };
    const r = await ask(id, `/meetings/${encodeUuid(c.uuid)}/meeting_summary`);
    if (missingScope(r.status, r.body)) { missing.add('summary'); return { gone: cannot('summary') }; }
    const text = r.ok ? summaryText(r.body) : null;
    if (text) return { text };
    // a meeting known only from My Notes is the user's own when Zoom gives its summary; otherwise it is the host's
    if (!c.hosted || (r.ok && r.body?.has_permission === false)) return { gone: NOT_HOST };
    // a meeting the user hosted with no summary yet may still get one; Zoom writes it within minutes of the end
    return now() - new Date(c.start ?? c.seenAt ?? 0).getTime() < SETTLE_MS ? { wait: true } : {};
  };

  // the transcript, filed only when the user turned it on: My Notes' own, the cloud recording's, or the AI Companion's
  const transcriptFor = async (id, c, notes, missing) => {
    const fromNotes = notes.map((n) => n.transcript).filter(Boolean).join('\n\n');
    if (fromNotes) return fromNotes;
    const file = c.recording ? transcriptFile(c.recording) : null;
    if (file) return vttToText(await (await api(id, file.download_url)).text());
    if (!c.uuid || !c.hosted || missing.has('transcript')) return '';
    const r = await ask(id, `/meetings/${encodeUuid(c.uuid)}/transcript`);
    if (missingScope(r.status, r.body)) { missing.add('transcript'); return ''; }
    if (!r.ok || !r.body?.can_download || !r.body.download_url) return '';
    return vttToText(await (await api(id, r.body.download_url)).text());
  };

  // a summary that came after the note was filed is added to that note, in its own section; nothing else changes
  const addLateSummary = async (id, c, filed, missing) => {
    const f = filed.get(c.uuid);
    if (!f || /^zoom_summary:/m.test(f.text.slice(0, 4000)) || missing.has('summary')) return false;
    const summary = await summaryFor(id, c, missing);
    if (!summary.text) return false;
    const next = setFrontmatterKey(addSummarySection(f.text, summary.text), 'zoom_summary', 'included');
    writeFileSync(f.file, next);
    afterWrite(f.file);
    filed.set(c.uuid, { ...f, text: next });
    return true;
  };

  const sync = (id) => jobs.run(id, 'Importing', async (progress) => {
    const p = PLATFORMS[id];
    const s = stateOf(id);
    const dir = folderFor(id);
    if (!dir) throw said('Pick a meeting notes folder in Settings › Memory first.');
    const existing = scanExisting(meetingsDir());
    const elsewhere = meetingIndex(meetingsDir());
    const filed = filedNotes(dir);
    const missing = new Set();
    const transcripts = !!s.syncTranscripts;
    const skipIds = new Set(s.withheld ?? []);
    const settle = [];
    const failed = [], waiting = [];
    let imported = 0, done = 0, filedElsewhere = 0, transcriptOnly = 0, withheld = 0, updated = 0, already = 0, stopped = null;
    let meetings = [];
    try {
      progress({ phase: 'list', message: `Checking ${p.name}`, total: null });
      const events = await pendingEvents(id).catch(() => []);
      const since = s.since ?? daysAgo(LOOKBACK_DAYS, now());
      const recordings = await listRecordings(id, since);
      const summaries = await listSummaries(id, since, missing);
      const calendar = await Promise.resolve().then(pastZoomMeetings).catch(() => []);
      const g = gather({ recordings, summaries, events, calendar: calendar ?? [] });
      meetings = g.list;
      // events that name no meeting have nothing to wait for
      settle.push(...g.loose);
      const known = (c) => (c.uuid && existing.has(c.uuid)) || [...c.noteIds].some((n) => existing.has(n) || existing.has(`note:${n}`));
      const todo = [];
      for (const c of meetings) {
        if ((c.uuid && skipIds.has(c.uuid)) || [...c.noteIds].some((n) => skipIds.has(n))) { already += 1; settle.push(...c.events); continue; }
        if (!known(c)) { todo.push(c); continue; }
        already += 1;
        if (c.summarized && (await addLateSummary(id, c, filed, missing))) updated += 1;
        settle.push(...c.events);
      }
      progress({ phase: 'import', phaseStartedAt: now(), total: todo.length, done: 0, message: todo.length ? `Checking ${todo.length} new of ${meetings.length} meetings` : 'Nothing new' });
      for (const c of todo) {
        try {
          const keep = await fileMeeting(id, c, { s, dir, transcripts, missing, existing, elsewhere });
          if (keep === 'imported') imported += 1;
          else if (keep === 'elsewhere') filedElsewhere += 1;
          else if (keep === 'withheld') { withheld += 1; s.withheld = [...new Set([...(s.withheld ?? []), ...(c.uuid ? [c.uuid] : []), ...c.noteIds])].slice(-500); }
          else if (keep === 'transcript-only') transcriptOnly += 1;
          if (keep === 'waiting') waiting.push(c); else settle.push(...c.events);
        } catch (err) {
          if (err.busy) throw err;
          failed.push({ id: c.uuid ?? c.number ?? '', title: c.title ?? '', error: err.message });
        } finally { done += 1; progress({ done, message: `Imported ${imported} of ${todo.length}` }); }
      }
    } catch (err) {
      if (!err.busy) throw err;
      // Zoom refused or did not answer: what is filed stays, the rest of the events stay queued for the next run
      stopped = err;
    }
    await ackEvents(id, settle).catch((err) => log('platforms', id, 'ack', err.message));
    // next time: two days back, or far enough to see a meeting Zoom is still processing
    const oldestWaiting = waiting.map((c) => c.start ?? c.seenAt).filter(Boolean).sort()[0];
    s.since = oldestWaiting && new Date(oldestWaiting).getTime() < now() - 2 * DAY ? new Date(new Date(oldestWaiting).getTime() - DAY).toISOString() : daysAgo(2, now());
    s.lastSyncAt = new Date(now()).toISOString();
    s.imported = (s.imported ?? 0) + imported;
    s.missing = [...missing];
    // repeated refusals back off and show on the Connectors page; a clean run clears them
    if (stopped) {
      const failures = (s.retry?.failures ?? 0) + 1;
      s.retry = { failures, status: stopped.status ?? 0, at: new Date(now()).toISOString(), until: new Date(now() + backoffMs(failures, stopped.retryAfter)).toISOString() };
    } else s.retry = null;
    saveSettings();
    log('platforms', id, `listed ${meetings.length}, imported ${imported}, summaries added ${updated}, waiting ${waiting.length}, elsewhere ${filedElsewhere}, withheld ${withheld}, transcript only ${transcriptOnly}, missing ${s.missing.map((k) => CAPABILITIES[k].scope).join(' ') || 'none'}, failed ${failed.length}${stopped ? `, stopped: ${stopped.message}` : ''}`);
    if (failed.length) progress({ failed });
    if (imported) toUI('log', `${p.name}: ${imported} ${imported === 1 ? 'meeting' : 'meetings'} added to your notes.`);
    if (stopped && !imported) throw stopped;
    return { listed: meetings.length, imported, updated, skipped: already + filedElsewhere + withheld, elsewhere: filedElsewhere, withheld, transcriptOnly, waiting: waiting.length, acked: settle.length, missing: s.missing.map((k) => CAPABILITIES[k].scope), stopped: stopped?.message ?? null, failed };
  });

  // One meeting: 'imported', 'waiting' (Zoom may still be writing it), 'elsewhere' (another source filed the same
  // event), 'withheld' (the invite is on the never-listen or opt-out list), 'transcript-only' or 'empty'.
  const fileMeeting = async (id, c, { s, dir, transcripts, missing, existing, elsewhere }) => {
    if (c.title && (await isWithheld(c))) { log('platforms', id, 'skipped a meeting on the never-listen or opt-out list'); return 'withheld'; }
    const notes = (await myNotesFor(id, c, { transcripts, missing })).filter((n) => n.manual.trim() || n.generated.trim() || n.transcript);
    if (notes.length) s.myNotesSeenAt = new Date(now()).toISOString();
    // a meeting known only from its notes takes their title and the time the first note was started
    c.start ??= notes[0]?.created ?? null;
    c.title ??= notes[0]?.name ?? null;
    if (await isWithheld(c)) { log('platforms', id, 'skipped a meeting on the never-listen or opt-out list'); return 'withheld'; }
    if (sameMeeting(elsewhere, { date: c.start, title: c.title, source: 'zoom' })) return 'elsewhere';
    const summary = await summaryFor(id, c, missing);
    // a hosted meeting is filed once, with its summary: while Zoom may still write the summary, it waits
    if (summary.wait) return 'waiting';
    const hasNotes = notes.some((n) => n.manual.trim() || n.generated.trim());
    const text = transcripts ? await transcriptFor(id, c, notes, missing) : '';
    if (!summary.text && !hasNotes && !text) {
      // still processing in Zoom: look again next run; otherwise there is nothing this account can file
      if (transcripts && c.recording && !transcriptFile(c.recording)) return 'waiting';
      if (c.noteIds.size && now() - new Date(c.seenAt ?? 0).getTime() < SETTLE_MS) return 'waiting';
      return c.recording && transcriptFile(c.recording) ? 'transcript-only' : 'empty';
    }
    c.start ??= c.seenAt ?? new Date(now()).toISOString();
    const name = aiFileName(c);
    mkdirSync(dir, { recursive: true });
    let transcriptRel = null;
    if (text) {
      mkdirSync(path.join(dir, SUBFOLDER), { recursive: true });
      const tFile = path.join(dir, SUBFOLDER, name);
      writeFileSync(tFile, transcriptMarkdown({ id: c.uuid ?? `note:${notes[0]?.id}`, title: c.title, date: c.start, source: id, recorder: s.name }, text));
      afterWrite(tFile);
      transcriptRel = `${SUBFOLDER}/${name}`;
    }
    const gone = [summary.gone, !hasNotes && summary.text && !c.hosted ? NO_MY_NOTES : null, ...['myNotes', 'myNotesContent'].filter((k) => missing.has(k)).map(cannot)].filter(Boolean);
    const note = zoomNote({ uuid: c.uuid, number: c.number, title: c.title, start: c.start, duration: c.duration, url: c.url, host: s.name }, { summary: summary.text ?? null, notes, missing: [...new Set(gone)], transcriptRel });
    const sourceId = /^source_id: (.+)$/m.exec(note)[1];
    // a second meeting with the same title on the same day keeps the first file and gets the id in its own name
    let file = path.join(dir, name);
    if (existsSync(file) && !readFileSync(file, 'utf8').includes(sourceId)) file = path.join(dir, name.replace(/\.md$/, `-${slug(sourceId).slice(0, 8)}.md`));
    // the note names the Zoom account it came from, and a re-import keeps the person's share choice and the keys
    // the guardrails protect (keepKeys, from main.js)
    const own = s.account && !/[\r\n]/.test(s.account) ? setFrontmatterKey(note, 'source_account', JSON.stringify(String(s.account))) : note;
    writeFileSync(file, keepKeys(existsSync(file) ? readFileSync(file, 'utf8') : null, own));
    afterWrite(file);
    existing.add(sourceId);
    for (const n of notes) existing.add(n.id);
    return 'imported';
  };
  const isWithheld = async (c) => { try { return !!(await withheldMeeting({ title: c.title, start: c.start })); } catch { return false; } };

  const app = (id) => (PLATFORMS[id] ? { ...PLATFORMS[id], clientId: null, redirectUri: null, ...clients[id] } : null);

  const connect = async (id) => {
    const p = app(id);
    if (!p) return { error: 'Unknown platform.' };
    const no = ready();
    if (no) return { error: no };
    if (!p.clientId) return { error: `${p.name} connections are not available in this build.` };
    const { verifier, challenge } = pkce();
    const state = `${randomBytes(12).toString('base64url')}.p${LOOPBACK_PORT}`;
    const waiting = loopback({ state });
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
      // the relay reads the account from Zoom with this token instead of trusting the ids; they stay for older relays
      await relay(`/v1/connect/${id}/account`, { body: { accessToken: tokens.accessToken, accountId: me.account_id, externalUserId: me.id } });
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

  const list = () => Object.keys(PLATFORMS).map((id) => {
    const p = app(id);
    const s = stateOf(id);
    const dir = folderFor(id);
    return { id, name: p.name, available: !!p.clientId, connected: !!s.connected, account: s.account, accountName: s.name, lastSyncAt: s.lastSyncAt, imported: s.imported ?? 0, notes: dir ? countNotes(dir) : 0, folderPath: dir, job: jobs.snapshot(id), syncTranscripts: !!s.syncTranscripts, vaultRemote: dir ? vaultRemote(meetingsDir()) : null, missing: (s.missing ?? []).map((k) => CAPABILITIES[k]?.label).filter(Boolean), myNotes: { seenAt: s.myNotesSeenAt ?? null, confirmedAt: s.notesConfirmedAt ?? null }, transcriptNotice: !!(s.legacyTranscripts && s.syncTranscripts && !s.transcriptNoticeSeen), trouble: s.retry?.failures >= 3 ? { failures: s.retry.failures, status: s.retry.status, at: s.retry.at, until: s.retry.until } : null };
  });

  // the webhook queue says when a recording, summary or note finished; a pass every two hours covers what it missed
  const tick = async () => {
    for (const id of Object.keys(PLATFORMS)) {
      const s = stateOf(id);
      if (!s.connected || jobs.running(id) || ready()) continue;
      try {
        // after Zoom refused, wait out the backoff; otherwise a run every two hours keeps the calendar look-back covered
        if (s.retry?.until && new Date(s.retry.until).getTime() > now()) continue;
        const events = await pendingEvents(id);
        const stale = !s.lastSyncAt || now() - new Date(s.lastSyncAt).getTime() > 2 * HOUR;
        if (events.length || stale) await sync(id);
      } catch (err) { log('platforms', id, 'tick', err.message); }
    }
  };

  const handlers = {
    'platforms-list': () => list(),
    'platform-connect': (id) => connect(id),
    'platform-disconnect': (id) => disconnect(id),
    // transcript filing (off by default) and "I turned My Notes on" from the Zoom connector's page
    'platform-set-option': (id, patch = {}) => {
      if (!PLATFORMS[id]) return { error: 'Unknown platform.' };
      const s = stateOf(id);
      if (typeof patch.syncTranscripts === 'boolean') s.syncTranscripts = patch.syncTranscripts;
      if (typeof patch.notesConfirmed === 'boolean') s.notesConfirmedAt = patch.notesConfirmed ? new Date(now()).toISOString() : null;
      if (patch.transcriptNoticeSeen === true) s.transcriptNoticeSeen = true;
      saveSettings();
      return { ok: true };
    },
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
