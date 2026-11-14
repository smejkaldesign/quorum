// Knowledge bases hosted by Quorum (ee/kbHosted.js): quorum://kb-file links and their resolution to a signed URL, the
// save that sends the opened hash and answers a stale save with the newer version and a merge, attachments, and the
// pull sync route that keeps hosted notes out of the personal vault. The server's rights are tested in
// supabase/tests/kb_hosted.sql; here a fake client records calls and answers with canned data.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const home = mkdtempSync(path.join(tmpdir(), 'quorum-kbh-home-'));
process.env.HOME = home;
const { conflictOf, createKbHosted, diskName, fileLinks, fileMarkdown, mimeOf, parseFileLink, shapeNote } = await import('../ee/kbHosted.js');
const { withFile, withoutFile } = await import('../ee/src/kbFiles.ts');
const { removeKbObjects } = await import('../ee/knowledgeBases.js');
const { hostedRow } = await import('../ee/sync.js');
const { shapeKb } = await import('../ee/knowledgeBases.js');
const { accessDraft, canArrange, readersOf, sourceLine } = await import('../ee/src/kbTree.ts');

const dirs = [home];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const KB = '01KH00000000000000000000K1';
const NOTE = '01KH00000000000000000000N1';
const FILE = '01KH00000000000000000000F1';
const fm = (title) => `---\ntitle: "${title}"\nvisibility: public\nkb_hosted: ${KB}\n---\n`;
const row = (over = {}) => ({ id: NOTE, kb_id: KB, folder_id: null, path: 'Knowledge bases/Wiki/Setup.md', title: 'Setup', body: `${fm('Setup')}one\ntwo\nthree\n`, hash: 'h2', updated_at: '2026-11-13T10:00:00Z', edited_by_name: 'Ana', ...over });

// a client whose rpc and table reads answer from the given maps and record each call
function fakeAccount({ rpc = {}, tables = {}, storage = {} } = {}) {
  const calls = [];
  const client = {
    rpc: async (name, args) => {
      calls.push(['rpc', name, args]);
      const a = rpc[name];
      if (a instanceof Error) return { data: null, error: { message: a.message, code: 'P0001' } };
      return { data: typeof a === 'function' ? a(args) : a ?? null, error: null };
    },
    from: (table) => {
      const call = ['from', table];
      calls.push(call);
      const b = {};
      for (const op of ['select', 'eq', 'is', 'order', 'limit', 'range', 'in']) b[op] = (...x) => { call.push([op, ...x]); return b; };
      b.then = (res, rej) => Promise.resolve({ data: tables[table] ?? [], error: null }).then(res, rej);
      return b;
    },
    storage: {
      from: (bucket) => ({
        upload: async (p, bytes, opts) => { calls.push(['upload', bucket, p, bytes.length, opts]); return { error: storage.uploadError ?? null }; },
        createSignedUrl: async (p, secs) => { calls.push(['sign', bucket, p, secs]); return storage.signed === null ? { data: null, error: { message: 'Object not found' } } : { data: { signedUrl: `https://storage.test/sign/${p}?t=x` }, error: null }; },
        remove: async (paths) => { calls.push(['remove', bucket, paths]); return { error: null }; },
      }),
    },
  };
  const state = { signedIn: true, workspace: { id: 'W1', role: 'member' }, userId: 'u1' };
  return { calls, account: { client: () => client, state: () => state } };
}

describe('quorum://kb-file links', () => {
  it('reads the file id from a link or a bare id and nothing else', () => {
    expect(parseFileLink(`quorum://kb-file/${FILE}`)).toBe(FILE);
    expect(parseFileLink(` ${FILE} `)).toBe(FILE);
    expect(parseFileLink('quorum://kb-file/not-an-id')).toBeNull();
    expect(parseFileLink(`https://example.com/${FILE}`)).toBeNull();
    expect(parseFileLink(`quorum://kb/${FILE}`)).toBeNull();
    expect(parseFileLink(null)).toBeNull();
  });
  it('lists every file a note links to once, and writes a link that stays one link', () => {
    const text = `See [a](quorum://kb-file/${FILE}) and [b](quorum://kb-file/${FILE}) and [c](quorum://kb-file/01KH00000000000000000000F2).`;
    expect(fileLinks(text)).toEqual([FILE, '01KH00000000000000000000F2']);
    expect(fileMarkdown({ id: FILE, name: 'Plan [v2].pdf', mime: 'application/pdf', link: `quorum://kb-file/${FILE}` })).toBe(`[Plan v2.pdf](quorum://kb-file/${FILE})`);
    expect(fileMarkdown({ id: FILE, name: 'Shot.png', mime: 'image/png', link: `quorum://kb-file/${FILE}` })).toBe(`![Shot.png](quorum://kb-file/${FILE})`);
    expect(mimeOf('/x/Photo.JPG')).toBe('image/jpeg');
    expect(mimeOf('/x/doc.pdf')).toBe('application/pdf');
    expect(mimeOf('/x/run.sh')).toBeNull();
  });
  it('resolves a link to a short signed URL, downloads the file on demand and opens it', async () => {
    const cache = mkdtempSync(path.join(tmpdir(), 'quorum-kbh-cache-'));
    dirs.push(cache);
    const f = { id: FILE, note_id: NOTE, kb_id: KB, name: 'Diagram.png', mime: 'image/png', size: 3, object_path: `W1/${KB}/${NOTE}/${FILE}.png` };
    const { account, calls } = fakeAccount({ tables: { kb_files: [f] } });
    const opened = [];
    const fetched = [];
    const h = createKbHosted({ account, cacheDir: cache, openPath: async (p) => { opened.push(p); return ''; }, fetch: async (u) => { fetched.push(u); return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }; } }).handlers;
    expect(await h['kb-file-open'](`quorum://kb-file/${FILE}`)).toEqual({ ok: true });
    expect(calls).toContainEqual(['sign', 'kb-files', f.object_path, 300]);
    expect(fetched[0]).toMatch(/^https:\/\/storage\.test\/sign\//);
    const to = path.join(cache, 'W1', FILE, 'Diagram.png');
    expect(opened).toEqual([to]);
    expect([...readFileSync(to)]).toEqual([1, 2, 3]);
  });
  it('refuses a link that is not a file, a file the person cannot read, and a file Storage will not sign', async () => {
    expect((await createKbHosted(fakeAccount()).handlers['kb-file-open']('https://example.com/x')).error).toMatch(/not a Quorum file/);
    expect((await createKbHosted(fakeAccount({ tables: { kb_files: [] } })).handlers['kb-file-open'](FILE)).error).toMatch(/not one you can read/);
    const f = { id: FILE, name: 'a.png', object_path: 'p' };
    expect((await createKbHosted(fakeAccount({ tables: { kb_files: [f] }, storage: { signed: null } })).handlers['kb-file-open'](FILE)).error).toMatch(/not one you can read/);
  });
});

describe('creating a hosted KB', () => {
  it('calls kb_create_hosted with the team when one is given, and refuses a member', async () => {
    const { account, calls } = fakeAccount({ rpc: { kb_create_hosted: { id: KB, name: 'Wiki', kind: 'general', source: { kind: 'hosted' }, role: 'admin', writable: true } } });
    account.state().workspace.role = 'admin';
    const h = createKbHosted({ account }).handlers;
    expect((await h['kb-hosted-create'](' Wiki ', 'T1')).kb).toMatchObject({ id: KB, hosted: true, writable: true });
    expect((await h['kb-hosted-create']('Wiki')).kb.id).toBe(KB);
    expect(calls.filter((c) => c[1] === 'kb_create_hosted').map((c) => c[2])).toEqual([{ workspace_id: 'W1', name: 'Wiki', team_id: 'T1' }, { workspace_id: 'W1', name: 'Wiki', team_id: null }]);
    expect((await createKbHosted(fakeAccount()).handlers['kb-hosted-create']('Wiki')).error).toMatch(/Only owners and admins/);
  });
});

describe('file links in a note\'s text', () => {
  const F2 = '01KH00000000000000000000F2';
  const pic = { id: FILE, name: 'Shot [1].png', mime: 'image/png', link: `quorum://kb-file/${FILE}` };
  const pdf = { id: F2, name: 'Plan.pdf', mime: 'application/pdf', link: `quorum://kb-file/${F2}` };
  it('puts a picture as an image and a PDF as a link at the end, after a blank line', () => {
    expect(withFile('', pic)).toBe(`![Shot 1.png](quorum://kb-file/${FILE})\n`);
    expect(withFile('Intro\n\n', pdf)).toBe(`Intro\n\n[Plan.pdf](quorum://kb-file/${F2})\n`);
  });
  it('takes a removed file out of the text, with the line it leaves empty, and leaves other files', () => {
    const text = `Intro\n\n![Shot.png](quorum://kb-file/${FILE})\n\nSee [the plan](quorum://kb-file/${F2}) and [it again](quorum://kb-file/${FILE}).\n`;
    expect(withoutFile(text, FILE)).toBe(`Intro\n\nSee [the plan](quorum://kb-file/${F2}) and .\n`);
    expect(withoutFile(text, 'not-an-id')).toBe(text);
  });
  it('names the downloaded copy safely, with its type\'s extension', () => {
    expect(diskName('Screenshot 2026-11-13 at 10.00.00\u202fAM.png', 'image/png')).toBe('Screenshot 2026-11-13 at 10.00.00\u202fAM.png');
    expect(diskName('a/b:c\u0001.pdf', 'application/pdf')).toBe('a b c .pdf');
    expect(diskName('Résumé', 'application/pdf')).toBe('Résumé.pdf');
    expect(diskName('photo.jpeg', 'image/jpeg')).toBe('photo.jpeg');
    expect(diskName('..', 'image/png')).toBe('File.png');
  });
  it('removes Storage objects 100 at a time, each once', async () => {
    const { account, calls } = fakeAccount();
    const paths = [...Array.from({ length: 150 }, (_, i) => `W/K/N/F${i}.png`), 'W/K/N/F0.png', null];
    expect(await removeKbObjects(account.client(), paths)).toBe(150);
    expect(calls.filter((c) => c[0] === 'remove').map((c) => c[2].length)).toEqual([100, 50]);
  });
});

describe('a picture for the preview', () => {
  it('comes back as a data URL through a signed URL, once per file', async () => {
    const f = { id: FILE, note_id: NOTE, kb_id: KB, name: 'Shot.png', mime: 'image/png', size: 3, object_path: `W1/${KB}/${NOTE}/${FILE}.png` };
    const { account, calls } = fakeAccount({ tables: { kb_files: [f] } });
    let fetched = 0;
    const h = createKbHosted({ account, fetch: async () => { fetched++; return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }; } }).handlers;
    expect(await h['kb-file-data'](`quorum://kb-file/${FILE}`)).toEqual({ name: 'Shot.png', mime: 'image/png', dataUrl: 'data:image/png;base64,AQID' });
    await h['kb-file-data'](FILE);
    expect(fetched).toBe(1);
    expect(calls.filter((c) => c[0] === 'sign')).toHaveLength(1);
  });
  it('gives a PDF\'s name only, and refuses another link', async () => {
    const f = { id: FILE, name: 'Plan.pdf', mime: 'application/pdf', object_path: 'p' };
    expect(await createKbHosted(fakeAccount({ tables: { kb_files: [f] } })).handlers['kb-file-data'](FILE)).toEqual({ name: 'Plan.pdf', mime: 'application/pdf' });
    expect((await createKbHosted(fakeAccount()).handlers['kb-file-data']('https://example.com/a.png')).error).toMatch(/not a Quorum file/);
  });
});

describe('saving a hosted note', () => {
  it('creates a note with a new id and no expected hash', async () => {
    const { account, calls } = fakeAccount({ rpc: { kb_hosted_note_save: (a) => ({ ok: true, note: row({ id: a.note_id, hash: 'h1', body: `${fm('Setup')}one\n` }) }) } });
    const r = await createKbHosted({ account }).handlers['kb-hosted-note-save']({ kbId: KB, folderId: null, title: ' Setup ', content: 'one\n' });
    const args = calls.find((c) => c[1] === 'kb_hosted_note_save')[2];
    expect(args).toMatchObject({ kb_id: KB, folder_id: null, title: 'Setup', content: 'one\n', expected_hash: null });
    expect(args.note_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(r.note).toMatchObject({ id: args.note_id, title: 'Setup', content: 'one\n', hash: 'h1' });
  });
  it('sends the hash the note was opened at', async () => {
    const { account, calls } = fakeAccount({ rpc: { kb_hosted_note_save: { ok: true, note: row() } } });
    await createKbHosted({ account }).handlers['kb-hosted-note-save']({ kbId: KB, noteId: NOTE, folderId: null, title: 'Setup', content: 'x', baseHash: 'h1', baseContent: 'one\n' });
    expect(calls.find((c) => c[1] === 'kb_hosted_note_save')[2]).toMatchObject({ note_id: NOTE, expected_hash: 'h1' });
  });
  it('answers a stale save with the newer version and the merge of both edits when they touch different lines', async () => {
    // opened: one two three; someone changed the last line; this person changed the first
    const { account } = fakeAccount({ rpc: { kb_hosted_note_save: { conflict: true, note: row({ body: `${fm('Setup')}one\ntwo\nthree, theirs\n` }) } } });
    const r = await createKbHosted({ account }).handlers['kb-hosted-note-save']({ kbId: KB, noteId: NOTE, folderId: null, title: 'Setup', content: 'one, mine\ntwo\nthree\n', baseHash: 'h1', baseContent: 'one\ntwo\nthree\n' });
    expect(r.note).toBeUndefined();
    expect(r.conflict.theirs).toMatchObject({ id: NOTE, hash: 'h2', content: 'one\ntwo\nthree, theirs\n', editedBy: 'Ana' });
    expect(r.conflict.merged).toBe('one, mine\ntwo\nthree, theirs\n');
  });
  it('offers no merge when both edits change the same line', async () => {
    const { account } = fakeAccount({ rpc: { kb_hosted_note_save: { conflict: true, note: row({ body: `${fm('Setup')}one\ntwo, theirs\nthree\n` }) } } });
    const r = await createKbHosted({ account }).handlers['kb-hosted-note-save']({ kbId: KB, noteId: NOTE, folderId: null, title: 'Setup', content: 'one\ntwo, mine\nthree\n', baseHash: 'h1', baseContent: 'one\ntwo\nthree\n' });
    expect(r.conflict.theirs.content).toBe('one\ntwo, theirs\nthree\n');
    expect(r.conflict.merged).toBeNull();
  });
  it('Keep mine saves on top of the newer version, so the second try goes in', async () => {
    let n = 0;
    const { account, calls } = fakeAccount({ rpc: { kb_hosted_note_save: (a) => (a.expected_hash === 'h2' ? { ok: true, note: row({ hash: 'h3' }) } : (n++, { conflict: true, note: row() })) } });
    const h = createKbHosted({ account }).handlers;
    const first = await h['kb-hosted-note-save']({ kbId: KB, noteId: NOTE, folderId: null, title: 'Setup', content: 'mine', baseHash: 'h1', baseContent: 'one' });
    const again = await h['kb-hosted-note-save']({ kbId: KB, noteId: NOTE, folderId: null, title: 'Setup', content: 'mine', baseHash: first.conflict.theirs.hash, baseContent: first.conflict.theirs.content });
    expect(n).toBe(1);
    expect(again.note.hash).toBe('h3');
    expect(calls.filter((c) => c[1] === 'kb_hosted_note_save').map((c) => c[2].expected_hash)).toEqual(['h1', 'h2']);
  });
  it('answers a save on a note deleted meanwhile with no newer version', async () => {
    const { account } = fakeAccount({ rpc: { kb_hosted_note_save: { conflict: true, note: { id: NOTE, deleted: true } } } });
    const r = await createKbHosted({ account }).handlers['kb-hosted-note-save']({ kbId: KB, noteId: NOTE, folderId: null, title: 'Setup', content: 'mine', baseHash: 'h1', baseContent: 'one' });
    expect(r).toEqual({ conflict: { theirs: null, merged: null } });
  });
  it('deletes a KB, then removes the objects the server listed', async () => {
    const { createKnowledgeBases } = await import('../ee/knowledgeBases.js');
    const { account, calls } = fakeAccount({ rpc: { kb_delete: { ok: true, objects: ['W1/K/N/a.png', 'W1/K/N/b.pdf'] } } });
    account.state().workspace.role = 'owner';
    expect(await createKnowledgeBases({ account }).handlers['kb-delete'](KB)).toEqual({ ok: true });
    const order = calls.filter((c) => c[1] === 'kb_delete' || c[0] === 'remove').map((c) => c[0]);
    expect(order).toEqual(['rpc', 'remove']);
    expect(calls).toContainEqual(['remove', 'kb-files', ['W1/K/N/a.png', 'W1/K/N/b.pdf']]);
  });
  it('says the note was deleted when there is no newer version, and passes a refusal through', async () => {
    expect(conflictOf({ theirs: null, base: 'a', mine: 'b' })).toEqual({ theirs: null, merged: null });
    expect(conflictOf({ theirs: row({ deleted: true }), base: 'a', mine: 'b' })).toEqual({ theirs: null, merged: null });
    const { account } = fakeAccount({ rpc: { kb_hosted_note_save: new Error("The workspace's plan ended, so this knowledge base is read-only. Renew Quorum Cloud to change it again") } });
    expect((await createKbHosted({ account }).handlers['kb-hosted-note-save']({ kbId: KB, folderId: null, title: 'T', content: '' })).error).toMatch(/plan ended/);
    expect((await createKbHosted(fakeAccount()).handlers['kb-hosted-note-save']({ kbId: KB, title: '  ' })).error).toBe('A note needs a title.');
  });
  it('shows the content without the frontmatter the server owns', () => {
    expect(shapeNote(row()).content).toBe('one\ntwo\nthree\n');
    expect(shapeNote(null)).toBeNull();
  });
  it('a stale delete is a conflict and removes nothing; a delete removes the note\'s objects', async () => {
    const stale = fakeAccount({ rpc: { kb_hosted_note_delete: { conflict: true, note: row() } } });
    expect((await createKbHosted({ account: stale.account }).handlers['kb-hosted-note-delete'](NOTE, 'h1')).conflict.theirs.hash).toBe('h2');
    expect(stale.calls.some((c) => c[0] === 'remove')).toBe(false);
    const ok = fakeAccount({ rpc: { kb_hosted_note_delete: { ok: true, objects: ['W1/a', 'W1/b'] } } });
    expect(await createKbHosted({ account: ok.account }).handlers['kb-hosted-note-delete'](NOTE, 'h2')).toEqual({ ok: true });
    expect(ok.calls).toContainEqual(['remove', 'kb-files', ['W1/a', 'W1/b']]);
  });
});

describe('attaching a file', () => {
  const begun = { id: FILE, object_path: `W1/${KB}/${NOTE}/${FILE}.png` };
  const done = { id: FILE, note_id: NOTE, name: 'Diagram.png', mime: 'image/png', size: 4, link: `quorum://kb-file/${FILE}`, created_at: 't' };
  it('begins the file, uploads it to its object without overwriting, and marks it done', async () => {
    const { account, calls } = fakeAccount({ rpc: { kb_file_begin: begun, kb_file_done: done } });
    const h = createKbHosted({ account, pickFile: async () => '/tmp/Diagram.png', statFile: async () => ({ size: 4 }), readFile: async () => Buffer.from('png!') }).handlers;
    const r = await h['kb-file-attach'](NOTE);
    expect(calls.find((c) => c[1] === 'kb_file_begin')[2]).toEqual({ note_id: NOTE, name: 'Diagram.png', mime: 'image/png', size: 4 });
    expect(calls).toContainEqual(['upload', 'kb-files', begun.object_path, 4, { contentType: 'image/png', upsert: false }]);
    expect(r.file).toEqual({ id: FILE, noteId: NOTE, name: 'Diagram.png', mime: 'image/png', size: 4, link: `quorum://kb-file/${FILE}`, createdAt: 't' });
  });
  it('refuses a file of another type or over 25 MB before anything is uploaded', async () => {
    const a = fakeAccount();
    expect((await createKbHosted({ account: a.account, pickFile: async () => '/tmp/run.sh' }).handlers['kb-file-attach'](NOTE)).error).toBe('Attach an image or a PDF.');
    expect((await createKbHosted({ account: a.account, pickFile: async () => '/tmp/big.pdf', statFile: async () => ({ size: 25 * 1024 * 1024 + 1 }) }).handlers['kb-file-attach'](NOTE)).error).toBe('A file can be up to 25 MB.');
    expect(a.calls.some((c) => c[0] === 'rpc' || c[0] === 'upload')).toBe(false);
    expect(await createKbHosted({ account: a.account, pickFile: async () => null }).handlers['kb-file-attach'](NOTE)).toEqual({ canceled: true });
  });
  it('removes the object when the server refuses the finished upload', async () => {
    const rejected = { rejected: true, object_path: begun.object_path, reason: 'The file is larger than it was when the upload began. Attach it again' };
    const { account, calls } = fakeAccount({ rpc: { kb_file_begin: begun, kb_file_done: rejected } });
    const h = createKbHosted({ account, pickFile: async () => '/tmp/Diagram.png', statFile: async () => ({ size: 4 }), readFile: async () => Buffer.from('png!') }).handlers;
    expect((await h['kb-file-attach'](NOTE)).error).toBe('The file is larger than it was when the upload began. Attach it again.');
    expect(calls).toContainEqual(['remove', 'kb-files', [begun.object_path]]);
  });
  it('says so when the upload fails and does not mark the file done', async () => {
    const { account, calls } = fakeAccount({ rpc: { kb_file_begin: begun, kb_file_done: done }, storage: { uploadError: { message: 'new row violates row-level security policy' } } });
    const h = createKbHosted({ account, pickFile: async () => '/tmp/Diagram.png', statFile: async () => ({ size: 4 }), readFile: async () => Buffer.from('png!') }).handlers;
    expect((await h['kb-file-attach'](NOTE)).error).toBe('The upload did not finish. Attach the file again.');
    expect(calls.some((c) => c[1] === 'kb_file_done')).toBe(false);
  });
});

describe('hosted KBs in the shapes, the readers list and pull sync', () => {
  it('reads the hosted source, the editor role and whether the caller may write', () => {
    const kb = shapeKb({ id: KB, name: 'Wiki', kind: 'general', source: { kind: 'hosted' }, role: 'editor', writable: true, folders: [], access: null });
    expect(kb).toMatchObject({ role: 'editor', hosted: true, writable: true, source: { kind: 'hosted' } });
    expect(shapeKb({ id: KB, name: 'Docs', kind: 'general', source: { kind: 'github', url: 'https://github.com/o/r' }, role: 'admin', writable: true })).toMatchObject({ hosted: false, writable: false });
    expect(sourceLine(kb.source)).toBe('Hosted by Quorum');
    expect(canArrange(kb)).toBe(true);
    expect(canArrange({ ...kb, writable: false, role: 'admin' })).toBe(false);
    expect(canArrange({ role: 'admin', hosted: false, writable: false })).toBe(true);
    expect(canArrange({ role: 'editor', hosted: false, writable: false })).toBe(false);
  });
  it('gives chosen people the editor role on a hosted KB and keeps admins', () => {
    const access = [{ principal: 'user', userId: 'a', role: 'admin' }, { principal: 'user', userId: 'b', role: 'editor' }, { principal: 'user', userId: 'c', role: 'reader' }];
    const start = readersOf(access);
    expect(start).toMatchObject({ mode: 'people', people: ['b', 'c'], editors: ['b'], workspaceEdits: false });
    expect(accessDraft(access, 'people', ['b', 'c'], { editors: ['c'], workspaceEdits: false })).toEqual([
      { principal: 'user', userId: 'a', role: 'admin' }, { principal: 'user', userId: 'b', role: 'reader' }, { principal: 'user', userId: 'c', role: 'editor' },
    ]);
    expect(accessDraft(access, 'workspace', [], { editors: ['b'], workspaceEdits: true })).toEqual([
      { principal: 'workspace', role: 'editor' }, { principal: 'user', userId: 'a', role: 'admin' }, { principal: 'user', userId: 'b', role: 'editor' },
    ]);
    // a KB without hosted storage never sends the editor role
    expect(accessDraft([{ principal: 'workspace', role: 'editor' }], 'workspace', [])).toEqual([{ principal: 'workspace', role: 'reader' }]);
  });
  it('routes a hosted note to the workspace folder, the person\'s own included', () => {
    expect(hostedRow({ frontmatter: { kb_hosted: KB } })).toBe(true);
    expect(hostedRow({ frontmatter: { visibility: 'public' } })).toBe(false);
    expect(hostedRow({ frontmatter: null })).toBe(false);
    expect(existsSync(home)).toBe(true);
  });
});
