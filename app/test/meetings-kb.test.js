// The meetings knowledge base routing (ee/meetingsKb.js), the share choice keys (shareChoice.js) and how sync.js
// places a pushed meeting note. The Supabase client is a recorder; the vault is a temp folder. HOME points at a temp
// folder before sync.js loads, so its sync-ids.json stays out of the real Application Support folder.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const home = mkdtempSync(path.join(tmpdir(), 'quorum-mkb-home-'));
process.env.HOME = home;
const { EXCLUDED, SYNC_OFF, createMeetingsKb, isMeetingNote, meetingRoute, meetingTeamOf, monthOf, originOf, startSince } = await import('../ee/meetingsKb.js');
const { KEPT_KEYS, carryKeys, choiceOf, reconcile, withChoice } = await import('../shareChoice.js');
const { createSync, parseFrontmatter } = await import('../ee/sync.js');

const dirs = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });

const SINCE = '2026-11-01T00:00:00.000Z';
const NOW = new Date('2026-11-13T20:00:00.000Z');
const DATE = '2026-11-13T10:00:00.000-07:00';
const note = (fm) => `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n# Standup\n\nWe agreed on the plan.\n`;
const fmOf = (abs) => parseFrontmatter(readFileSync(abs, 'utf8'));

describe('monthOf', () => {
  it('takes the year and month the date was written with', () => {
    expect(monthOf('2026-11-30T23:30:00.000-08:00')).toBe('2026-11');
    expect(monthOf('2026-01-02')).toBe('2026-01');
  });
  it('falls back to the current month for a missing or odd date', () => {
    const now = new Date(2026, 10, 13);
    expect(monthOf(null, now)).toBe('2026-11');
    expect(monthOf('2026-13-01', now)).toBe('2026-11');
  });
});

describe('isMeetingNote and originOf', () => {
  it('counts connector and call notes, recorded written notes, and never transcripts', () => {
    expect(isMeetingNote({ source: 'granola' })).toBe(true);
    expect(isMeetingNote({ type: 'note' })).toBe(false);
    expect(isMeetingNote({ type: 'note', recorded: 'true' })).toBe(true);
    expect(isMeetingNote({ type: 'transcript' })).toBe(false);
  });
  it('names each connector source account, and Quorum recordings apart', () => {
    expect(originOf({ source: 'quorum' })).toBe('recorded');
    expect(originOf({ source: 'granola', source_account: 'Alex@Example.com' })).toEqual({ key: 'granola:alex@example.com', label: 'Granola (Alex@Example.com)' });
    expect(originOf({ source: 'zoom' })).toEqual({ key: 'zoom:', label: 'Zoom' });
    expect(originOf({})).toBeNull();
  });
});

describe('meetingRoute', () => {
  const rec = { source: 'quorum', date: DATE };
  const gran = { source: 'granola', source_account: 'alex@example.com', date: DATE, visibility: 'private' };
  it('shares a new recorded note by default, and leaves it with the setting off or before since', () => {
    expect(meetingRoute({ fm: rec, since: SINCE })).toBe('share');
    expect(meetingRoute({ fm: rec, autoSave: false, since: SINCE })).toBe('leave');
    expect(meetingRoute({ fm: { ...rec, date: '2026-10-31T09:00:00.000-07:00' }, since: SINCE })).toBe('leave');
    expect(meetingRoute({ fm: { source: 'quorum' }, since: SINCE })).toBe('leave');
  });
  it('asks about a connector source until the person chooses, whatever visibility the importer wrote', () => {
    expect(meetingRoute({ fm: gran, since: SINCE })).toBe('ask');
    expect(meetingRoute({ fm: gran, source: { choice: 'share', since: SINCE } })).toBe('share');
    expect(meetingRoute({ fm: gran, source: { choice: 'private' } })).toBe('leave');
    expect(meetingRoute({ fm: gran, source: { choice: 'share', since: '2026-11-14T00:00:00.000Z' } })).toBe('leave');
  });
  it('lets keep_private decide over visibility in both directions', () => {
    expect(meetingRoute({ fm: { ...gran, keep_private: 'true', visibility: 'public' } })).toBe('private');
    expect(meetingRoute({ fm: { ...gran, keep_private: 'false', visibility: 'private' } })).toBe('shared');
  });
  it('never shares a confidential, withheld or excluded note', () => {
    expect(meetingRoute({ fm: { ...rec, confidential: 'true' }, since: SINCE })).toBe('private');
    expect(meetingRoute({ fm: { ...rec, confidential: 'true', keep_private: 'false' }, since: SINCE })).toBe('private');
    expect(meetingRoute({ fm: rec, withheld: true, since: SINCE })).toBe('private');
    expect(meetingRoute({ fm: { ...rec, keep_private: 'false' }, excluded: true, since: SINCE })).toBe('leave');
  });
  it('leaves written notes, transcripts, and notes no connector made', () => {
    expect(meetingRoute({ fm: { ...rec, type: 'note' }, since: SINCE })).toBe('leave');
    expect(meetingRoute({ fm: { ...rec, type: 'transcript' }, since: SINCE })).toBe('leave');
    expect(meetingRoute({ fm: { date: DATE }, since: SINCE })).toBe('leave');
  });
});

describe('startSince', () => {
  it('reaches back to the starting note less a margin, never later than now, never more than a day, never before floor', () => {
    expect(startSince('2026-11-13T19:00:00.000Z', NOW)).toBe('2026-11-13T17:00:00.000Z');
    expect(startSince('2026-11-14T09:00:00.000Z', NOW)).toBe(NOW.toISOString());
    expect(startSince('2025-01-01T00:00:00.000Z', NOW)).toBe('2026-11-12T20:00:00.000Z');
    expect(startSince('2026-11-13T19:00:00.000Z', NOW, '2026-11-13T18:30:00.000Z')).toBe('2026-11-13T18:30:00.000Z');
    expect(startSince(null, NOW)).toBe(NOW.toISOString());
  });
});

describe('shareChoice', () => {
  it('writes both keys, keeping the rest of the note', () => {
    const shared = withChoice(note({ title: 'Standup' }), false);
    expect(parseFrontmatter(shared)).toMatchObject({ title: 'Standup', keep_private: 'false', visibility: 'public' });
    const kept = withChoice(shared, true);
    expect(parseFrontmatter(kept)).toMatchObject({ keep_private: 'true', visibility: 'private' });
    expect(kept.endsWith('We agreed on the plan.\n')).toBe(true);
  });
  it('a speaker-correction rewrite keeps the choice, the confidential mark and guardrail keys', () => {
    const before = note({ quorum_id: 'q1', title: 'Standup', source: 'quorum', keep_private: 'true', visibility: 'private', confidential: 'true', client: 'acme' });
    // noteMarkdown writes the note again from its parts, without the keys the person or the guardrails added
    const rewritten = note({ quorum_id: 'q1', title: 'Standup (corrected)', source: 'quorum' });
    const out = parseFrontmatter(carryKeys(before, rewritten, [...KEPT_KEYS, 'client']));
    expect(out).toMatchObject({ title: 'Standup (corrected)', keep_private: 'true', visibility: 'private', confidential: 'true', client: 'acme' });
    expect(meetingRoute({ fm: out, since: SINCE })).toBe('private');
  });
  it('a connector re-import keeps the choice over the importer visibility line', () => {
    const before = note({ granola_id: 'g1', source: 'granola', visibility: 'public', keep_private: 'false', source_account: '"alex@example.com"' });
    const fresh = note({ granola_id: 'g1', source: 'granola', visibility: 'private' });
    expect(parseFrontmatter(carryKeys(before, fresh))).toMatchObject({ keep_private: 'false', visibility: 'public', source_account: 'alex@example.com' });
    expect(carryKeys(null, fresh)).toBe(fresh);
  });
  it('reconcile moves the other key with whichever one the person changed', () => {
    const shared = withChoice(note({ source: 'quorum' }), false);
    expect(parseFrontmatter(reconcile(shared, shared.replace('visibility: public', 'visibility: private')))).toMatchObject({ visibility: 'private', keep_private: 'true' });
    expect(parseFrontmatter(reconcile(shared, shared.replace('keep_private: false', 'keep_private: true')))).toMatchObject({ visibility: 'private', keep_private: 'true' });
    // neither changed but the two disagree: keep_private wins
    const odd = note({ keep_private: 'false', visibility: 'private' });
    expect(parseFrontmatter(reconcile(odd, odd))).toMatchObject({ keep_private: 'false', visibility: 'public' });
    expect(choiceOf({})).toBeNull();
  });
});

// a team workspace with a meetings KB, a vault and a recording client
function harness({ teamEnabled = true, sync = true, info = { kb_id: 'KB1', name: 'Meetings' }, folder = { kb_id: 'KB1', folder_id: 'F11', month: '2026-11' }, settings = {}, isExcludedText = () => false, isExcluded = () => false } = {}) {
  const vault = mkdtempSync(path.join(tmpdir(), 'quorum-mkb-vault-'));
  dirs.push(vault);
  const calls = [];
  const rpcs = [];
  const client = {
    rpc: async (name, args) => { rpcs.push({ name, args }); return { data: name === 'kb_meetings_info' ? info : name === 'kb_meetings_folder' ? folder : null, error: null }; },
    from: (table) => ({ upsert: async (rows) => { calls.push({ table, rows }); return { error: null }; } }),
  };
  const state = { sync, signedIn: true, workspace: { id: `ws-${path.basename(vault)}`, name: 'Example Team', teamEnabled }, userId: 'user-1' };
  const account = { state: () => state, client: () => client, markSync: () => {} };
  const files = new Set();
  let syncer = null;
  const rel = (abs) => path.relative(vault, abs).split(path.sep).join('/');
  const mkb = createMeetingsKb({ account, settings, isExcluded, isExcludedText, relOf: rel, listNotes: () => [...files], push: (abs) => syncer.pushMeetingNote(abs), now: () => NOW });
  syncer = createSync({ account, store: { meetings: { root: path.join(vault, '.sessions') } }, brain: () => ({ vault }), isExcluded, isExcludedText, meetings: mkb });
  const put = (r, text) => { const abs = path.join(vault, r); mkdirSync(path.dirname(abs), { recursive: true }); writeFileSync(abs, text); files.add(abs); return abs; };
  const pushes = () => calls.filter((c) => c.table === 'notes').map((c) => c.rows[0]);
  const pushedNote = () => pushes().at(-1);
  const since = (iso) => { settings.meetingsKb = { ...settings.meetingsKb, since: { [state.workspace.id]: iso } }; };
  return { settings, calls, rpcs, mkb, sync: syncer, put, pushes, pushedNote, state, since };
}

describe('a recorded note', () => {
  it('is shared into the month folder, the choice written into the file, and placed only once', async () => {
    const h = harness();
    h.since(SINCE);
    const abs = h.put('meetings/quorum/standup.md', note({ source: 'quorum', date: DATE }));
    expect(await h.sync.pushMeetingNote(abs)).toBe(true);
    expect(h.pushedNote()).toMatchObject({ kb_id: 'KB1', folder_id: 'F11' });
    expect(h.pushedNote().frontmatter).toMatchObject({ visibility: 'public', keep_private: 'false' });
    expect(h.rpcs.find((r) => r.name === 'kb_meetings_folder').args.month).toBe('2026-11');
    expect(h.rpcs.some((r) => r.name === 'kb_list')).toBe(false);
    await h.sync.pushMeetingNote(abs);
    expect(h.pushedNote().kb_id).toBeUndefined();
  });

  it('starts the default from the first note it routes, within a day', async () => {
    const h = harness();
    const recent = h.put('meetings/quorum/now.md', note({ source: 'quorum', date: '2026-11-13T19:30:00.000Z' }));
    await h.sync.pushMeetingNote(recent);
    expect(h.settings.meetingsKb.since[h.state.workspace.id]).toBe('2026-11-13T17:30:00.000Z');
    expect(h.pushedNote().kb_id).toBe('KB1');
    const old = h.put('meetings/quorum/old.md', note({ source: 'quorum', date: '2026-11-10T10:00:00.000Z' }));
    await h.sync.pushMeetingNote(old);
    expect(h.pushedNote().kb_id).toBeUndefined();
    expect(fmOf(old).keep_private).toBeUndefined();
  });

  it('turning auto-save from off to on starts it from now, so notes made while off stay out', async () => {
    const h = harness({ settings: { meetingsKb: { autoSave: false } } });
    h.since(SINCE);
    const whileOff = h.put('meetings/quorum/off.md', note({ source: 'quorum', date: '2026-11-13T19:00:00.000Z' }));
    await h.sync.pushMeetingNote(whileOff);
    expect(h.pushedNote().kb_id).toBeUndefined();
    h.mkb.setAutoSave(true);
    expect(h.settings.meetingsKb.since[h.state.workspace.id]).toBe(NOW.toISOString());
    await h.sync.pushMeetingNote(whileOff);
    expect(h.pushedNote().kb_id).toBeUndefined();
  });

  it('keep private pushes it private and out of the KB; turning it off places it again', async () => {
    const h = harness();
    h.since(SINCE);
    const abs = h.put('meetings/quorum/one.md', note({ source: 'quorum', date: DATE }));
    await h.sync.pushMeetingNote(abs);
    expect((await h.mkb.setKeepPrivate(abs, true)).keepPrivate).toBe(true);
    await h.sync.pushMeetingNote(abs);
    expect(h.pushedNote().frontmatter).toMatchObject({ visibility: 'private', keep_private: 'true' });
    expect(h.pushedNote().kb_id).toBeUndefined();
    expect(await h.mkb.stateOf(abs)).toMatchObject({ available: true, keepPrivate: true, kbName: 'Meetings' });
    await h.mkb.setKeepPrivate(abs, false);
    await h.sync.pushMeetingNote(abs);
    expect(h.pushedNote()).toMatchObject({ kb_id: 'KB1', folder_id: 'F11' });
  });

  it('reconciles disagreeing keys before the push, in both directions', async () => {
    const h = harness();
    h.since(SINCE);
    const kept = h.put('meetings/quorum/kept.md', note({ source: 'quorum', date: DATE, keep_private: 'true', visibility: 'public' }));
    await h.sync.pushMeetingNote(kept);
    expect(h.pushedNote().frontmatter.visibility).toBe('private');
    expect(h.pushedNote().kb_id).toBeUndefined();
    expect(fmOf(kept).visibility).toBe('private');
    const shared = h.put('meetings/quorum/shared.md', note({ source: 'quorum', date: DATE, keep_private: 'false', visibility: 'private' }));
    await h.sync.pushMeetingNote(shared);
    expect(h.pushedNote()).toMatchObject({ kb_id: 'KB1' });
    expect(h.pushedNote().frontmatter.visibility).toBe('public');
  });
});

describe('a connector note', () => {
  const gran = (extra = {}) => note({ source: 'granola', source_account: '"alex@example.com"', visibility: 'private', date: DATE, ...extra });

  it('stays private and asks once until the person chooses for its source account', async () => {
    const h = harness();
    const abs = h.put('meetings/granola/a.md', gran());
    await h.sync.pushMeetingNote(abs);
    expect(h.pushedNote().kb_id).toBeUndefined();
    expect(h.pushedNote().frontmatter.visibility).toBe('private');
    expect(await h.mkb.stateOf(abs)).toMatchObject({ available: true, keepPrivate: true, ask: { key: 'granola:alex@example.com', label: 'Granola (alex@example.com)' } });
    const list = await h.mkb.sources();
    expect(list).toMatchObject({ available: true, workspaceName: 'Example Team', kbName: 'Meetings' });
    expect(list.sources).toEqual([{ key: 'granola:alex@example.com', label: 'Granola (alex@example.com)', choice: null, past: 1 }]);
  });

  it('Share places the notes that asked (within a day) and the ones after; older ones wait for share past', async () => {
    const h = harness();
    const recent = h.put('meetings/granola/recent.md', gran());
    await h.sync.pushMeetingNote(recent);
    const old = h.put('meetings/granola/old.md', gran({ date: '2026-09-01T10:00:00.000-07:00' }));
    await h.sync.pushMeetingNote(old);
    expect((await h.mkb.setSource('granola:alex@example.com', 'share')).ok).toBe(true);
    expect(fmOf(recent)).toMatchObject({ keep_private: 'false', visibility: 'public' });
    expect(h.pushes().some((r) => r.kb_id === 'KB1' && r.path === 'meetings/granola/recent.md')).toBe(true);
    expect(fmOf(old).keep_private).toBeUndefined();
    expect((await h.mkb.sources()).sources[0]).toMatchObject({ choice: 'share', past: 1 });
    expect(await h.mkb.sharePast('granola:alex@example.com')).toEqual({ shared: 1 });
    expect(fmOf(old)).toMatchObject({ keep_private: 'false', visibility: 'public' });
    expect(h.pushes().some((r) => r.kb_id === 'KB1' && r.path === 'meetings/granola/old.md')).toBe(true);
  });

  it('Keep private for a source leaves its notes out; another account asks on its own', async () => {
    const h = harness();
    const a = h.put('meetings/granola/a.md', gran());
    await h.sync.pushMeetingNote(a);
    await h.mkb.setSource('granola:alex@example.com', 'private');
    await h.sync.pushMeetingNote(a);
    expect(h.pushedNote().kb_id).toBeUndefined();
    expect((await h.mkb.stateOf(a)).ask).toBeNull();
    const other = h.put('meetings/granola/b.md', gran({ source_account: '"dana@example.com"' }));
    await h.sync.pushMeetingNote(other);
    expect((await h.mkb.stateOf(other)).ask).toMatchObject({ key: 'granola:dana@example.com' });
  });
});

describe('guardrails and availability', () => {
  it('never pushes or shares a confidential note', async () => {
    const confidential = (t) => /^confidential:/m.test(t);
    const h = harness({ isExcludedText: confidential });
    h.since(SINCE);
    const abs = h.put('meetings/quorum/secret.md', note({ source: 'quorum', date: DATE, confidential: 'true' }));
    expect(await h.sync.pushMeetingNote(abs)).toBe(false);
    expect(h.calls).toEqual([]);
    expect(await h.mkb.stateOf(abs)).toMatchObject({ available: true, locked: true, keepPrivate: true });
    expect((await h.mkb.setKeepPrivate(abs, false)).error).toMatch(/confidential/);
  });

  it('never rewrites a note in an excluded folder, and says why it is not shared', async () => {
    const h = harness({ isExcluded: (rel) => rel.startsWith('private/') });
    h.since(SINCE);
    const text = note({ source: 'quorum', date: DATE });
    const abs = h.put('private/meetings/x.md', text);
    expect(await h.mkb.route(abs)).toBeNull();
    expect(readFileSync(abs, 'utf8')).toBe(text);
    expect(await h.mkb.stateOf(abs)).toMatchObject({ available: false, reason: EXCLUDED });
  });

  it('with sync off: nothing is routed and the toggle gives way to a sentence', async () => {
    const h = harness({ sync: false });
    h.since(SINCE);
    const text = note({ source: 'quorum', date: DATE });
    const abs = h.put('meetings/quorum/x.md', text);
    expect(await h.mkb.route(abs)).toBeNull();
    expect(readFileSync(abs, 'utf8')).toBe(text);
    expect(await h.mkb.stateOf(abs)).toMatchObject({ available: false, reason: SYNC_OFF });
    expect((await h.mkb.setKeepPrivate(abs, true)).error).toBe(SYNC_OFF);
  });

  it('does nothing in a solo workspace, without a meetings KB, or when the person cannot read it', async () => {
    for (const h of [harness({ teamEnabled: false }), harness({ info: null }), harness({ folder: null })]) {
      h.since(SINCE);
      const abs = h.put('meetings/quorum/x.md', note({ source: 'quorum', date: DATE }));
      await h.sync.pushMeetingNote(abs);
      expect(h.pushedNote().kb_id).toBeUndefined();
      expect(fmOf(abs).visibility).toBeUndefined();
    }
    const solo = harness({ teamEnabled: false });
    const abs = solo.put('meetings/quorum/y.md', note({ source: 'quorum', date: DATE }));
    expect(await solo.mkb.stateOf(abs)).toMatchObject({ available: false, reason: null });
    expect(await solo.mkb.sources()).toEqual({ available: false, sources: [] });
  });
});

describe('the placed-once mark', () => {
  it('comes from the pulled place, so a note an admin moved within the KB stays where they put it', async () => {
    const { createHash } = await import('node:crypto');
    const vault = mkdtempSync(path.join(tmpdir(), 'quorum-mkb-pull-'));
    dirs.push(vault);
    const rel = 'meetings/quorum/moved.md';
    const text = withChoice(note({ source: 'quorum', date: DATE }), false);
    mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
    writeFileSync(path.join(vault, rel), text);
    const hash = createHash('sha256').update(text).digest('hex');
    const upserts = [];
    const pulled = { notes: [{ id: '01JC0000000000000000000001', user_id: 'user-1', path: rel, frontmatter: {}, body: text, hash, mtime: null, updated_at: '2026-11-13T19:00:00.000Z', deleted_at: null, kb_id: 'KB1', folder_id: 'ADMIN_FOLDER' }], meetings: [] };
    const from = (table) => {
      const b = { upserting: false };
      for (const op of ['select', 'eq', 'neq', 'is', 'gt', 'in', 'like', 'order', 'range', 'limit', 'update']) b[op] = () => b;
      b.upsert = (rows) => { b.upserting = true; upserts.push({ table, rows }); return b; };
      b.then = (res, rej) => Promise.resolve({ data: b.upserting ? null : pulled[table] ?? [], error: null }).then(res, rej);
      return b;
    };
    const client = { from, rpc: async (name) => ({ data: name === 'kb_meetings_info' ? { kb_id: 'KB1', name: 'Meetings' } : { kb_id: 'KB1', folder_id: 'F11' }, error: null }) };
    const state = { sync: true, signedIn: true, workspace: { id: `ws-${path.basename(vault)}`, teamEnabled: true }, userId: 'user-1' };
    const account = { state: () => state, client: () => client, markSync: () => {} };
    const mkb = createMeetingsKb({ account, settings: {}, now: () => NOW });
    const sync = createSync({ account, store: { notes: { write: (abs, t) => writeFileSync(abs, t) }, meetings: { root: path.join(vault, '.sessions') } }, brain: () => ({ vault }), meetings: mkb });
    expect((await sync.pullNow()).error).toBeUndefined();
    await sync.pushMeetingNote(path.join(vault, rel));
    const row = upserts.filter((u) => u.table === 'notes').at(-1).rows[0];
    expect(row.kb_id).toBeUndefined();
    expect(row.folder_id).toBeUndefined();
  });
});

describe('teams (migration 0035)', () => {
  const ALPHA = { id: 'T-alpha', name: 'Alpha', meetings_default: false };
  const BETA = { id: 'T-beta', name: 'Beta', meetings_default: false };
  const alphaInfo = (teams = [ALPHA]) => ({ kb_id: 'KB-alpha', name: 'Alpha meetings', team_id: 'T-alpha', teams });

  it('names the meeting team the way the server routes: the chosen one, else the first joined, else none', () => {
    expect(meetingTeamOf([])).toBeNull();
    expect(meetingTeamOf(undefined)).toBeNull();
    expect(meetingTeamOf([ALPHA])).toBe('T-alpha');
    expect(meetingTeamOf([ALPHA, BETA])).toBe('T-alpha');
    expect(meetingTeamOf([ALPHA, { ...BETA, meetings_default: true }])).toBe('T-beta');
  });

  it('places a team member\'s shared note in the team meetings KB the server answers with', async () => {
    const h = harness({ info: alphaInfo(), folder: { kb_id: 'KB-alpha', folder_id: 'FA11', month: '2026-11', team_id: 'T-alpha' } });
    h.since(SINCE);
    const abs = h.put('meetings/quorum/design.md', note({ source: 'quorum', date: DATE }));
    expect(await h.sync.pushMeetingNote(abs)).toBe(true);
    expect(h.pushedNote()).toMatchObject({ kb_id: 'KB-alpha', folder_id: 'FA11' });
    expect((await h.mkb.stateOf(abs)).kbName).toBe('Alpha meetings');
  });

  it('routes before the team meetings KB exists, since the folder call makes it', async () => {
    const h = harness({ info: { ...alphaInfo(), kb_id: null }, folder: { kb_id: 'KB-new', folder_id: 'FN11', month: '2026-11', team_id: 'T-alpha' } });
    h.since(SINCE);
    const abs = h.put('meetings/quorum/kickoff.md', note({ source: 'quorum', date: DATE }));
    await h.sync.pushMeetingNote(abs);
    expect(h.pushedNote()).toMatchObject({ kb_id: 'KB-new', folder_id: 'FN11' });
  });

  it('keeps the per-source share choice in force for team members', async () => {
    const h = harness({ info: alphaInfo(), folder: { kb_id: 'KB-alpha', folder_id: 'FA11', month: '2026-11' } });
    const abs = h.put('meetings/granola/call.md', note({ source: 'granola', source_account: 'alex@example.com', date: DATE, visibility: 'private' }));
    await h.sync.pushMeetingNote(abs);
    expect(h.pushedNote()?.kb_id).toBeUndefined();
    expect(h.rpcs.some((r) => r.name === 'kb_meetings_folder')).toBe(false);
    expect((await h.mkb.sources()).sources[0]).toMatchObject({ key: 'granola:alex@example.com', choice: null });
  });

  it('offers the meeting team choice only to a person in several teams', async () => {
    expect(await harness({ info: alphaInfo() }).mkb.sources()).toMatchObject({ available: true, teams: [], teamId: 'T-alpha' });
    expect(await harness({ info: alphaInfo([ALPHA, BETA]) }).mkb.sources()).toMatchObject({ teams: [{ id: 'T-alpha', name: 'Alpha' }, { id: 'T-beta', name: 'Beta' }], teamId: 'T-alpha' });
    // a server before 0035 sends no team: nothing to choose, and the workspace KB is used as before
    expect(await harness().mkb.sources()).toMatchObject({ available: true, kbName: 'Meetings', teams: [], teamId: null });
  });

  it('saves the choice on the server and asks again where notes go', async () => {
    const h = harness({ info: alphaInfo([ALPHA, BETA]) });
    await h.mkb.sources();
    expect(await h.mkb.setTeam('T-beta')).toEqual({ ok: true, teamId: 'T-beta' });
    expect(h.rpcs.find((r) => r.name === 'team_meetings_default_set').args).toEqual({ workspace_id: h.state.workspace.id, team_id: 'T-beta' });
    await h.mkb.sources();
    expect(h.rpcs.filter((r) => r.name === 'kb_meetings_info')).toHaveLength(2);
    expect(await h.mkb.setTeam(null)).toEqual({ ok: true, teamId: null });
    h.state.workspace.teamEnabled = false;
    expect((await h.mkb.setTeam('T-beta')).error).toMatch(/workspace with a team/);
  });
});
