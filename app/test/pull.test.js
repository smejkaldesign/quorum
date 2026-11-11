// Pull sync (ee/sync.js pullNow) and the hosted store (ee/store/remote.js) against a fake Supabase client that records
// every query and answers with canned rows. HOME points at a temp folder before the module loads, so sync-ids.json
// and sync-pull.json stay out of the real Application Support folder.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const home = mkdtempSync(path.join(tmpdir(), 'quorum-pull-home-'));
process.env.HOME = home;
const { createSync } = await import('../ee/sync.js');
const { createRemote } = await import('../ee/store/remote.js');

const NOTE = '---\ntitle: Hello\n---\n# Hello\n\nBody line.\n';
const REMOTE = '---\ntitle: Hello\n---\n# Hello\n\nEdited elsewhere.\n';
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const T1 = '2026-11-08T10:00:00.000Z', T2 = '2026-11-08T11:00:00.000Z';
const id = (n) => `01JC000000000000000000${String(n).padStart(4, '0')}`.slice(-26).replace(/[ILOU]/g, 'X');
const vaults = [];

// a PostgREST-shaped builder: every filter records itself and returns the builder; awaiting it resolves the canned
// rows of its table (upsert and update resolve with no rows)
function fakeClient(rows = {}) {
  const calls = [];
  const from = (table) => {
    const call = { table, ops: [], rows: null };
    calls.push(call);
    const b = {};
    for (const op of ['select', 'eq', 'neq', 'is', 'gt', 'in', 'like', 'order', 'range', 'limit', 'update']) b[op] = (...a) => { call.ops.push([op, ...a]); return b; };
    b.upsert = (data, opts) => { call.ops.push(['upsert', opts]); call.rows = data; return b; };
    b.then = (res, rej) => Promise.resolve({ data: call.ops.some(([o]) => o === 'upsert' || o === 'update') ? null : rows[table] ?? [], error: null }).then(res, rej);
    return b;
  };
  return { client: { from }, calls };
}

function harness({ files = {}, rows = {}, isExcluded, isExcludedText, teamRoot } = {}) {
  const vault = mkdtempSync(path.join(tmpdir(), 'quorum-pull-vault-'));
  vaults.push(vault);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
    writeFileSync(path.join(vault, rel), text);
  }
  const fake = fakeClient(rows);
  const logs = [];
  const state = { sync: true, signedIn: true, workspace: { id: `ws-${path.basename(vault)}` }, userId: 'user-1', lastSyncAt: null, lastPullAt: null, syncError: null };
  const account = { state: () => state, client: () => fake.client, markSync: (patch) => Object.assign(state, patch) };
  const store = { notes: { write: (abs, text) => writeFileSync(abs, text) }, meetings: { root: path.join(vault, '.sessions') } };
  const sync = createSync({ account, store, brain: () => ({ vault }), log: (...a) => logs.push(a.join(' ')), isExcluded, isExcludedText, ...(teamRoot ? { teamRoot } : {}) });
  const read = (rel) => readFileSync(path.join(vault, rel), 'utf8');
  const has = (rel) => existsSync(path.join(vault, rel));
  const upserts = (table) => fake.calls.filter((c) => c.table === table && c.rows).flatMap((c) => c.rows);
  return { vault, state, rows, sync, logs, calls: fake.calls, read, has, upserts, abs: (rel) => path.join(vault, rel) };
}
const noteRow = (over) => ({ id: id(1), path: 'notes/hello.md', frontmatter: { title: 'Hello' }, body: REMOTE, hash: '', mtime: T2, updated_at: T2, deleted_at: null, ...over });

afterAll(() => {
  for (const v of vaults) rmSync(v, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('pull', () => {
  it('writes a new remote note to the vault at its path and does not push it back', async () => {
    const h = harness({ rows: { notes: [noteRow()] } });
    expect(await h.sync.pullNow()).toEqual({ written: 1, conflicts: 0, removed: 0, skipped: 0 });
    expect(h.read('notes/hello.md')).toBe(REMOTE);
    expect(h.state.lastPullAt).toBeTruthy();
    expect(h.state.syncError).toBeNull();
    // the id map now binds the path to the remote id, so the next push is a skip and a later edit reuses the id
    h.rows.notes = [];
    expect(await h.sync.syncNow()).toEqual({ pushed: 0, skipped: 1, meetings: 0 });
    writeFileSync(h.abs('notes/hello.md'), `${REMOTE}More.\n`);
    await h.sync.syncNow();
    expect(h.upserts('notes').map((r) => r.id)).toEqual([id(1)]);
  });

  it('overwrites a local file that has not changed since the last sync with the newer remote row', async () => {
    const h = harness({ files: { 'notes/hello.md': NOTE } });
    expect(await h.sync.syncNow()).toEqual({ pushed: 1, skipped: 0, meetings: 0 });
    const pushedId = h.upserts('notes')[0].id;
    h.rows.notes = [noteRow({ id: pushedId })];
    expect(await h.sync.pullNow()).toEqual({ written: 1, conflicts: 0, removed: 0, skipped: 0 });
    expect(h.read('notes/hello.md')).toBe(REMOTE);
    expect(readdirSync(h.abs('notes'))).toEqual(['hello.md']);
  });

  it('keeps the remote text and writes the local text as a conflict copy when both changed', async () => {
    const h = harness({ files: { 'notes/hello.md': NOTE } });
    await h.sync.syncNow();
    const pushedId = h.upserts('notes')[0].id;
    const mine = `${NOTE}\nMy local edit.\n`;
    writeFileSync(h.abs('notes/hello.md'), mine);
    h.rows.notes = [noteRow({ id: pushedId })];
    expect(await h.sync.pullNow()).toEqual({ written: 1, conflicts: 1, removed: 0, skipped: 0 });
    expect(h.read('notes/hello.md')).toBe(REMOTE);
    const copy = readdirSync(h.abs('notes')).find((f) => /^hello \(conflict \d{4}-\d{2}-\d{2}\)\.md$/.test(f));
    expect(copy).toBeTruthy();
    expect(h.read(`notes/${copy}`)).toBe(mine);
    expect(h.logs.some((l) => l.includes('conflict on notes/hello.md'))).toBe(true);
  });

  it('leaves a locally edited file alone when the remote row is the one this device pushed', async () => {
    const h = harness({ files: { 'notes/hello.md': NOTE } });
    await h.sync.syncNow();
    const pushed = h.upserts('notes')[0];
    const mine = `${NOTE}\nMy local edit.\n`;
    writeFileSync(h.abs('notes/hello.md'), mine);
    h.rows.notes = [noteRow({ id: pushed.id, body: NOTE, hash: pushed.hash })];
    expect(await h.sync.pullNow()).toEqual({ written: 0, conflicts: 0, removed: 0, skipped: 0 });
    expect(h.read('notes/hello.md')).toBe(mine);
    expect(readdirSync(h.abs('notes'))).toEqual(['hello.md']);
  });

  it('never writes into a private folder or outside the vault', async () => {
    const h = harness({ rows: { notes: [noteRow({ id: id(1), path: 'private/secret.md' }), noteRow({ id: id(2), path: '../escape.md' }), noteRow({ id: id(3), path: '/abs/../../etc.md' }), noteRow({ id: id(4), path: 'notes/ok.md' })] }, isExcluded: (rel) => rel.startsWith('private/') });
    expect(await h.sync.pullNow()).toEqual({ written: 1, conflicts: 0, removed: 0, skipped: 3 });
    expect(h.has('private/secret.md')).toBe(false);
    expect(h.has('private')).toBe(false);
    expect(existsSync(path.join(h.vault, '..', 'escape.md'))).toBe(false);
    expect(h.read('notes/ok.md')).toBe(REMOTE);
  });

  it('writes a pulled note with confidential: frontmatter but never pushes it again', async () => {
    const confidential = '---\ntitle: Payroll\nconfidential: personal\n---\n# Payroll\n';
    const h = harness({ rows: { notes: [noteRow({ path: 'notes/payroll.md', body: confidential })] }, isExcludedText: (text) => /^---\n[\s\S]*?^confidential:/m.test(text) });
    expect(await h.sync.pullNow()).toEqual({ written: 1, conflicts: 0, removed: 0, skipped: 0 });
    expect(h.read('notes/payroll.md')).toBe(confidential);
    h.rows.notes = [];
    writeFileSync(h.abs('notes/payroll.md'), `${confidential}\nSalary line.\n`);
    expect(await h.sync.syncNow()).toEqual({ pushed: 0, skipped: 1, meetings: 0 });
    expect(h.upserts('notes')).toHaveLength(0);
  });

  it('renames the local file when the remote row is soft-deleted and never deletes it', async () => {
    const h = harness({ files: { 'notes/hello.md': NOTE } });
    await h.sync.syncNow();
    const pushedId = h.upserts('notes')[0].id;
    h.rows.notes = [noteRow({ id: pushedId, body: NOTE, deleted_at: T2 })];
    expect(await h.sync.pullNow()).toEqual({ written: 0, conflicts: 0, removed: 1, skipped: 0 });
    expect(h.has('notes/hello.md')).toBe(false);
    expect(h.read('notes/hello (removed).md')).toBe(NOTE);
  });

  it('asks only for rows after the last pull, per workspace, and binds meetings to their note', async () => {
    const h = harness({ rows: { notes: [noteRow({ updated_at: T1 })], meetings: [{ id: id(9), note_id: id(1), title: 'Hello', updated_at: T2, deleted_at: null }] } });
    await h.sync.pullNow();
    const firstReads = h.calls.filter((c) => !c.rows);
    expect(firstReads.map((c) => c.table).sort()).toEqual(['meetings', 'notes']);
    for (const c of firstReads) {
      expect(c.ops).toContainEqual(['eq', 'workspace_id', h.state.workspace.id]);
      expect(c.ops.some(([op]) => op === 'gt')).toBe(false);
    }
    h.calls.length = 0;
    await h.sync.pullNow();
    for (const c of h.calls) expect(c.ops).toContainEqual(['gt', 'updated_at', T2]);
    const pullFile = path.join(home, 'Library/Application Support/Quorum/sync-pull.json');
    expect(JSON.parse(readFileSync(pullFile, 'utf8'))[h.state.workspace.id]).toEqual({ lastPullAt: T2 });
    // a push of the pulled meeting note reuses the remote meetings id
    let last = null;
    const recorder = { from: (table) => ({ upsert: async (rows) => { last = { table, rows }; return { error: null }; } }) };
    const meetingsSync = createSync({ account: { state: () => h.state, client: () => recorder, markSync: () => {} }, store: { meetings: { root: h.abs('.sessions') } }, brain: () => ({ vault: h.vault }) });
    await meetingsSync.pushMeetingNote(h.abs('notes/hello.md'));
    expect(last.table).toBe('meetings');
    expect(last.rows[0].id).toBe(id(9));
    expect(last.rows[0].note_id).toBe(id(1));
  });

  it('does nothing while sync is off and reports a failed pull on the account', async () => {
    const h = harness({ rows: { notes: [noteRow()] } });
    h.state.sync = false;
    expect(await h.sync.pullNow()).toEqual({ error: 'Sync is off or no workspace is chosen.' });
    expect(h.has('notes/hello.md')).toBe(false);
    h.state.sync = true;
    const broken = { state: () => h.state, client: () => ({ from: () => ({ select: () => ({ eq: () => ({ order: () => ({ order: () => ({ range: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }) }) }) }) }), markSync: (p) => Object.assign(h.state, p) };
    const s = createSync({ account: broken, store: { meetings: { root: h.abs('.sessions') } }, brain: () => ({ vault: h.vault }) });
    expect(await s.pullNow()).toEqual({ error: 'Sync could not pull the vault.' });
    expect(h.state.syncError).toBe('Sync could not pull the vault.');
  });
});

describe('remote store', () => {
  const ws = id(7), user = 'user-1';
  it('reads and writes notes by vault path and lists one folder', async () => {
    const fake = fakeClient({ notes: [{ id: id(1), path: 'notes/hello.md', body: NOTE }, { id: id(2), path: 'notes/deep/x.md', body: '' }, { id: id(3), path: 'notes/index.md', body: '' }] });
    const r = createRemote({ client: fake.client, workspaceId: ws, userId: user });
    expect(await r.notes.read('notes/hello.md')).toBe(NOTE);
    expect(await r.notes.title('notes/hello.md')).toBe('Hello');
    expect(await r.notes.list('notes')).toEqual(['hello.md']);
    expect(await r.notes.write('notes/hello.md', REMOTE)).toBe(id(1));
    const up = fake.calls.find((c) => c.table === 'notes' && c.rows);
    expect(up.rows[0]).toMatchObject({ id: id(1), path: 'notes/hello.md', body: REMOTE, workspace_id: ws, user_id: user, frontmatter: { title: 'Hello', participants: [] } });
    const fresh = createRemote({ client: fakeClient({ notes: [] }).client, workspaceId: ws, userId: user });
    expect(await fresh.notes.write('notes/new.md', NOTE)).toMatch(ULID);
  });

  it('writes a chat as a chats row plus one turn row each, and reads it back in the local shape', async () => {
    const fake = fakeClient({ chat_turns: [{ id: id(5), created_at: T1 }] });
    const r = createRemote({ client: fake.client, workspaceId: ws, userId: user });
    await r.chats.write({ id: id(4), title: 'Ask', turns: [{ q: 'q1', a: 'a1', at: T1 }, { q: 'q2', a: 'a2', at: T2 }] });
    const chat = fake.calls.find((c) => c.table === 'chats' && c.rows).rows[0];
    expect(chat).toMatchObject({ id: id(4), title: 'Ask', meeting_id: null, note_id: null });
    const turns = fake.calls.find((c) => c.table === 'chat_turns' && c.rows).rows;
    expect(turns.map((t) => [t.id === id(5), t.question, t.answer, t.chat_id])).toEqual([[true, 'q1', 'a1', id(4)], [false, 'q2', 'a2', id(4)]]);
    expect(turns[1].id).toMatch(ULID);
    await expect(r.chats.write({ id: 'chat-123', turns: [] })).rejects.toThrow(/ULID/);
    const reader = createRemote({ client: fakeClient({ chats: [{ id: id(4), title: 'Ask', created_at: T1, updated_at: T2, turns: [{ id: id(5), question: 'q1', answer: 'a1', sources: [], steps: [], created_at: T1 }] }] }).client, workspaceId: ws, userId: user });
    expect(await reader.chats.read(id(4))).toEqual({ id: id(4), title: 'Ask', meetingId: undefined, noteId: undefined, createdAt: T1, updatedAt: T2, turns: [{ id: id(5), q: 'q1', a: 'a1', sources: [], steps: [], at: T1 }] });
  });

  it('keeps settings per scope and names what the hosted store cannot do', async () => {
    const fake = fakeClient({ settings: [{ id: id(6), scope: 'user', data: { model: 'opus' } }] });
    const r = createRemote({ client: fake.client, workspaceId: ws, userId: user });
    expect(r.settings.get()).toEqual({});
    expect(await r.settings.load()).toEqual({ model: 'opus' });
    expect(await r.settings.set({ suggestions: false })).toEqual({ model: 'opus', suggestions: false });
    expect(fake.calls.find((c) => c.table === 'settings' && c.rows).rows[0]).toMatchObject({ id: id(6), scope: 'user', data: { model: 'opus', suggestions: false } });
    for (const fn of [r.meetings.ensureRoot, r.meetings.beginSegment, r.meetings.deleteSession, r.attachments.clear, r.state.write]) expect(fn).toThrow(/not available in the hosted store/);
    expect(() => r.meetings.root).toThrow(/not available in the hosted store/);
  });
});

// a teammate's shared note: the workspace vault, the bond, behind marking, removal once no longer shared
describe('workspace vault', () => {
  const TEAM = '---\ntitle: Pricing\nvisibility: public\n---\n# Pricing\n\nTeam text v1.\n';
  const TEAM2 = TEAM.replace('v1', 'v2');
  const shared = (over) => noteRow({ id: id(7), user_id: 'user-2', path: 'knowledge/pricing.md', body: TEAM, ...over });
  const teamHarness = (rows) => {
    const team = mkdtempSync(path.join(tmpdir(), 'quorum-team-'));
    vaults.push(team);
    const h = harness({ rows, teamRoot: () => team });
    return { ...h, team, tread: (rel) => readFileSync(path.join(team, rel), 'utf8'), thas: (rel) => existsSync(path.join(team, rel)) };
  };
  it('writes a teammate note into the workspace vault with a bond and leaves the personal vault alone', async () => {
    const h = teamHarness({ notes: [shared()] });
    expect(await h.sync.pullNow()).toEqual({ written: 0, conflicts: 0, removed: 0, skipped: 0 });
    expect(h.has('knowledge/pricing.md')).toBe(false);
    const text = h.tread('knowledge/pricing.md');
    expect(text).toContain('team_item: ' + id(7));
    expect(text).toContain('team_workspace: ' + h.state.workspace.id);
    expect(text).toMatch(/team_pulled_at: \d{4}-/);
    expect(text).toContain('title: Pricing');
    expect(text.endsWith('Team text v1.\n')).toBe(true);
    expect(h.sync.team()).toMatchObject({ root: h.team, notes: 1, behind: 0 });
    // a second pull of the same version changes nothing
    const before = h.tread('knowledge/pricing.md');
    await h.sync.pullNow();
    expect(h.tread('knowledge/pricing.md')).toBe(before);
  });
  it('replaces an untouched copy with the newer team version', async () => {
    const h = teamHarness({ notes: [shared()] });
    await h.sync.pullNow();
    h.rows.notes = [shared({ body: TEAM2, updated_at: '2026-11-08T12:00:00.000Z' })];
    await h.sync.pullNow();
    expect(h.tread('knowledge/pricing.md')).toContain('Team text v2.');
    expect(h.sync.team().behind).toBe(0);
  });
  it('keeps an edited copy, marks it behind and parks the new text under .updates', async () => {
    const h = teamHarness({ notes: [shared()] });
    await h.sync.pullNow();
    writeFileSync(path.join(h.team, 'knowledge/pricing.md'), h.tread('knowledge/pricing.md') + '\nMy own line.\n');
    h.rows.notes = [shared({ body: TEAM2, updated_at: '2026-11-08T12:00:00.000Z' })];
    await h.sync.pullNow();
    const text = h.tread('knowledge/pricing.md');
    expect(text).toContain('My own line.');
    expect(text).toContain('team_behind: true');
    expect(text).not.toContain('Team text v2.');
    expect(h.tread('.updates/knowledge/pricing.md')).toBe(TEAM2);
    expect(h.sync.team().behind).toBe(1);
  });
  it('moves the copy aside once the note is no longer shared, and on a remote delete', async () => {
    const h = teamHarness({ notes: [shared(), shared({ id: id(8), path: 'knowledge/roadmap.md' })] });
    await h.sync.pullNow();
    expect(h.sync.team().notes).toBe(2);
    // the read policy no longer returns pricing; roadmap comes back soft-deleted
    h.rows.notes = [shared({ id: id(8), path: 'knowledge/roadmap.md', deleted_at: '2026-11-08T12:00:00.000Z', updated_at: '2026-11-08T12:00:00.000Z' })];
    await h.sync.pullNow();
    expect(h.thas('knowledge/pricing.md')).toBe(false);
    expect(h.thas('knowledge/pricing (removed).md')).toBe(true);
    expect(h.thas('knowledge/roadmap.md')).toBe(false);
    expect(h.thas('knowledge/roadmap (removed).md')).toBe(true);
    expect(h.sync.team().notes).toBe(0);
  });
  it('a note with no author column still goes to the personal vault', async () => {
    const h = teamHarness({ notes: [noteRow()] });
    expect(await h.sync.pullNow()).toEqual({ written: 1, conflicts: 0, removed: 0, skipped: 0 });
    expect(h.has('notes/hello.md')).toBe(true);
  });
});
