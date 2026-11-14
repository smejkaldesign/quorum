// Importing a knowledge base from a public GitHub repository or a zip (Cloud edition; docs/specs/workspace-knowledge.md,
// "Filling a KB in the MVP"; migration 0026). Folders in the source become kb_folders, nested the same way, and each
// markdown file becomes a note in the matching folder. Nothing is written to disk: the archive is read in memory
// (ee/zipRead.js), and each note goes up as the importer's own notes row through the remote store, the same row a
// vault push writes, with kb_id and folder_id set. Pull sync then brings the notes to the importer's vault and to
// every reader, as it does for any shared note.
//
// IPC API (preload exposes each as window.quorum.<camelName>):
//
//   kb-import          ({ kbId?, name?, source?, folderId? })  -> { kb: Kb, imported: number, skipped: Skipped[] } | { error }
//   kb-import-pick-zip ()                                      -> { path } | { canceled: true }
//   kb-import-progress (event to the renderer)                   { kbId, phase: 'fetching' | 'reading' | 'writing' | 'done', done, total }
//
//   source      { kind: 'github', url, branch? } | { kind: 'zip', path }. Left out with a kbId, the KB's stored GitHub
//               source is fetched again; a zip has to be chosen again.
//   Skipped     { path, reason }   path inside the source; reason is a sentence for the page
//
// With no kbId a KB is created, named `name`, else the repository or zip name; it is deleted again when the source
// cannot be read. folderId puts the import inside that folder of the KB. An import into a KB that already holds the
// notes updates them by their place in the KB (folder path and file name) and adds none twice. Notes no longer in the
// source are left in the KB. Progress phases: fetching counts bytes (total 0 when the size is unknown), reading counts
// archive entries, writing counts notes, done repeats the imported count.
import { createHash } from 'node:crypto';
import { readFile as fsReadFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { plain } from './account.js';
import { checkName, shapeKb } from './knowledgeBases.js';
import { createRemote, ulid } from './store/remote.js';
import { parseFrontmatter } from './sync.js';
import { listZip, MAX_BYTES, readEntry } from './zipRead.js';

const BATCH = 100;
const PAGE = 1000;
const MAX_NOTE_BYTES = 5 * 1024 * 1024;
const MARKDOWN = /\.(md|markdown)$/i;
export const PRIVATE_REPO = 'That repository was not found, or it is private. Private repositories need the GitHub connector, which comes later.';

// https://github.com/<owner>/<repo>, with an optional .git, trailing slash or /tree/<branch>; a branch given apart
// from the address wins over one inside it
const GITHUB = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})\/([A-Za-z0-9._-]{1,100})(?:\/tree\/([^?#\s]+?))?\/?$/;
export function checkBranch(b) {
  const s = String(b ?? '').trim();
  if (!s) return { branch: null };
  if (s.length > 200 || !/^[A-Za-z0-9._/-]+$/.test(s) || s.startsWith('-') || s.startsWith('/') || s.endsWith('/') || s.endsWith('.lock') || s.includes('..') || s.includes('//')) return { error: 'That branch name is not valid.' };
  return { branch: s };
}
export function parseGithubUrl(url, branch) {
  const raw = String(url ?? '').trim();
  if (!raw) return { error: 'Enter the repository address.' };
  const m = raw.match(GITHUB);
  if (!m) return { error: 'Enter a GitHub repository address, like https://github.com/owner/repository.' };
  const repo = m[2].replace(/\.git$/i, '');
  if (!repo || repo === '.' || repo === '..') return { error: 'Enter a GitHub repository address, like https://github.com/owner/repository.' };
  const b = checkBranch(branch ?? (m[3] ? decodeURIComponent(m[3]) : ''));
  if (b.error) return b;
  return { owner: m[1], repo, branch: b.branch, url: `https://github.com/${m[1]}/${repo}` };
}

class ImportError extends Error {
  constructor(message) { super(message); this.code = 'IMPORT'; }
}

// a response body as one Buffer, refused past the cap; onBytes reports progress
async function readCapped(res, onBytes, cap = MAX_BYTES) {
  const total = Number(res.headers?.get?.('content-length')) || 0;
  if (total > cap) throw new ImportError(`The repository archive is larger than ${Math.round(cap / 1024 / 1024)} MB.`);
  const reader = res.body?.getReader?.();
  if (!reader) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > cap) throw new ImportError(`The repository archive is larger than ${Math.round(cap / 1024 / 1024)} MB.`);
    onBytes(buf.length, total || buf.length);
    return buf;
  }
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > cap) { try { await reader.cancel(); } catch {} throw new ImportError(`The repository archive is larger than ${Math.round(cap / 1024 / 1024)} MB.`); }
    parts.push(Buffer.from(value));
    onBytes(size, total);
  }
  return Buffer.concat(parts);
}

// the repository's zip from GitHub without credentials: the API says whether the repository is public and names its
// default branch, then codeload serves the archive of that branch
export async function fetchGithubZip({ owner, repo, branch }, { fetch: get = globalThis.fetch, onBytes = () => {} } = {}) {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'Quorum' };
  const reach = async (url, h) => { try { return await get(url, { headers: h, redirect: 'follow' }); } catch { throw new ImportError('GitHub could not be reached. Check your connection and try again.'); } };
  const api = await reach(`https://api.github.com/repos/${owner}/${repo}`, headers);
  if (api.status === 404 || api.status === 401) throw new ImportError(PRIVATE_REPO);
  if (api.status === 403 || api.status === 429) throw new ImportError('GitHub is limiting requests right now. Try again in a few minutes.');
  if (!api.ok) throw new ImportError('GitHub could not be reached. Try again in a moment.');
  const info = await api.json().catch(() => ({}));
  if (info?.private) throw new ImportError(PRIVATE_REPO);
  const ref = branch || info?.default_branch || 'HEAD';
  const zip = await reach(`https://codeload.github.com/${owner}/${repo}/zip/${ref.split('/').map(encodeURIComponent).join('/')}`, { 'user-agent': 'Quorum' });
  if (zip.status === 404) throw new ImportError(branch ? `The branch ${branch} was not found in that repository.` : PRIVATE_REPO);
  if (zip.status === 403 || zip.status === 429) throw new ImportError('GitHub is limiting requests right now. Try again in a few minutes.');
  if (!zip.ok) throw new ImportError('GitHub could not send the repository. Try again in a moment.');
  return { buf: await readCapped(zip, onBytes), branch: ref };
}

// paths an import passes over without a word: dot files and folders, macOS resource forks, installed packages
const quiet = (p) => p.split('/').some((s) => s.startsWith('.') || s === '__MACOSX' || s === 'node_modules');

// the markdown files in an archive, as { rel, text }, with every other file named in skipped. One folder that holds
// everything (a GitHub archive's "repo-branch/", a zipped folder) is taken off the front of each path
export function readArchive(buf, { onEntry = () => {} } = {}) {
  const entries = listZip(buf);
  const live = entries.filter((e) => !quiet(e.path));
  const tops = new Set(live.map((e) => e.path.split('/')[0]));
  const rootFiles = live.some((e) => !e.dir && !e.path.includes('/'));
  const strip = tops.size === 1 && !rootFiles ? `${[...tops][0]}/` : '';
  const files = [];
  const skipped = [];
  let n = 0;
  for (const e of live) {
    n++;
    if (n % 100 === 0) onEntry(n, live.length);
    if (e.dir) continue;
    const rel = strip && e.path.startsWith(strip) ? e.path.slice(strip.length) : e.path;
    if (!rel) continue;
    if (e.symlink) { skipped.push({ path: rel, reason: 'Symbolic links are not imported.' }); continue; }
    if (!MARKDOWN.test(rel)) { skipped.push({ path: rel, reason: 'Only markdown files are imported.' }); continue; }
    if (e.encrypted) { skipped.push({ path: rel, reason: 'The file is encrypted.' }); continue; }
    if (e.size > MAX_NOTE_BYTES) { skipped.push({ path: rel, reason: 'The file is larger than 5 MB.' }); continue; }
    if (e.method !== 0 && e.method !== 8) { skipped.push({ path: rel, reason: 'The file is compressed in a way Quorum cannot read.' }); continue; }
    files.push({ rel, text: readEntry(buf, e).toString('utf8').replace(/^\uFEFF/, '') });
  }
  onEntry(live.length, live.length);
  return { files, skipped };
}

// a frontmatter value on one line, quoted when YAML would read it as something else
const fmValue = (v) => { const s = String(v).replace(/[\r\n]+/g, ' ').trim(); return /^[\w./@~+-][\w ./:@~+%=-]*$/.test(s) && !/:\s/.test(s) ? s : `"${s.replace(/"/g, "'")}"`; };
// the file's text with its frontmatter set: shared with the workspace, and where it came from
export function sharedText(text, sourceLine) {
  const body = String(text).replace(/\r\n?/g, '\n');
  const set = { visibility: 'public', kb_source: fmValue(sourceLine) };
  const m = body.match(/^---\n([\s\S]*?)\n---(\n|$)/);
  if (!m) return `---\n${Object.entries(set).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n${body}`;
  const kept = m[1].split('\n').filter((l) => !Object.keys(set).some((k) => l.startsWith(`${k}:`)));
  return `---\n${[...kept, ...Object.entries(set).map(([k, v]) => `${k}: ${v}`)].join('\n')}\n---${m[2]}${body.slice(m[0].length)}`;
}

const safeSeg = (s) => String(s ?? '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Knowledge base';
const sha256 = (t) => createHash('sha256').update(t).digest('hex');
const keyOf = (segs) => segs.map((s) => s.trim().toLowerCase()).join('/');

export function createKbImport({ account, fetch: get = globalThis.fetch, readFile = fsReadFile, statFile = stat, pickZip = async () => null, toUI = () => {}, log = () => {} }) {
  const ready = (admin) => {
    if (!account.client()) return { error: 'Hosted accounts are not set up in this build.' };
    const s = account.state();
    if (!s.signedIn) return { error: 'Sign in first.' };
    if (!s.workspace) return { error: 'Pick a workspace first.' };
    if (admin && s.workspace.role === 'member') return { error: 'Only owners and admins can create a knowledge base.' };
    return null;
  };
  const ws = () => account.state().workspace.id;
  const rpc = async (name, args) => {
    const { data, error } = await account.client().rpc(name, args);
    if (error) throw Object.assign(new Error(error.message), { code: error.code ?? '' });
    return data;
  };
  const findKb = async (kbId) => ((await rpc('kb_list', { workspace_id: ws() })) ?? []).find((k) => k.id === kbId) ?? null;
  // fetching reports at most once per 256 KB, so a large download does not flood the renderer
  let lastBytes = -1;
  const progress = (kbId, phase, done, total) => {
    if (phase === 'fetching' && done > 0 && done < total && done - lastBytes < 256 * 1024) return;
    if (phase === 'fetching') lastBytes = done;
    toUI('kb-import-progress', { kbId, phase, done, total });
  };

  // every live note in the KB the person can read, page by page
  const kbNotes = async (kbId) => {
    const rows = [];
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await account.client().from('notes').select('id, path, folder_id, user_id')
        .eq('workspace_id', ws()).eq('kb_id', kbId).is('deleted_at', null).order('id').range(offset, offset + PAGE - 1);
      if (error) throw error;
      rows.push(...(data ?? []));
      if ((data ?? []).length < PAGE) return rows;
    }
  };

  // the source's bytes and the KB's name for it, before anything is created
  const resolveSource = async (source, stored) => {
    const src = source ?? (stored?.kind === 'github' ? { kind: 'github', url: stored.url, branch: stored.branch ?? undefined } : null);
    if (!src) return { error: stored?.kind === 'zip' ? 'Choose the zip again to refresh this knowledge base.' : 'Choose a GitHub repository or a zip to import.' };
    if (src.kind === 'github') {
      const g = parseGithubUrl(src.url, src.branch);
      if (g.error) return g;
      return { kind: 'github', gh: g, asked: g.branch, name: g.repo };
    }
    if (src.kind === 'zip') {
      const p = String(src.path ?? '');
      if (!p || !path.isAbsolute(p) || !/\.zip$/i.test(p)) return { error: 'Choose a .zip file.' };
      return { kind: 'zip', file: p, name: path.basename(p).replace(/\.zip$/i, '') };
    }
    return { error: 'Choose a GitHub repository or a zip to import.' };
  };
  const fetchBytes = async (src, kbId) => {
    if (src.kind === 'github') {
      const r = await fetchGithubZip(src.gh, { fetch: get, onBytes: (done, total) => progress(kbId, 'fetching', done, total) });
      src.gh.branch = r.branch;
      return r.buf;
    }
    let info;
    try { info = await statFile(src.file); } catch { throw new ImportError('That zip could not be opened.'); }
    if (info.size > MAX_BYTES) throw new ImportError(`The zip is larger than ${Math.round(MAX_BYTES / 1024 / 1024)} MB.`);
    progress(kbId, 'fetching', 0, info.size);
    const buf = await readFile(src.file);
    progress(kbId, 'fetching', buf.length, buf.length);
    return buf;
  };
  const sourceLine = (src, rel) => (src.kind === 'github' ? `${src.gh.url}/blob/${src.gh.branch}/${rel}` : `${src.name}.zip/${rel}`);

  let running = false;
  async function importKb(req = {}) {
    if (running) return { error: 'An import is already running. Wait for it to finish.' };
    const no = ready(!req.kbId); if (no) return no;
    running = true;
    let kbId = req.kbId ?? null;
    let created = false;
    let wrote = 0;
    try {
      let kb = null;
      if (kbId) {
        kb = await findKb(kbId);
        if (!kb) return { error: 'That knowledge base no longer exists.' };
        if (kb.role !== 'admin') return { error: 'Only the knowledge base\'s admins can import into it.' };
      }
      const src = await resolveSource(req.source ?? null, kb?.source ?? null);
      if (src.error) return src;
      if (!kb) {
        const n = checkName(req.name || src.name);
        if (n.error) return n;
        kb = await rpc('kb_create', { workspace_id: ws(), name: n.name.slice(0, 120), kind: 'general' });
        kbId = kb.id; created = true;
      }
      const folders = Array.isArray(kb.folders) ? kb.folders : [];
      const byId = new Map(folders.map((f) => [f.id, f]));
      const segsOf = (id) => { const out = []; for (let f = byId.get(id), guard = 0; f && guard < 1000; f = byId.get(f.parent_id ?? f.parentId), guard++) out.unshift(f.name); return out; };
      const rootId = req.folderId ?? null;
      if (rootId && !byId.has(rootId)) throw new ImportError('That folder is not in this knowledge base.');
      const rootSegs = rootId ? segsOf(rootId) : [];

      lastBytes = -1;
      progress(kbId, 'fetching', 0, 0);
      const buf = await fetchBytes(src, kbId);
      const { files, skipped } = readArchive(buf, { onEntry: (done, total) => progress(kbId, 'reading', done, total) });

      // folders: the KB's own by their path of names (the server compares names without case), then the missing ones
      // made parent first. Only folders on the way to a markdown file are made
      const folderAt = new Map([[keyOf(rootSegs), rootId]]);
      for (const f of folders) folderAt.set(keyOf(segsOf(f.id)), f.id);
      const failedDir = new Map();
      const dirs = [...new Set(files.map((f) => path.posix.dirname(f.rel)).filter((d) => d !== '.'))];
      const wanted = new Set();
      for (const d of dirs) { const segs = d.split('/'); for (let i = 1; i <= segs.length; i++) wanted.add(segs.slice(0, i).join('/')); }
      for (const d of [...wanted].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))) {
        const segs = d.split('/');
        const parent = segs.slice(0, -1).join('/');
        if (parent && failedDir.has(parent)) { failedDir.set(d, failedDir.get(parent)); continue; }
        const key = keyOf([...rootSegs, ...segs]);
        if (folderAt.has(key)) continue;
        const n = checkName(segs.at(-1), { folder: true });
        if (n.error) { failedDir.set(d, n.error); continue; }
        try {
          const f = await rpc('kb_folder_create', { kb_id: kbId, parent_id: folderAt.get(keyOf([...rootSegs, ...segs.slice(0, -1)])) ?? null, name: n.name, position: null });
          folderAt.set(key, f.id);
        } catch (err) { failedDir.set(d, plain(err, 'The folder could not be created.')); }
      }

      // notes: an existing note at the same place in the KB keeps its id and path; another member's note there stays
      const me = account.state().userId;
      const existing = new Map();
      for (const n of await kbNotes(kbId)) {
        const name = path.posix.basename(String(n.path ?? ''));
        existing.set(keyOf([...(n.folder_id ? segsOf(n.folder_id) : []), name]), n);
      }
      const prefix = `Knowledge bases/${safeSeg(kb.name)}`;
      const rows = [];
      const seen = new Set();
      for (const f of files) {
        const dir = path.posix.dirname(f.rel);
        if (dir !== '.' && failedDir.has(dir)) { skipped.push({ path: f.rel, reason: failedDir.get(dir) }); continue; }
        const file = path.posix.basename(f.rel).replace(/\.markdown$/i, '.md');
        const kbSegs = [...rootSegs, ...(dir === '.' ? [] : dir.split('/')), file];
        const key = keyOf(kbSegs);
        if (seen.has(key)) { skipped.push({ path: f.rel, reason: 'Another file in the import has the same name in this folder.' }); continue; }
        seen.add(key);
        const text = sharedText(f.text, sourceLine(src, f.rel));
        const frontmatter = parseFrontmatter(text);
        if (frontmatter.confidential) { skipped.push({ path: f.rel, reason: 'The note is marked confidential.' }); continue; }
        const had = existing.get(key);
        if (had && had.user_id !== me) { skipped.push({ path: f.rel, reason: 'Another member\'s note is already at this place in the knowledge base.' }); continue; }
        rows.push({ id: had?.id ?? ulid(), rel: had?.path ?? `${prefix}/${kbSegs.join('/')}`, text, frontmatter, hash: sha256(text), mtime: new Date().toISOString(), kbId, folderId: folderAt.get(keyOf(kbSegs.slice(0, -1))) ?? null, from: f.rel });
      }

      const remote = createRemote({ client: account.client(), workspaceId: ws(), userId: me });
      progress(kbId, 'writing', 0, rows.length);
      for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH);
        try { await remote.notes.pushMany(batch); wrote += batch.length; } catch (err) {
          if (!/duplicate key|notes_workspace_path/i.test(String(err?.message))) throw err;
          // a path another note already holds fails the whole batch; one at a time finds which
          for (const r of batch) {
            try { await remote.notes.push(r); wrote++; } catch (e) {
              if (!/duplicate key|notes_workspace_path/i.test(String(e?.message))) throw e;
              skipped.push({ path: r.from, reason: 'Another note in the workspace already uses this path.' });
            }
          }
        }
        progress(kbId, 'writing', Math.min(i + BATCH, rows.length), rows.length);
      }

      const stored = src.kind === 'github' ? { kind: 'github', url: src.gh.url, branch: src.asked, name: src.gh.repo } : { kind: 'zip', name: `${src.name}.zip` };
      let shaped = null;
      try { shaped = await rpc('kb_source_set', { kb_id: kbId, source: stored }); } catch (err) { log('kb-import', 'source not stored', err?.message ?? err); }
      shaped ??= await findKb(kbId);
      progress(kbId, 'done', wrote, wrote);
      log('kb-import', `${wrote} notes into ${kbId}, ${skipped.length} skipped`);
      return { kb: shapeKb(shaped ?? kb), imported: wrote, skipped };
    } catch (err) {
      log('kb-import', err?.message ?? err);
      if (created && !wrote) { try { await rpc('kb_delete', { kb_id: kbId }); } catch (e) { log('kb-import', 'cleanup', e?.message ?? e); } }
      const msg = err?.code === 'IMPORT' || err?.code === 'ZIP' ? err.message : plain(err, 'The import could not finish.');
      return { error: wrote ? `The import stopped after ${wrote} notes. ${msg}` : msg };
    } finally { running = false; }
  }

  const handlers = {
    'kb-import': (req) => importKb(req ?? {}),
    'kb-import-pick-zip': async () => {
      const p = await pickZip();
      return p ? { path: p } : { canceled: true };
    },
  };
  return { handlers, importKb };
}

export function registerKbImport({ ipcMain, account, log, toUI, pickZip }) {
  const k = createKbImport({ account, log, toUI, pickZip });
  for (const [name, fn] of Object.entries(k.handlers)) ipcMain.handle(name, (_e, ...a) => fn(...a));
  return k;
}
