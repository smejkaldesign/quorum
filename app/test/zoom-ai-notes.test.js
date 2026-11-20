import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addSummarySection, createPlatforms } from '../ee/platforms.js';
import { encodeUuid, fileNameFor, meetingNumberFromUrl, missingScope, noteTranscriptText, summaryText, zoomNote } from '../ee/zoomAi.js';
import { meetingIndex, sameMeeting } from '../cli/sameMeeting.mjs';
import { vaultRemote } from '../sources/transcripts.js';
import { importPrompt } from '../sources/agent-import.js';
import { joinAdvice } from '../joinAdvice.js';
import { CONNECTOR_BY_ID, withoutOf } from '../connectors/library.js';
import { readFrontmatter } from '../frontmatter.js';

import { listEvents } from '../sources/gcal.js';
import { sync as granolaSync } from '../sources/granola.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'quorum.mjs');

// Fixtures copied from Zoom's docs, values filled in where the docs leave "":
//   developers.zoom.us/docs/api/meetings  (GET /meetings/{meetingId}/meeting_summary, GET /users/{userId}/meeting_summaries)
//   developers.zoom.us/docs/api/my-notes  (GET /my_notes/notes, GET /my_notes/notes/{noteId}/content)
// and the relay's stored events, which keep only routing fields (relay/connect.js eventRoute)
const UUID = 'TvC-TbvRRS-rYfehr2M1RA==';
const summaryOf = (start, over = {}) => ({ meeting_host_id: 'zu1', meeting_host_email: 'alex@example.com', meeting_uuid: UUID, meeting_id: 81234567890, meeting_topic: 'Roadmap review', meeting_start_time: start, meeting_end_time: start, summary_start_time: start, summary_end_time: start, summary_created_time: start, summary_last_modified_time: start, summary_title: 'Meeting summary for Roadmap review', summary_content: '## Key takeaways\n- Ship the importer.', summary_doc_url: 'https://docs.zoom.us/doc/1aBcDeFgHiJkLmNoPqRsTu', ...over });
const listOf = (start, ...summaries) => ({ from: start, to: start, page_size: 300, next_page_token: '', summaries });
const noteList = (start, id = 'lXyU1N4sTzSON6cgVwQ48Q', name = 'Weekly Sync Notes') => ({ notes: [{ note_id: id, note_name: name, note_link: `https://docs.zoom.us/doc/${id}`, created_time: start, modified_time: start }] });
const noteContent = (id = 'lXyU1N4sTzSON6cgVwQ48Q', over = {}) => ({
  note_id: id, note_name: 'Weekly Sync Notes', note_url: 'https://docs.zoom.us/doc/9S1Vnf13RmqZ0ZYAD-k6uA',
  manual_note_content: 'Discussion follow-ups to review before the next sync.',
  generated_note_content: '## Summary\n- Reviewed API rollout\n- Confirmed self-test plan',
  transcript: { items: [{ text: 'Hello hello hello.', start_time: '00:00:21.743', end_time: '00:00:23.923', speaker_id: '2049487510' }, { text: 'Can everyone hear me?', start_time: '00:00:24.100', end_time: '00:00:25.000', speaker_id: '2049487510' }, { text: 'Yes.', start_time: '00:01:05.000', end_time: '00:01:06.000', speaker_id: '2049486460' }], speakers: [{ speaker_id: '2049487510', display_name: 'William Smith', zoom_user_id: 'OnsTZFMpTUWD_YTo2Z_3Lg' }, { speaker_id: '2049486460', display_name: 'Speaker 1' }] },
  ...over,
});
const summaryEvent = (id, start) => ({ id, event: 'meeting.summary_completed', external_id: UUID, received_at: start, payload: { account_id: 'acc1', object: { meeting_host_id: 'zu1', meeting_uuid: UUID, meeting_id: 81234567890, meeting_start_time: start } } });
const noteEvent = (id, noteId, meetingId, at) => ({ id, event: 'my_notes.note_completed', external_id: noteId, received_at: at, payload: { account_id: 'acc1', operator_id: 'zu1', object: { note_id: noteId, meeting_id: meetingId } } });

describe('zoom AI notes shapes', () => {
  it('reads the summary from summary_content, the older fields, or not at all', () => {
    expect(summaryText(summaryOf(''))).toBe('## Key takeaways\n- Ship the importer.');
    expect(summaryText({ summary_overview: 'We met.', summary_details: [{ label: 'Plan', summary: 'Do it.' }], next_steps: ['Alex writes it'] })).toBe('We met.\n\n### Plan\n\nDo it.\n\n### Next steps\n\n- Alex writes it');
    expect(summaryText({ summary_overview: 'old', edited_summary: { summary_overview: 'edited', next_steps: ['x'] } })).toBe('edited\n\n### Next steps\n\n- x');
    expect(summaryText({ has_permission: false, summary_content: 'hidden' })).toBeNull();
    expect(summaryText({})).toBeNull();
  });
  it('turns a My Notes transcript into timestamped turns named by display_name', () => {
    expect(noteTranscriptText(noteContent().transcript)).toBe('[0:21] William Smith: Hello hello hello. Can everyone hear me?\n\n[1:05] Speaker 1: Yes.');
  });
  it('finds the meeting number in a join link and encodes uuids Zoom needs twice-encoded', () => {
    expect(meetingNumberFromUrl('https://acme.zoom.us/j/81234567890?pwd=abc')).toBe('81234567890');
    expect(meetingNumberFromUrl('https://meet.google.com/abc-defg-hij')).toBeNull();
    expect(encodeUuid('/ab//c==')).toBe(encodeURIComponent(encodeURIComponent('/ab//c==')));
    expect(encodeUuid('abc==')).toBe('abc%3D%3D');
  });
  it('treats a 4711 or a scopes message as a missing scope, nothing else', () => {
    expect(missingScope(400, { code: 4711, message: 'Invalid access token, does not contain scopes:[my_notes:read:note].' })).toBe(true);
    expect(missingScope(401, { message: 'does not contain scopes' })).toBe(true);
    expect(missingScope(404, { code: 3001 })).toBe(false);
    expect(missingScope(200, { code: 4711 })).toBe(false);
  });
  it('writes the note in the shared imported-meeting shape, with a line for each missing part', () => {
    const md = zoomNote({ uuid: null, number: '81234567890', title: 'Partner sync', start: '2026-11-18T17:00:00Z', host: 'Alex Rivera' }, { notes: [{ id: 'n1', url: 'https://zoom.us/my-notes/n1', manual: 'my line', generated: 'recap' }], missing: ['AI Companion summary: not yours.'] });
    expect(readFrontmatter(md)).toMatchObject({ source_id: 'note:n1', source: 'zoom', visibility: 'private', zoom_note_id: 'n1', zoom_url: 'https://zoom.us/my-notes/n1' });
    expect(md).toContain('## My notes\n\nmy line');
    expect(md).toContain('## My Notes recap\n\nrecap');
    expect(readFrontmatter(md).zoom_summary).toBeUndefined();
    expect(md).toContain('## Not imported\n\n- AI Companion summary: not yours.');
    expect(fileNameFor({ title: 'Partner sync', start: '2026-11-18T17:00:00Z' })).toBe('2026-11-18-partner-sync.md');
  });
  it('adds a late summary under the heading and leaves every other line alone', () => {
    const before = '---\nsource_id: x\n---\n\n# Sync\n\n## My notes\n\nmine\n';
    const after = addSummarySection(before, 'The summary.');
    expect(after).toBe('---\nsource_id: x\n---\n\n# Sync\n\n## Summary\n\nThe summary.\n\n## My notes\n\nmine\n');
    expect(addSummarySection('---\na: 1\n---\n\n# Only\n', 'S')).toBe('---\na: 1\n---\n\n# Only\n\n## Summary\n\nS\n');
  });
});

// a fake relay plus a fake Zoom; routes answer by path (or path and query), a missing route is 404; a route returns
// [status, body] or [status, body, headers]
function world({ routes = {}, events = [] } = {}) {
  const calls = [];
  const state = { routes: { '/v2/users/me/recordings': [200, { meetings: [], next_page_token: '' }], ...routes }, events };
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null });
    const u = new URL(url);
    if (u.pathname.endsWith('/v1/connect/events/ack')) { const ids = JSON.parse(init.body).ids; state.events = state.events.filter((e) => !ids.includes(e.id)); return new Response(JSON.stringify({ ok: true }), { status: 200 }); }
    if (u.pathname.endsWith('/v1/connect/events')) return new Response(JSON.stringify({ events: state.events }), { status: 200 });
    if (init.headers?.authorization !== 'Bearer zoom-at') return new Response('{}', { status: 401 });
    const route = state.routes[`${u.pathname}${u.search}`] ?? state.routes[u.pathname];
    if (!route) return new Response('{}', { status: 404 });
    const [status, body, headers = {}] = typeof route === 'function' ? route(u) : route;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
  };
  const account = { client: () => ({ auth: { getSession: async () => ({ data: { session: { access_token: 'session-tok' } } }) } }), state: () => ({ signedIn: true, workspace: { id: 'ws1' } }), envStatus: () => ({ config: 'production' }) };
  const saved = { 'platform-zoom': { accessToken: 'zoom-at', refreshToken: 'rt', expiresAt: Date.now() + 365 * 86400000 } };
  const store = { tokens: { get: async (k) => saved[k] ?? null, set: async (k, v) => { saved[k] = v; } } };
  return { calls, state, fetchImpl, account, store, acked: () => calls.filter((c) => c.url.endsWith('/v1/connect/events/ack')).flatMap((c) => c.body.ids) };
}
const CLIENTS = { zoom: { clientId: 'zoom-client', redirectUri: 'https://relay.example/cb' } };
const SCOPE = (scope) => [400, { code: 4711, message: `Invalid access token, does not contain scopes:[${scope}].` }];
const zoomFiles = (dir) => { try { return readdirSync(path.join(dir, 'zoom')).filter((f) => f.endsWith('.md')); } catch { return []; } };

describe('zoom AI notes import', () => {
  let dir, clock;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'quorum-zoom-ai-')); clock = Date.parse('2026-11-19T18:00:00Z'); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const at = (hoursBack) => new Date(clock - hoursBack * 3600000).toISOString();
  const makeWith = (w, over = {}) => { const settings = over.settings ?? { platforms: { zoom: { connected: true, name: 'Alex Rivera', account: 'alex@example.com', syncTranscripts: false } } }; const p = createPlatforms({ clients: CLIENTS, account: w.account, meetingsDir: () => dir, fetchImpl: w.fetchImpl, store: w.store, now: () => clock, ...over, settings }); return Object.assign(p, { settings }); };

  it('files a hosted meeting once: the AI Companion summary and the user\'s My Notes in one note, the My Notes event merged by uuid', async () => {
    const start = at(3);
    const w = world({
      events: [summaryEvent(1, start), noteEvent(2, 'lXyU1N4sTzSON6cgVwQ48Q', UUID, at(2))],
      routes: {
        '/v2/users/me/meeting_summaries': [200, listOf(start, summaryOf(start))],
        [`/v2/meetings/${encodeUuid(UUID)}/meeting_summary`]: [200, summaryOf(start)],
        '/v2/my_notes/notes': (u) => (u.searchParams.get('meeting_id') === UUID ? [200, noteList(start)] : [200, { notes: [] }]),
        '/v2/my_notes/notes/lXyU1N4sTzSON6cgVwQ48Q/content': [200, noteContent()],
      },
    });
    const p = makeWith(w);
    const r = await p.sync('zoom');
    expect(r).toMatchObject({ imported: 1, failed: [] });
    expect(zoomFiles(dir)).toHaveLength(1);
    const md = readFileSync(path.join(dir, 'zoom', zoomFiles(dir)[0]), 'utf8');
    expect(readFrontmatter(md)).toMatchObject({ source_id: UUID, source: 'zoom', zoom_note_id: 'lXyU1N4sTzSON6cgVwQ48Q', zoom_meeting_id: '81234567890', source_account: 'alex@example.com' });
    expect(md).toContain('## Summary\n\n## Key takeaways');
    expect(readFrontmatter(md).zoom_summary).toBe('included');
    expect(md).toContain('## My notes\n\nDiscussion follow-ups');
    expect(md).toContain('## My Notes recap');
    expect(md).not.toContain('Not imported');
    expect(existsSync(path.join(dir, 'zoom', 'transcripts'))).toBe(false);
    expect(w.calls.some((c) => c.url.includes('include=transcript'))).toBe(false);
    expect(w.acked().sort()).toEqual([1, 2]);
    expect(p.list()[0].myNotes.seenAt).toBeTruthy();
    expect(await p.sync('zoom')).toMatchObject({ imported: 0 });
  });

  it('for a meeting the user only joined, files their My Notes with the host line, and the transcript when asked', async () => {
    const w = world({
      events: [noteEvent(9, 'n2', 'Att-UUID==', at(2))],
      routes: {
        '/v2/my_notes/notes': [200, noteList(at(3), 'n2', 'Partner sync')],
        '/v2/my_notes/notes/n2/content': [200, noteContent('n2', { note_name: 'Partner sync', manual_note_content: '' })],
        [`/v2/meetings/${encodeUuid('Att-UUID==')}/meeting_summary`]: [400, { code: 3001, message: 'Meeting does not exist or you are not its host.' }],
      },
    });
    const p = makeWith(w);
    p.handlers['platform-set-option']('zoom', { syncTranscripts: true });
    expect(await p.sync('zoom')).toMatchObject({ imported: 1 });
    const [name] = zoomFiles(dir);
    const md = readFileSync(path.join(dir, 'zoom', name), 'utf8');
    expect(readFrontmatter(md)).toMatchObject({ source_id: 'Att-UUID==', zoom_note_id: 'n2', transcript: `transcripts/${name}`, title: 'Partner sync' });
    expect(md).toContain('## My Notes recap\n\n## Summary\n- Reviewed API rollout');
    expect(md).toMatch(/Not imported\n\n- AI Companion summary: Zoom gives it only to the meeting's host/);
    expect(w.calls.some((c) => c.url.endsWith('/my_notes/notes/n2/content?include=transcript'))).toBe(true);
    expect(readFileSync(path.join(dir, 'zoom', 'transcripts', name), 'utf8')).toContain('[0:21] William Smith: Hello hello hello. Can everyone hear me?');
    expect(w.acked()).toEqual([9]);
  });

  it('holds a hosted meeting while its summary may still come, files it later, and adds a summary that arrives after filing', async () => {
    const start = at(1);
    const w = world({
      events: [noteEvent(4, 'n4', UUID, at(0.5))],
      routes: {
        '/v2/users/me/meeting_summaries': [200, listOf(start)],
        '/v2/users/me/recordings': [200, { meetings: [{ uuid: UUID, id: 81234567890, topic: 'Roadmap review', start_time: start, duration: 30, recording_files: [] }], next_page_token: '' }],
        '/v2/my_notes/notes': [200, noteList(start, 'n4', 'Roadmap review')],
        '/v2/my_notes/notes/n4/content': [200, noteContent('n4')],
      },
    });
    const p = makeWith(w);
    // the summary is not written yet: nothing is filed and the event stays queued
    expect(await p.sync('zoom')).toMatchObject({ imported: 0, waiting: 1 });
    expect(zoomFiles(dir)).toHaveLength(0);
    expect(w.acked()).toEqual([]);
    // seven hours on with no summary, the notes are filed on their own
    clock += 7 * 3600000;
    expect(await p.sync('zoom')).toMatchObject({ imported: 1 });
    expect(w.acked()).toEqual([4]);
    const file = path.join(dir, 'zoom', zoomFiles(dir)[0]);
    expect(readFrontmatter(readFileSync(file, 'utf8')).zoom_summary).toBeUndefined();
    // then Zoom finishes the summary: it joins the same note
    w.state.routes['/v2/users/me/meeting_summaries'] = [200, listOf(start, summaryOf(start))];
    w.state.routes[`/v2/meetings/${encodeUuid(UUID)}/meeting_summary`] = [200, summaryOf(start)];
    expect(await p.sync('zoom')).toMatchObject({ imported: 0, updated: 1 });
    expect(zoomFiles(dir)).toHaveLength(1);
    const md = readFileSync(file, 'utf8');
    expect(md).toMatch(/# Roadmap review\n\n## Summary\n\n## Key takeaways[\s\S]*## My notes\n\nDiscussion follow-ups/);
    expect(readFrontmatter(md).zoom_summary).toBe('included');
    expect(await p.sync('zoom')).toMatchObject({ updated: 0 });
  });

  it('keeps events queued on a 429 or a 5xx, backs off as Zoom asks, and shows repeated refusals', async () => {
    const w = world({
      events: [noteEvent(5, 'n5', 'Att-UUID==', at(1))],
      routes: { '/v2/my_notes/notes': [429, { code: 429, message: 'Too many requests' }, { 'retry-after': '1800' }] },
    });
    const p = makeWith(w);
    await expect(p.sync('zoom')).rejects.toThrow(/429/);
    expect(w.acked()).toEqual([]);
    expect(zoomFiles(dir)).toHaveLength(0);
    expect(Date.parse(p.settings.platforms.zoom.retry.until) - clock).toBe(30 * 60000);
    // the timer waits out the backoff
    const before = w.calls.length;
    await p.tick();
    expect(w.calls.length).toBe(before);
    w.state.routes['/v2/my_notes/notes'] = [503, {}];
    await expect(p.sync('zoom')).rejects.toThrow(/503/);
    await expect(p.sync('zoom')).rejects.toThrow(/503/);
    expect(p.list()[0].trouble).toMatchObject({ failures: 3, status: 503 });
    // Zoom answers again: the note is filed, the event acknowledged, the trouble cleared
    w.state.routes['/v2/my_notes/notes'] = [200, noteList(at(1), 'n5', 'Partner sync')];
    w.state.routes['/v2/my_notes/notes/n5/content'] = [200, noteContent('n5')];
    expect(await p.sync('zoom')).toMatchObject({ imported: 1 });
    expect(w.acked()).toEqual([5]);
    expect(p.list()[0].trouble).toBeNull();
  });

  it('never files a meeting on the never-listen or opt-out list, and logs that it skipped it', async () => {
    const logs = [];
    const w = world({
      events: [noteEvent(6, 'n6', 'Int-UUID==', at(1))],
      routes: { '/v2/my_notes/notes': [200, noteList(at(2), 'n6', 'Interview: Sam Lee')], '/v2/my_notes/notes/n6/content': [200, noteContent('n6', { note_name: 'Interview: Sam Lee' })] },
    });
    const p = makeWith(w, { log: (...a) => logs.push(a.join(' ')), withheldMeeting: async ({ title }) => (/Interview/.test(title ?? '') ? 'never-listen' : null) });
    expect(await p.sync('zoom')).toMatchObject({ imported: 0, withheld: 1 });
    expect(zoomFiles(dir)).toHaveLength(0);
    expect(w.acked()).toEqual([6]);
    expect(logs.some((l) => /skipped a meeting on the never-listen or opt-out list/.test(l))).toBe(true);
    expect(p.settings.platforms.zoom.withheld).toEqual(['Int-UUID==', 'n6']);
    // a later run does not fetch it again
    w.state.events = [noteEvent(7, 'n6', 'Int-UUID==', at(1))];
    const before = w.calls.filter((c) => c.url.includes('/my_notes/')).length;
    await p.sync('zoom');
    expect(w.calls.filter((c) => c.url.includes('/my_notes/')).length).toBe(before);
  });

  it('finds My Notes for a calendar Zoom call with no webhook, and skips a meeting another source filed once its title is known', async () => {
    const start = at(1);
    mkdirSync(path.join(dir, 'granola'), { recursive: true });
    writeFileSync(path.join(dir, 'granola', 'g.md'), `---\nsource_id: g1\ntitle: "Design crit"\ndate: ${start}\nsource: granola\n---\n# Design crit\n`);
    const w = world({ routes: {
      '/v2/my_notes/notes': (u) => (u.searchParams.get('meeting_id') === '81111111111' ? [200, noteList(start, 'n3', 'Hiring sync')] : [200, noteList(start, 'n4', 'Design crit')]),
      '/v2/my_notes/notes/n3/content': [200, noteContent('n3', { note_name: 'Hiring sync', manual_note_content: 'Two candidates.' })],
      '/v2/my_notes/notes/n4/content': [200, noteContent('n4', { note_name: 'Design crit' })],
    } });
    const p = makeWith(w, { pastZoomMeetings: async () => [{ url: 'https://acme.zoom.us/j/81111111111?pwd=x', title: 'Hiring sync', start }, { url: 'https://acme.zoom.us/j/82222222222', title: 'Design crit', start }] });
    expect(await p.sync('zoom')).toMatchObject({ imported: 1, elsewhere: 1 });
    expect(zoomFiles(dir)).toHaveLength(1);
    expect(readFileSync(path.join(dir, 'zoom', zoomFiles(dir)[0]), 'utf8')).toContain('Two candidates.');
  });

  it('degrades cleanly when the Zoom app lacks the new scopes, and says which parts are missing', async () => {
    const start = at(30);
    const w = world({
      events: [summaryEvent(3, start)],
      routes: {
        '/v2/users/me/meeting_summaries': SCOPE('meeting:read:list_summaries'),
        [`/v2/meetings/${encodeUuid(UUID)}/meeting_summary`]: SCOPE('meeting:read:summary'),
        '/v2/my_notes/notes': SCOPE('my_notes:read:note'),
      },
    });
    const p = makeWith(w);
    const r = await p.sync('zoom');
    expect(r).toMatchObject({ imported: 0, failed: [] });
    expect(r.missing.sort()).toEqual(['meeting:read:list_summaries', 'meeting:read:summary', 'my_notes:read:note']);
    expect(p.list()[0].missing).toEqual(expect.arrayContaining(['list your My Notes', 'read AI Companion summaries']));
    expect(w.acked()).toEqual([3]);
  });

  it('a connection made before the transcript setting keeps filing them and sees the privacy text once', () => {
    const w = world();
    const settings = { platforms: { zoom: { connected: true } } };
    const p = createPlatforms({ clients: CLIENTS, account: w.account, settings, meetingsDir: () => dir, fetchImpl: w.fetchImpl, store: w.store });
    expect(settings.platforms.zoom.syncTranscripts).toBe(true);
    expect(p.list()[0].transcriptNotice).toBe(true);
    p.handlers['platform-set-option']('zoom', { syncTranscripts: false, transcriptNoticeSeen: true });
    expect(p.list()[0]).toMatchObject({ transcriptNotice: false, syncTranscripts: false });
    const fresh = createPlatforms({ clients: CLIENTS, account: w.account, settings: { platforms: {} }, meetingsDir: () => dir, fetchImpl: w.fetchImpl, store: w.store });
    expect(fresh.list()[0]).toMatchObject({ syncTranscripts: false, transcriptNotice: false });
  });
});

describe('calendar look-back', () => {
  it('reads Google from an earlier time, so meetings that already ended come back', async () => {
    const asked = [];
    const fetchImpl = async (url) => {
      asked.push(url);
      if (url.includes('/calendarList')) return new Response(JSON.stringify({ items: [{ id: 'primary', summary: 'Me' }] }), { status: 200 });
      return new Response(JSON.stringify({ items: [{ id: 'e1', summary: 'Hiring sync', start: { dateTime: '2026-11-19T09:00:00Z' }, end: { dateTime: '2026-11-19T09:30:00Z' }, location: 'https://acme.zoom.us/j/81111111111' }] }), { status: 200 });
    };
    const now = Date.parse('2026-11-19T18:00:00Z');
    const r = await listEvents({ client: {}, tokens: { accessToken: 'g' }, days: 1, from: now - 12 * 3600000, fetchImpl, now });
    expect(new URL(asked[1]).searchParams.get('timeMin')).toBe('2026-11-19T06:00:00.000Z');
    expect(r.events.map((e) => e.title)).toEqual(['Hiring sync']);
    await listEvents({ client: {}, tokens: { accessToken: 'g' }, days: 1, fetchImpl, now });
    expect(new URL(asked[3]).searchParams.get('timeMin')).toBe('2026-11-19T18:00:00.000Z');
  });
});

describe('one calendar event, one note, for every source', () => {
  it('Granola leaves out a meeting another source already filed', async () => {
    const meetings = '<meetings_list><meeting id="g1" title="Weekly sync" meeting_at="2026-11-18T17:02:00Z"></meeting><meeting id="g2" title="Pricing" meeting_at="2026-11-18T19:00:00Z"></meeting></meetings_list>';
    const details = (ids) => ids.map((id) => `<meeting id="${id}" title="${id === 'g1' ? 'Weekly sync' : 'Pricing'}" meeting_at="2026-11-18T19:00:00Z"><summary>s</summary></meeting>`).join('');
    const mcp = { call: async (tool, args) => ({ text: tool === 'search_meetings' ? meetings : details(args.meeting_ids) }) };
    const written = [];
    const r = await granolaSync({ mcp, existing: new Set(), write: async (name, _t, m) => { written.push(m.id); return name; }, elsewhere: (m) => m.id === 'g1' });
    expect(written).toEqual(['g2']);
    expect(r).toMatchObject({ imported: 1, skipped: 1 });
  });
});

describe('same meeting across sources', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'quorum-same-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  it('matches by start time and title, or by time when one title is Zoom\'s default; never within one source', () => {
    mkdirSync(path.join(dir, 'granola', 'transcripts'), { recursive: true });
    writeFileSync(path.join(dir, 'granola', 'a.md'), '---\ntitle: "Weekly sync"\ndate: 2026-11-18T17:00:00Z\nsource: granola\n---\n');
    writeFileSync(path.join(dir, 'granola', 'transcripts', 'a.md'), '---\ntype: transcript\ntitle: "Weekly sync (transcript)"\ndate: 2026-11-18T17:00:00Z\nsource: granola\n---\n');
    const index = meetingIndex(dir);
    expect(index).toHaveLength(1);
    expect(sameMeeting(index, { date: '2026-11-18T17:04:00Z', title: 'Weekly Sync', source: 'zoom' })?.source).toBe('granola');
    expect(sameMeeting(index, { date: '2026-11-18T17:04:00Z', title: "Alex Rivera's Zoom Meeting", source: 'zoom' })).toBeTruthy();
    expect(sameMeeting(index, { date: '2026-11-18T17:04:00Z', title: 'Pricing review', source: 'zoom' })).toBeNull();
    expect(sameMeeting(index, { date: '2026-11-18T18:00:00Z', title: 'Weekly sync', source: 'zoom' })).toBeNull();
    expect(sameMeeting(index, { date: '2026-11-18T17:00:00Z', title: 'Weekly sync', source: 'granola' })).toBeNull();
    // a meeting with no title yet matches nothing, so back-to-back meetings are never confused
    expect(sameMeeting(index, { date: '2026-11-18T17:00:00Z', title: null, source: 'zoom' })).toBeNull();
  });
});

describe('transcript privacy', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'quorum-remote-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  it('names only the host a vault pushes to, never the URL or its credentials', () => {
    const meetings = path.join(dir, '08-meetings');
    mkdirSync(meetings, { recursive: true });
    expect(vaultRemote(meetings)).toBeNull();
    mkdirSync(path.join(dir, '.git'));
    writeFileSync(path.join(dir, '.git', 'config'), '[core]\n\tbare = false\n');
    expect(vaultRemote(meetings)).toBeNull();
    writeFileSync(path.join(dir, '.git', 'config'), '[core]\n\tbare = false\n[remote "origin"]\n\turl = https://user:tok123@example.com/acme/vault.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n');
    expect(vaultRemote(meetings)).toBe('example.com');
    writeFileSync(path.join(dir, '.git', 'config'), '[remote "origin"]\n\turl = ssh://git@example.com:22/acme/vault.git\n');
    expect(vaultRemote(meetings)).toBe('example.com');
    writeFileSync(path.join(dir, '.git', 'config'), '[remote "origin"]\n\turl = https://Code.Example.org/acme/vault.git\n');
    expect(vaultRemote(meetings)).toBe('code.example.org');
  });

  it('import_meeting files a transcript only when filing is on for that source', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'quorum-home-'));
    try {
      const meetings = path.join(home, 'vault', '08-meetings');
      mkdirSync(meetings, { recursive: true });
      const support = path.join(home, 'Library', 'Application Support', 'Quorum');
      mkdirSync(support, { recursive: true });
      const run = (sources, id) => {
        writeFileSync(path.join(support, 'settings.json'), JSON.stringify({ meetingsDir: meetings, sources }));
        const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'import_meeting', arguments: { source: 'fathom', id, title: `Call ${id}`, date: '2026-11-18T17:00:00Z', body: 'notes', transcript: 'Alex: hello' } } };
        const r = spawnSync(process.execPath, [CLI, 'mcp'], { input: `${JSON.stringify(call)}\n`, env: { ...process.env, HOME: home, QUORUM_ENV: '' }, encoding: 'utf8', timeout: 15000 });
        expect(r.status).toBe(0);
        return JSON.parse(JSON.parse(r.stdout.trim().split('\n').pop()).result.content[0].text);
      };
      expect(run({}, 'a1').transcript).toMatch(/not filed/);
      expect(existsSync(path.join(meetings, 'fathom', 'transcripts'))).toBe(false);
      expect(run({ fathom: { syncTranscripts: true } }, 'b2').transcript).toBe('filed');
      const t = readdirSync(path.join(meetings, 'fathom', 'transcripts'));
      expect(t).toHaveLength(1);
      expect(readFileSync(path.join(meetings, 'fathom', 'transcripts', t[0]), 'utf8')).toContain('Alex: hello');
      expect(readFrontmatter(readFileSync(path.join(meetings, 'fathom', t[0]), 'utf8')).transcript).toBe(`transcripts/${t[0]}`);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('import_meeting skips a meeting another source already filed for the same calendar event', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'quorum-home-'));
    try {
      const meetings = path.join(home, 'vault', '08-meetings');
      mkdirSync(path.join(meetings, 'zoom'), { recursive: true });
      writeFileSync(path.join(meetings, 'zoom', 'z.md'), '---\nsource_id: u1\ntitle: "Weekly sync"\ndate: 2026-11-18T17:00:00Z\nsource: zoom\n---\n# Weekly sync\n');
      const support = path.join(home, 'Library', 'Application Support', 'Quorum');
      mkdirSync(support, { recursive: true });
      writeFileSync(path.join(support, 'settings.json'), JSON.stringify({ meetingsDir: meetings }));
      const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'import_meeting', arguments: { source: 'fathom', id: 'f1', title: 'Weekly Sync', date: '2026-11-18T17:03:00Z', body: 'notes' } } };
      const r = spawnSync(process.execPath, [CLI, 'mcp'], { input: `${JSON.stringify(call)}\n`, env: { ...process.env, HOME: home, QUORUM_ENV: '' }, encoding: 'utf8', timeout: 15000 });
      expect(r.status).toBe(0);
      expect(JSON.parse(JSON.parse(r.stdout.trim().split('\n').pop()).result.content[0].text)).toMatchObject({ skipped: true, elsewhere: 'zoom' });
      expect(existsSync(path.join(meetings, 'fathom'))).toBe(false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('the scheduled agent import asks for the transcript only when filing is on', () => {
    const source = { id: 'granola', name: 'Granola' };
    expect(importPrompt({ source, server: 'granola' })).not.toContain('pass it as transcript');
    expect(importPrompt({ source, server: 'granola', transcripts: true })).toContain('pass it as transcript');
  });
});

describe('join advice', () => {
  const zoom = { connected: true, myNotes: { seenAt: null, confirmedAt: null } };
  it('shows where both Zoom settings are before a Zoom call until the person says they are on', () => {
    const a = joinAdvice({ platform: 'zoom', zoom });
    expect(a.kind).toBe('zoom');
    expect(a.detail).toContain('Settings. In the side menu click Notes, and under My Notes turn on Enable My Notes');
    expect(a.detail).toContain('Meetings & webinars tab, and under When joining meetings and webinars turn on Auto-start My Notes');
    expect(joinAdvice({ platform: 'zoom', zoom: { ...zoom, myNotes: { seenAt: new Date().toISOString(), confirmedAt: null } } }).message).toMatch(/Auto-start/);
    expect(joinAdvice({ platform: 'zoom', zoom: { ...zoom, myNotes: { seenAt: null, confirmedAt: '2026-11-01T00:00:00Z' } } })).toBeNull();
    expect(joinAdvice({ platform: 'zoom', zoom, dismissed: { zoom: true } })).toBeNull();
  });
  it('reminds to start notes by hand and ask first for Meet, Teams and in person', () => {
    expect(joinAdvice({ platform: 'meet', zoom }).detail).toMatch(/ask everyone in the meeting whether they agree/);
    expect(joinAdvice({ platform: 'teams', zoom }).message).toContain('Microsoft Teams');
    expect(joinAdvice({ platform: null, zoom }).message).toContain('in-person');
    expect(joinAdvice({ platform: 'meet', zoom, dismissed: { manual: true } })).toBeNull();
  });
  it('for a never-listen or opt-out invite, never prompts capture; a Zoom call gets the warning to stop My Notes', () => {
    const a = joinAdvice({ platform: 'zoom', zoom: { ...zoom, myNotes: { seenAt: null, confirmedAt: '2026-11-01T00:00:00Z' } }, blocked: true });
    expect(a.kind).toBe('blocked');
    expect(a.detail).toContain('click the My Notes icon at the top of the meeting window and stop transcription');
    expect(a.detail).toContain('turn off Auto-start My Notes before you join');
    expect(joinAdvice({ platform: 'zoom', zoom, blocked: true, dismissed: { zoom: true } }).kind).toBe('blocked');
    expect(joinAdvice({ platform: 'meet', zoom, blocked: true })).toBeNull();
    expect(joinAdvice({ platform: null, zoom, blocked: true })).toBeNull();
    expect(joinAdvice({ platform: 'zoom', zoom: null })).toBeNull();
  });
});

describe('what a connector costs to leave off', () => {
  it('names what is lost for the connectors Quorum ships, and nothing for ones not built', () => {
    for (const id of ['granola', 'zoom', 'apple-calendar', 'google-calendar', 'claude-code']) expect(withoutOf(CONNECTOR_BY_ID[id])).toBeTruthy();
    expect(withoutOf({ id: 'x', name: 'X', category: 'crm', status: 'soon' })).toBeNull();
  });
});
