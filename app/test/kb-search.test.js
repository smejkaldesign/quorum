// Knowledge base search (ee/kbSearch.js): result shaping, citations, the chat's context block and source cards, path
// resolution, and the calls each method makes. The server's rights are tested in supabase/tests/kb_search.sql; here a
// fake client records calls and answers with canned rows.
import { describe, expect, it } from 'vitest';
import { splitSources } from '../agent.js';

const { KB_CHAT, chatContext, citation, createKbSearch, folderNames, folderPaths, kbLink, kbPlace, kbSources, parseKbLink, resolvePath, runKbCommand, shapeHit } = await import('../ee/kbSearch.js');
const { shapeKb } = await import('../ee/knowledgeBases.js');

const KB = '01KB00000000000000000000K1';
const KB2 = '01KB00000000000000000000K2';
const N1 = '01KB000000000000000000N001';
const N2 = '01KB000000000000000000N002';
const ROW = { note_id: N1, kb_id: KB, kb_name: 'Handbook', folder_id: 'F2', folder_path: ['Policies', 'Travel'], path: 'handbook/travel.md', title: 'Travel policy', snippet: 'The per diem\ncovers  meals', rank: 0.4, user_id: 'u1', updated_at: '2026-11-01T10:00:00Z' };
const KB_ROWS = [
  { id: KB, name: 'Handbook', kind: 'general', is_default: true, role: 'reader', folders: [{ id: 'F1', parent_id: null, name: 'Policies', position: 0 }, { id: 'F2', parent_id: 'F1', name: 'Travel', position: 0 }], access: null },
  { id: KB2, name: 'Leadership', kind: 'general', is_default: false, role: 'admin', folders: [], access: [] },
];

describe('result shaping and citations', () => {
  it('shapes a search row with its place, link and citation', () => {
    const h = shapeHit(ROW);
    expect(h).toEqual({
      noteId: N1, kbId: KB, kbName: 'Handbook', folderId: 'F2', folderPath: ['Policies', 'Travel'], path: 'handbook/travel.md', title: 'Travel policy',
      snippet: 'The per diem covers meals', rank: 0.4, updatedAt: '2026-11-01T10:00:00Z',
      link: `quorum://kb/${KB}/${N1}`, citation: 'Handbook / Policies / Travel / Travel policy',
    });
  });

  it('falls back to the file name for a missing title and to an empty folder path', () => {
    const h = shapeHit({ ...ROW, title: '  ', folder_path: null, folder_id: null });
    expect(h.title).toBe('travel');
    expect(h.folderPath).toEqual([]);
    expect(h.citation).toBe('Handbook / travel');
  });

  it('runs the snippet through the redactor', () => {
    const h = shapeHit({ ...ROW, snippet: 'met with Acme about it' }, (s) => s.replace('Acme', '[withheld]'));
    expect(h.snippet).toBe('met with [withheld] about it');
  });

  it('formats places and citations', () => {
    expect(kbPlace('Handbook', ['A', 'B'])).toBe('Handbook / A / B');
    expect(kbPlace(null)).toBe('Knowledge base');
    expect(citation({ kbName: 'Handbook', folderPath: [], title: 'Intro' })).toBe('Handbook / Intro');
  });

  it('builds and reads note links, and refuses anything else', () => {
    expect(parseKbLink(kbLink(KB, N1))).toEqual({ kbId: KB, noteId: N1 });
    expect(parseKbLink('quorum://kb/nope/also-nope')).toBeNull();
    expect(parseKbLink('quorum://note/handbook.md')).toBeNull();
    expect(parseKbLink(`quorum://kb/${KB}/${N1}/extra`)).toBeNull();
    expect(parseKbLink(null)).toBeNull();
  });
});

describe('the chat context and its sources', () => {
  const hits = [shapeHit(ROW), shapeHit({ ...ROW, note_id: N2, kb_id: KB2, kb_name: 'Leadership', folder_path: [], title: 'Board plan', snippet: 'Limits rise next quarter.', updated_at: null })];

  it('labels each result and carries its citation and date', () => {
    const c = chatContext(hits);
    expect(c.hits.map((h) => h.label)).toEqual(['K1', 'K2']);
    expect(c.block).toBe('[K1] Handbook / Policies / Travel / Travel policy (updated 2026-11-01)\nThe per diem covers meals\n\n[K2] Leadership / Board plan\nLimits rise next quarter.');
  });

  it('stays inside the budget: excerpts are cut and a result past the total is left out', () => {
    const long = shapeHit({ ...ROW, snippet: 'word '.repeat(400) });
    const c = chatContext([long, long, long], { excerpt: 100, total: 400 });
    expect(c.hits).toHaveLength(2);
    expect(c.block.length).toBeLessThanOrEqual(400);
    expect(c.block.split('\n\n')[0].split('\n')[1].length).toBe(100);
    expect(c.block).toContain('…');
    const full = chatContext(Array.from({ length: 20 }, () => long));
    expect(full.block.length).toBeLessThanOrEqual(KB_CHAT.total);
  });

  it('is null with nothing to say', () => {
    expect(chatContext([])).toBeNull();
  });

  it('turns cited labels into Knowledge source cards, once each, and drops labels it never handed out', () => {
    const { hits: labelled } = chatContext(hits);
    expect(kbSources(['k2', 'K1', 'K2', 'K9'], labelled)).toEqual([
      { title: 'Board plan', rel: 'Leadership', abs: null, app: 'Knowledge', url: `quorum://kb/${KB2}/${N2}`, kb: { kbId: KB2, noteId: N2 } },
      { title: 'Travel policy', rel: 'Handbook / Policies / Travel', abs: null, app: 'Knowledge', url: `quorum://kb/${KB}/${N1}`, kb: { kbId: KB, noteId: N1 } },
    ]);
  });

  it('reads knowledge base labels out of the answer\'s Sources block', () => {
    const r = splitSources('Trains for short trips.\n\nSources:\n- K1\n[K2] Leadership / Board plan\n- Knowledge/missing.md', '/nowhere');
    expect(r.text).toBe('Trains for short trips.');
    expect(r.kb).toEqual(['K1', 'K2']);
    expect(r.files).toEqual([]);
    expect(splitSources('No sources here.', '/nowhere')).toEqual({ text: 'No sources here.', files: [], kb: [] });
  });
});

describe('folders and paths', () => {
  const kbs = KB_ROWS.map(shapeKb);
  it('lists folder paths and one folder\'s names', () => {
    expect(folderPaths(kbs[0].folders)).toEqual(['Policies', 'Policies/Travel']);
    expect(folderNames(kbs[0].folders, 'F2')).toEqual(['Policies', 'Travel']);
    expect(folderNames(kbs[0].folders, null)).toEqual([]);
    expect(folderNames(kbs[0].folders, 'gone')).toEqual([]);
  });

  it('resolves "KB/folder/title" without case', () => {
    expect(resolvePath(kbs, 'handbook/policies/TRAVEL/Travel policy.md')).toMatchObject({ kb: { id: KB }, folderId: 'F2', name: 'Travel policy' });
    expect(resolvePath(kbs, 'Leadership/Board plan')).toMatchObject({ kb: { id: KB2 }, folderId: null, name: 'Board plan' });
    expect(resolvePath(kbs, 'Handbook').error).toMatch(/at least the KB and the note/);
    expect(resolvePath(kbs, 'Secret/x').error).toMatch(/No knowledge base named "Secret"/);
    expect(resolvePath(kbs, 'Handbook/Nope/x').error).toMatch(/No folder "Nope" in Handbook/);
  });
});

// a client that records rpc and table calls; rpc answers come from `answers`, table reads from `tables`
function fakeAccount({ answers = {}, tables = {}, state = { signedIn: true, workspace: { id: 'W', role: 'member' }, userId: 'u1' } } = {}) {
  const calls = [];
  const query = (table) => {
    const q = { table, filters: [] };
    const chain = {
      select: (cols) => { q.cols = cols; return chain; },
      eq: (k, v) => { q.filters.push(['eq', k, v]); return chain; },
      is: (k, v) => { q.filters.push(['is', k, v]); return chain; },
      not: (k, op, v) => { q.filters.push(['not', k, op, v]); return chain; },
      order: () => chain,
      range: () => { calls.push(['from', q]); return Promise.resolve({ data: tables[table]?.(q) ?? [], error: null }); },
      limit: () => { calls.push(['from', q]); return Promise.resolve({ data: tables[table]?.(q) ?? [], error: null }); },
    };
    return chain;
  };
  const client = {
    rpc: (name, args) => { calls.push(['rpc', name, args]); const a = answers[name]; return Promise.resolve(typeof a === 'function' ? a(args) : { data: a ?? null, error: null }); },
    from: query,
  };
  return { account: { client: () => client, state: () => state }, calls };
}
const has = (q, ...f) => q.filters.some((x) => JSON.stringify(x) === JSON.stringify(f));

describe('the calls each method makes', () => {
  it('searches as the signed-in person in their workspace, and falls back to any word', async () => {
    const { account, calls } = fakeAccount({ answers: { kb_search: (a) => ({ data: a.mode === 'any' ? [ROW] : [], error: null }) } });
    const kb = createKbSearch({ account });
    const r = await kb.search({ query: '  travel unicorn ', limit: 500 });
    expect(r.results.map((h) => h.noteId)).toEqual([N1]);
    expect(calls).toEqual([
      ['rpc', 'kb_search', { workspace_id: 'W', query: 'travel unicorn', only_kb: null, max_results: 50, mode: 'all' }],
      ['rpc', 'kb_search', { workspace_id: 'W', query: 'travel unicorn', only_kb: null, max_results: 50, mode: 'any' }],
    ]);
  });

  it('names a KB by name or id, and keeps an asked-for mode', async () => {
    const { account, calls } = fakeAccount({ answers: { kb_list: KB_ROWS, kb_search: [] } });
    const kb = createKbSearch({ account });
    await kb.search({ query: 'plan', kb: 'leadership', mode: 'all' });
    expect(calls.at(-1)).toEqual(['rpc', 'kb_search', { workspace_id: 'W', query: 'plan', only_kb: KB2, max_results: 8, mode: 'all' }]);
    expect(calls.filter((c) => c[1] === 'kb_search')).toHaveLength(1);
    await kb.search({ query: 'plan', kb: KB });
    expect(calls.at(-2)[2].only_kb).toBe(KB);
    expect((await kb.search({ query: 'plan', kb: 'Secret' })).error).toMatch(/No knowledge base named "Secret"/);
    expect((await kb.search({ query: '   ' })).error).toMatch(/at least one word/);
    expect((await kb.search({ query: 'x', mode: 'some' })).error).toMatch(/all or any/);
  });

  it('refuses plainly when signed out or with no workspace, and never calls the server', async () => {
    const out = fakeAccount({ state: { signedIn: false } });
    expect((await createKbSearch({ account: out.account }).search({ query: 'x' })).error).toBe('Sign in to Quorum first.');
    const none = fakeAccount({ state: { signedIn: true, workspace: null } });
    expect((await createKbSearch({ account: none.account }).list()).error).toBe('Pick a workspace in Quorum first.');
    expect(createKbSearch({ account: none.account }).available()).toBe(false);
    expect(await createKbSearch({ account: none.account }).forChat('anything')).toBeNull();
    expect([...out.calls, ...none.calls]).toEqual([]);
    expect((await createKbSearch({ account: { client: () => null, state: () => ({}) } }).search({ query: 'x' })).error).toMatch(/Quorum Cloud/);
  });

  it('turns a server failure into a plain sentence', async () => {
    const { account } = fakeAccount({ answers: { kb_search: () => ({ data: null, error: { message: 'relation "x" does not exist', code: '42P01' } }) } });
    const logged = [];
    expect(await createKbSearch({ account, log: (...a) => logged.push(a) }).search({ query: 'x' })).toEqual({ error: 'The knowledge bases could not be searched.' });
    expect(logged).toHaveLength(1);
  });

  it('gives chat the best few results in any-word mode, and nothing when the search fails', async () => {
    const { account, calls } = fakeAccount({ answers: { kb_search: [ROW] } });
    const c = await createKbSearch({ account }).forChat('What is the travel policy?');
    expect(calls).toEqual([['rpc', 'kb_search', { workspace_id: 'W', query: 'What is the travel policy?', only_kb: null, max_results: KB_CHAT.results, mode: 'any' }]]);
    expect(c.hits[0]).toMatchObject({ label: 'K1', noteId: N1 });
    const broken = fakeAccount({ answers: { kb_search: () => { throw new Error('offline'); } } });
    expect(await createKbSearch({ account: broken.account, log: () => {} }).forChat('x')).toBeNull();
  });

  it('reads a note by id through the notes table, KB notes only, with the body redacted', async () => {
    const note = { id: N1, kb_id: KB, folder_id: 'F2', path: 'handbook/travel.md', frontmatter: { title: 'Travel policy' }, body: 'Ask Acme first.', updated_at: 't' };
    const { account, calls } = fakeAccount({ answers: { kb_list: KB_ROWS }, tables: { notes: (q) => (has(q, 'eq', 'id', N1) ? [note] : []) } });
    const kb = createKbSearch({ account, redact: (s) => s.replace('Acme', '[withheld]') });
    const r = await kb.read({ id: N1 });
    expect(r.note).toEqual({ id: N1, kbId: KB, kbName: 'Handbook', folderId: 'F2', folderPath: ['Policies', 'Travel'], path: 'handbook/travel.md', title: 'Travel policy', body: 'Ask [withheld] first.', updatedAt: 't', link: kbLink(KB, N1), citation: 'Handbook / Policies / Travel / Travel policy' });
    const read = calls.find((c) => c[0] === 'from')[1];
    expect(read.table).toBe('notes');
    expect(has(read, 'eq', 'workspace_id', 'W') && has(read, 'not', 'kb_id', 'is', null) && has(read, 'is', 'deleted_at', null)).toBe(true);
    expect((await kb.read({ id: N2 })).error).toMatch(/No knowledge base note there/);
    expect((await kb.read({ id: 'x' })).error).toMatch(/26 letters/);
    expect((await kb.read({})).error).toMatch(/note id or a knowledge base path/);
  });

  it('a note whose KB is not in the readable list reads as missing', async () => {
    const own = { id: N1, kb_id: '01KB00000000000000000000K9', folder_id: null, path: 'mine.md', frontmatter: {}, body: 'mine', updated_at: 't' };
    const { account } = fakeAccount({ answers: { kb_list: KB_ROWS }, tables: { notes: () => [own] } });
    expect((await createKbSearch({ account }).read({ id: N1 })).error).toMatch(/No knowledge base note there/);
  });

  it('reads a note by "KB/folder/title", in that folder only', async () => {
    const listed = [{ id: N2, path: 'other.md', frontmatter: { title: 'Other' } }, { id: N1, path: 'handbook/travel.md', frontmatter: { title: 'Travel policy' } }];
    const note = { id: N1, kb_id: KB, folder_id: 'F2', path: 'handbook/travel.md', frontmatter: { title: 'Travel policy' }, body: 'Trains.', updated_at: 't' };
    const { account, calls } = fakeAccount({
      answers: { kb_list: KB_ROWS },
      tables: { notes: (q) => (q.cols === 'id, path, frontmatter' ? listed : has(q, 'eq', 'id', N1) ? [note] : []) },
    });
    const r = await createKbSearch({ account }).read({ path: 'Handbook/Policies/Travel/travel policy' });
    expect(r.note.id).toBe(N1);
    const listing = calls.map((c) => c[1]).find((q) => q.cols === 'id, path, frontmatter');
    expect(has(listing, 'eq', 'kb_id', KB) && has(listing, 'eq', 'folder_id', 'F2')).toBe(true);
  });

  it('lists readable KBs with folder paths', async () => {
    const { account } = fakeAccount({ answers: { kb_list: KB_ROWS } });
    expect(await createKbSearch({ account }).list()).toEqual({ kbs: [
      { id: KB, name: 'Handbook', kind: 'general', role: 'reader', isDefault: true, folders: ['Policies', 'Policies/Travel'] },
      { id: KB2, name: 'Leadership', kind: 'general', role: 'admin', isDefault: false, folders: [] },
    ] });
  });

  it('routes the control socket commands', async () => {
    const seen = [];
    const kb = { search: (a) => seen.push(['search', a]), read: (a) => seen.push(['read', a]), list: () => seen.push(['list']) };
    runKbCommand(kb, 'kb_search', { query: 'q', kb: 'Handbook' });
    runKbCommand(kb, 'kb_read', { path: 'Handbook/x' });
    runKbCommand(kb, 'kb_list');
    expect(seen).toEqual([['search', { query: 'q', kb: 'Handbook', limit: 8, mode: null }], ['read', { id: null, path: 'Handbook/x' }], ['list']]);
    expect(await runKbCommand(kb, 'kb_write')).toEqual({ error: 'Unknown command kb_write' });
  });
});
