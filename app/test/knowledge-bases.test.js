// Knowledge bases (ee/knowledgeBases.js): the shapes the renderer gets, the RPC each handler calls, and the KB
// placement pull sync carries (ee/sync.js, ee/store/remote.js). The server's rights are tested in
// supabase/tests/knowledge_bases.sql; here a fake client records calls and answers with canned data.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const home = mkdtempSync(path.join(tmpdir(), 'quorum-kb-home-'));
process.env.HOME = home;
const { accessRows, checkName, createKnowledgeBases, folderTree, shapeKb } = await import('../ee/knowledgeBases.js');
const { bondOf, createSync, parseFrontmatter, placeOf } = await import('../ee/sync.js');
const { createRemote } = await import('../ee/store/remote.js');

const dirs = [home];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const KB = '01KB00000000000000000000K1';
const ROW = {
  id: KB, workspace_id: 'W', name: 'Handbook', kind: 'general', team_id: null, is_default: true, source: { kind: 'git', url: 'https://example.com/kb.git', path: null, set_by: 'u' },
  role: 'admin', created_at: 't0', updated_at: 't1',
  folders: [
    { id: 'F3', parent_id: 'F1', name: 'Week 2', position: 1 },
    { id: 'F1', parent_id: null, name: 'Guides', position: 0 },
    { id: 'F2', parent_id: 'F1', name: 'Week 1', position: 0 },
    { id: 'F4', parent_id: null, name: 'Archive', position: 0 },
    { id: 'F5', parent_id: 'GONE', name: 'Orphan', position: 5 },
  ],
  access: [{ principal: 'workspace', user_id: null, team_id: null, role: 'reader', email: null, name: null }],
};

describe('what the renderer gets', () => {
  it('builds the folder tree by position, then name, at any depth', () => {
    const tree = folderTree(ROW.folders);
    expect(tree.map((n) => n.name)).toEqual(['Archive', 'Guides', 'Orphan']);
    expect(tree[1].children.map((n) => n.name)).toEqual(['Week 1', 'Week 2']);
    const deep = folderTree([{ id: 'a', parent_id: null, name: 'a' }, { id: 'b', parent_id: 'a', name: 'b' }, { id: 'c', parent_id: 'b', name: 'c' }, { id: 'd', parent_id: 'c', name: 'd' }]);
    expect(deep[0].children[0].children[0].children[0].name).toBe('d');
  });

  it('shapes a KB row defensively', () => {
    const kb = shapeKb(ROW);
    expect(kb).toMatchObject({ id: KB, name: 'Handbook', kind: 'general', isDefault: true, role: 'admin', source: { kind: 'git', url: 'https://example.com/kb.git', path: null } });
    expect(kb.access).toEqual([{ principal: 'workspace', userId: null, teamId: null, role: 'reader', email: null, name: null }]);
    expect(shapeKb({ id: 'x', name: 'n', kind: 'odd', role: 'owner', source: { kind: 'sync' }, access: null })).toMatchObject({ kind: 'general', role: 'reader', source: null, access: null, folders: [] });
  });

  it('checks names and access lists before the server sees them', () => {
    expect(checkName('  Handbook ')).toEqual({ name: 'Handbook' });
    expect(checkName('   ').error).toMatch(/needs a name/);
    expect(checkName('x'.repeat(121)).error).toMatch(/too long/);
    expect(checkName('a/b', { folder: true }).error).toMatch(/slashes/);
    expect(checkName('a/b').name).toBe('a/b');
    expect(accessRows([{ principal: 'workspace' }, { principal: 'user', userId: 'u1', role: 'admin' }])).toEqual({ rows: [{ principal: 'workspace', role: 'reader' }, { principal: 'user', role: 'admin', user_id: 'u1' }] });
    expect(accessRows([{ principal: 'user' }]).error).toMatch(/person/);
    expect(accessRows([{ principal: 'workspace', role: 'owner' }]).error).toMatch(/admin or reader/);
    expect(accessRows([{ principal: 'everyone' }]).error).toMatch(/workspace, a team or a person/);
    expect(accessRows('all').error).toMatch(/list/);
  });
});

// a client whose rpc answers from a table of canned results and whose from() answers notes reads
function fakeAccount({ role = 'admin', answers = {}, notes = [], signedIn = true } = {}) {
  const calls = [];
  let reads = 0;
  const client = {
    rpc: async (name, args) => { calls.push([name, args]); const a = answers[name]; return a instanceof Error ? { data: null, error: { message: a.message, code: 'P0001' } } : { data: typeof a === 'function' ? a(args) : a ?? null, error: null }; },
    from: (table) => {
      const ops = [];
      const b = {};
      for (const op of ['select', 'eq', 'is', 'order', 'limit', 'range']) b[op] = (...a) => { ops.push([op, ...a]); return b; };
      b.then = (res, rej) => { calls.push([`from:${table}`, ops]); reads++; return Promise.resolve({ data: typeof notes === 'function' ? notes(reads - 1) : notes, error: null }).then(res, rej); };
      return b;
    },
  };
  const state = { signedIn, userId: 'me', workspace: { id: 'W', role } };
  return { calls, account: { client: () => client, state: () => state } };
}

describe('the IPC handlers', () => {
  it('stop before the server when signed out, without a workspace, or as a member creating a KB', async () => {
    expect((await createKnowledgeBases(fakeAccount({ signedIn: false })).handlers['kb-list']()).error).toMatch(/Sign in/);
    expect((await createKnowledgeBases(fakeAccount({ role: 'member' })).handlers['kb-create']({ name: 'X' })).error).toMatch(/Only owners and admins/);
    expect((await createKnowledgeBases(fakeAccount({ role: 'member' })).handlers['kb-delete'](KB)).error).toMatch(/Only owners and admins/);
    const f = fakeAccount();
    expect((await createKnowledgeBases(f).handlers['kb-create']({ name: ' ' })).error).toMatch(/needs a name/);
    expect((await createKnowledgeBases(f).handlers['kb-create']({ name: 'X', kind: 'wiki' })).error).toMatch(/general or meetings/);
    expect((await createKnowledgeBases(f).handlers['kb-folder-move']({ folderId: 'F1', parentId: 'F1' })).error).toMatch(/inside itself/);
    expect((await createKnowledgeBases(f).handlers['kb-rename'](null, 'Name')).error).toMatch(/Pick the knowledge base/);
    expect(f.calls).toEqual([]);
  });

  it('call the RPCs with the names and arguments the migration defines', async () => {
    const folder = { id: 'F9', kb_id: KB, parent_id: 'F1', name: 'New', position: 2 };
    const f = fakeAccount({ answers: { kb_list: [ROW], kb_create: ROW, kb_rename: ROW, kb_folder_create: folder, kb_folder_rename: folder, kb_folder_move: folder, kb_set_access: ROW.access, kb_note_assign: { note_id: 'N1', kb_id: KB, folder_id: 'F2', updated_at: 't2' } } });
    const h = createKnowledgeBases(f).handlers;
    expect((await h['kb-list']()).kbs[0].folders[1].children).toHaveLength(2);
    expect((await h['kb-create']({ name: ' Handbook ' })).kb.name).toBe('Handbook');
    await h['kb-rename'](KB, 'Handbook');
    expect(await h['kb-delete'](KB)).toEqual({ ok: true });
    expect((await h['kb-folder-create']({ kbId: KB, parentId: 'F1', name: 'New' })).folder).toEqual({ id: 'F9', kbId: KB, parentId: 'F1', name: 'New', position: 2 });
    await h['kb-folder-rename']('F9', 'New');
    await h['kb-folder-move']({ folderId: 'F9', parentId: null, position: 0 });
    await h['kb-folder-move']({ folderId: 'F9', position: 3 });
    expect(await h['kb-folder-delete']('F9')).toEqual({ ok: true });
    expect((await h['kb-access-set'](KB, [{ principal: 'workspace' }])).access[0].principal).toBe('workspace');
    expect((await h['kb-note-assign']({ noteId: 'N1', kbId: KB, folderId: 'F2' })).placement).toEqual({ noteId: 'N1', kbId: KB, folderId: 'F2', updatedAt: 't2' });
    expect(f.calls).toEqual([
      ['kb_list', { workspace_id: 'W' }],
      ['kb_create', { workspace_id: 'W', name: 'Handbook', kind: 'general' }],
      ['kb_rename', { kb_id: KB, name: 'Handbook' }],
      ['kb_delete', { kb_id: KB }],
      ['kb_folder_create', { kb_id: KB, parent_id: 'F1', name: 'New', position: null }],
      ['kb_folder_rename', { folder_id: 'F9', name: 'New' }],
      ['kb_folder_move', { folder_id: 'F9', parent_id: null, position: 0, reparent: true }],
      ['kb_folder_move', { folder_id: 'F9', parent_id: null, position: 3, reparent: false }],
      ['kb_folder_delete', { folder_id: 'F9' }],
      ['kb_set_access', { kb_id: KB, access: [{ principal: 'workspace', role: 'reader' }] }],
      ['kb_note_assign', { note_id: 'N1', kb_id: KB, folder_id: 'F2' }],
    ]);
  });

  it('finds a note by its path, takes one out of a KB, and lists a KB\'s notes', async () => {
    const f = fakeAccount({ notes: [{ id: 'N7', path: 'a/plan.md', frontmatter: {}, folder_id: 'F2', user_id: 'u', updated_at: 't' }], answers: { kb_note_assign: (a) => ({ note_id: a.note_id, kb_id: a.kb_id, folder_id: a.folder_id }) } });
    const h = createKnowledgeBases(f).handlers;
    expect((await h['kb-note-assign']({ path: 'a/plan.md', kbId: KB })).placement.noteId).toBe('N7');
    expect((await h['kb-note-assign']({ noteId: 'N7', kbId: null, folderId: 'F2' })).placement).toEqual({ noteId: 'N7', kbId: null, folderId: null, updatedAt: null });
    expect((await h['kb-notes'](KB)).notes).toEqual([{ id: 'N7', path: 'a/plan.md', title: 'plan', folderId: 'F2', userId: 'u', updatedAt: 't' }]);
    const reads = f.calls.filter(([n]) => n === 'from:notes').map(([, ops]) => ops);
    expect(reads[0]).toContainEqual(['eq', 'path', 'a/plan.md']);
    expect(reads[0]).toContainEqual(['eq', 'user_id', 'me']);
    expect(reads[1]).toContainEqual(['eq', 'kb_id', KB]);
    expect(f.calls.filter(([n]) => n === 'kb_note_assign').map(([, a]) => a.folder_id)).toEqual([null, null]);
  });

  it('reads a KB\'s notes page by page', async () => {
    const page = Array.from({ length: 1000 }, (_, i) => ({ id: `N${i}`, path: `p${i}.md`, frontmatter: { title: `T${i}` }, folder_id: null, user_id: 'u', updated_at: 't' }));
    const f = fakeAccount({ notes: (i) => (i === 0 ? page : [{ id: 'last', path: 'z.md', frontmatter: {}, folder_id: null, user_id: 'u', updated_at: 't' }]) });
    const r = await createKnowledgeBases(f).handlers['kb-notes'](KB);
    expect(r.notes).toHaveLength(1001);
    expect(r.notes[0].title).toBe('T0');
    const ranges = f.calls.filter(([n]) => n === 'from:notes').map(([, ops]) => ops.find(([o]) => o === 'range'));
    expect(ranges).toEqual([['range', 0, 999], ['range', 1000, 1999]]);
  });

  it('passes the server\'s refusal through as the page\'s sentence', async () => {
    const f = fakeAccount({ answers: { kb_rename: new Error('Only the knowledge base\'s admins can rename it') } });
    expect(await createKnowledgeBases(f).handlers['kb-rename'](KB, 'X')).toEqual({ error: 'Only the knowledge base\'s admins can rename it.' });
  });
});

describe('pull sync carries the KB placement', () => {
  it('reads kb_id and folder_id, and drops them for a database without migration 0024', async () => {
    const selects = [];
    let missing = true;
    const client = {
      from: () => {
        const b = {};
        let cols = '';
        for (const op of ['select', 'eq', 'gt', 'order', 'range']) b[op] = (...a) => { if (op === 'select') { cols = a[0]; selects.push(cols); } return b; };
        b.then = (res, rej) => Promise.resolve(missing && cols.includes('kb_id') ? { data: null, error: { message: 'column notes.kb_id does not exist' } } : { data: [], error: null }).then(res, rej);
        return b;
      },
    };
    const remote = createRemote({ client, workspaceId: 'W', userId: 'u' });
    expect(await remote.notes.changedSince(null)).toEqual([]);
    expect(await remote.notes.changedSince(null)).toEqual([]);
    expect(selects.map((s) => s.includes('kb_id'))).toEqual([true, false, false]);
    missing = false;
    const later = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60 * 1000);
    await remote.notes.changedSince(null);
    later.mockRestore();
    expect(selects.at(-1)).toMatch(/kb_id, folder_id$/);
  });

  it('writes a teammate\'s KB note with its place, and follows a move without touching the text', async () => {
    const team = mkdtempSync(path.join(tmpdir(), 'quorum-kb-team-'));
    const vault = mkdtempSync(path.join(tmpdir(), 'quorum-kb-vault-'));
    dirs.push(team, vault);
    let rows = [{ id: 'N1', user_id: 'other', path: 'kb/plan.md', frontmatter: {}, body: '# Plan\n', hash: 'h1', updated_at: '2026-11-13T10:00:00Z', deleted_at: null, kb_id: KB, folder_id: 'F2' }];
    const client = {
      from: () => {
        const b = {};
        let shared = false;
        for (const op of ['select', 'eq', 'neq', 'is', 'gt', 'order', 'range']) b[op] = () => { if (op === 'neq') shared = true; return b; };
        b.then = (res, rej) => Promise.resolve({ data: shared ? rows.map((r) => ({ id: r.id, hash: r.hash })) : rows, error: null }).then(res, rej);
        return b;
      },
    };
    const state = { sync: true, signedIn: true, workspace: { id: 'W' }, userId: 'me', syncError: null };
    const account = { state: () => state, client: () => client, markSync: (p) => Object.assign(state, p) };
    const sync = createSync({ account, store: { notes: { write: (abs, text) => writeFileSync(abs, text) } }, brain: () => ({ vault }), idsFile: path.join(home, 'sync-ids-kb.json'), teamRoot: () => team });
    await sync.pullNow();
    const first = readFileSync(path.join(team, 'kb/plan.md'), 'utf8');
    expect(bondOf(first)).toMatchObject({ item: 'N1', version: 'h1' });
    expect(parseFrontmatter(first)).toMatchObject({ team_kb: KB, team_folder: 'F2' });
    rows = [{ ...rows[0], folder_id: null, kb_id: KB, updated_at: '2026-11-13T11:00:00Z' }];
    await sync.pullNow();
    const moved = readFileSync(path.join(team, 'kb/plan.md'), 'utf8');
    expect(bondOf(moved)).toMatchObject({ item: 'N1' });
    expect(parseFrontmatter(moved).team_kb).toBe(KB);
    expect(parseFrontmatter(moved).team_folder).toBeUndefined();
    expect(moved.endsWith('# Plan\n')).toBe(true);
    expect(placeOf({ kb_id: null, folder_id: 'F2' })).toEqual({ kb: undefined, folder: undefined });
  });
});
