// The meetings knowledge base routing (ee/meetingsKb.js) and how sync.js places a pushed meeting note with it. The
// Supabase client is a recorder; the vault is a temp folder. HOME points at a temp folder before sync.js loads, so its
// sync-ids.json stays out of the real Application Support folder.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const home = mkdtempSync(path.join(tmpdir(), 'quorum-mkb-home-'));
process.env.HOME = home;
const { createMeetingsKb, isMeetingNote, meetingRoute, monthOf, shareChoice, withChoice } = await import('../ee/meetingsKb.js');
const { createSync, parseFrontmatter } = await import('../ee/sync.js');

const dirs = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });

const SINCE = '2026-11-01T00:00:00.000Z';
const note = (fm) => `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n# Standup\n\nWe agreed on the plan.\n`;

describe('monthOf', () => {
  it('takes the year and month the date was written with', () => {
    expect(monthOf('2026-11-30T23:30:00.000-08:00')).toBe('2026-11');
    expect(monthOf('2026-01-02')).toBe('2026-01');
  });
  it('falls back to the current month for a missing or odd date', () => {
    const now = new Date(2026, 10, 13);
    expect(monthOf(null, now)).toBe('2026-11');
    expect(monthOf('2026-13-01', now)).toBe('2026-11');
    expect(monthOf('yesterday', now)).toBe('2026-11');
  });
});

describe('isMeetingNote', () => {
  it('counts connector and call notes, recorded written notes, and never transcripts', () => {
    expect(isMeetingNote({ source: 'granola' })).toBe(true);
    expect(isMeetingNote({ source: 'quorum', platform: 'Zoom' })).toBe(true);
    expect(isMeetingNote({ type: 'note' })).toBe(false);
    expect(isMeetingNote({ type: 'note', recorded: 'true' })).toBe(true);
    expect(isMeetingNote({ type: 'transcript' })).toBe(false);
  });
});

describe('meetingRoute', () => {
  const base = { source: 'granola', date: '2026-11-13T10:00:00.000-07:00' };
  it('shares a new undecided meeting note by default', () => {
    expect(meetingRoute({ fm: base, since: SINCE })).toBe('share');
  });
  it('keeps a note the person kept private out', () => {
    expect(meetingRoute({ fm: { ...base, keep_private: 'true', visibility: 'private' }, since: SINCE })).toBe('private');
    expect(meetingRoute({ fm: { ...base, visibility: 'private' }, since: SINCE })).toBe('private');
  });
  it('places a note the person turned back to shared, old or new', () => {
    expect(meetingRoute({ fm: { ...base, keep_private: 'false', visibility: 'public' }, since: SINCE })).toBe('shared');
    expect(meetingRoute({ fm: { ...base, date: '2025-01-01', keep_private: 'false' }, since: SINCE })).toBe('shared');
  });
  it('never shares a confidential note or one with withheld lines', () => {
    expect(meetingRoute({ fm: { ...base, confidential: 'true' }, since: SINCE })).toBe('private');
    expect(meetingRoute({ fm: { ...base, confidential: 'true', keep_private: 'false' }, since: SINCE })).toBe('private');
    expect(meetingRoute({ fm: base, withheld: true, since: SINCE })).toBe('private');
  });
  it('leaves undecided notes alone with the setting off', () => {
    expect(meetingRoute({ fm: base, autoSave: false, since: SINCE })).toBe('leave');
    expect(meetingRoute({ fm: { ...base, keep_private: 'false' }, autoSave: false, since: SINCE })).toBe('shared');
  });
  it('leaves undecided notes from before the routing started, or without a date', () => {
    expect(meetingRoute({ fm: { ...base, date: '2026-10-31T09:00:00.000-07:00' }, since: SINCE })).toBe('leave');
    expect(meetingRoute({ fm: { source: 'granola' }, since: SINCE })).toBe('leave');
    expect(meetingRoute({ fm: base, since: null })).toBe('leave');
  });
  it('leaves written notes and transcripts alone', () => {
    expect(meetingRoute({ fm: { ...base, type: 'note' }, since: SINCE })).toBe('leave');
    expect(meetingRoute({ fm: { ...base, type: 'transcript' }, since: SINCE })).toBe('leave');
  });
});

describe('withChoice', () => {
  it('writes keep_private and visibility, keeping the rest of the note', () => {
    const shared = withChoice(note({ title: 'Standup' }), false);
    expect(parseFrontmatter(shared)).toMatchObject({ title: 'Standup', keep_private: 'false', visibility: 'public' });
    expect(shareChoice(parseFrontmatter(shared))).toBe('shared');
    const kept = withChoice(shared, true);
    expect(parseFrontmatter(kept)).toMatchObject({ keep_private: 'true', visibility: 'private' });
    expect(kept.endsWith('We agreed on the plan.\n')).toBe(true);
  });
});

// a team workspace with a meetings KB, a vault and a recording client
function harness({ teamEnabled = true, kbs = [{ id: 'KB1', name: 'Meetings', kind: 'meetings', created_at: '2026-11-01' }], folder = { kb_id: 'KB1', folder_id: 'F11', month: '2026-11' }, settings = {}, isExcludedText = () => false } = {}) {
  const vault = mkdtempSync(path.join(tmpdir(), 'quorum-mkb-vault-'));
  dirs.push(vault);
  const calls = [];
  const rpcs = [];
  const client = {
    rpc: async (name, args) => { rpcs.push({ name, args }); return { data: name === 'kb_list' ? kbs : name === 'kb_meetings_folder' ? folder : null, error: null }; },
    from: (table) => ({ upsert: async (rows) => { calls.push({ table, rows }); return { error: null }; } }),
  };
  const state = { sync: true, signedIn: true, workspace: { id: `ws-${path.basename(vault)}`, teamEnabled }, userId: 'user-1' };
  const account = { state: () => state, client: () => client, markSync: () => {} };
  const mkb = createMeetingsKb({ account, settings, isExcludedText, now: () => new Date('2026-11-13T12:00:00.000Z') });
  const sync = createSync({ account, store: { meetings: { root: path.join(vault, '.sessions') } }, brain: () => ({ vault }), isExcludedText, meetings: mkb });
  const put = (rel, text) => { const abs = path.join(vault, rel); mkdirSync(path.dirname(abs), { recursive: true }); writeFileSync(abs, text); return abs; };
  const pushedNote = () => calls.filter((c) => c.table === 'notes').at(-1)?.rows[0];
  return { vault, settings, calls, rpcs, mkb, sync, put, pushedNote, state };
}

describe('pushing a meeting note', () => {
  it('shares a new Granola note into the month folder, writing the choice into the file', async () => {
    const h = harness({ settings: { meetingsKb: { since: {} } } });
    h.settings.meetingsKb.since[h.state.workspace.id] = SINCE;
    const abs = h.put('meetings/granola/standup.md', note({ source: 'granola', date: '2026-11-13T10:00:00.000-07:00' }));
    expect(await h.sync.pushMeetingNote(abs)).toBe(true);
    expect(h.pushedNote()).toMatchObject({ kb_id: 'KB1', folder_id: 'F11' });
    expect(h.pushedNote().frontmatter).toMatchObject({ visibility: 'public', keep_private: 'false' });
    expect(h.rpcs.find((r) => r.name === 'kb_meetings_folder').args.month).toBe('2026-11');
    expect(parseFrontmatter(readFileSync(abs, 'utf8')).visibility).toBe('public');
    // a later push leaves the place alone, so an admin's move stands
    await h.sync.pushMeetingNote(abs);
    expect(h.pushedNote().kb_id).toBeUndefined();
  });

  it('keep private pushes the note private and out of the KB; turning it off places it again', async () => {
    const h = harness({ settings: { meetingsKb: { since: {} } } });
    h.settings.meetingsKb.since[h.state.workspace.id] = SINCE;
    const abs = h.put('meetings/granola/one.md', note({ source: 'granola', date: '2026-11-13T10:00:00.000-07:00' }));
    await h.sync.pushMeetingNote(abs);
    expect((await h.mkb.setKeepPrivate(abs, true)).keepPrivate).toBe(true);
    await h.sync.pushMeetingNote(abs);
    expect(h.pushedNote().frontmatter).toMatchObject({ visibility: 'private', keep_private: 'true' });
    expect(h.pushedNote().kb_id).toBeUndefined();
    expect((await h.mkb.stateOf(abs))).toMatchObject({ available: true, keepPrivate: true, kbName: 'Meetings' });
    await h.mkb.setKeepPrivate(abs, false);
    await h.sync.pushMeetingNote(abs);
    expect(h.pushedNote()).toMatchObject({ kb_id: 'KB1', folder_id: 'F11' });
    expect(h.pushedNote().frontmatter.visibility).toBe('public');
  });

  it('starts the default the first time it applies, so notes from before stay as they are', async () => {
    const h = harness();
    const abs = h.put('meetings/granola/old.md', note({ source: 'granola', date: '2026-11-12T10:00:00.000-07:00' }));
    await h.sync.pushMeetingNote(abs);
    expect(h.settings.meetingsKb.since[h.state.workspace.id]).toBe('2026-11-13T12:00:00.000Z');
    expect(h.pushedNote().kb_id).toBeUndefined();
    expect(parseFrontmatter(readFileSync(abs, 'utf8')).visibility).toBeUndefined();
  });

  it('leaves undecided notes alone with the setting off', async () => {
    const h = harness({ settings: { meetingsKb: { autoSave: false, since: {} } } });
    h.settings.meetingsKb.since[h.state.workspace.id] = SINCE;
    const abs = h.put('meetings/quorum/call.md', note({ source: 'quorum', date: '2026-11-13T10:00:00.000-07:00' }));
    await h.sync.pushMeetingNote(abs);
    expect(h.pushedNote().kb_id).toBeUndefined();
    expect(h.pushedNote().frontmatter.visibility).toBeUndefined();
  });

  it('never pushes a confidential note, and refuses to share it', async () => {
    const confidential = (t) => /^confidential:/m.test(t);
    const h = harness({ settings: { meetingsKb: { since: {} } }, isExcludedText: confidential });
    h.settings.meetingsKb.since[h.state.workspace.id] = SINCE;
    const abs = h.put('meetings/granola/secret.md', note({ source: 'granola', date: '2026-11-13T10:00:00.000-07:00', confidential: 'true' }));
    expect(await h.sync.pushMeetingNote(abs)).toBe(false);
    expect(h.calls).toEqual([]);
    expect(await h.mkb.stateOf(abs)).toMatchObject({ available: true, locked: true, keepPrivate: true });
    expect((await h.mkb.setKeepPrivate(abs, false)).error).toMatch(/confidential/);
  });

  it('does nothing in a solo workspace or without a meetings KB', async () => {
    for (const h of [harness({ teamEnabled: false }), harness({ kbs: [{ id: 'G', name: 'Handbook', kind: 'general' }] })]) {
      const abs = h.put('meetings/granola/x.md', note({ source: 'granola', date: '2026-11-13T10:00:00.000-07:00' }));
      await h.sync.pushMeetingNote(abs);
      expect(h.pushedNote().kb_id).toBeUndefined();
      expect(h.pushedNote().frontmatter.visibility).toBeUndefined();
      expect((await h.mkb.stateOf(abs)).available).toBe(false);
      expect((await h.mkb.setKeepPrivate(abs, true)).error).toMatch(/no team meetings knowledge base/);
    }
  });

  it('leaves the note as it is when the person cannot read the meetings KB', async () => {
    const h = harness({ folder: null, settings: { meetingsKb: { since: {} } } });
    h.settings.meetingsKb.since[h.state.workspace.id] = SINCE;
    const abs = h.put('meetings/granola/y.md', note({ source: 'granola', date: '2026-11-13T10:00:00.000-07:00' }));
    await h.sync.pushMeetingNote(abs);
    expect(h.pushedNote().kb_id).toBeUndefined();
    expect(parseFrontmatter(readFileSync(abs, 'utf8')).visibility).toBeUndefined();
  });
});
