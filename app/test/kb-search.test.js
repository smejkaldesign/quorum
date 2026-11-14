// Knowledge base search (ee/kbSearch.js): result shaping, redaction, citations, the chat's context block and source
// cards, path resolution, and the calls each method makes. The server's rights are tested in
// supabase/tests/kb_search.sql; here a fake client records calls and answers with canned rows.
import { describe, expect, it } from 'vitest';
import { splitSources } from '../agent.js';

const { KB_CHAT, chatContext, citation, createKbSearch, folderNames, folderPaths, kbLink, kbPlace, kbSources, parseKbLink, pickByName, resolvePath, runKbCommand, shapeHit } = await import('../ee/kbSearch.js');
const { shapeKb } = await import('../ee/knowledgeBases.js');

const KB = '01KB00000000000000000000K1';
const KB2 = '01KB00000000000000000000K2';
const N1 = '01KB000000000000000000N001';
const N2 = '01KB000000000000000000N002';
const N3 = '01KB000000000000000000N003';
const ROW = { note_id: N1, kb_id: KB, kb_name: 'Handbook', folder_id: 'F2', folder_path: ['Policies', 'Travel'], path: 'handbook/travel.md', title: 'Travel policy', snippet: 'The per diem\ncovers  meals', rank: 0.4, user_id: 'u1', updated_at: '2026-11-01T10:00:00Z' };
const KB_ROWS = [
  { id: KB, name: 'Handbook', kind: 'general', is_default: true, role: 'reader', folders: [{ id: 'F1', parent_id: null, name: 'Policies', position: 0 }, { id: 'F2', parent_id: 'F1', name: 'Travel', position: 0 }], access: null },
  { id: KB2, name: 'Leadership', kind: 'general', is_default: false, role: 'admin', folders: [], access: [] },
];
// the app's redactor works line by line (suggest.js redactLines): a line naming an opted-out customer is replaced whole
const WITHHELD = '[withheld: opted-out customer]';
const redact = (t) => String(t).split('\n').map((l) => (/acme/i.test(l) ? WITHHELD : l)).join('\n');

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

  it('withholds an opted-out name wherever it shows: KB, folder, path, file name, title and snippet', () => {
    const h = shapeHit({ ...ROW, kb_name: 'Acme rollout', folder_path: ['Customers', 'Acme'], path: 'customers/acme-renewal.md', title: '', snippet: 'met with Acme about it' }, redact);
    expect(h).toMatchObject({ kbName: WITHHELD, folderPath: ['Customers', WITHHELD], path: WITHHELD, title: WITHHELD, snippet: WITHHELD });
    expect(h.citation).toBe(`${WITHHELD} / Customers / ${WITHHELD} / ${WITHHELD}`);
    expect(JSON.stringify(h)).not.toMatch(/acme/i);
    const { hits } = chatContext([h]);
    expect(chatContext([h]).block).not.toMatch(/acme/i);
    expect(JSON.stringify(kbSources(['K1'], hits))).not.toMatch(/acme/i);
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

  it('shows a body in place of its snippet, cut to the body excerpt, and still within the total', () => {
    const withBody = { ...hits[0], body: 'x'.repeat(5000) };
    const c = chatContext([withBody, { ...hits[1], body: 'y'.repeat(5000) }, hits[1]]);
    const first = c.block.split('\n\n')[0].split('\n')[1];
    expect(first.length).toBe(KB_CHAT.bodyExcerpt);
    expect(c.block.length).toBeLessThanOrEqual(KB_CHAT.total);
    expect(c.hits.map((h) => h.label)).toEqual(['K1', 'K2', 'K3']);
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

  it('resolves "KB/folder/title" without case, and names only what was typed when it cannot', () => {
    expect(resolvePath(kbs, 'handbook/policies/TRAVEL/Travel policy.md')).toMatchObject({ kb: { id: KB }, folderId: 'F2', name: 'Travel policy' });
    expect(resolvePath(kbs, 'Leadership/Board plan')).toMatchObject({ kb: { id: KB2 }, folderId: null, name: 'Board plan' });
    expect(resolvePath(kbs, 'Handbook').error).toMatch(/at least the KB and the note/);
    expect(resolvePath(kbs, 'Secret/x').error).toMatch(/No knowledge base named "Secret"/);
    expect(resolvePath(kbs, 'Handbook/Nope/x').error).toBe('No folder "Nope" on that path.');
  });

  it('picks a note by title before file name, the first in path order', () => {
    const rows = [{ id: 'a', path: 'a/plan.md', frontmatter: { title: 'Other' } }, { id: 'b', path: 'b/x.md', frontmatter: { title: 'Plan' } }, { id: 'c', path: 'c/x.md', frontmatter: { title: 'plan' } }];
    expect(pickByName(rows, 'plan').id).toBe('b');
    expect(pickByName(rows.slice(0, 1), 'plan').id).toBe('a');
    expect(pickByName(rows, 'missing')).toBeNull();
  });
});

// a client that records rpc and table calls. rpc answers come from `answers` (data, or a function returning
// { data, error }); table reads return `tables[table]` rows that pass the eq, in and is filters, ordered as asked
function fakeAccount({ answers = {}, tables = {}, state = { signedIn: true, workspace: { id: 'W', role: 'member' }, userId: 'u1' } } = {}) {
  const calls = [];
  const query = (table) => {
    const q = { table, filters: [], orders: [] };
    const result = () => {
      calls.push(['from', q]);
      let rows = (tables[table] ?? []).filter((r) => q.filters.every(([op, k, v]) => (op === 'eq' ? r[k] === v : op === 'in' ? v.includes(r[k]) : op === 'is' ? (r[k] ?? null) === v : true)));
      for (const [k, asc] of [...q.orders].reverse()) rows = [...rows].sort((a, b) => String(a[k]).localeCompare(String(b[k])) * (asc ? 1 : -1));
      return rows;
    };
    const chain = {
      select: (cols) => { q.cols = cols; return chain; },
      eq: (k, v) => { q.filters.push(['eq', k, v]); return chain; },
      in: (k, v) => { q.filters.push(['in', k, v]); return chain; },
      is: (k, v) => { q.filters.push(['is', k, v]); return chain; },
      order: (k, o = {}) => { q.orders.push([k, o.ascending !== false]); return chain; },
      range: (a, b) => Promise.resolve({ data: result().slice(a, b + 1), error: null }),
      limit: (n) => Promise.resolve({ data: result().slice(0, n), error: null }),
      then: (ok, bad) => Promise.resolve({ data: result(), error: null }).then(ok, bad),
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
const NOTE = { id: N1, kb_id: KB, folder_id: 'F2', path: 'handbook/travel.md', frontmatter: { title: 'Travel policy' }, body: 'Ask Acme first.\nThen book.', updated_at: '2026-11-02', workspace_id: 'W', deleted_at: null };

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

  it('refuses with the same sentences as the rest of the KB calls, and never calls the server', async () => {
    const out = fakeAccount({ state: { signedIn: false } });
    expect((await createKbSearch({ account: out.account }).search({ query: 'x' })).error).toBe('Sign in first.');
    const none = fakeAccount({ state: { signedIn: true, workspace: null } });
    expect((await createKbSearch({ account: none.account }).list()).error).toBe('Pick a workspace first.');
    expect(createKbSearch({ account: none.account }).available()).toBe(false);
    expect(await createKbSearch({ account: none.account }).forChat('anything')).toBeNull();
    expect([...out.calls, ...none.calls]).toEqual([]);
    expect((await createKbSearch({ account: { client: () => null, state: () => ({}) } }).search({ query: 'x' })).error).toBe('Hosted accounts are not set up in this build.');
  });

  it('turns a server failure into a plain sentence', async () => {
    const { account } = fakeAccount({ answers: { kb_search: () => ({ data: null, error: { message: 'relation "x" does not exist', code: '42P01' } }) } });
    const logged = [];
    expect(await createKbSearch({ account, log: (...a) => logged.push(a) }).search({ query: 'x' })).toEqual({ error: 'The knowledge bases could not be searched.' });
    expect(logged).toEqual([['kb search', 'relation "x" does not exist']]);
  });

  it('gives chat the best few results in any-word mode, passages only when they are long enough', async () => {
    const long = { ...ROW, snippet: 'p'.repeat(400) };
    const { account, calls } = fakeAccount({ answers: { kb_search: [long] }, tables: { notes: [NOTE] } });
    const c = await createKbSearch({ account }).forChat('What is the travel policy?');
    expect(calls).toEqual([['rpc', 'kb_search', { workspace_id: 'W', query: 'What is the travel policy?', only_kb: null, max_results: KB_CHAT.results, mode: 'any' }]]);
    expect(c.hits[0]).toMatchObject({ label: 'K1', noteId: N1 });
    expect(c.hits[0].body).toBeUndefined();
    const broken = fakeAccount({ answers: { kb_search: () => { throw new Error('offline'); } } });
    expect(await createKbSearch({ account: broken.account, log: () => {} }).forChat('x')).toBeNull();
  });

  it('reads the top bodies, redacted, when the passages are short', async () => {
    const n2 = { ...NOTE, id: N2, kb_id: KB2, body: 'Second body.' };
    const n3 = { ...NOTE, id: N3, body: 'Third body.' };
    const rows = [ROW, { ...ROW, note_id: N2, kb_id: KB2 }, { ...ROW, note_id: N3 }];
    const { account, calls } = fakeAccount({ answers: { kb_search: rows }, tables: { notes: [NOTE, n2, n3] } });
    const c = await createKbSearch({ account, redact }).forChat('travel');
    expect(c.hits.map((h) => h.body ?? null)).toEqual([`${WITHHELD}\nThen book.`, 'Second body.', null]);
    expect(c.block).not.toMatch(/acme/i);
    const read = calls.find((x) => x[0] === 'from')[1];
    expect(has(read, 'in', 'id', [N1, N2]) && has(read, 'in', 'kb_id', [KB, KB2]) && has(read, 'is', 'deleted_at', null)).toBe(true);
  });

  it('reads a note by id among the readable KBs, with every name and the body redacted', async () => {
    const acme = { ...NOTE, path: 'customers/acme.md', frontmatter: {} };
    const { account, calls } = fakeAccount({ answers: { kb_list: KB_ROWS }, tables: { notes: [acme] } });
    const kb = createKbSearch({ account, redact });
    const r = await kb.read({ id: N1 });
    expect(r.note).toEqual({ id: N1, kbId: KB, kbName: 'Handbook', folderId: 'F2', folderPath: ['Policies', 'Travel'], path: WITHHELD, title: WITHHELD, body: `${WITHHELD}\nThen book.`, updatedAt: '2026-11-02', link: kbLink(KB, N1), citation: `Handbook / Policies / Travel / ${WITHHELD}` });
    const read = calls.find((c) => c[0] === 'from')[1];
    expect(read.table).toBe('notes');
    expect(has(read, 'eq', 'workspace_id', 'W') && has(read, 'in', 'kb_id', [KB, KB2]) && has(read, 'is', 'deleted_at', null)).toBe(true);
    expect((await kb.read({ id: N2 })).error).toMatch(/No knowledge base note there/);
    expect((await kb.read({ id: 'x' })).error).toMatch(/26 letters/);
    expect((await kb.read({})).error).toMatch(/note id or a knowledge base path/);
  });

  it('a note in a KB the caller cannot read reads as missing, by id and by path', async () => {
    const elsewhere = { ...NOTE, kb_id: '01KB00000000000000000000K9' };
    const { account } = fakeAccount({ answers: { kb_list: KB_ROWS }, tables: { notes: [elsewhere] } });
    const kb = createKbSearch({ account });
    expect((await kb.read({ id: N1 })).error).toMatch(/No knowledge base note there/);
    expect((await kb.read({ path: 'handbook/travel.md' })).error).toMatch(/No knowledge base note there/);
    const nothing = fakeAccount({ answers: { kb_list: [] }, tables: { notes: [NOTE] } });
    expect((await createKbSearch({ account: nothing.account }).read({ id: N1 })).error).toMatch(/No knowledge base note there/);
  });

  it('reads by the note\'s own path first, the newest when two match', async () => {
    const older = { ...NOTE, id: N2, updated_at: '2026-10-01' };
    const { account } = fakeAccount({ answers: { kb_list: KB_ROWS }, tables: { notes: [older, NOTE] } });
    expect((await createKbSearch({ account }).read({ path: 'handbook/travel.md' })).note.id).toBe(N1);
  });

  it('reads by "KB/folder/title", in that folder only, falling back to the file name', async () => {
    const other = { ...NOTE, id: N2, path: 'handbook/other.md', frontmatter: { title: 'Other' } };
    const top = { ...NOTE, id: N3, folder_id: null, path: 'handbook/travel-top.md', frontmatter: { title: 'Travel policy' } };
    const { account, calls } = fakeAccount({ answers: { kb_list: KB_ROWS }, tables: { notes: [other, NOTE, top] } });
    const kb = createKbSearch({ account });
    expect((await kb.read({ path: 'Handbook/Policies/Travel/travel policy' })).note.id).toBe(N1);
    const listing = calls.map((c) => c[1]).find((q) => q?.cols === 'id, path, frontmatter');
    expect(has(listing, 'in', 'kb_id', [KB]) && has(listing, 'eq', 'folder_id', 'F2')).toBe(true);
    expect((await kb.read({ path: 'Handbook/Policies/Travel/other' })).note.id).toBe(N2);
    expect((await kb.read({ path: 'Handbook/Travel policy' })).note.id).toBe(N3);
    expect((await kb.read({ path: 'Handbook/Policies/Travel/nothing' })).error).toMatch(/No knowledge base note there/);
  });

  it('lists readable KBs with folder paths, names redacted', async () => {
    const rows = [KB_ROWS[0], { ...KB_ROWS[1], name: 'Acme deal', folders: [{ id: 'F9', parent_id: null, name: 'Acme', position: 0 }] }];
    const { account } = fakeAccount({ answers: { kb_list: rows } });
    expect(await createKbSearch({ account, redact }).list()).toEqual({ kbs: [
      { id: KB, name: 'Handbook', kind: 'general', role: 'reader', isDefault: true, folders: ['Policies', 'Policies/Travel'] },
      { id: KB2, name: WITHHELD, kind: 'general', role: 'admin', isDefault: false, folders: [WITHHELD] },
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
