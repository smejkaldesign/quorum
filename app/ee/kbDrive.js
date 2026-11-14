// Google Drive files attached to a knowledge base folder (Cloud edition; docs/specs/workspace-knowledge.md, "Sources
// inside a KB"). A KB admin picks individual files with the Google Picker (sources/drive.js), which grants Quorum's
// drive.file access to those files only, and each picked file becomes a shared note in the chosen KB folder, written
// the way ee/kbImport.js writes an import: the admin's own notes row with kb_id and folder_id set, visibility public,
// and kb_source naming where it came from (google-drive:<file id>). Pull sync then carries the note to every reader.
// No table is added: the attached files are the KB's notes whose kb_source starts with google-drive:. Syncing runs
// only when an admin asks for it (Sync now); there is no background sync.
//
// IPC API (preload exposes each as window.quorum.<camelName>). Every handler resolves to { error } on a refusal.
//
//   kb-drive-status ()                          -> { connected, available, account }
//   kb-drive-files  (kbId)                      -> { files: DriveFile[] }
//   kb-drive-add    ({ kbId, folderId? })       -> { files, synced, skipped: Skipped[] } | { canceled: true }
//   kb-drive-sync   ({ kbId, fileId? })         -> { files, synced, skipped }    fileId left out syncs every file the
//                                                                                  caller attached to the KB
//   kb-drive-remove ({ kbId, fileId })          -> { files }                       the note leaves the KB and the vaults
//
//   DriveFile   { fileId, noteId, name, folderId, url, syncedAt, modifiedAt, mine }
//   Skipped     { path, reason }   path is the file's name in Drive
//
// connected says the Google Drive account is connected (Settings, Connections); available says this build carries the
// Picker's API key. Picking a file that is already attached to the KB syncs it where it already is. Re-syncing keeps
// the note's id and place, so nothing is duplicated. Only the admin who attached a file syncs or removes it, since
// the note is their row.
import path from 'node:path';
import { plain } from './account.js';
import { fmValue, keyOf, safeSeg, sha256, sharedText } from './kbImport.js';
import { createRemote, ulid } from './store/remote.js';
import { parseFrontmatter } from './sync.js';
import { notes as localNotes } from '../store/local.js';
import { awaitPicker, driveFile, driveText } from '../sources/drive.js';

export const DRIVE_PREFIX = 'google-drive:';
const PAGE = 1000;
const NOT_CONNECTED = 'Connect Google Drive in Settings, Connections first.';
const NOT_AVAILABLE = 'Adding files from Google Drive is not available in this build yet.';

export const driveSource = (fileId) => `${DRIVE_PREFIX}${fileId}`;
export const driveIdOf = (ks) => (String(ks ?? '').startsWith(DRIVE_PREFIX) ? String(ks).slice(DRIVE_PREFIX.length) : null);

// a note file name from a Drive name: the extension dropped, the characters a path cannot hold replaced
export const noteFileName = (name) => `${safeSeg(String(name ?? '').replace(/\.(md|markdown|txt)$/i, '')).replace(/^Knowledge base$/, 'Untitled')}.md`;

// the note's text: the file's text with its frontmatter set (shared, kb_source, the Drive link, the sync time, a title
// when the file has none) and one source line under the frontmatter that names the file in Drive
export function driveNoteText({ text, meta, syncedAt }) {
  let out = sharedText(text, driveSource(meta.id));
  if (meta.url) out = localNotes.setFrontmatterKey(out, 'kb_source_url', fmValue(meta.url));
  out = localNotes.setFrontmatterKey(out, 'kb_synced_at', fmValue(syncedAt));
  if (meta.modifiedTime) out = localNotes.setFrontmatterKey(out, 'kb_source_modified', fmValue(meta.modifiedTime));
  if (!parseFrontmatter(out).title) out = localNotes.setFrontmatterKey(out, 'title', fmValue(meta.name));
  const m = out.match(/^---\n[\s\S]*?\n---\n?/);
  const head = m ? m[0].replace(/\n?$/, '\n') : '';
  const label = String(meta.name).replace(/[[\]]/g, '');
  const line = meta.url ? `> Source: [${label}](${meta.url}) in Google Drive.` : `> Source: ${label} in Google Drive.`;
  return `${head}${line}\n\n${out.slice(m ? m[0].length : 0).replace(/^\n+/, '')}`;
}

const shapeFile = (n, me) => ({
  fileId: driveIdOf(n.frontmatter?.kb_source), noteId: n.id, name: n.frontmatter?.title || path.posix.basename(String(n.path ?? ''), '.md'),
  folderId: n.folder_id ?? null, url: n.frontmatter?.kb_source_url ?? null, syncedAt: n.frontmatter?.kb_synced_at ?? n.updated_at ?? null,
  modifiedAt: n.frontmatter?.kb_source_modified ?? null, mine: n.user_id === me,
});

export function createKbDrive({ account, accounts, picker = null, pick = awaitPicker, open = async () => {}, fetch: get = globalThis.fetch, now = () => new Date(), log = () => {} }) {
  const ready = () => {
    if (!account.client()) return { error: 'Hosted accounts are not set up in this build.' };
    const s = account.state();
    if (!s.signedIn) return { error: 'Sign in first.' };
    if (!s.workspace) return { error: 'Pick a workspace first.' };
    return null;
  };
  const rpc = async (name, args) => {
    const { data, error } = await account.client().rpc(name, args);
    if (error) throw Object.assign(new Error(error.message), { code: error.code ?? '' });
    return data;
  };
  const ws = () => account.state().workspace.id;
  const me = () => account.state().userId;
  const driveAccount = () => accounts.list().find((a) => a.id === 'google-drive') ?? null;
  const available = () => !!picker?.apiKey && !!picker?.appId;

  const findKb = async (kbId) => ((await rpc('kb_list', { workspace_id: ws() })) ?? []).find((k) => k.id === kbId) ?? null;
  const adminKb = async (kbId) => {
    if (!kbId || typeof kbId !== 'string') return { error: 'Pick the knowledge base first.' };
    const kb = await findKb(kbId);
    if (!kb) return { error: 'That knowledge base no longer exists.' };
    if (kb.role !== 'admin') return { error: 'Only the knowledge base\'s admins can add files from Google Drive.' };
    return { kb };
  };
  // every live note in the KB: the attached files are among them, and a new file's name must not repeat another's
  const kbNotes = async (kbId) => {
    const rows = [];
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await account.client().from('notes').select('id, path, folder_id, user_id, frontmatter, updated_at')
        .eq('workspace_id', ws()).eq('kb_id', kbId).is('deleted_at', null).order('id').range(offset, offset + PAGE - 1);
      if (error) throw error;
      rows.push(...(data ?? []));
      if ((data ?? []).length < PAGE) return rows;
    }
  };
  const driveNotes = (rows) => rows.filter((n) => driveIdOf(n.frontmatter?.kb_source));
  const filesOf = (rows) => driveNotes(rows).map((n) => shapeFile(n, me())).sort((a, b) => a.name.localeCompare(b.name));
  const token = async () => {
    const t = await accounts.accessToken('google-drive');
    if (!t) throw Object.assign(new Error(NOT_CONNECTED), { code: 'DRIVE' });
    return t;
  };

  // read each picked file from Drive and write it as a note. An attached file keeps its note (id, path, folder); a new
  // one goes into folderId under a name no other note in that folder has
  async function syncInto(kb, list, folderId) {
    const picks = [...new Map(list.map((p) => [p.id, p])).values()];
    const folders = Array.isArray(kb.folders) ? kb.folders : [];
    const byId = new Map(folders.map((f) => [f.id, f]));
    if (folderId && !byId.has(folderId)) return { error: 'That folder is not in this knowledge base.' };
    const segsOf = (id) => { const out = []; for (let f = byId.get(id), guard = 0; f && guard < 1000; f = byId.get(f.parent_id ?? f.parentId), guard++) out.unshift(f.name); return out; };
    const rows = await kbNotes(kb.id);
    const attached = new Map(driveNotes(rows).map((n) => [driveIdOf(n.frontmatter.kb_source), n]));
    const taken = new Set(rows.map((n) => keyOf([...(n.folder_id ? segsOf(n.folder_id) : []), path.posix.basename(String(n.path ?? ''))])));
    const access = await token();
    const prefix = `Knowledge bases/${safeSeg(kb.name)}`;
    const skipped = [];
    const out = [];
    for (const p of picks) {
      const had = attached.get(p.id);
      const label = p.name || had?.frontmatter?.title || p.id;
      if (had && had.user_id !== me()) { skipped.push({ path: label, reason: 'Another admin attached this file. They sync it.' }); continue; }
      let meta;
      let body;
      try {
        meta = await driveFile(access, p.id, get);
        body = await driveText(access, meta, get);
      } catch (err) {
        if (err?.code === 'reauth' || err?.code === 'network') throw Object.assign(new Error(err.message), { code: 'DRIVE' });
        skipped.push({ path: label, reason: err?.code ? err.message : 'The file could not be read from Google Drive.' });
        continue;
      }
      const text = driveNoteText({ text: body.text, meta, syncedAt: now().toISOString() });
      const frontmatter = parseFrontmatter(text);
      if (frontmatter.confidential) { skipped.push({ path: meta.name, reason: 'The note is marked confidential.' }); continue; }
      let rel = had?.path;
      let folder = had ? had.folder_id ?? null : folderId ?? null;
      if (!had) {
        const segs = folder ? segsOf(folder) : [];
        const base = noteFileName(meta.name).replace(/\.md$/, '');
        let file = `${base}.md`;
        for (let i = 2; taken.has(keyOf([...segs, file])); i++) file = `${base} (${i}).md`;
        taken.add(keyOf([...segs, file]));
        rel = `${prefix}/${[...segs, file].join('/')}`;
      }
      out.push({ id: had?.id ?? ulid(), rel, text, frontmatter, hash: sha256(text), mtime: now().toISOString(), kbId: kb.id, folderId: folder, from: meta.name });
    }
    const remote = createRemote({ client: account.client(), workspaceId: ws(), userId: me() });
    let synced = 0;
    for (const r of out) {
      try { await remote.notes.push(r); synced++; } catch (err) {
        if (!/duplicate key|notes_workspace_path/i.test(String(err?.message))) throw err;
        skipped.push({ path: r.from, reason: 'Another note in the workspace already uses this path.' });
      }
    }
    log('kb-drive', `${synced} files into ${kb.id}, ${skipped.length} skipped`);
    return { files: filesOf(await kbNotes(kb.id)), synced, skipped };
  }

  let running = false;
  const once = async (fn) => {
    const no = ready(); if (no) return no;
    if (running) return { error: 'Google Drive files are already syncing. Wait for that to finish.' };
    running = true;
    try { return await fn(); } catch (err) {
      log('kb-drive', err?.message ?? err);
      return { error: err?.code === 'DRIVE' ? err.message : plain(err, 'The Google Drive files could not be synced.') };
    } finally { running = false; }
  };

  const handlers = {
    'kb-drive-status': async () => {
      const a = driveAccount();
      return { connected: !!a?.connected, available: available(), account: a?.account ?? null };
    },
    'kb-drive-files': async (kbId) => {
      const no = ready(); if (no) return no;
      if (!kbId || typeof kbId !== 'string') return { error: 'Pick the knowledge base first.' };
      try { return { files: filesOf(await kbNotes(kbId)) }; } catch (err) { log('kb-drive', err?.message ?? err); return { error: plain(err, 'The Google Drive files could not be read.') }; }
    },
    'kb-drive-add': (req = {}) => once(async () => {
      const a = await adminKb(req?.kbId); if (a.error) return a;
      if (req.folderId && !(a.kb.folders ?? []).some((f) => f.id === req.folderId)) return { error: 'That folder is not in this knowledge base.' };
      if (!driveAccount()?.connected) return { error: NOT_CONNECTED };
      if (!available()) return { error: NOT_AVAILABLE };
      const picked = await pick({ apiKey: picker.apiKey, appId: picker.appId, accessToken: await token(), open });
      if (picked?.canceled || !picked?.files?.length) return { canceled: true };
      return syncInto(a.kb, picked.files, req.folderId ?? null);
    }),
    'kb-drive-sync': (req = {}) => once(async () => {
      const a = await adminKb(req?.kbId); if (a.error) return a;
      if (!driveAccount()?.connected) return { error: NOT_CONNECTED };
      const mine = driveNotes(await kbNotes(a.kb.id)).filter((n) => n.user_id === me());
      const picks = mine.map((n) => ({ id: driveIdOf(n.frontmatter.kb_source), name: n.frontmatter?.title ?? null })).filter((p) => !req.fileId || p.id === req.fileId);
      if (req.fileId && !picks.length) return { error: 'That file is not one you attached to this knowledge base.' };
      return syncInto(a.kb, picks, null);
    }),
    'kb-drive-remove': (req = {}) => once(async () => {
      const a = await adminKb(req?.kbId); if (a.error) return a;
      const n = driveNotes(await kbNotes(a.kb.id)).find((x) => driveIdOf(x.frontmatter.kb_source) === req?.fileId);
      if (!n) return { error: 'That file is no longer attached to this knowledge base.' };
      if (n.user_id !== me()) return { error: 'Only the admin who attached this file can remove it.' };
      const { error } = await account.client().from('notes').update({ deleted_at: now().toISOString() }).eq('workspace_id', ws()).eq('user_id', me()).in('id', [n.id]);
      if (error) throw error;
      return { files: filesOf(await kbNotes(a.kb.id)) };
    }),
  };
  return { handlers };
}

export function registerKbDrive({ ipcMain, account, accounts, picker, open, log }) {
  const d = createKbDrive({ account, accounts, picker, open, log });
  for (const [name, fn] of Object.entries(d.handlers)) ipcMain.handle(name, (_e, ...a) => fn(...a));
  return d;
}
