import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPlatforms } from '../ee/platforms.js';
import { encodeUuid, fileNameFor, meetingNumberFromUrl, missingScope, noteTranscriptText, summaryText, zoomNote } from '../ee/zoomAi.js';
import { meetingIndex, sameMeeting } from '../sources/sameMeeting.js';
import { vaultRemote } from '../sources/transcripts.js';
import { importPrompt } from '../sources/agent-import.js';
import { joinAdvice } from '../joinAdvice.js';
import { CONNECTOR_BY_ID, withoutOf } from '../connectors/library.js';
import { readFrontmatter } from '../frontmatter.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'quorum.mjs');
const SUMMARY = { meeting_uuid: 'uuid-h', meeting_id: 81234567890, meeting_topic: 'Roadmap review', meeting_start_time: '', summary_content: '## Key takeaways\n- Ship the importer.' };
const NOTE_TRANSCRIPT = { items: [{ start_time: '00:00:01.000', end_time: '00:00:02.000', speaker_id: 's1', text: 'Hi all.' }, { start_time: '00:00:02.500', end_time: '00:00:03.000', speaker_id: 's1', text: 'Shall we start?' }, { start_time: '00:01:05.000', end_time: '00:01:07.000', speaker_id: 's2', text: 'Yes.' }], speakers: [{ speaker_id: 's1', speaker_name: 'Alex Rivera' }, { speaker_id: 's2', speaker_name: 'Dana Whitfield' }] };

describe('zoom AI notes shapes', () => {
  it('reads the summary from summary_content, the older fields, or not at all', () => {
    expect(summaryText(SUMMARY)).toBe('## Key takeaways\n- Ship the importer.');
    expect(summaryText({ summary_overview: 'We met.', summary_details: [{ label: 'Plan', summary: 'Do it.' }], next_steps: ['Alex writes it'] })).toBe('We met.\n\n### Plan\n\nDo it.\n\n### Next steps\n\n- Alex writes it');
    expect(summaryText({ summary_overview: 'old', edited_summary: { summary_overview: 'edited', next_steps: ['x'] } })).toBe('edited\n\n### Next steps\n\n- x');
    expect(summaryText({ has_permission: false, summary_content: 'hidden' })).toBeNull();
    expect(summaryText({})).toBeNull();
  });
  it('turns a My Notes transcript into timestamped speaker turns', () => {
    expect(noteTranscriptText(NOTE_TRANSCRIPT)).toBe('[0:01] Alex Rivera: Hi all. Shall we start?\n\n[1:05] Dana Whitfield: Yes.');
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
    const fm = readFrontmatter(md);
    expect(fm).toMatchObject({ source_id: 'note:n1', source: 'zoom', visibility: 'private', zoom_note_id: 'n1', zoom_url: 'https://zoom.us/my-notes/n1' });
    expect(md).toContain('## My notes\n\nmy line');
    expect(md).toContain('## Summary\n\nrecap');
    expect(md).toContain('## Not imported\n\n- AI Companion summary: not yours.');
    expect(fileNameFor({ title: 'Partner sync', start: '2026-11-18T17:00:00Z' })).toBe('2026-11-18-partner-sync.md');
  });
});

// a fake relay plus a fake Zoom; routes answer by path, a missing route is 404
function world({ routes = {}, events = [] } = {}) {
  const calls = [];
  routes = { '/v2/users/me/recordings': [200, { meetings: [], next_page_token: '' }], ...routes };
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null });
    const u = new URL(url);
    if (u.pathname.endsWith('/v1/connect/events/ack')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (u.pathname.endsWith('/v1/connect/events')) return new Response(JSON.stringify({ events }), { status: 200 });
    if (init.headers?.authorization !== 'Bearer zoom-at') return new Response('{}', { status: 401 });
    const route = routes[`${u.pathname}${u.search}`] ?? routes[u.pathname];
    if (!route) return new Response('{}', { status: 404 });
    const [status, body] = typeof route === 'function' ? route(u) : route;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  const account = { client: () => ({ auth: { getSession: async () => ({ data: { session: { access_token: 'session-tok' } } }) } }), state: () => ({ signedIn: true, workspace: { id: 'ws1' } }), envStatus: () => ({ config: 'production' }) };
  const saved = { 'platform-zoom': { accessToken: 'zoom-at', refreshToken: 'rt', expiresAt: Date.now() + 3600000 } };
  const store = { tokens: { get: async (k) => saved[k] ?? null, set: async (k, v) => { saved[k] = v; } } };
  return { calls, fetchImpl, account, store };
}
const CLIENTS = { zoom: { clientId: 'zoom-client', redirectUri: 'https://relay.example/cb' } };
const hoursAgo = (h) => new Date(Date.now() - h * 3600000).toISOString();
const SCOPE = (scope) => [400, { code: 4711, message: `Invalid access token, does not contain scopes:[${scope}].` }];

describe('zoom AI notes import', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'quorum-zoom-ai-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const make = (w, over = {}) => createPlatforms({ clients: CLIENTS, account: w.account, settings: { platforms: { zoom: { connected: true, name: 'Alex Rivera', account: 'alex@example.com', syncTranscripts: false } } }, meetingsDir: () => dir, fetchImpl: w.fetchImpl, store: w.store, ...over });

  it('files a hosted meeting\'s AI Companion summary and the user\'s My Notes, without the transcript while filing is off', async () => {
    const start = hoursAgo(3);
    const w = world({ routes: {
      '/v2/users/me/meeting_summaries': [200, { summaries: [{ ...SUMMARY, meeting_start_time: start }] }],
      '/v2/meetings/uuid-h/meeting_summary': [200, { ...SUMMARY, meeting_start_time: start }],
      '/v2/my_notes/notes': (u) => (u.searchParams.get('meeting_id') === '81234567890' ? [200, { notes: [{ note_id: 'n1', note_name: 'Roadmap', note_link: 'https://zoom.us/my-notes/n1', created_time: start, modified_time: start }] }] : [200, { notes: [] }]),
      '/v2/my_notes/notes/n1/content': [200, { note_id: 'n1', note_name: 'Roadmap', note_url: 'https://zoom.us/my-notes/n1', manual_note_content: 'Ask about pricing.', generated_note_content: 'Recap from My Notes.', transcript: NOTE_TRANSCRIPT }],
    } });
    const p = make(w);
    const r = await p.sync('zoom');
    expect(r).toMatchObject({ imported: 1, failed: [] });
    const [file] = readdirSync(path.join(dir, 'zoom'));
    const md = readFileSync(path.join(dir, 'zoom', file), 'utf8');
    expect(readFrontmatter(md)).toMatchObject({ source_id: 'uuid-h', source: 'zoom', zoom_note_id: 'n1', zoom_meeting_id: '81234567890', source_account: 'alex@example.com' });
    expect(md).toContain('## Summary\n\n## Key takeaways');
    expect(md).toContain('## My notes\n\nAsk about pricing.');
    expect(md).toContain('## My Notes recap\n\nRecap from My Notes.');
    expect(md).not.toContain('Not imported');
    expect(existsSync(path.join(dir, 'zoom', 'transcripts'))).toBe(false);
    expect(w.calls.some((c) => c.url.includes('include=transcript'))).toBe(false);
    expect(p.list()[0].myNotes.seenAt).toBeTruthy();
    // a second run files nothing again
    expect(await p.sync('zoom')).toMatchObject({ imported: 0 });
  });

  it('for a meeting the user only joined, files their My Notes from the webhook, says the summary is the host\'s, and files the transcript when asked', async () => {
    const start = hoursAgo(2);
    const w = world({
      events: [{ id: 9, event: 'my_notes.note_completed', received_at: start, payload: { operator_id: 'zu1', object: { note_id: 'n2', meeting_id: '89999999999' } } }],
      routes: {
        '/v2/my_notes/notes': [200, { notes: [{ note_id: 'n2', note_name: 'Partner sync', note_link: 'https://zoom.us/my-notes/n2', created_time: start, modified_time: start }] }],
        '/v2/my_notes/notes/n2/content': [200, { note_id: 'n2', note_name: 'Partner sync', note_url: 'https://zoom.us/my-notes/n2', manual_note_content: '', generated_note_content: 'They agreed on dates.', transcript: NOTE_TRANSCRIPT }],
      },
    });
    const p = make(w);
    p.handlers['platform-set-option']('zoom', { syncTranscripts: true });
    const r = await p.sync('zoom');
    expect(r).toMatchObject({ imported: 1 });
    const name = readdirSync(path.join(dir, 'zoom')).find((f) => f.endsWith('.md'));
    const md = readFileSync(path.join(dir, 'zoom', name), 'utf8');
    expect(readFrontmatter(md)).toMatchObject({ source_id: 'note:n2', zoom_note_id: 'n2', transcript: `transcripts/${name}` });
    expect(md).toContain('## Summary\n\nThey agreed on dates.');
    expect(md).toMatch(/Not imported\n\n- AI Companion summary: Zoom gives it only to the meeting's host/);
    expect(w.calls.some((c) => c.url.endsWith('/my_notes/notes/n2/content?include=transcript'))).toBe(true);
    // no uuid for a meeting the user did not host, so the summary is never asked for
    expect(w.calls.some((c) => c.url.includes('meeting_summary'))).toBe(false);
    const t = readFileSync(path.join(dir, 'zoom', 'transcripts', name), 'utf8');
    expect(t).toContain('[0:01] Alex Rivera: Hi all. Shall we start?');
    expect(w.calls.some((c) => c.url.endsWith('/v1/connect/events/ack') && c.body.ids.includes(9))).toBe(true);
  });

  it('finds My Notes for a calendar Zoom call with no webhook, and skips a meeting another source already filed', async () => {
    const start = hoursAgo(1);
    mkdirSync(path.join(dir, 'granola'), { recursive: true });
    writeFileSync(path.join(dir, 'granola', 'g.md'), `---\nsource_id: g1\ntitle: "Design crit"\ndate: ${start}\nsource: granola\n---\n# Design crit\n`);
    const w = world({ routes: {
      '/v2/my_notes/notes': (u) => [200, { notes: [{ note_id: u.searchParams.get('meeting_id') === '81111111111' ? 'n3' : 'n4', note_name: 'x', note_link: 'https://zoom.us/my-notes/x', created_time: start, modified_time: start }] }],
      '/v2/my_notes/notes/n3/content': [200, { note_id: 'n3', note_name: 'Hiring sync', note_url: 'https://zoom.us/my-notes/n3', manual_note_content: 'Two candidates.', generated_note_content: '' }],
      '/v2/my_notes/notes/n4/content': [200, { note_id: 'n4', note_name: 'Design crit', note_url: 'https://zoom.us/my-notes/n4', manual_note_content: 'Same meeting.', generated_note_content: '' }],
    } });
    const p = make(w, { pastZoomMeetings: async () => [{ url: 'https://acme.zoom.us/j/81111111111?pwd=x', title: 'Hiring sync', start }, { url: 'https://acme.zoom.us/j/82222222222', title: 'Design crit', start }] });
    const r = await p.sync('zoom');
    expect(r).toMatchObject({ imported: 1, elsewhere: 1 });
    const files = readdirSync(path.join(dir, 'zoom'));
    expect(files).toHaveLength(1);
    expect(readFileSync(path.join(dir, 'zoom', files[0]), 'utf8')).toContain('Two candidates.');
  });

  it('degrades cleanly when the Zoom app lacks the new scopes, and says which parts are missing', async () => {
    const start = hoursAgo(30);
    const w = world({
      events: [{ id: 3, event: 'meeting.summary_completed', received_at: start, payload: { object: { meeting_uuid: 'uuid-s', meeting_id: 81234567890, meeting_topic: 'Board prep', meeting_start_time: start, host_id: 'zu1' } } }],
      routes: {
        '/v2/users/me/meeting_summaries': SCOPE('meeting:read:list_summaries'),
        '/v2/meetings/uuid-s/meeting_summary': SCOPE('meeting:read:summary'),
        '/v2/my_notes/notes': SCOPE('my_notes:read:note'),
      },
    });
    const p = make(w);
    const r = await p.sync('zoom');
    expect(r).toMatchObject({ imported: 0, failed: [] });
    expect(r.missing.sort()).toEqual(['meeting:read:list_summaries', 'meeting:read:summary', 'my_notes:read:note']);
    expect(p.list()[0].missing).toEqual(expect.arrayContaining(['list your My Notes', 'read AI Companion summaries']));
  });

  it('keeps filing transcripts for a connection made before the setting existed', () => {
    const w = world();
    const settings = { platforms: { zoom: { connected: true } } };
    createPlatforms({ clients: CLIENTS, account: w.account, settings, meetingsDir: () => dir, fetchImpl: w.fetchImpl, store: w.store });
    expect(settings.platforms.zoom.syncTranscripts).toBe(true);
    const fresh = { platforms: {} };
    const p = createPlatforms({ clients: CLIENTS, account: w.account, settings: fresh, meetingsDir: () => dir, fetchImpl: w.fetchImpl, store: w.store });
    expect(p.list()[0].syncTranscripts).toBe(false);
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
  it('says nothing when the invite matches the never-listen or opt-out lists, or Zoom AI notes are not connected', () => {
    expect(joinAdvice({ platform: 'zoom', zoom, blocked: true })).toBeNull();
    expect(joinAdvice({ platform: 'meet', zoom, blocked: true })).toBeNull();
    expect(joinAdvice({ platform: 'zoom', zoom: null })).toBeNull();
  });
});

describe('what a connector costs to leave off', () => {
  it('names what is lost for the connectors Quorum ships, and nothing for ones not built', () => {
    for (const id of ['granola', 'zoom', 'apple-calendar', 'google-calendar', 'claude-code']) expect(withoutOf(CONNECTOR_BY_ID[id])).toBeTruthy();
    expect(withoutOf({ id: 'x', name: 'X', category: 'crm', status: 'soon' })).toBeNull();
  });
});
