import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { handleKbSyncAttach, cleanAttach } from '../kbSync/routes.js';
import { googleDrive } from '../kbSync/providers/googleDrive.js';
import { github } from '../kbSync/providers/github.js';
import { isConfidential, parseFrontmatter, sha256, syncedNoteText } from '../kbSync/rules.js';
import { syncAttachment } from '../kbSync/run.js';
import { refreshAccess, revokeGrant } from '../kbSync/tokens.js';
import { backoffSeconds, createKbSyncWorker, GONE_TWICE } from '../kbSync/worker.js';

const WS = '01JD0000000000000000000001';
const KB = '01JD00000000000000000000KB';
const FOLDER = '01JD00000000000000000000F1';
const ADMIN = '11111111-1111-4111-8111-111111111111';
const RT = 'rt-secret-do-not-log';
const config = { oauth: { google: { clientId: 'gid', clientSecret: 'gsecret' }, github: { clientId: 'hid', clientSecret: 'hsecret' } }, kbSync: {} };

// a supabase-js shaped client over arrays, with the calls the worker makes: select with eq/is/in/order/range,
// update and insert, maybeSingle, and rpc(name) answered by the test
function fakeDb({ tables = {}, rpcs = {}, uniquePaths = [] } = {}) {
  const calls = [];
  const from = (table) => {
    const filters = [];
    let mode = 'select', patch = null, range = null;
    const rows = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
    const run = () => {
      if (mode === 'update') { const hit = rows(); for (const r of hit) Object.assign(r, patch); calls.push({ table, op: 'update', patch, ids: hit.map((r) => r.id) }); return { data: null, error: null }; }
      const all = rows();
      return { data: range ? all.slice(range[0], range[1] + 1) : all, error: null };
    };
    const b = {
      select() { return b; },
      order() { return b; },
      range(a, z) { range = [a, z]; return b; },
      update(p) { mode = 'update'; patch = p; return b; },
      eq(k, v) { filters.push((r) => r[k] === v); return b; },
      in(k, v) { filters.push((r) => v.includes(r[k])); return b; },
      is(k, v) { filters.push((r) => (v === null ? r[k] == null : r[k] === v)); return b; },
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      insert: async (row) => {
        if (table === 'notes' && ((tables.notes ?? []).some((n) => n.path === row.path && !n.deleted_at) || uniquePaths.includes(row.path))) return { error: { code: '23505', message: 'duplicate key value violates unique constraint "notes_workspace_path"' } };
        (tables[table] ??= []).push({ ...row });
        calls.push({ table, op: 'insert', row });
        return { data: null, error: null };
      },
      then: (res, rej) => Promise.resolve(run()).then(res, rej),
    };
    return b;
  };
  return {
    tables, calls, from,
    rpc: async (name, args) => { calls.push({ rpc: name, args }); return rpcs[name] ? rpcs[name](args) : { data: null, error: { message: `no rpc ${name}` } }; },
  };
}

const res = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  arrayBuffer: async () => Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
  clone() { return this; },
});

// a fetch that answers by URL pattern and records every call
function fakeFetch(routes) {
  const seen = [];
  const f = async (url, init = {}) => {
    seen.push({ url, init });
    for (const [re, fn] of routes) if (re.test(url)) return fn(url, init);
    return res(404, { error: 'nope' });
  };
  f.seen = seen;
  return f;
}

// 0032's wrappers over the 0031 writes, as the database does them: a note and its upstream row together; a base only
// for a note whose hash it matches
function upstreamRpcs(tables) {
  const upsert = (row) => { tables.kb_note_upstream ??= []; const i = tables.kb_note_upstream.findIndex((u) => u.note_id === row.note_id); if (i >= 0) tables.kb_note_upstream[i] = { ...tables.kb_note_upstream[i], ...row }; else tables.kb_note_upstream.push({ suggestions: [], ...row }); };
  return {
    kb_sync_notes_write: ({ rows }) => {
      const ids = [];
      for (const r of rows) {
        const n = tables.notes.find((x) => x.id === r.note_id && !x.deleted_at);
        if (!n) return { data: null, error: { message: 'That note is no longer synced into this knowledge base', code: 'P0001' } };
        Object.assign(n, { body: r.body, frontmatter: r.frontmatter, hash: r.hash, mtime: r.mtime });
        if (r.upstream) upsert({ note_id: n.id, ...r.upstream });
        ids.push(n.id);
      }
      return { data: ids, error: null };
    },
    kb_sync_upstream_save: ({ rows }) => {
      let saved = 0;
      for (const r of rows) { const n = tables.notes.find((x) => x.id === r.note_id); if (!n || n.hash !== r.base_hash) continue; upsert({ ...r }); saved++; }
      return { data: saved, error: null };
    },
  };
}

const attachment = (over = {}) => ({
  id: '01JD00000000000000000000A1', workspace_id: WS, kb_id: KB, kb_name: 'Handbook', folder_id: FOLDER, provider: 'google-drive',
  remote_id: 'root-folder', remote_kind: 'folder', options: {}, attached_by: ADMIN, cursor: {}, note_count: 0, failures: 0,
  folders: [{ id: FOLDER, parent_id: null, name: 'Policies' }], ...over,
});

const driveRoutes = (files, { docs = {} } = {}) => [
  [/\/files\/root-folder\?fields/, () => res(200, { id: 'root-folder', name: 'Policies', mimeType: 'application/vnd.google-apps.folder' })],
  [/\/files\?q=/, (url) => {
    const parent = decodeURIComponent(url).match(/'([^']+)' in parents/)[1];
    return res(200, { files: files.filter((f) => f.parent === parent).map(({ parent: _p, ...f }) => f) });
  }],
  [/\/export\?mimeType=text%2Fmarkdown/, (url) => res(200, docs[url.match(/files\/([^/]+)\/export/)[1]] ?? '# Doc')],
  [/alt=media/, (url) => res(200, docs[url.match(/files\/([^?]+)\?alt/)[1]] ?? '# File')],
];

test('a synced note is shared, names its source and attachment, and carries a source line', () => {
  const text = syncedNoteText({ text: '# Leave policy\n\nTwenty days.', source: 'google-drive:f1', attachmentId: 'A1', name: 'Leave policy', url: 'https://drive.google.com/file/d/f1', syncedAt: '2026-11-13T00:00:00.000Z', modified: '2026-11-12T00:00:00.000Z', where: 'Google Drive' });
  const fm = parseFrontmatter(text);
  assert.equal(fm.visibility, 'public');
  assert.equal(fm.kb_source, 'google-drive:f1');
  assert.equal(fm.kb_attachment, 'A1');
  assert.equal(fm.kb_source_modified, '2026-11-12T00:00:00.000Z');
  assert.equal(fm.title, 'Leave policy');
  assert.match(text, /\n> Source: \[Leave policy\]\(https:\/\/drive\.google\.com\/file\/d\/f1\) in Google Drive\.\n\n# Leave policy/);
  assert.equal(isConfidential(parseFrontmatter(syncedNoteText({ text: '---\nconfidential: false\n---\nx', source: 's', attachmentId: 'A', name: 'n', syncedAt: 't', where: 'GitHub' }))), false);
  assert.equal(isConfidential(parseFrontmatter(syncedNoteText({ text: '---\nconfidential: finance\n---\nx', source: 's', attachmentId: 'A', name: 'n', syncedAt: 't', where: 'GitHub' }))), true);
});

test('a refresh returns the access token, keeps a rotated refresh token, and reads a refused grant as auth', async () => {
  const google = fakeFetch([[/oauth2\.googleapis\.com\/token/, (_u, init) => (String(init.body).includes(`refresh_token=${RT}`) ? res(200, { access_token: 'at-1', expires_in: 3600 }) : res(400, { error: 'invalid_grant' }))]]);
  const t = await refreshAccess({ provider: 'google-drive', client: config.oauth.google, refreshToken: RT, fetchImpl: google, now: () => 0 });
  assert.deepEqual(t, { accessToken: 'at-1', refreshToken: null, expiresAt: 3600000 });
  await assert.rejects(refreshAccess({ provider: 'google-drive', client: config.oauth.google, refreshToken: 'other', fetchImpl: google }), (e) => e.code === 'auth');
  const gh = fakeFetch([[/github\.com\/login\/oauth\/access_token/, () => res(200, { access_token: 'gh-at', refresh_token: 'gh-rt-2', expires_in: 28800 })]]);
  assert.equal((await refreshAccess({ provider: 'github', client: config.oauth.github, refreshToken: 'gh-rt-1', fetchImpl: gh })).refreshToken, 'gh-rt-2');
  await assert.rejects(refreshAccess({ provider: 'github', client: { clientId: null }, refreshToken: 'x', fetchImpl: gh }), (e) => e.code === 'config');
});

test('revoking a GitHub grant revokes only the relay token; Google revokes from the refresh token', async () => {
  const f = fakeFetch([
    [/login\/oauth\/access_token/, () => res(200, { access_token: 'gh-at', refresh_token: 'gh-rt-2' })],
    [/applications\/hid\/token$/, () => res(204, '')],
    [/oauth2\.googleapis\.com\/revoke/, () => res(200, {})],
  ]);
  assert.equal(await revokeGrant({ provider: 'github', client: config.oauth.github, refreshToken: 'gh-rt-1', fetchImpl: f }), true);
  const del = f.seen.find((c) => /applications\/hid\/token$/.test(c.url));
  assert.equal(del.init.method, 'DELETE');
  assert.equal(JSON.parse(del.init.body).access_token, 'gh-at');
  assert.ok(!f.seen.some((c) => /\/grant$/.test(c.url)), 'the whole grant is never deleted');
  assert.equal(await revokeGrant({ provider: 'google-drive', client: config.oauth.google, refreshToken: RT, fetchImpl: f }), true);
});

test('Drive lists a folder with its subfolders, pages through, and waits out a rate limit', async () => {
  let first = true;
  const pages = fakeFetch([
    [/\/files\/root-folder\?fields/, () => res(200, { id: 'root-folder', mimeType: 'application/vnd.google-apps.folder' })],
    [/\/files\?q=/, (url) => {
      if (first) { first = false; return res(429, { error: { errors: [{ reason: 'rateLimitExceeded' }] } }, { 'retry-after': '2' }); }
      if (/'sub'/.test(decodeURIComponent(url))) return res(200, { files: [{ id: 'f3', name: 'Deep.md', mimeType: 'text/markdown', modifiedTime: 'm3' }] });
      if (!/pageToken/.test(url)) return res(200, { nextPageToken: 'p2', files: [{ id: 'f1', name: 'Plan', mimeType: 'application/vnd.google-apps.document', modifiedTime: 'm1' }, { id: 'sub', name: 'Teams', mimeType: 'application/vnd.google-apps.folder' }] });
      return res(200, { files: [{ id: 'f2', name: 'photo.png', mimeType: 'image/png' }, { id: 'f4', name: 'Notes.txt', mimeType: 'text/plain', modifiedTime: 'm4' }] });
    }],
  ]);
  const waits = [];
  const l = await googleDrive.list({ token: 'at', attachment: attachment(), fetchImpl: pages, sleep: async (ms) => { waits.push(ms); } });
  assert.deepEqual(waits, [2000]);
  assert.equal(l.complete, true);
  assert.deepEqual(l.files.map((f) => [f.remoteId, f.segs.join('/')]), [['f1', ''], ['f4', ''], ['f3', 'Teams']]);
  assert.ok(pages.seen.every((c) => c.init.headers.authorization === 'Bearer at'));
});

test('a run writes new notes as the admin in KB folders, skips unchanged files, updates changed ones, removes gone and confidential ones', async () => {
  const files = [
    { parent: 'root-folder', id: 'd1', name: 'Leave', mimeType: 'application/vnd.google-apps.document', modifiedTime: 'm1' },
    { parent: 'root-folder', id: 'sub', name: 'Teams', mimeType: 'application/vnd.google-apps.folder' },
    { parent: 'sub', id: 'd2', name: 'Oncall.md', mimeType: 'text/markdown', modifiedTime: 'm2' },
  ];
  const tables = { notes: [], kb_note_upstream: [], kb_folders: [{ id: FOLDER, kb_id: KB, parent_id: null, name: 'Policies' }] };
  const db = fakeDb({ tables, rpcs: upstreamRpcs(tables) });
  const a = attachment();
  const fetchImpl = fakeFetch(driveRoutes(files, { docs: { d1: '# Leave\n\nTwenty days.' } }));
  const r1 = await syncAttachment({ db, attachment: a, provider: googleDrive, token: 'at', fetchImpl, now: () => new Date('2026-11-13T00:00:00Z') });
  assert.equal(r1.written, 2);
  const notes = db.tables.notes;
  assert.deepEqual(notes.map((n) => n.path).sort(), ['Knowledge bases/Handbook/Policies/Leave.md', 'Knowledge bases/Handbook/Policies/Teams/Oncall.md']);
  assert.ok(notes.every((n) => n.user_id === ADMIN && n.kb_id === KB && n.workspace_id === WS && n.frontmatter.visibility === 'public' && n.frontmatter.kb_attachment === a.id));
  const teams = db.tables.kb_folders.find((f) => f.name === 'Teams');
  assert.equal(teams.parent_id, FOLDER);
  assert.equal(notes.find((n) => n.path.endsWith('Oncall.md')).folder_id, teams.id);
  assert.equal(notes.find((n) => n.path.endsWith('Leave.md')).folder_id, FOLDER);

  assert.equal(tables.kb_note_upstream.length, 2, 'each new note has its upstream base');

  // second run: d1 unchanged, d2 changed upstream and also edited in Quorum, a new confidential file
  const leave = notes.find((n) => n.path.endsWith('Leave.md'));
  const oncall = notes.find((n) => n.path.endsWith('Oncall.md'));
  const synced = oncall.body;
  oncall.body = `${synced}\nAgent note: page the secondary first.\n`;
  oncall.hash = sha256(oncall.body);
  files[2].modifiedTime = 'm2b';
  files.push({ parent: 'root-folder', id: 'd3', name: 'Salaries.md', mimeType: 'text/markdown', modifiedTime: 'm3' });
  const docs = { d1: '# Leave\n\nTwenty days.', d2: '# Oncall v2', d3: '---\nconfidential: true\n---\n# Pay' };
  const r2 = await syncAttachment({ db, attachment: { ...a, cursor: r1.cursor, folders: db.tables.kb_folders }, provider: googleDrive, token: 'at', fetchImpl: fakeFetch(driveRoutes(files, { docs })) });
  assert.equal(r2.unchanged, 1);
  assert.equal(r2.written, 1);
  assert.equal(r2.suggested, 1);
  assert.match(oncall.body, /# Oncall v2/);
  assert.doesNotMatch(oncall.body, /Agent note/, 'the source text is written as the note');
  const row = tables.kb_note_upstream.find((u) => u.note_id === oncall.id);
  assert.equal(row.suggestions.length, 1);
  assert.equal(row.suggestions[0].state, 'ready', 'the edit merges onto the new text');
  assert.match(row.suggestions[0].body, /# Oncall v2[\s\S]*Agent note: page the secondary first\./);
  assert.equal(row.base_body, oncall.body);
  assert.equal(notes.length, 2, 'the confidential file is not written');
  assert.ok(r2.skipped.some((s) => s.path === 'Salaries.md'));
  assert.equal(r2.noteCount, 2);

  // an edit to d1 while Drive only moved its time: Quorum's copy stays, with the new time
  leave.body = `${leave.body}\nEdited in Quorum.\n`;
  leave.hash = sha256(leave.body);
  files[0].modifiedTime = 'm1b';
  const rk = await syncAttachment({ db, attachment: { ...a, cursor: r2.cursor, folders: db.tables.kb_folders }, provider: googleDrive, token: 'at', fetchImpl: fakeFetch(driveRoutes(files, { docs })) });
  assert.equal(rk.kept, 1);
  assert.match(leave.body, /Edited in Quorum\./);
  assert.equal(leave.frontmatter.kb_source_modified, 'm1b');

  // third run: d1 is gone from the folder, d2 turns confidential
  files.splice(0, 1);
  docs.d2 = '---\nconfidential: yes\n---\n# Oncall';
  files[1].modifiedTime = 'm2c';
  const r3 = await syncAttachment({ db, attachment: { ...a, cursor: rk.cursor, folders: db.tables.kb_folders }, provider: googleDrive, token: 'at', fetchImpl: fakeFetch(driveRoutes(files, { docs })) });
  assert.equal(r3.removed, 2);
  assert.ok(leave.deleted_at && oncall.deleted_at);
});

test('a path another note holds gets the next free name, and a note another attachment holds is skipped', async () => {
  const db = fakeDb({ tables: { notes: [{ id: 'other', path: 'Knowledge bases/Handbook/Policies/Leave.md', kb_id: KB, user_id: 'someone', frontmatter: { kb_source: 'google-drive:elsewhere' }, hash: 'h' }, { id: 'held', path: 'Knowledge bases/Handbook/x.md', kb_id: KB, user_id: ADMIN, frontmatter: { kb_source: 'google-drive:d9', kb_attachment: 'ANOTHER' }, hash: 'h' }] } });
  const files = [{ parent: 'root-folder', id: 'd1', name: 'Leave.md', mimeType: 'text/markdown', modifiedTime: 'm' }, { parent: 'root-folder', id: 'd9', name: 'Held.md', mimeType: 'text/markdown', modifiedTime: 'm' }];
  const r = await syncAttachment({ db, attachment: attachment(), provider: googleDrive, token: 'at', fetchImpl: fakeFetch(driveRoutes(files)) });
  assert.equal(r.written, 1);
  assert.ok(db.tables.notes.some((n) => n.path === 'Knowledge bases/Handbook/Policies/Leave (2).md'));
  assert.match(r.skipped[0].reason, /Another synced folder/);
});

test('GitHub reads only changed markdown under the folder and stops after one call when the head is unchanged', async () => {
  const blob = (s) => res(200, { content: Buffer.from(s).toString('base64'), encoding: 'base64' });
  const routes = (sha, tree) => fakeFetch([
    [/\/branches\/main$/, () => res(200, { commit: { sha } })],
    [/\/git\/trees\//, () => res(200, { tree, truncated: false })],
    [/\/git\/blobs\/b1/, () => blob('# Intro')],
    [/\/git\/blobs\/b2/, () => blob('# Setup')],
    [/\/git\/blobs\/b2x/, () => blob('# Setup v2')],
  ]);
  const tree = [
    { path: 'docs/intro.md', type: 'blob', sha: 'b1' }, { path: 'docs/guide/setup.md', type: 'blob', sha: 'b2' },
    { path: 'README.md', type: 'blob', sha: 'b0' }, { path: 'docs/.github/x.md', type: 'blob', sha: 'b5' }, { path: 'docs/logo.png', type: 'blob', sha: 'b6' },
  ];
  const a = attachment({ provider: 'github', remote_id: 'octo/handbook', options: { branch: 'main', path: 'docs' }, folder_id: null, folders: [] });
  const ghTables = { notes: [], kb_folders: [], kb_note_upstream: [] };
  const db = fakeDb({ tables: ghTables, rpcs: upstreamRpcs(ghTables) });
  const f1 = routes('c1', tree);
  const r1 = await syncAttachment({ db, attachment: a, provider: github, token: 'gh-at', fetchImpl: f1 });
  assert.equal(r1.written, 2);
  assert.deepEqual(db.tables.notes.map((n) => n.path).sort(), ['Knowledge bases/Handbook/guide/setup.md', 'Knowledge bases/Handbook/intro.md']);
  assert.equal(db.tables.notes.find((n) => n.path.endsWith('intro.md')).frontmatter.kb_source, 'https://github.com/octo/handbook/blob/main/docs/intro.md');

  const f2 = routes('c1', tree);
  const r2 = await syncAttachment({ db, attachment: { ...a, cursor: r1.cursor }, provider: github, token: 'gh-at', fetchImpl: f2 });
  assert.equal(f2.seen.length, 1, 'one call for an unchanged head');
  assert.equal(r2.written, 0);

  const f3 = routes('c2', tree.map((e) => (e.sha === 'b2' ? { ...e, sha: 'b2x' } : e)));
  const r3 = await syncAttachment({ db, attachment: { ...a, cursor: r2.cursor, folders: db.tables.kb_folders }, provider: github, token: 'gh-at', fetchImpl: f3 });
  assert.equal(r3.written, 1);
  assert.equal(f3.seen.filter((c) => /blobs/.test(c.url)).length, 1);
});

test('a GitHub run that could not read a file keeps the old head, so the file is read again next run', async () => {
  const blob = (t) => res(200, { content: Buffer.from(t).toString('base64'), encoding: 'base64' });
  const tree = [{ path: 'a.md', type: 'blob', sha: 'ba' }, { path: 'b.md', type: 'blob', sha: 'bb' }];
  const tables = { notes: [], kb_folders: [], kb_note_upstream: [] };
  const db = fakeDb({ tables, rpcs: upstreamRpcs(tables) });
  const a = attachment({ provider: 'github', remote_id: 'octo/h', options: { branch: 'main' }, folder_id: null, folders: [], cursor: { sha: 'old', complete: true } });
  const f = fakeFetch([[/branches\/main$/, () => res(200, { commit: { sha: 'new' } })], [/git\/trees/, () => res(200, { tree })], [/blobs\/ba/, () => blob('# A')], [/blobs\/bb/, () => res(500, {})]]);
  const r = await syncAttachment({ db, attachment: a, provider: github, token: 't', fetchImpl: f, sleep: async () => {} });
  assert.equal(r.written, 1);
  assert.deepEqual(r.cursor, { sha: 'old', complete: true });
});

test('a folder made meanwhile is used instead of a second one', async () => {
  const tables = { notes: [], kb_folders: [{ id: 'F-made', kb_id: KB, parent_id: FOLDER, name: 'Teams' }], kb_note_upstream: [] };
  const db = fakeDb({ tables, rpcs: upstreamRpcs(tables) });
  const insert = db.from;
  db.from = (t) => { const b = insert(t); if (t === 'kb_folders') b.insert = async () => ({ error: { code: '23505', message: 'duplicate key value violates unique constraint "kb_folders_name"' } }); return b; };
  // the claim's folder list is older than the table: it does not have Teams yet
  const files = [{ parent: 'root-folder', id: 'sub', name: 'Teams', mimeType: 'application/vnd.google-apps.folder' }, { parent: 'sub', id: 'd2', name: 'Oncall.md', mimeType: 'text/markdown', modifiedTime: 'm' }];
  const r = await syncAttachment({ db, attachment: attachment(), provider: googleDrive, token: 't', fetchImpl: fakeFetch(driveRoutes(files)) });
  assert.equal(r.written, 1);
  assert.equal(tables.notes[0].folder_id, 'F-made');
});

function workerDb({ attachments, tokens = {}, revocations = [], locked = new Map(), renew = () => true, store = () => null, finishOk = () => true }) {
  const finished = [];
  const db = fakeDb({
    tables: { notes: [], kb_folders: [] },
    rpcs: {
      kb_sync_refresh_lock: ({ grant_id, owner }) => { const held = locked.get(grant_id); if (held && held !== owner) return { data: false, error: null }; locked.set(grant_id, owner); return { data: true, error: null }; },
      kb_sync_refresh_unlock: ({ grant_id, owner }) => { if (locked.get(grant_id) === owner) locked.delete(grant_id); return { data: null, error: null }; },
      kb_sync_renew: (args) => ({ data: renew(args), error: null }),
      kb_sync_strays: () => ({ data: 0, error: null }),
      kb_sync_revoke_failed: () => ({ data: false, error: null }),
      kb_sync_claim: () => ({ data: attachments, error: null }),
      kb_sync_token: ({ attachment_id }) => ({ data: tokens[attachment_id] ? [tokens[attachment_id]] : [], error: null }),
      kb_sync_token_store: (args) => ({ data: null, error: store(args) }),
      kb_sync_finish: (args) => { finished.push(args); return { data: finishOk(args), error: null }; },
      kb_sync_grant_refused: () => ({ data: null, error: null }),
      kb_sync_revocations: () => ({ data: revocations, error: null }),
      kb_sync_revoked: () => ({ data: null, error: null }),
    },
  });
  return { db, finished, locked };
}

test('the worker keeps going past a failing attachment, ends a refused grant, backs off a rate limit, stores a rotated token, and never logs a token', async () => {
  const ok = attachment({ id: 'A-ok' });
  const bad = attachment({ id: 'A-bad', remote_id: 'broken' });
  const refused = attachment({ id: 'A-refused' });
  const limited = attachment({ id: 'A-limited', provider: 'github', remote_id: 'octo/busy', options: { branch: 'main' } });
  const tok = (grant, provider = 'google-drive', refresh = RT) => ({ grant_id: grant, provider, client: 'quorum', refresh_token: refresh });
  const { db, finished } = workerDb({
    attachments: [ok, bad, refused, limited],
    tokens: { 'A-ok': tok('G1'), 'A-bad': tok('G1'), 'A-refused': tok('G2', 'google-drive', 'rt-dead'), 'A-limited': tok('G3', 'github', 'gh-rt-1') },
    revocations: [{ grant_id: 'G9', provider: 'google-drive', client: 'quorum', refresh_token: 'rt-ended' }],
  });
  const fetchImpl = fakeFetch([
    [/oauth2\.googleapis\.com\/token/, (_u, init) => (String(init.body).includes('rt-dead') ? res(400, { error: 'invalid_grant' }) : res(200, { access_token: 'at', expires_in: 3600 }))],
    [/oauth2\.googleapis\.com\/revoke/, () => res(200, {})],
    [/login\/oauth\/access_token/, () => res(200, { access_token: 'gh-at', refresh_token: 'gh-rt-2', expires_in: 28800 })],
    [/\/files\/broken/, () => res(500, {})],
    [/api\.github\.com\/repos\/octo\/busy/, () => res(429, {}, { 'retry-after': '120' })],
    ...driveRoutes([{ parent: 'root-folder', id: 'd1', name: 'A.md', mimeType: 'text/markdown', modifiedTime: 'm' }]),
  ]);
  const lines = [];
  const w = createKbSyncWorker({ db, config, fetchImpl, log: (e, f) => lines.push(JSON.stringify({ e, ...f })), sleep: async () => {} });
  const results = await w.tick();
  assert.equal(results.length, 4);
  const by = Object.fromEntries(finished.map((f) => [f.attachment_id, f]));
  assert.equal(by['A-ok'].ok, true);
  assert.equal(by['A-ok'].note_count, 1);
  assert.equal(by['A-bad'].ok, false);
  assert.match(by['A-bad'].message, /refused the request/);
  assert.equal(by['A-refused'].needs_auth, true);
  assert.ok(db.calls.some((c) => c.rpc === 'kb_sync_grant_refused' && c.args.grant_id === 'G2'));
  assert.equal(by['A-limited'].ok, false);
  assert.equal(by['A-limited'].retry_seconds, 120);
  assert.ok(db.calls.some((c) => c.rpc === 'kb_sync_token_store' && c.args.token === 'gh-rt-2'));
  assert.ok(db.calls.some((c) => c.rpc === 'kb_sync_revoked' && c.args.grant_id === 'G9'));
  // one read per run, and one more under the grant lock for each of the three refreshes
  assert.equal(db.calls.filter((c) => c.rpc === 'kb_sync_token').length, 7);
  // one refresh for the shared grant G1: the second run reuses the access token
  assert.equal(fetchImpl.seen.filter((c) => /oauth2\.googleapis\.com\/token/.test(c.url) && String(c.init.body).includes(RT)).length, 1);
  const logged = lines.join('\n');
  for (const secret of [RT, 'rt-dead', 'gh-rt-1', 'gh-rt-2', 'rt-ended', 'gsecret', 'hsecret', '"at"', 'gh-at']) assert.ok(!logged.includes(secret), `the log has no ${secret}`);
});

test('a gone file keeps its notes: the second run in a row says so, and only an admin removes them', async () => {
  const a = attachment({ id: 'A-gone', remote_kind: 'file', remote_id: 'gone-file' });
  const tokens = { 'A-gone': { grant_id: 'G', provider: 'google-drive', client: 'quorum', refresh_token: RT } };
  const fetchImpl = fakeFetch([[/oauth2\.googleapis\.com\/token/, () => res(200, { access_token: 'at' })], [/\/files\/gone-file/, () => res(404, {})]]);
  const one = workerDb({ attachments: [a], tokens });
  one.db.tables.notes.push({ id: 'n1', kb_id: KB, path: 'p', frontmatter: { kb_attachment: 'A-gone' } });
  await createKbSyncWorker({ db: one.db, config, fetchImpl, sleep: async () => {} }).tick();
  assert.match(one.finished[0].message, /no longer in Google Drive/);
  assert.equal(one.finished[0].cur.gone, 1);
  assert.equal(one.db.tables.notes[0].deleted_at, undefined, 'the notes stay');
  const two = workerDb({ attachments: [{ ...a, cursor: one.finished[0].cur }], tokens });
  two.db.tables.notes.push({ id: 'n1', kb_id: KB, path: 'p', frontmatter: { kb_attachment: 'A-gone' } });
  await createKbSyncWorker({ db: two.db, config, fetchImpl, sleep: async () => {} }).tick();
  assert.equal(two.finished[0].message, GONE_TWICE);
  assert.equal(two.finished[0].ok, false);
  assert.equal(two.db.tables.notes[0].deleted_at, undefined, 'still kept after two runs');
  assert.ok(!two.db.calls.some((c) => c.op === 'update' && c.table === 'notes'));
  assert.equal(backoffSeconds(0), 300);
  assert.equal(backoffSeconds(10), 6 * 3600);
});

test('an ambiguous 403 is no proof of a gone item: GitHub secondary limits back off, other refusals keep the notes', async () => {
  const sleeps = [];
  const secondary = fakeFetch([[/branches\/main$/, () => res(403, { message: 'You have exceeded a secondary rate limit.' })]]);
  await assert.rejects(github.list({ token: 't', attachment: attachment({ provider: 'github', remote_id: 'o/r', options: { branch: 'main' } }), fetchImpl: secondary, sleep: async (ms) => { sleeps.push(ms); } }), (e) => e.code === 'limited');
  assert.equal(sleeps.length, 3);
  const retryAfter = fakeFetch([[/branches\/main$/, () => res(403, {}, { 'retry-after': '600' })]]);
  await assert.rejects(github.list({ token: 't', attachment: attachment({ provider: 'github', remote_id: 'o/r', options: { branch: 'main' } }), fetchImpl: retryAfter, sleep: async () => {} }), (e) => e.code === 'limited' && e.retryAfterMs === 600000);
  const denied = fakeFetch([[/branches\/main$/, () => res(403, { message: 'Resource not accessible by integration' })]]);
  await assert.rejects(github.list({ token: 't', attachment: attachment({ provider: 'github', remote_id: 'o/r', options: { branch: 'main' } }), fetchImpl: denied, sleep: async () => {} }), (e) => e.code === 'access');
  const driveOther = fakeFetch([[/\/files\/root-folder/, () => res(403, { error: { errors: [{ reason: 'domainPolicy' }] } })]]);
  await assert.rejects(googleDrive.list({ token: 't', attachment: attachment(), fetchImpl: driveOther, sleep: async () => {} }), (e) => e.code === 'provider');
  const driveNoAccess = fakeFetch([[/\/files\/root-folder/, () => res(403, { error: { errors: [{ reason: 'insufficientFilePermissions' }] } })]]);
  await assert.rejects(googleDrive.list({ token: 't', attachment: attachment(), fetchImpl: driveNoAccess, sleep: async () => {} }), (e) => e.code === 'gone');
});

test('a run that loses its lease stops writing and takes out what it wrote', async () => {
  const files = [1, 2, 3, 4].map((i) => ({ parent: 'root-folder', id: `d${i}`, name: `N${i}.md`, mimeType: 'text/markdown', modifiedTime: 'm' }));
  let renewals = 0;
  const { db, finished } = workerDb({ attachments: [attachment({ id: 'A-lease' })], tokens: { 'A-lease': { grant_id: 'G', provider: 'google-drive', client: 'quorum', refresh_token: RT } }, renew: () => ++renewals < 2 });
  const fetchImpl = fakeFetch([[/oauth2\.googleapis\.com\/token/, () => res(200, { access_token: 'at', expires_in: 3600 })], ...driveRoutes(files)]);
  const [r] = await createKbSyncWorker({ db, config, fetchImpl, sleep: async () => {}, settings: { renewEveryMs: 0 } }).tick();
  assert.equal(r.code, 'lease');
  assert.equal(db.tables.notes.length, 1, 'the writes stop when the lease is gone');
  assert.equal(finished.length, 0, 'a lost run reports nothing');
  assert.ok(db.calls.some((c) => c.rpc === 'kb_sync_strays' && c.args.attachment_id === 'A-lease'));
});

test('a finish that finds the attachment gone sweeps its notes', async () => {
  const { db } = workerDb({ attachments: [attachment({ id: 'A-removed' })], tokens: { 'A-removed': { grant_id: 'G', provider: 'google-drive', client: 'quorum', refresh_token: RT } }, finishOk: () => false });
  const fetchImpl = fakeFetch([[/oauth2\.googleapis\.com\/token/, () => res(200, { access_token: 'at', expires_in: 3600 })], ...driveRoutes([{ parent: 'root-folder', id: 'd1', name: 'A.md', mimeType: 'text/markdown', modifiedTime: 'm' }])]);
  const [r] = await createKbSyncWorker({ db, config, fetchImpl, sleep: async () => {} }).tick();
  assert.equal(r.ok, false);
  assert.ok(db.calls.some((c) => c.rpc === 'kb_sync_strays' && c.args.attachment_id === 'A-removed'));
});

test('a refresh waits for the grant lock, and a rotated token the store refused is kept and stored before the next use', async () => {
  const locked = new Map([['G', 'another-process']]);
  const gh = attachment({ id: 'A-gh', provider: 'github', remote_id: 'octo/h', options: { branch: 'main' } });
  const tokens = { 'A-gh': { grant_id: 'G', provider: 'github', client: 'quorum', refresh_token: 'gh-rt-1' } };
  const busy = workerDb({ attachments: [gh], tokens, locked });
  const fetchImpl = fakeFetch([[/login\/oauth\/access_token/, (_u, init) => res(200, { access_token: 'gh-at', refresh_token: String(init.body).includes('gh-rt-2') ? 'gh-rt-3' : 'gh-rt-2', expires_in: 1 })], [/branches\/main$/, () => res(200, { commit: { sha: 'c' } })], [/git\/trees/, () => res(200, { tree: [] })]]);
  const [r1] = await createKbSyncWorker({ db: busy.db, config, fetchImpl, sleep: async () => {} }).tick();
  assert.equal(r1.code, 'network');
  assert.equal(fetchImpl.seen.length, 0, 'no refresh while another process holds the lock');

  let refuse = true;
  const flaky = workerDb({ attachments: [gh], tokens, store: () => (refuse ? { message: 'down' } : null) });
  const w = createKbSyncWorker({ db: flaky.db, config, fetchImpl, sleep: async () => {} });
  const [r2] = await w.tick();
  assert.equal(r2.ok, false, 'the access token is not used before its rotated refresh token is stored');
  assert.ok(flaky.locked.has('G'), 'the lock is left to expire so nobody refreshes with the spent token');
  assert.equal(flaky.db.calls.filter((c) => c.rpc === 'kb_sync_token_store').length, 3);
  refuse = false;
  flaky.locked.clear();
  await w.tick();
  const stores = flaky.db.calls.filter((c) => c.rpc === 'kb_sync_token_store').map((c) => c.args.token);
  assert.deepEqual(stores.slice(3), ['gh-rt-2', 'gh-rt-3'], 'the kept token goes in first, then the next rotation');
  assert.ok(fetchImpl.seen.some((c) => /access_token$/.test(c.url) && String(c.init.body).includes('refresh_token=gh-rt-2')), 'the kept token is the one refreshed');
});

test('a revoke the provider does not confirm is retried later, never dropped silently', async () => {
  const { db } = workerDb({ attachments: [], revocations: [{ grant_id: 'G8', provider: 'google-drive', client: 'quorum', refresh_token: RT }] });
  const fetchImpl = fakeFetch([[/oauth2\.googleapis\.com\/revoke/, () => res(500, {})]]);
  await createKbSyncWorker({ db, config, fetchImpl, sleep: async () => {} }).tick();
  assert.ok(db.calls.some((c) => c.rpc === 'kb_sync_revoke_failed' && c.args.grant_id === 'G8'));
  assert.ok(!db.calls.some((c) => c.rpc === 'kb_sync_revoked'));
});

function attachReq(body, token = 'session') {
  const req = new EventEmitter();
  req.method = 'POST';
  req.headers = { authorization: `Bearer ${token}` };
  req.socket = { remoteAddress: '127.0.0.1' };
  setImmediate(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end'); });
  return req;
}
function captureRes() {
  const r = { status: null, body: null, writeHead(s) { r.status = s; }, end(b) { r.body = JSON.parse(b); } };
  return r;
}

test('attach checks the session and the token, stores the rotated token, and never returns it', async () => {
  const stored = [];
  let liveGrant = null, lockHolder = null;
  const db = fakeDb({
    tables: { knowledge_bases: [{ id: KB, workspace_id: WS }], workspaces: [{ id: WS, plan: 'paid', deleted_at: null }] },
    rpcs: {
      kb_sync_attach: (args) => { stored.push(args); return { data: { id: 'A1', status: 'pending', connected: true }, error: null }; },
      kb_sync_grant_of: () => ({ data: liveGrant, error: null }),
      kb_sync_refresh_lock: ({ owner }) => { if (lockHolder && lockHolder !== owner) return { data: false, error: null }; lockHolder = owner; return { data: true, error: null }; },
      kb_sync_refresh_unlock: ({ owner }) => { if (lockHolder === owner) lockHolder = null; return { data: null, error: null }; },
    },
  });
  const anon = { auth: { getUser: async (t) => (t === 'session' ? { data: { user: { id: ADMIN } }, error: null } : { data: { user: null }, error: new Error('bad') }) } };
  const fetchImpl = fakeFetch([[/login\/oauth\/access_token/, (_u, init) => (String(init.body).includes('gh-rt-1') ? res(200, { access_token: 'gh-at', refresh_token: 'gh-rt-2' }) : res(400, { error: 'bad_refresh_token' }))]]);
  const pokes = [];
  const deps = { clients: { anon, db }, config, fetchImpl, worker: { poke: () => pokes.push(1) }, limit: { allow: () => true } };
  const body = { kb_id: KB, provider: 'github', remote: { id: 'octo/handbook', kind: 'folder', name: 'octo/handbook', branch: 'main', path: 'docs' }, refresh_token: 'gh-rt-1' };

  const r = captureRes();
  await handleKbSyncAttach(attachReq(body), r, deps);
  assert.equal(r.status, 200);
  assert.equal(stored[0].token, 'gh-rt-2', 'the rotated token is stored');
  assert.equal(stored[0].uid, ADMIN);
  assert.deepEqual(stored[0].options, { branch: 'main', path: 'docs' });
  assert.ok(!JSON.stringify(r.body).includes('gh-rt'));
  assert.equal(pokes.length, 1);

  const refused = captureRes();
  await handleKbSyncAttach(attachReq({ ...body, refresh_token: 'nope' }), refused, deps);
  assert.equal(refused.status, 400);
  assert.equal(stored.length, 1, 'a refused token is not stored');

  // a token for a grant the worker is refreshing waits for its lock, and gives up with a 409
  liveGrant = 'G-live'; lockHolder = 'kbsync-worker';
  const busy = captureRes();
  await handleKbSyncAttach(attachReq(body), busy, { ...deps, sleep: async () => {} });
  assert.equal(busy.status, 409);
  assert.equal(stored.length, 1);
  lockHolder = null;
  const again = captureRes();
  await handleKbSyncAttach(attachReq(body), again, { ...deps, sleep: async () => {} });
  assert.equal(again.status, 200);
  assert.equal(lockHolder, null, 'the attach unlocks the grant');
  liveGrant = null;

  const signedOut = captureRes();
  await handleKbSyncAttach(attachReq(body, 'expired'), signedOut, deps);
  assert.equal(signedOut.status, 401);

  assert.throws(() => cleanAttach({ provider: 'notion', remote: { id: 'x', kind: 'folder' } }), /cannot sync folders yet/);
  assert.throws(() => cleanAttach({ provider: 'google-drive', remote: { id: 'x', kind: 'drive' } }), /folder or a file/);
});

test('one owner per file: a file another admin added on their Mac is not written a second time', async () => {
  const tables = { notes: [{ id: 'mac', path: 'Knowledge bases/Handbook/Plan.md', kb_id: KB, user_id: 'another-admin', frontmatter: { kb_source: 'google-drive:d1', visibility: 'public' }, hash: 'h' }], kb_folders: [], kb_note_upstream: [] };
  const db = fakeDb({ tables, rpcs: upstreamRpcs(tables) });
  const files = [{ parent: 'root-folder', id: 'd1', name: 'Plan.md', mimeType: 'text/markdown', modifiedTime: 'm' }];
  const r = await syncAttachment({ db, attachment: attachment(), provider: googleDrive, token: 't', fetchImpl: fakeFetch(driveRoutes(files)) });
  assert.equal(r.written, 0);
  assert.equal(tables.notes.length, 1);
  assert.match(r.skipped[0].reason, /Another admin added this file/);
});

test('an attach sent again with its attach id answers the first attachment without using the token again', async () => {
  const stored = [];
  const db = fakeDb({
    tables: { knowledge_bases: [{ id: KB, workspace_id: WS }], workspaces: [{ id: WS, plan: 'paid', deleted_at: null }] },
    rpcs: {
      kb_sync_attachment_by_attach_id: ({ attach_id }) => ({ data: attach_id === 'attach-1234-abcd' ? { id: 'A-first', attach_id } : null, error: null }),
      kb_sync_attach: (args) => { stored.push(args); return { data: { id: 'A-new' }, error: null }; },
      kb_sync_grant_of: () => ({ data: null, error: null }),
    },
  });
  const anon = { auth: { getUser: async () => ({ data: { user: { id: ADMIN } }, error: null }) } };
  const fetchImpl = fakeFetch([[/access_token/, () => res(200, { access_token: 'gh-at', refresh_token: 'gh-rt-2' })]]);
  const deps = { clients: { anon, db }, config, fetchImpl, limit: { allow: () => true } };
  const body = { kb_id: KB, provider: 'github', remote: { id: 'octo/h', kind: 'folder', name: 'octo/h' }, refresh_token: 'gh-rt-1', attach_id: 'attach-1234-abcd' };
  const again = captureRes();
  await handleKbSyncAttach(attachReq(body), again, deps);
  assert.equal(again.status, 200);
  assert.equal(again.body.attachment.id, 'A-first');
  assert.equal(fetchImpl.seen.length, 0, 'the token is not refreshed again');
  assert.equal(stored.length, 0);
  const fresh = captureRes();
  await handleKbSyncAttach(attachReq({ ...body, attach_id: 'attach-5678-efgh' }), fresh, deps);
  assert.equal(fresh.body.attachment.id, 'A-new');
  assert.equal(stored[0].attach_id, 'attach-5678-efgh');
  const bad = captureRes();
  await handleKbSyncAttach(attachReq({ ...body, attach_id: 'no spaces allowed' }), bad, deps);
  assert.equal(bad.status, 400);
});
