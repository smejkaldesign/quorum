// Importing a knowledge base from a GitHub repository or a zip (ee/kbImport.js, ee/zipRead.js, migration 0026).
// Fixture zips are built here byte by byte, so the tests can also make the hostile ones (paths that leave the archive,
// symbolic links, too many files). GitHub and the database are fakes; nothing reaches the network.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';

const home = mkdtempSync(path.join(tmpdir(), 'quorum-kbimport-home-'));
process.env.HOME = home;
const { createKbImport, fetchGithubZip, parseGithubUrl, readArchive, sharedText, PRIVATE_REPO } = await import('../ee/kbImport.js');
const { listZip, readEntry, safeEntryPath } = await import('../ee/zipRead.js');
const { shapeKb } = await import('../ee/knowledgeBases.js');
const { notes: localNotes } = await import('../store/local.js');

afterAll(() => rmSync(home, { recursive: true, force: true }));

// a zip of { name, data?, symlink?, deflate?, encrypted? } entries; a name ending in "/" is a folder
const crc32 = (b) => zlib.crc32(b) >>> 0;
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = Buffer.from(e.data ?? '', 'utf8');
    const method = e.deflate === false || !data.length ? 0 : 8;
    const body = method === 8 ? zlib.deflateRawSync(data) : data;
    const crc = crc32(data);
    const flags = 0x800 | (e.encrypted ? 1 : 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    const mode = e.symlink ? 0o120777 : e.name.endsWith('/') ? 0o040755 : 0o100644;
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE((3 << 8) | 20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(flags, 8); central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((mode << 16) | (e.name.endsWith('/') ? 0x10 : 0)) >>> 0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const HANDBOOK = [
  { name: 'handbook-main/' },
  { name: 'handbook-main/README.md', data: '# Handbook\n\nStart here.' },
  { name: 'handbook-main/guides/' },
  { name: 'handbook-main/guides/onboarding.md', data: '---\ntitle: Onboarding\nvisibility: private\n---\n# Onboarding' },
  { name: 'handbook-main/guides/deep/nested/setup.markdown', data: '# Setup', deflate: false },
  { name: 'handbook-main/guides/logo.png', data: 'PNG' },
  { name: 'handbook-main/src/index.js', data: 'console.log(1)' },
  { name: 'handbook-main/.github/notes.md', data: '# hidden' },
  { name: 'handbook-main/__MACOSX/._README.md', data: 'fork' },
  { name: 'handbook-main/link.md', data: 'README.md', symlink: true },
  { name: 'handbook-main/secret.md', data: '---\nconfidential: true\n---\n# Secret' },
];

describe('zip reading', () => {
  it('lists entries and reads stored and deflated ones', () => {
    const buf = makeZip(HANDBOOK);
    const entries = listZip(buf);
    expect(entries.map((e) => e.path)).toContain('handbook-main/guides/deep/nested/setup.markdown');
    const readme = entries.find((e) => e.path === 'handbook-main/README.md');
    expect(readEntry(buf, readme).toString()).toBe('# Handbook\n\nStart here.');
    expect(entries.find((e) => e.path === 'handbook-main/link.md').symlink).toBe(true);
  });

  it('refuses paths that leave the archive', () => {
    expect(safeEntryPath('a/./b//c.md')).toBe('a/b/c.md');
    expect(safeEntryPath('../evil.md')).toBeNull();
    expect(safeEntryPath('/etc/passwd')).toBeNull();
    expect(safeEntryPath('C:\\Windows\\x.md')).toBeNull();
    expect(safeEntryPath('a\\..\\..\\x.md')).toBeNull();
    expect(() => listZip(makeZip([{ name: 'ok.md', data: '#' }, { name: 'docs/../../evil.md', data: '#' }]))).toThrow(/outside/);
    expect(() => listZip(makeZip([{ name: '/abs.md', data: '#' }]))).toThrow(/outside/);
  });

  it('caps the file count and the uncompressed size, and refuses what is not a zip', () => {
    expect(() => listZip(makeZip([{ name: 'a.md' }, { name: 'b.md' }, { name: 'c.md' }]), { maxEntries: 2 })).toThrow(/more than 2 files/);
    expect(() => listZip(makeZip([{ name: 'a.md', data: 'x'.repeat(5000) }]), { maxBytes: 4000 })).toThrow(/MB/);
    expect(() => listZip(Buffer.from('not a zip at all, just some text that is long enough'))).toThrow(/not a zip/);
  });

  it('notices a damaged entry', () => {
    const buf = makeZip([{ name: 'a.md', data: 'hello world', deflate: false }]);
    const entry = listZip(buf)[0];
    buf[30 + 4] = 'X'.charCodeAt(0);
    expect(() => readEntry(buf, entry)).toThrow(/damaged/);
  });
});

describe('what an archive becomes', () => {
  it('keeps markdown, names every other file, and passes over dot files and resource forks', () => {
    const { files, skipped } = readArchive(makeZip(HANDBOOK));
    expect(files.map((f) => f.rel).sort()).toEqual(['README.md', 'guides/deep/nested/setup.markdown', 'guides/onboarding.md', 'secret.md']);
    expect(skipped).toEqual(expect.arrayContaining([
      { path: 'guides/logo.png', reason: 'Only markdown files are imported.' },
      { path: 'src/index.js', reason: 'Only markdown files are imported.' },
      { path: 'link.md', reason: 'Symbolic links are not imported.' },
    ]));
    expect(skipped.some((s) => s.path.includes('.github') || s.path.includes('__MACOSX'))).toBe(false);
  });

  it('keeps the top folder when the archive has files beside it', () => {
    const { files } = readArchive(makeZip([{ name: 'top.md', data: '#' }, { name: 'docs/a.md', data: '#' }]));
    expect(files.map((f) => f.rel).sort()).toEqual(['docs/a.md', 'top.md']);
  });

  it('skips encrypted entries', () => {
    const { files, skipped } = readArchive(makeZip([{ name: 'a.md', data: '#', encrypted: true, deflate: false }]));
    expect(files).toEqual([]);
    expect(skipped).toEqual([{ path: 'a.md', reason: 'The file is encrypted.' }]);
  });

  it('fills an empty frontmatter block instead of adding a second one', () => {
    expect(localNotes.setFrontmatterKey('---\n---\nBody\n---\nx', 'visibility', 'public')).toBe('---\nvisibility: public\n---\nBody\n---\nx');
    expect(localNotes.setFrontmatterKey('---\n---', 'a', 'b')).toBe('---\na: b\n---');
    expect(localNotes.setFrontmatterKey('---\ntitle: T\n---\nB', 'title', '$& x')).toBe('---\ntitle: $& x\n---\nB');
    expect(sharedText('---\n---\n# Doc', 'a.zip/doc.md')).toBe('---\nvisibility: public\nkb_source: a.zip/doc.md\n---\n# Doc');
  });

  it('marks every note shared and says where it came from', () => {
    expect(sharedText('# Plain', 'https://github.com/o/r/blob/main/a.md')).toBe('---\nvisibility: public\nkb_source: https://github.com/o/r/blob/main/a.md\n---\n# Plain');
    expect(sharedText('x: 1', 'a: b #c')).toBe('---\nvisibility: public\nkb_source: "a: b #c"\n---\nx: 1');
    expect(sharedText('---\r\ntitle: T\r\nvisibility: private\r\n---\r\nBody', 'Team docs.zip/a.md')).toBe('---\ntitle: T\nvisibility: public\nkb_source: Team docs.zip/a.md\n---\nBody');
  });
});

describe('GitHub addresses', () => {
  it('takes a repository address and an optional branch', () => {
    expect(parseGithubUrl('https://github.com/example-org/handbook')).toEqual({ owner: 'example-org', repo: 'handbook', branch: null, tree: null, url: 'https://github.com/example-org/handbook' });
    expect(parseGithubUrl('https://github.com/example-org/handbook.git/', 'release/v2')).toMatchObject({ repo: 'handbook', branch: 'release/v2', tree: null });
    expect(parseGithubUrl('https://github.com/example-org/handbook/tree/release/v2/docs/guides')).toMatchObject({ branch: null, tree: 'release/v2/docs/guides' });
    expect(parseGithubUrl('https://github.com/example-org/handbook/tree/main/Team%20docs/')).toMatchObject({ tree: 'main/Team docs' });
    expect(parseGithubUrl('https://github.com/example-org/handbook/tree/main', 'main')).toMatchObject({ branch: 'main', tree: 'main' });
    expect(parseGithubUrl('https://github.com/example-org/handbook/tree/main/../x').error).toBeTruthy();
    expect(parseGithubUrl('https://github.com/example-org/handbook/tree/main//x').error).toBeTruthy();
  });

  it('refuses anything else', () => {
    for (const bad of ['http://github.com/a/b', 'https://gitlab.com/a/b', 'https://github.com/a', 'https://github.com/a/b/blob/main/x.md', 'ssh://github.com/a/b.git', 'https://github.com/-a/b', 'https://github.com/a/b?x=1', 'https://github.com/a/..', 'https://github.com.example.com/a/b']) {
      expect(parseGithubUrl(bad).error, bad).toBeTruthy();
    }
    expect(parseGithubUrl('').error).toMatch(/address/);
    expect(parseGithubUrl('https://github.com/a/b', '../main').error).toMatch(/branch/);
    expect(parseGithubUrl('https://github.com/a/b', '-x').error).toMatch(/branch/);
  });
});

// a fetch that answers the GitHub API and codeload from a table
function fakeGithub({ api = { status: 200, json: { default_branch: 'main', private: false } }, zips = {}, branches = ['main'] } = {}) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    const refs = url.match(/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/git\/matching-refs\/heads\/(.+)$/);
    if (refs) { const first = decodeURIComponent(refs[1]); return { status: 200, ok: true, json: async () => branches.filter((b) => b.startsWith(first)).map((b) => ({ ref: `refs/heads/${b}` })) }; }
    if (url.startsWith('https://api.github.com/')) return { status: api.status, ok: api.status < 300, json: async () => api.json };
    const ref = url.replace(/^https:\/\/codeload\.github\.com\/[^/]+\/[^/]+\/zip\//, '');
    const z = zips[decodeURIComponent(ref)];
    if (!z) return { status: 404, ok: false };
    return { status: 200, ok: true, headers: { get: () => String(z.length) }, arrayBuffer: async () => z.buffer.slice(z.byteOffset, z.byteOffset + z.length) };
  };
  return { fetch, calls };
}

describe('fetching from GitHub', () => {
  it('reads the default branch and fetches its archive without credentials', async () => {
    const zip = makeZip(HANDBOOK);
    const gh = fakeGithub({ zips: { main: zip } });
    const r = await fetchGithubZip({ owner: 'o', repo: 'r', branch: null }, { fetch: gh.fetch });
    expect(r.branch).toBe('main');
    expect(r.buf.equals(zip)).toBe(true);
    expect(gh.calls).toEqual(['https://api.github.com/repos/o/r', 'https://codeload.github.com/o/r/zip/main']);
  });

  it('says a private repository needs the connector, and names a missing branch', async () => {
    await expect(fetchGithubZip({ owner: 'o', repo: 'r' }, { fetch: fakeGithub({ api: { status: 404 } }).fetch })).rejects.toThrow(PRIVATE_REPO);
    await expect(fetchGithubZip({ owner: 'o', repo: 'r', branch: 'nope' }, { fetch: fakeGithub().fetch })).rejects.toThrow(/branch nope was not found/);
    await expect(fetchGithubZip({ owner: 'o', repo: 'r' }, { fetch: fakeGithub({ api: { status: 403 } }).fetch })).rejects.toThrow(/limiting/);
    await expect(fetchGithubZip({ owner: 'o', repo: 'r' }, { fetch: async () => { throw new Error('offline'); } })).rejects.toThrow(/could not be reached/);
  });

  it('refuses an archive past the size cap from its declared length', async () => {
    const fetch = async (url) => (url.includes('api.github.com') ? { status: 200, ok: true, json: async () => ({ default_branch: 'main' }) } : { status: 200, ok: true, headers: { get: () => String(500 * 1024 * 1024) }, arrayBuffer: async () => new ArrayBuffer(0) });
    await expect(fetchGithubZip({ owner: 'o', repo: 'r' }, { fetch })).rejects.toThrow(/larger than 200 MB/);
  });
});

// a Supabase client fake: KBs and folders kept in memory, kb_* RPCs acting on them, and a notes table that takes
// upserts and answers the KB notes read
function fakeServer({ role = 'admin', notes = [], kbs = [], folderFail = null, sourceSet = true, profiles = [] } = {}) {
  const state = { kbs: kbs.map((k) => ({ folders: [], source: null, role: 'admin', ...k })), notes: notes.map((n) => ({ ...n })), calls: [] };
  let seq = 0;
  const id = (p) => `${p}${String(++seq).padStart(4, '0')}`;
  const answer = (data, error = null) => ({ data, error });
  const rpc = async (name, args) => {
    state.calls.push([name, args]);
    if (name === 'kb_list') return answer(state.kbs.map((k) => structuredClone(k)));
    if (name === 'kb_create') {
      if (state.kbs.some((k) => k.name.toLowerCase() === args.name.toLowerCase())) return answer(null, { message: 'A knowledge base with that name already exists', code: 'P0001' });
      const kb = { id: id('KB'), workspace_id: args.workspace_id, name: args.name, kind: args.kind, folders: [], source: null, role: 'admin' };
      state.kbs.push(kb);
      return answer(structuredClone(kb));
    }
    if (name === 'kb_delete') { state.kbs = state.kbs.filter((k) => k.id !== args.kb_id); return answer(null); }
    if (name === 'kb_folder_create') {
      if (folderFail && args.name === folderFail) return answer(null, { message: 'That folder name is taken', code: 'P0001' });
      const kb = state.kbs.find((k) => k.id === args.kb_id);
      const f = { id: id('F'), kb_id: kb.id, parent_id: args.parent_id, name: args.name, position: 0 };
      kb.folders.push({ id: f.id, parent_id: f.parent_id, name: f.name, position: 0 });
      return answer(f);
    }
    if (name === 'kb_source_set') {
      if (!sourceSet) return answer(null, { message: 'Could not find the function public.kb_source_set', code: 'PGRST202' });
      const kb = state.kbs.find((k) => k.id === args.kb_id);
      kb.source = { ...args.source, imported_at: 't' };
      return answer(structuredClone(kb));
    }
    return answer(null, { message: `unknown rpc ${name}` });
  };
  const from = (table) => {
    const ops = [];
    const b = {};
    for (const op of ['select', 'eq', 'is', 'order', 'range', 'limit', 'neq', 'gt', 'in', 'like']) b[op] = (...a) => { ops.push([op, ...a]); return b; };
    b.upsert = (rows) => { ops.push(['upsert', rows]); return b; };
    b.update = (patch) => { ops.push(['update', patch]); return b; };
    b.then = (res, rej) => {
      if (table === 'profiles') {
        const ids = ops.find((o) => o[0] === 'in')?.[2] ?? [];
        return Promise.resolve({ data: profiles.filter((p) => ids.includes(p.user_id)), error: null }).then(res, rej);
      }
      const upd = ops.find((o) => o[0] === 'update');
      if (upd) {
        const ids = ops.find((o) => o[0] === 'in')?.[2] ?? [];
        for (const n of state.notes) if (ids.includes(n.id)) Object.assign(n, upd[1]);
        state.calls.push([`update:${table}`, ids.length]);
        return Promise.resolve({ data: [], error: null }).then(res, rej);
      }
      const up = ops.find((o) => o[0] === 'upsert');
      if (up) {
        for (const r of up[1]) {
          const clash = state.notes.find((n) => n.path === r.path && n.id !== r.id && !n.deleted_at);
          if (clash) return Promise.resolve({ data: null, error: { message: 'duplicate key value violates unique constraint "notes_workspace_path"' } }).then(res, rej);
        }
        for (const r of up[1]) {
          const i = state.notes.findIndex((n) => n.id === r.id);
          if (i >= 0) state.notes[i] = { ...state.notes[i], ...r }; else state.notes.push({ ...r });
        }
        state.calls.push([`upsert:${table}`, up[1].length]);
        return Promise.resolve({ data: [], error: null }).then(res, rej);
      }
      const kbId = ops.find((o) => o[0] === 'eq' && o[1] === 'kb_id')?.[2];
      const [, lo, hi] = ops.find((o) => o[0] === 'range') ?? [null, 0, 999];
      const rows = state.notes.filter((n) => n.kb_id === kbId && !n.deleted_at).slice(lo, hi + 1);
      return Promise.resolve({ data: rows, error: null }).then(res, rej);
    };
    return b;
  };
  const account = { client: () => ({ rpc, from }), state: () => ({ signedIn: true, userId: 'me', workspace: { id: 'W', role } }) };
  return { state, account };
}

function importer(server, { zips = {}, gh = fakeGithub({ zips }), files = {} } = {}) {
  const events = [];
  const k = createKbImport({
    account: server.account, fetch: gh.fetch, toUI: (ch, p) => events.push([ch, p]),
    readFile: async (p) => { if (!files[p]) throw new Error('ENOENT'); return files[p]; },
    statFile: async (p) => { if (!files[p]) throw new Error('ENOENT'); return { size: files[p].length }; },
    pickZip: async () => '/tmp/quorum-kb/Team docs.zip',
  });
  return { ...k, events, gh };
}

describe('kb-import', () => {
  it('creates a KB from a GitHub repository with nested folders and shared notes', async () => {
    const server = fakeServer();
    const k = importer(server, { zips: { main: makeZip(HANDBOOK) } });
    const r = await k.handlers['kb-import']({ source: { kind: 'github', url: 'https://github.com/example-org/handbook' } });
    expect(r.error).toBeUndefined();
    expect(r.imported).toBe(3);
    expect(r.kb).toMatchObject({ name: 'handbook', source: { kind: 'github', url: 'https://github.com/example-org/handbook', branch: null, name: 'handbook' } });
    const names = (nodes) => nodes.map((n) => [n.name, names(n.children)]);
    expect(names(r.kb.folders)).toEqual([['guides', [['deep', [['nested', []]]]]]]);
    expect(r.skipped).toEqual(expect.arrayContaining([{ path: 'secret.md', reason: 'The note is marked confidential.' }, { path: 'src/index.js', reason: 'Only markdown files are imported.' }]));

    const kb = server.state.kbs[0];
    const folderOf = (n) => kb.folders.find((f) => f.id === n.folder_id)?.name ?? null;
    const byPath = Object.fromEntries(server.state.notes.map((n) => [n.path, n]));
    expect(Object.keys(byPath).sort()).toEqual(['Knowledge bases/handbook/README.md', 'Knowledge bases/handbook/guides/deep/nested/setup.md', 'Knowledge bases/handbook/guides/onboarding.md']);
    const onboarding = byPath['Knowledge bases/handbook/guides/onboarding.md'];
    expect(onboarding).toMatchObject({ kb_id: kb.id, frontmatter: { title: 'Onboarding', visibility: 'public', kb_source: 'https://github.com/example-org/handbook/blob/main/guides/onboarding.md' } });
    expect(onboarding.body).toMatch(/^---\ntitle: Onboarding\nvisibility: public\n/);
    expect(folderOf(onboarding)).toBe('guides');
    expect(folderOf(byPath['Knowledge bases/handbook/guides/deep/nested/setup.md'])).toBe('nested');
    expect(byPath['Knowledge bases/handbook/README.md'].folder_id).toBeNull();

    const phases = k.events.filter(([ch]) => ch === 'kb-import-progress').map(([, p]) => p);
    expect(new Set(phases.map((p) => p.kbId))).toEqual(new Set([kb.id]));
    expect([...new Set(phases.map((p) => p.phase))]).toEqual(['fetching', 'reading', 'writing', 'done']);
    expect(phases.at(-1)).toEqual({ kbId: kb.id, phase: 'done', done: 3, total: 3 });
  });

  it('updates notes by their place on a second import and adds none twice', async () => {
    const server = fakeServer();
    const k = importer(server, { zips: { main: makeZip(HANDBOOK) } });
    const first = await k.handlers['kb-import']({ name: 'Handbook', source: { kind: 'github', url: 'https://github.com/example-org/handbook' } });
    const ids = server.state.notes.map((n) => n.id).sort();
    const changed = HANDBOOK.map((e) => (e.name.endsWith('README.md') ? { ...e, data: '# Handbook\n\nUpdated.' } : e));
    const k2 = importer(server, { zips: { main: makeZip([...changed, { name: 'handbook-main/guides/new.md', data: '# New' }]) } });
    const again = await k2.handlers['kb-import']({ kbId: first.kb.id });
    expect(again.error).toBeUndefined();
    expect(again.imported).toBe(4);
    expect(server.state.notes).toHaveLength(4);
    expect(server.state.notes.map((n) => n.id).filter((i) => ids.includes(i)).sort()).toEqual(ids);
    expect(server.state.notes.find((n) => n.path.endsWith('README.md')).body).toMatch(/Updated\./);
    expect(server.state.kbs[0].folders.filter((f) => f.name === 'guides')).toHaveLength(1);
    expect(server.state.calls.filter(([n]) => n === 'kb_create')).toHaveLength(1);
  });

  it('imports a zip into a folder of an existing KB and keeps another member\'s note', async () => {
    const server = fakeServer({
      kbs: [{ id: 'KB1', name: 'Team', folders: [{ id: 'FA', parent_id: null, name: 'Policies', position: 0 }] }],
      notes: [{ id: 'N1', path: 'someone/leave.md', kb_id: 'KB1', folder_id: 'FA', user_id: 'other' }],
    });
    const zip = makeZip([{ name: 'leave.md', data: '# Leave' }, { name: 'travel/expenses.md', data: '# Expenses' }, { name: 'travel/map.pdf', data: '%PDF' }]);
    const k = importer(server, { files: { '/tmp/quorum-kb/Team docs.zip': zip } });
    const r = await k.handlers['kb-import']({ kbId: 'KB1', folderId: 'FA', source: { kind: 'zip', path: '/tmp/quorum-kb/Team docs.zip' } });
    expect(r.error).toBeUndefined();
    expect(r.imported).toBe(1);
    expect(r.skipped).toEqual(expect.arrayContaining([{ path: 'leave.md', reason: 'Another member already has a note at this place in the knowledge base.' }, { path: 'travel/map.pdf', reason: 'Only markdown files are imported.' }]));
    const travel = server.state.kbs[0].folders.find((f) => f.name === 'travel');
    expect(travel.parent_id).toBe('FA');
    expect(server.state.notes.find((n) => n.path.endsWith('expenses.md'))).toMatchObject({ path: 'Knowledge bases/Team/Policies/travel/expenses.md', folder_id: travel.id, frontmatter: { kb_source: 'Team docs.zip/travel/expenses.md' } });
    expect(r.kb.source).toMatchObject({ kind: 'zip', name: 'Team docs.zip', url: null });
  });

  it('names the member who owns a note at the same place', async () => {
    const server = fakeServer({ kbs: [{ id: 'KB1', name: 'Team' }], notes: [{ id: 'N1', path: 'x/leave.md', kb_id: 'KB1', folder_id: null, user_id: 'u2', frontmatter: { kb_source: 'old.zip/leave.md' } }], profiles: [{ user_id: 'u2', name: 'Sam Example', email: 'sam@example.com' }] });
    const k = importer(server, { files: { '/tmp/t.zip': makeZip([{ name: 'leave.md', data: '# Leave' }]) } });
    const r = await k.handlers['kb-import']({ kbId: 'KB1', source: { kind: 'zip', path: '/tmp/t.zip' } });
    expect(r.skipped).toEqual([{ path: 'leave.md', reason: 'Sam Example already has a note at this place in the knowledge base.' }]);
  });

  it('leaves a hand-written note alone and removes imported notes the source no longer has', async () => {
    const server = fakeServer();
    const k = importer(server, { zips: { main: makeZip(HANDBOOK) } });
    const first = await k.handlers['kb-import']({ source: { kind: 'github', url: 'https://github.com/example-org/handbook' } });
    const kb = server.state.kbs[0];
    // a note the person wrote by hand in the same folder, and one in another folder
    server.state.notes.push({ id: 'H1', path: 'mine/faq.md', kb_id: kb.id, folder_id: kb.folders.find((f) => f.name === 'guides').id, user_id: 'me', frontmatter: { visibility: 'public' } });
    server.state.notes.push({ id: 'H2', path: 'mine/other.md', kb_id: kb.id, folder_id: null, user_id: 'me', frontmatter: { visibility: 'public' } });
    const next = HANDBOOK.filter((e) => !e.name.endsWith('onboarding.md')).concat({ name: 'handbook-main/guides/faq.md', data: '# FAQ' });
    const again = await importer(server, { zips: { main: makeZip(next) } }).handlers['kb-import']({ kbId: first.kb.id });
    expect(again.error).toBeUndefined();
    expect(again).toMatchObject({ imported: 2, removed: 1 });
    expect(again.skipped).toEqual(expect.arrayContaining([{ path: 'guides/faq.md', reason: 'A note with this name already exists.' }]));
    const live = server.state.notes.filter((n) => !n.deleted_at).map((n) => n.id);
    expect(live).toEqual(expect.arrayContaining(['H1', 'H2']));
    expect(server.state.notes.find((n) => n.path.endsWith('onboarding.md')).deleted_at).toBeTruthy();
    expect(server.state.notes.find((n) => n.id === 'H1').body).toBeUndefined();
  });

  it('imports only the folder a /tree/ address names, on a branch whose name has a slash', async () => {
    const zip = makeZip([
      { name: 'handbook-release-v2/' }, { name: 'handbook-release-v2/README.md', data: '# Root' },
      { name: 'handbook-release-v2/docs/guides/a.md', data: '# A' }, { name: 'handbook-release-v2/docs/guides/sub/b.md', data: '# B' },
      { name: 'handbook-release-v2/docs/other.md', data: '# Other' },
    ]);
    const server = fakeServer();
    const gh = fakeGithub({ zips: { 'release/v2': zip }, branches: ['release', 'release/v2', 'main'] });
    const k = importer(server, { gh });
    const r = await k.handlers['kb-import']({ source: { kind: 'github', url: 'https://github.com/example-org/handbook/tree/release/v2/docs/guides' } });
    expect(r.error).toBeUndefined();
    expect(r.imported).toBe(2);
    expect(server.state.notes.map((n) => n.path).sort()).toEqual(['Knowledge bases/handbook/a.md', 'Knowledge bases/handbook/sub/b.md']);
    expect(server.state.notes.find((n) => n.path.endsWith('a.md')).frontmatter.kb_source).toBe('https://github.com/example-org/handbook/blob/release/v2/docs/guides/a.md');
    expect(r.kb.source).toMatchObject({ kind: 'github', branch: 'release/v2', subpath: 'docs/guides' });
    expect(gh.calls).toContain('https://api.github.com/repos/example-org/handbook/git/matching-refs/heads/release');
    // a refresh reads the stored branch and folder again
    const again = await importer(server, { gh }).handlers['kb-import']({ kbId: r.kb.id });
    expect(again).toMatchObject({ imported: 2, removed: 0 });
    // a folder or branch that is not there
    const missing = await importer(fakeServer(), { gh }).handlers['kb-import']({ source: { kind: 'github', url: 'https://github.com/example-org/handbook/tree/release/v2/nope' } });
    expect(missing.error).toBe('The folder nope was not found in the repository.');
    const nobranch = await importer(fakeServer(), { gh }).handlers['kb-import']({ source: { kind: 'github', url: 'https://github.com/example-org/handbook/tree/feature/x' } });
    expect(nobranch.error).toMatch(/branch in that address was not found/);
  });

  it('deletes a new KB that would hold no notes and says why', async () => {
    const server = fakeServer();
    const k = importer(server, { files: { '/tmp/code.zip': makeZip([{ name: 'a.js', data: '1' }, { name: 'b.png', data: 'x' }, { name: 'l.md', data: 'a.md', symlink: true }]) } });
    const r = await k.handlers['kb-import']({ source: { kind: 'zip', path: '/tmp/code.zip' } });
    expect(r.error).toBe('No markdown files were found in the source. Skipped: 2 files (Only markdown files are imported), 1 file (Symbolic links are not imported).');
    expect(r.skipped).toHaveLength(3);
    expect(server.state.kbs).toEqual([]);
  });

  it('skips a damaged file and imports the rest', async () => {
    const buf = makeZip([{ name: 'a.md', data: 'hello world', deflate: false }, { name: 'b.md', data: '# B' }]);
    buf[30 + 4 + 2] = 'X'.charCodeAt(0);
    const { files, skipped } = readArchive(buf);
    expect(files.map((f) => f.rel)).toEqual(['b.md']);
    expect(skipped).toEqual([{ path: 'a.md', reason: 'The file is damaged in the archive.' }]);
  });

  it('takes the wrapping folder off before passing over resource forks', () => {
    const { files, skipped } = readArchive(makeZip([{ name: '__MACOSX/Docs/._a.md', data: 'x' }, { name: 'Docs/a.md', data: '# A' }, { name: 'Docs/.hidden.md', data: '#' }]));
    expect(files.map((f) => f.rel)).toEqual(['a.md']);
    expect(skipped).toEqual([]);
  });

  it('names a KB from a long zip name within the limit', async () => {
    const long = `/tmp/${'n'.repeat(150)}.zip`;
    const server = fakeServer();
    const r = await importer(server, { files: { [long]: makeZip([{ name: 'a.md', data: '#' }]) } }).handlers['kb-import']({ source: { kind: 'zip', path: long } });
    expect(r.error).toBeUndefined();
    expect(r.kb.name).toBe('n'.repeat(120));
  });

  it('reports download progress at most once per 256 KB when the size is unknown', async () => {
    const zip = makeZip([{ name: 'a.md', data: '#' }]);
    const chunks = [...Array(64)].map(() => new Uint8Array(16 * 1024));
    chunks.push(new Uint8Array(zip));
    let i = 0;
    const fetch = async (url) => (url.includes('api.github.com')
      ? { status: 200, ok: true, json: async () => ({ default_branch: 'main' }) }
      : { status: 200, ok: true, headers: { get: () => null }, body: { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }), cancel: async () => {} }) } });
    const k = importer(fakeServer(), { gh: { fetch, calls: [] } });
    await k.handlers['kb-import']({ source: { kind: 'github', url: 'https://github.com/o/r' } });
    const fetching = k.events.filter(([, p]) => p.phase === 'fetching').map(([, p]) => p);
    expect(fetching.length).toBeLessThanOrEqual(6);
    expect(fetching.every((p) => p.total === 0)).toBe(true);
  });

  it('names a note whose path another note holds, and goes on with the rest', async () => {
    const server = fakeServer({ notes: [{ id: 'P1', path: 'Knowledge bases/docs/a.md', user_id: 'me', kb_id: null }] });
    const k = importer(server, { files: { '/tmp/docs.zip': makeZip([{ name: 'a.md', data: '# A' }, { name: 'b.md', data: '# B' }]) } });
    const r = await k.handlers['kb-import']({ source: { kind: 'zip', path: '/tmp/docs.zip' } });
    expect(r.imported).toBe(1);
    expect(r.skipped).toEqual([{ path: 'a.md', reason: 'Another note in the workspace already uses this path.' }]);
  });

  it('skips the files under a folder the server refuses', async () => {
    const server = fakeServer({ folderFail: 'drafts' });
    const k = importer(server, { files: { '/tmp/x.zip': makeZip([{ name: 'a.md', data: '#' }, { name: 'drafts/b.md', data: '#' }, { name: 'drafts/deep/c.md', data: '#' }]) } });
    const r = await k.handlers['kb-import']({ source: { kind: 'zip', path: '/tmp/x.zip' } });
    expect(r.imported).toBe(1);
    expect(r.skipped).toEqual([{ path: 'drafts/b.md', reason: 'That folder name is taken.' }, { path: 'drafts/deep/c.md', reason: 'That folder name is taken.' }]);
  });

  it('deletes the new KB when the source cannot be read', async () => {
    const server = fakeServer();
    const k = importer(server, { gh: fakeGithub({ api: { status: 404 } }) });
    const r = await k.handlers['kb-import']({ source: { kind: 'github', url: 'https://github.com/example-org/private-repo' } });
    expect(r).toEqual({ error: PRIVATE_REPO });
    expect(server.state.kbs).toEqual([]);
    expect(server.state.calls.map(([n]) => n)).toEqual(['kb_create', 'kb_delete']);

    const bad = importer(server, { files: { '/tmp/evil.zip': makeZip([{ name: '../../evil.md', data: '#' }]) } });
    expect(await bad.handlers['kb-import']({ source: { kind: 'zip', path: '/tmp/evil.zip' } })).toEqual({ error: 'The zip has a file path that points outside it.' });
    expect(server.state.kbs).toEqual([]);
  });

  it('checks the request and the person before anything is fetched', async () => {
    const server = fakeServer({ role: 'member', kbs: [{ id: 'KB1', name: 'Team', role: 'reader' }, { id: 'KB2', name: 'Zipped', source: { kind: 'zip', name: 'x.zip' } }] });
    const k = importer(server);
    expect((await k.handlers['kb-import']({ source: { kind: 'github', url: 'https://github.com/a/b' } })).error).toMatch(/owners and admins/);
    expect((await k.handlers['kb-import']({ kbId: 'KB1', source: { kind: 'github', url: 'https://github.com/a/b' } })).error).toMatch(/admins can import/);
    expect((await k.handlers['kb-import']({ kbId: 'GONE', source: { kind: 'github', url: 'https://github.com/a/b' } })).error).toMatch(/no longer exists/);
    expect((await k.handlers['kb-import']({ kbId: 'KB2' })).error).toMatch(/Choose the zip again/);
    expect((await k.handlers['kb-import']({ kbId: 'KB2', source: { kind: 'github', url: 'https://example.com/a/b' } })).error).toMatch(/GitHub repository address/);
    expect((await k.handlers['kb-import']({ kbId: 'KB2', source: { kind: 'zip', path: 'relative.zip' } })).error).toMatch(/\.zip file/);
    expect((await k.handlers['kb-import']({ kbId: 'KB2', source: { kind: 'zip', path: '/tmp/missing.zip' } })).error).toMatch(/could not be opened/);
    expect(k.gh.calls).toEqual([]);
  });

  it('still returns the KB when the database has no kb_source_set yet', async () => {
    const server = fakeServer({ sourceSet: false });
    const k = importer(server, { files: { '/tmp/x.zip': makeZip([{ name: 'a.md', data: '#' }]) } });
    const r = await k.handlers['kb-import']({ name: 'Docs', source: { kind: 'zip', path: '/tmp/x.zip' } });
    expect(r).toMatchObject({ imported: 1, kb: { name: 'Docs', source: null } });
  });

  it('picks a zip through the native dialog', async () => {
    expect(await importer(fakeServer()).handlers['kb-import-pick-zip']()).toEqual({ path: '/tmp/quorum-kb/Team docs.zip' });
    const none = createKbImport({ account: fakeServer().account, pickZip: async () => null });
    expect(await none.handlers['kb-import-pick-zip']()).toEqual({ canceled: true });
  });

  it('shapes import sources on a KB', () => {
    expect(shapeKb({ id: 'k', name: 'n', source: { kind: 'github', url: 'https://github.com/o/r', branch: 'main', name: 'r', imported_at: 't' } }).source).toEqual({ kind: 'github', url: 'https://github.com/o/r', path: null, branch: 'main', subpath: null, name: 'r', importedAt: 't' });
    expect(shapeKb({ id: 'k', name: 'n', source: { kind: 'zip', name: 'x.zip' } }).source).toMatchObject({ kind: 'zip', name: 'x.zip', url: null });
  });
});

// a real zip file on disk through the default readers, so the fs path is covered once
describe('the default file readers', () => {
  it('reads a zip from disk', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'quorum-kbimport-zip-'));
    const file = path.join(dir, 'notes.zip');
    writeFileSync(file, makeZip([{ name: 'notes/a.md', data: '# A' }]));
    const server = fakeServer();
    const k = createKbImport({ account: server.account });
    const r = await k.handlers['kb-import']({ source: { kind: 'zip', path: file } });
    rmSync(dir, { recursive: true, force: true });
    expect(r).toMatchObject({ imported: 1, kb: { name: 'notes' } });
    expect(server.state.notes[0].path).toBe('Knowledge bases/notes/a.md');
  });
});
