// Importing a knowledge base from a public GitHub repository or a zip (Cloud edition; docs/specs/workspace-knowledge.md,
// "Filling a KB in the MVP"; migration 0026). Folders in the source become kb_folders, nested the same way, and each
// markdown file becomes a note in the matching folder. Nothing is written to disk: the archive is read in memory
// (ee/zipRead.js), and each note goes up as the importer's own notes row through the remote store, the same row a
// vault push writes, with kb_id and folder_id set. Pull sync then brings the notes to the importer's vault and to
// every reader, as it does for any shared note.
//
// IPC API (preload exposes each as window.quorum.<camelName>):
//
//   kb-import          ({ kbId?, name?, source?, folderId? })  -> { kb: Kb, imported, removed, kept, suggested, skipped: Skipped[] } | { error, skipped? }
//   kb-import-pick-zip ()                                      -> { path } | { canceled: true }
//   kb-import-progress (event to the renderer)                   { kbId, phase: 'fetching' | 'reading' | 'writing' | 'done', done, total }
//
//   source      { kind: 'github', url, branch? } | { kind: 'zip', path }. A GitHub address may end in /tree/<branch>/<folder>
//               to import that folder only. Left out with a kbId, the KB's stored GitHub source is fetched again; a zip
//               has to be chosen again.
//   Skipped     { path, reason }   path inside the source; reason is a sentence for the page
//
// With no kbId a KB is created, named `name`, else the repository or zip name; it is deleted again when the source
// cannot be read or nothing in it could be imported. folderId puts the import inside that folder of the KB.
// Re-importing into a KB updates the notes an earlier import wrote (they carry kb_source) at the same place in the KB
// (folder path and file name), adds none twice, and removes those from the same source that are gone from it (counted
// in removed). A note written by hand at the same place is left alone, as is another member's note. A note Quorum (or
// the person) edited since the last import (ee/kbUpstream.js) stays as it is while the source has not changed (kept);
// when the source changed, the source's text is written and Quorum's edit is kept as a suggestion (counted in suggested).
// Nothing is ever written back to GitHub or the zip. Progress phases:
// fetching counts bytes (total 0 when the size is unknown), reading counts archive entries, writing counts notes, done
// repeats the imported count.
import { createHash } from 'node:crypto';
import { readFile as fsReadFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { plain } from './account.js';
import { checkName, kbSession, shapeKb } from './knowledgeBases.js';
import { baseRow, syncUpstream } from './kbUpstream.js';
import { createRemote, ulid } from './store/remote.js';
import { notes as localNotes } from '../store/local.js';
import { parseFrontmatter } from './sync.js';
import { listZip, MAX_BYTES, readEntry } from './zipRead.js';
import { parseGithubUrl, resolveTree } from './githubUrl.js';

const BATCH = 100;
const FOLDER_CALLS = 8;
const MAX_NOTE_BYTES = 5 * 1024 * 1024;
const PROGRESS_BYTES = 256 * 1024;
const MARKDOWN = /\.(md|markdown)$/i;
export const PRIVATE_REPO = 'That repository was not found, or it is private. Private repositories need the GitHub connector, which comes later.';
export const RATE_LIMITED = 'GitHub is limiting requests from this network. Try again in an hour.';
// the address checks are shared with folder sync and the renderer (ee/githubUrl.js)
export { checkBranch, parseGithubUrl } from './githubUrl.js';

class ImportError extends Error {
  constructor(message) { super(message); this.code = 'IMPORT'; }
}

// a response body as one Buffer, refused past the cap; onBytes reports progress
async function readCapped(res, onBytes, cap = MAX_BYTES) {
  const tooLarge = () => new ImportError(`The repository archive is larger than ${Math.round(cap / 1024 / 1024)} MB.`);
  const total = Number(res.headers?.get?.('content-length')) || 0;
  if (total > cap) throw tooLarge();
  const reader = res.body?.getReader?.();
  if (!reader) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > cap) throw tooLarge();
    onBytes(buf.length, total || buf.length);
    return buf;
  }
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > cap) { try { await reader.cancel(); } catch {} throw tooLarge(); }
    parts.push(Buffer.from(value));
    onBytes(size, total);
  }
  return Buffer.concat(parts);
}

// the repository's zip from GitHub without credentials. The API says whether the repository is public and names its
// default branch; a /tree/ path is split into a branch and a folder by asking for the branches that start with its
// first segment and taking the longest one the path begins with. codeload then serves the branch's archive
export async function fetchGithubZip({ owner, repo, branch = null, tree = null }, { fetch: get = globalThis.fetch, onBytes = () => {} } = {}) {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'Quorum' };
  const reach = async (url, h) => { try { return await get(url, { headers: h, redirect: 'follow' }); } catch { throw new ImportError('GitHub could not be reached. Check your connection and try again.'); } };
  const limited = (res) => res.status === 403 || res.status === 429;
  const api = await reach(`https://api.github.com/repos/${owner}/${repo}`, headers);
  if (api.status === 404 || api.status === 401) throw new ImportError(PRIVATE_REPO);
  if (limited(api)) throw new ImportError(RATE_LIMITED);
  if (!api.ok) throw new ImportError('GitHub could not be reached. Try again in a moment.');
  const info = await api.json().catch(() => ({}));
  if (info?.private) throw new ImportError(PRIVATE_REPO);

  let ref = branch;
  let subpath = null;
  if (tree) {
    const t = await resolveTree({ owner, repo, tree, branch }, (url) => reach(url, headers));
    if (t.error) throw new ImportError(t.code === 'limited' ? RATE_LIMITED : t.error);
    ref = t.branch;
    subpath = t.path;
  }
  ref ||= info?.default_branch || 'HEAD';
  const zip = await reach(`https://codeload.github.com/${owner}/${repo}/zip/${ref.split('/').map(encodeURIComponent).join('/')}`, { 'user-agent': 'Quorum' });
  if (zip.status === 404) throw new ImportError(branch ? `The branch ${branch} was not found in that repository.` : PRIVATE_REPO);
  if (limited(zip)) throw new ImportError(RATE_LIMITED);
  if (!zip.ok) throw new ImportError('GitHub could not send the repository. Try again in a moment.');
  return { buf: await readCapped(zip, onBytes), branch: ref, subpath };
}

// paths an import passes over without a word: dot files and folders, macOS resource forks, installed packages
const quiet = (p) => p.split('/').some((s) => s.startsWith('.') || s === '__MACOSX' || s === 'node_modules');

// the markdown files in an archive, as { rel, text }, with every other file named in skipped. One folder that holds
// everything (a GitHub archive's "repo-branch/", a zipped folder) is taken off the front of each path first, ignoring a
// top-level __MACOSX folder; then subpath, when given, keeps only that folder's contents. A file that cannot be read
// from the archive is skipped with its path and the import goes on
export function readArchive(buf, { subpath = null, onEntry = () => {} } = {}) {
  const entries = listZip(buf).filter((e) => e.path.split('/')[0] !== '__MACOSX');
  const tops = new Set(entries.map((e) => e.path.split('/')[0]));
  const rootFiles = entries.some((e) => !e.dir && !e.path.includes('/'));
  const strip = tops.size === 1 && !rootFiles ? `${[...tops][0]}/` : '';
  const under = subpath ? `${subpath}/` : '';
  const files = [];
  const skipped = [];
  let inSubpath = !subpath;
  let n = 0;
  for (const e of entries) {
    n++;
    if (n % 100 === 0) onEntry(n, entries.length);
    let rel = strip && e.path.startsWith(strip) ? e.path.slice(strip.length) : e.path;
    if (under) {
      if (rel !== subpath && !rel.startsWith(under)) continue;
      inSubpath = true;
      rel = rel.slice(under.length);
    }
    if (!rel || e.dir || quiet(rel)) continue;
    if (e.symlink) { skipped.push({ path: rel, reason: 'Symbolic links are not imported.' }); continue; }
    if (!MARKDOWN.test(rel)) { skipped.push({ path: rel, reason: 'Only markdown files are imported.' }); continue; }
    if (e.encrypted) { skipped.push({ path: rel, reason: 'The file is encrypted.' }); continue; }
    if (e.size > MAX_NOTE_BYTES) { skipped.push({ path: rel, reason: 'The file is larger than 5 MB.' }); continue; }
    if (e.method !== 0 && e.method !== 8) { skipped.push({ path: rel, reason: 'The file is compressed in a way Quorum cannot read.' }); continue; }
    let text;
    try { text = readEntry(buf, e).toString('utf8').replace(/^\uFEFF/, ''); } catch { skipped.push({ path: rel, reason: 'The file is damaged in the archive.' }); continue; }
    files.push({ rel, text });
  }
  if (!inSubpath) throw new ImportError(`The folder ${subpath} was not found in the repository.`);
  onEntry(entries.length, entries.length);
  return { files, skipped };
}

// a frontmatter value on one line, quoted when YAML would read it as something else
export const fmValue = (v) => { const s = String(v).replace(/[\r\n]+/g, ' ').trim(); return /^[\w./@~+-][\w ./:@~+%=-]*$/.test(s) && !/:\s/.test(s) ? s : `"${s.replace(/"/g, "'")}"`; };
// the file's text with its frontmatter set: shared with the workspace, and where it came from
export function sharedText(text, sourceLine) {
  const body = String(text).replace(/\r\n?/g, '\n');
  return localNotes.setFrontmatterKey(localNotes.setFrontmatterKey(body, 'visibility', 'public'), 'kb_source', fmValue(sourceLine));
}

// a confidential key marks a note that never leaves its author's vault. true, yes, 1 or any other label (a vault's
// own tag, like a team name) is confidential, as the database reads it (note_shared, 0024); false, no, 0, off or an
// empty value is not
const NOT_CONFIDENTIAL = /^(false|no|0|off)?$/i;
export const isConfidential = (fm) => { const v = fm?.confidential; return v !== undefined && v !== null && v !== false && !NOT_CONFIDENTIAL.test(String(v).trim()); };
// the database treats any confidential value as confidential, so a note that says false loses the key before it goes
// up; without this a shared note that says confidential: false would be refused by the KB
export function dropFalseConfidential(text) {
  const m = String(text).match(/^---\n([\s\S]*?)\n---/);
  if (!m) return text;
  const lines = m[1].split('\n');
  const kept = lines.filter((l) => { const kv = l.match(/^confidential:\s*(.*?)\s*$/); return !kv || !NOT_CONFIDENTIAL.test(kv[1].replace(/^["']|["']$/g, '')); });
  return kept.length === lines.length ? text : `---\n${kept.join('\n')}\n---${text.slice(m[0].length)}`;
}
export const safeSeg = (s) => String(s ?? '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Knowledge base';
export const sha256 = (t) => createHash('sha256').update(t).digest('hex');
export const keyOf = (segs) => segs.map((s) => s.trim().toLowerCase()).join('/');
// a KB name from a repository or zip name: trimmed to the 120 characters the server takes
const kbName = (s) => String(s ?? '').trim().slice(0, 120).trim() || 'Imported knowledge base';
// why nothing could be imported, with the skipped files counted by reason
function nothingImported(files, skipped) {
  const counts = new Map();
  for (const s of skipped) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);
  const lead = files ? 'None of the markdown files could be imported.' : 'No markdown files were found in the source.';
  if (!counts.size) return lead;
  return `${lead} Skipped: ${[...counts].map(([r, c]) => `${c} ${c === 1 ? 'file' : 'files'} (${r.replace(/\.$/, '')})`).join(', ')}.`;
}

export function createKbImport({ account, fetch: get = globalThis.fetch, readFile = fsReadFile, statFile = stat, pickZip = async () => null, toUI = () => {}, log = () => {} }) {
  const { ready: sessionReady, rpc, findKb, kbNotes } = kbSession({ account, log, tag: 'kb-import' });
  const ready = (admin) => sessionReady(admin, 'Only owners and admins can create a knowledge base.');
  // fetching reports at most once per 256 KB, whether or not the size is known, plus the first and last byte
  let lastBytes = 0;
  const progress = (kbId, phase, done, total) => {
    if (phase === 'fetching') {
      const last = total > 0 && done >= total;
      if (done > 0 && !last && done - lastBytes < PROGRESS_BYTES) return;
      lastBytes = done;
    }
    toUI('kb-import-progress', { kbId, phase, done, total });
  };

  // who owns each of these notes, as a name for a skipped reason
  const ownerNames = async (ids) => {
    if (!ids.length) return new Map();
    const { data, error } = await account.client().from('profiles').select('user_id, name, email').in('user_id', ids);
    if (error) { log('kb-import', 'profiles', error.message); return new Map(); }
    return new Map((data ?? []).map((p) => [p.user_id, p.name || p.email || null]));
  };

  // the source as the import reads it, before anything is created
  const resolveSource = (source, stored) => {
    const again = stored?.kind === 'github' && stored.url
      ? (stored.subpath && stored.branch ? { kind: 'github', url: `${stored.url}/tree/${stored.branch}/${stored.subpath}` } : { kind: 'github', url: stored.url, branch: stored.branch ?? undefined })
      : null;
    const src = source ?? again;
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
      src.ref = r.branch;
      src.subpath = r.subpath;
      // a branch taken from the address is the one to fetch again on a refresh
      if (src.gh.tree) src.asked = r.branch;
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
  const sourceLine = (src, rel) => (src.kind === 'github' ? `${src.gh.url}/blob/${src.ref}/${src.subpath ? `${src.subpath}/` : ''}${rel}` : `${src.name}.zip/${rel}`);
  // whether a note's kb_source came from this same source: the same repository (and folder), or any zip
  const sameOrigin = (src, ks) => {
    const s = String(ks ?? '');
    if (src.kind === 'zip') return /^[^/]+\.zip\//i.test(s);
    if (!s.startsWith(`${src.gh.url}/blob/`)) return false;
    return !src.subpath || s.includes(`/${src.subpath}/`);
  };

  let running = false;
  async function importKb(req = {}) {
    if (running) return { error: 'An import is already running. Wait for it to finish.' };
    const no = ready(!req.kbId); if (no) return no;
    running = true;
    const wsId = account.state().workspace.id;
    const me = account.state().userId;
    let kbId = req.kbId ?? null;
    let created = false;
    let wrote = 0;
    const dropCreated = async () => { if (created && !wrote) { try { await rpc('kb_delete', { kb_id: kbId }); } catch (e) { log('kb-import', 'cleanup', e?.message ?? e); } } };
    try {
      let kb = null;
      if (kbId) {
        kb = await findKb(kbId);
        if (!kb) return { error: 'That knowledge base no longer exists.' };
        if (kb.role !== 'admin') return { error: 'Only the knowledge base\'s admins can import into it.' };
      }
      const src = resolveSource(req.source ?? null, kb?.source ?? null);
      if (src.error) return src;
      if (!kb) {
        const n = checkName(kbName(req.name || src.name));
        if (n.error) return n;
        kb = await rpc('kb_create', { workspace_id: wsId, name: n.name, kind: 'general' });
        kbId = kb.id; created = true;
      }
      const folders = Array.isArray(kb.folders) ? kb.folders : [];
      const byId = new Map(folders.map((f) => [f.id, f]));
      const segsOf = (id) => { const out = []; for (let f = byId.get(id), guard = 0; f && guard < 1000; f = byId.get(f.parent_id ?? f.parentId), guard++) out.unshift(f.name); return out; };
      const rootId = req.folderId ?? null;
      if (rootId && !byId.has(rootId)) throw new ImportError('That folder is not in this knowledge base.');
      const rootSegs = rootId ? segsOf(rootId) : [];

      lastBytes = 0;
      progress(kbId, 'fetching', 0, 0);
      const buf = await fetchBytes(src, kbId);
      const { files, skipped } = readArchive(buf, { subpath: src.subpath ?? null, onEntry: (done, total) => progress(kbId, 'reading', done, total) });
      if (created && !files.length) { await dropCreated(); return { error: nothingImported(false, skipped), skipped }; }

      // folders: the KB's own by their path of names (the server compares names without case), then the missing ones,
      // one level at a time with a few calls in flight. Only folders on the way to a markdown file are made
      const folderAt = new Map([[keyOf(rootSegs), rootId]]);
      for (const f of folders) folderAt.set(keyOf(segsOf(f.id)), f.id);
      const failedDir = new Map();
      const wanted = new Set();
      for (const f of files) { const segs = f.rel.split('/').slice(0, -1); for (let i = 1; i <= segs.length; i++) wanted.add(segs.slice(0, i).join('/')); }
      const levels = [];
      for (const d of wanted) (levels[d.split('/').length - 1] ??= []).push(d);
      for (const level of levels) {
        const todo = [];
        for (const d of (level ?? []).sort()) {
          const segs = d.split('/');
          const parent = segs.slice(0, -1).join('/');
          if (parent && failedDir.has(parent)) { failedDir.set(d, failedDir.get(parent)); continue; }
          if (folderAt.has(keyOf([...rootSegs, ...segs]))) continue;
          const n = checkName(segs.at(-1), { folder: true });
          if (n.error) { failedDir.set(d, n.error); continue; }
          todo.push({ d, segs, name: n.name });
        }
        for (let i = 0; i < todo.length; i += FOLDER_CALLS) {
          await Promise.all(todo.slice(i, i + FOLDER_CALLS).map(async ({ d, segs, name }) => {
            try {
              const f = await rpc('kb_folder_create', { kb_id: kbId, parent_id: folderAt.get(keyOf([...rootSegs, ...segs.slice(0, -1)])) ?? null, name, position: null });
              folderAt.set(keyOf([...rootSegs, ...segs]), f.id);
            } catch (err) { failedDir.set(d, plain(err, 'The folder could not be created.')); }
          }));
        }
      }

      // notes: an earlier import's note at the same place keeps its id and path; a hand-written note or another
      // member's note there stays as it is
      const existing = new Map();
      const placeKey = (n) => keyOf([...(n.folder_id ? segsOf(n.folder_id) : []), path.posix.basename(String(n.path ?? ''))]);
      const inKb = await kbNotes(kbId, 'id, path, folder_id, user_id, frontmatter, hash');
      for (const n of inKb) existing.set(placeKey(n), n);
      const owners = await ownerNames([...new Set(inKb.filter((n) => n.user_id !== me).map((n) => n.user_id))]);
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
        const text = dropFalseConfidential(sharedText(f.text, sourceLine(src, f.rel)));
        const frontmatter = parseFrontmatter(text);
        if (isConfidential(frontmatter)) { skipped.push({ path: f.rel, reason: 'The note is marked confidential.' }); continue; }
        const had = existing.get(key);
        if (had && had.user_id !== me) {
          const who = owners.get(had.user_id);
          skipped.push({ path: f.rel, reason: who ? `${who} already has a note at this place in the knowledge base.` : 'Another member already has a note at this place in the knowledge base.' });
          continue;
        }
        if (had && !had.frontmatter?.kb_source) { skipped.push({ path: f.rel, reason: 'A note with this name already exists.' }); continue; }
        rows.push({ id: had?.id ?? ulid(), rel: had?.path ?? `${prefix}/${kbSegs.join('/')}`, text, frontmatter, hash: sha256(text), mtime: new Date().toISOString(), kbId, folderId: folderAt.get(keyOf(kbSegs.slice(0, -1))) ?? null, from: f.rel, had: had ?? null });
      }

      // a note Quorum or the person edited since the last import (ee/kbUpstream.js): kept while the source is unchanged,
      // else the source's text with the edit kept as a suggestion. A note already in the KB goes up together with its
      // base in one call; a new note is pushed, then its base recorded. Without migration 0031 every note is pushed
      const upstream = syncUpstream({ client: () => account.client(), ws: () => wsId, log, tag: 'kb-import' });
      await upstream.prepare(rows.filter((r) => r.had).map((r) => ({ id: r.id, hash: r.had.hash })));
      const plans = new Map();
      let kept = 0;
      for (const r of rows.splice(0)) {
        const plan = r.had ? upstream.plan({ id: r.id }, r.text) : null;
        if (plan && !plan.write) { kept++; continue; }
        if (plan) plans.set(r.id, plan);
        rows.push(r);
      }

      progress(kbId, 'writing', 0, rows.length);
      let suggested = 0;
      const synced = upstream.off ? [] : rows.filter((r) => r.had);
      const pushes = upstream.off ? [...rows] : rows.filter((r) => !r.had);
      if (synced.length) {
        const res = await upstream.write(kbId, synced.map((r) => ({ note_id: r.id, body: r.text, frontmatter: r.frontmatter, hash: r.hash, mtime: r.mtime, upstream: baseRow(r.id, r.text, plans.get(r.id).suggestions) })));
        if (!res) pushes.push(...synced);
        else {
          for (const r of synced) {
            if (res.written.has(r.id)) { wrote++; suggested += plans.get(r.id).fresh; continue; }
            const err = res.failed.get(r.id);
            log('kb-import', r.from, err?.message ?? 'not written');
            skipped.push({ path: r.from, reason: plain(err, 'The note could not be written.') });
          }
          progress(kbId, 'writing', wrote, rows.length);
        }
      }

      const remote = createRemote({ client: account.client(), workspaceId: wsId, userId: me });
      const pushed = [];
      const clash = (e) => /duplicate key|notes_workspace_path/i.test(String(e?.message));
      for (let i = 0; i < pushes.length; i += BATCH) {
        const batch = pushes.slice(i, i + BATCH);
        try { await remote.notes.pushMany(batch); wrote += batch.length; pushed.push(...batch); } catch (err) {
          if (!clash(err)) throw err;
          // a path another note already holds fails the whole batch; one at a time finds which
          for (const r of batch) {
            try { await remote.notes.push(r); wrote++; pushed.push(r); } catch (e) {
              if (!clash(e)) throw e;
              skipped.push({ path: r.from, reason: 'Another note in the workspace already uses this path.' });
            }
          }
        }
        progress(kbId, 'writing', Math.min(wrote, rows.length), rows.length);
      }
      if (created && !wrote) { await dropCreated(); return { error: nothingImported(true, skipped), skipped }; }
      await upstream.saveBases(kbId, pushed.map((r) => baseRow(r.id, r.text)));

      // notes an earlier import of this source wrote under the same folder that the source no longer has
      const rootKey = keyOf(rootSegs);
      const gone = inKb.filter((n) => n.user_id === me && sameOrigin(src, n.frontmatter?.kb_source) && !seen.has(placeKey(n)) && (!rootKey || placeKey(n).startsWith(`${rootKey}/`))).map((n) => n.id);
      let removed = 0;
      for (let i = 0; i < gone.length; i += BATCH) {
        const ids = gone.slice(i, i + BATCH);
        const { error } = await account.client().from('notes').update({ deleted_at: new Date().toISOString() }).eq('workspace_id', wsId).eq('user_id', me).in('id', ids);
        if (error) { log('kb-import', 'remove', error.message); break; }
        removed += ids.length;
      }

      const stored = src.kind === 'github' ? { kind: 'github', url: src.gh.url, branch: src.asked, subpath: src.subpath, name: src.gh.repo } : { kind: 'zip', name: `${src.name}.zip` };
      let shaped = null;
      try { shaped = await rpc('kb_source_set', { kb_id: kbId, source: stored }); } catch (err) { log('kb-import', 'source not stored', err?.message ?? err); }
      shaped ??= await findKb(kbId);
      progress(kbId, 'done', wrote, wrote);
      log('kb-import', `${wrote} notes into ${kbId}, ${removed} removed, ${kept} kept, ${suggested} suggested, ${skipped.length} skipped`);
      return { kb: shapeKb(shaped ?? kb), imported: wrote, removed, kept, suggested, skipped };
    } catch (err) {
      log('kb-import', err?.message ?? err);
      await dropCreated();
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
