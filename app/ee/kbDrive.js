// Google Drive files attached to a knowledge base folder (Cloud edition; docs/specs/workspace-knowledge.md, "Sources
// inside a KB"; migration 0028). A KB admin picks individual files with the Google Picker (sources/drive.js), which
// grants Quorum's drive.file access to those files only, and each picked file becomes a shared note in the chosen KB
// folder, written the way ee/kbImport.js writes an import: the admin's own notes row with kb_id and folder_id set,
// visibility public, and kb_source naming where it came from (google-drive:<file id>). Pull sync then carries the
// note to every reader. No table is added: the attached files are the KB's notes whose kb_source starts with
// google-drive:. Syncing runs only when an admin asks for it (Sync now); there is no background sync.
//
// IPC API (preload exposes each as window.quorum.<camelName>). Every handler resolves to { error } on a refusal.
//
//   kb-drive-status ()                          -> { connected, available, account }
//   kb-drive-files  (kbId)                      -> { files: DriveFile[] }
//   kb-drive-add    ({ kbId, folderId? })       -> Synced | { canceled: true }
//   kb-drive-cancel ()                          -> { canceled }                    ends a picker that is still waiting
//   kb-drive-sync   ({ kbId, fileId? })         -> Synced                          fileId left out: every file in the KB
//   kb-drive-remove ({ kbId, fileId })          -> { files }                       the note leaves the KB and the vaults
//
//   Synced      { files: DriveFile[], synced, unchanged, kept, suggested, skipped: Skipped[] }
//   DriveFile   { fileId, noteId, name, folderId, url, syncedAt, modifiedAt }
//   Skipped     { path, reason }   path is the file's name in Drive
//
// connected says the Google Drive account is connected (Settings, Connections); available says this build carries the
// Picker's API key. The picker wait runs outside the sync lock, so a picker left open blocks nothing; reading and
// writing files runs one batch at a time. Picking a file that is already attached syncs it where it already is, and
// re-syncing keeps the note's id and place, so nothing is duplicated. A file whose Drive modifiedTime matches the
// note's kb_source_modified is not read again; only its check time (kb_checked_at, in the row's frontmatter, outside
// the note text) moves. Any admin of the KB syncs or removes any attached file, reading Drive with their own Google
// token; the note stays its author's row, so those writes go through the 0028 functions. A file that has become
// confidential takes its note out of the KB. A note Quorum (or the person) edited since the last sync (ee/kbUpstream.js)
// keeps that edit while the file's text is unchanged (kept); when the file changed, the file's text is written and Quorum's edit is kept as a
// suggestion (counted in suggested). Nothing is ever written back to Drive. One file failing (no access, rate limited, offline) never discards the
// files already read: what was read is written and each failure is reported.
import path from 'node:path';
import { plain } from './account.js';
import { dropFalseConfidential, fmValue, isConfidential, keyOf, safeSeg, sha256, sharedText } from './kbImport.js';
import { kbSession } from './knowledgeBases.js';
import { baseRow, sameNote, syncUpstream } from './kbUpstream.js';
import { createRemote, ulid } from './store/remote.js';
import { parseFrontmatter } from './sync.js';
import { notes as localNotes } from '../store/local.js';
import { awaitPicker, cancelPicker, driveFile, driveText } from '../sources/drive.js';

export const DRIVE_PREFIX = 'google-drive:';
const NOT_CONNECTED = 'Connect Google Drive in Settings, Connections first.';
const NOT_AVAILABLE = 'Adding files from Google Drive is not available in this build yet.';
const COLUMNS = 'id, path, folder_id, user_id, frontmatter, hash, updated_at';
export const NOW_CONFIDENTIAL = 'The file is now marked confidential, so its note left the knowledge base.';
const NEEDS_UPDATE = 'This needs the latest database update. Only the admin who added the file can sync or remove it until then.';

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

const latest = (...xs) => xs.filter(Boolean).sort().at(-1) ?? null;
const shapeFile = (n) => ({
  fileId: driveIdOf(n.frontmatter?.kb_source), noteId: n.id, name: n.frontmatter?.title || path.posix.basename(String(n.path ?? ''), '.md'),
  folderId: n.folder_id ?? null, url: n.frontmatter?.kb_source_url ?? null,
  syncedAt: latest(n.frontmatter?.kb_synced_at, n.frontmatter?.kb_checked_at) ?? n.updated_at ?? null,
  modifiedAt: n.frontmatter?.kb_source_modified ?? null,
});
// a database without migration 0028 answers a call to its functions with PGRST202
const missingFn = (err) => err?.code === 'PGRST202' || /could not find the function/i.test(String(err?.message));

export function createKbDrive({ account, accounts, picker = null, pick = awaitPicker, cancelPick = cancelPicker, open = async () => {}, fetch: get = globalThis.fetch, sleep, now = () => new Date(), log = () => {} }) {
  const { ready, ws, rpc, findKb, kbNotes } = kbSession({ account, log, tag: 'kb-drive' });
  const me = () => account.state().userId;
  const driveAccount = () => accounts.list().find((a) => a.id === 'google-drive') ?? null;
  const available = () => !!picker?.apiKey && !!picker?.appId;
  const driveOpts = sleep ? { sleep } : {};

  const adminKb = async (kbId) => {
    if (!kbId || typeof kbId !== 'string') return { error: 'Pick the knowledge base first.' };
    const kb = await findKb(kbId);
    if (!kb) return { error: 'That knowledge base no longer exists.' };
    if (kb.role !== 'admin') return { error: 'Only the knowledge base\'s admins can manage its Google Drive files.' };
    return { kb };
  };
  const driveNotes = (rows) => rows.filter((n) => driveIdOf(n.frontmatter?.kb_source));
  const filesOf = (rows) => driveNotes(rows).map(shapeFile).sort((a, b) => a.name.localeCompare(b.name));
  const token = async () => {
    const t = await accounts.accessToken('google-drive');
    if (!t) throw Object.assign(new Error(NOT_CONNECTED), { code: 'DRIVE' });
    return t;
  };

  // writes to a note that may be another admin's row go through 0028's functions; the caller's own row falls back to
  // a plain write when the database does not have them yet
  const removeNote = async (n) => {
    try { await rpc('kb_drive_note_remove', { note_id: n.id }); return; } catch (err) { if (!missingFn(err) || n.user_id !== me()) throw missingFn(err) ? Object.assign(new Error(NEEDS_UPDATE), { code: 'DRIVE' }) : err; }
    const { error } = await account.client().from('notes').update({ deleted_at: now().toISOString() }).eq('workspace_id', ws()).eq('user_id', me()).in('id', [n.id]);
    if (error) throw error;
  };
  const updateNote = async (n, row, remote) => {
    try { await rpc('kb_drive_note_write', { note_id: n.id, body: row.text, frontmatter: row.frontmatter, hash: row.hash, mtime: row.mtime }); return; } catch (err) { if (!missingFn(err) || n.user_id !== me()) throw missingFn(err) ? Object.assign(new Error(NEEDS_UPDATE), { code: 'DRIVE' }) : err; }
    await remote.notes.push(row);
  };
  const markChecked = async (n, at) => {
    try { await rpc('kb_drive_note_checked', { note_id: n.id, checked_at: at }); } catch (err) { log('kb-drive', 'check time not stored', err?.message ?? err); }
  };

  // read each picked file from Drive and write it as a note. An attached file keeps its note (id, path, folder); a new
  // one goes into folderId under a name no other note in that folder has. A failure that will repeat for every file
  // (the token, a rate limit) stops the reads and names the rest; every other failure skips that file only
  async function syncInto(kb, list, folderId) {
    const picks = [...new Map(list.map((p) => [p.id, p])).values()];
    const byId = new Map((Array.isArray(kb.folders) ? kb.folders : []).map((f) => [f.id, f]));
    const segsOf = (id) => { const out = []; for (let f = byId.get(id), guard = 0; f && guard < 1000; f = byId.get(f.parent_id ?? f.parentId), guard++) out.unshift(f.name); return out; };
    const rows = await kbNotes(kb.id, COLUMNS);
    const attached = new Map(driveNotes(rows).map((n) => [driveIdOf(n.frontmatter.kb_source), n]));
    const taken = new Set(rows.map((n) => keyOf([...(n.folder_id ? segsOf(n.folder_id) : []), path.posix.basename(String(n.path ?? ''))])));
    const access = await token();
    // the upstream rows of the attached files in this batch, and the note texts the plans need, read once
    const upstream = syncUpstream({ client: () => account.client(), ws, log, tag: 'kb-drive' });
    await upstream.prepare(picks.map((p) => attached.get(p.id)).filter(Boolean).map((n) => ({ id: n.id, hash: n.hash })), { withoutBase: true });
    const prefix = `Knowledge bases/${safeSeg(kb.name)}`;
    const at = now().toISOString();
    const skipped = [];
    const creates = [];
    const updates = [];
    const checked = [];
    const leaving = [];
    const bases = [];
    let kept = 0;
    let stop = null;
    for (const p of picks) {
      const had = attached.get(p.id);
      const label = p.name || had?.frontmatter?.title || p.id;
      if (stop) { skipped.push({ path: label, reason: stop }); continue; }
      let meta;
      let body;
      try {
        meta = await driveFile(access, p.id, get, driveOpts);
        // an unchanged file is not read again, except once for a note synced before its base was recorded
        const sameTime = had && meta.modifiedTime && had.frontmatter?.kb_source_modified === meta.modifiedTime;
        if (sameTime && (upstream.off || upstream.row(had.id))) { checked.push(had); continue; }
        body = await driveText(access, meta, get, driveOpts);
      } catch (err) {
        const reason = err?.code ? err.message : 'The file could not be read from Google Drive.';
        if (err?.code === 'reauth' || err?.code === 'limited') stop = reason;
        skipped.push({ path: label, reason });
        continue;
      }
      const text = dropFalseConfidential(driveNoteText({ text: body.text, meta, syncedAt: at }));
      const frontmatter = parseFrontmatter(text);
      if (isConfidential(frontmatter)) {
        if (had) leaving.push({ note: had, label: meta.name }); else skipped.push({ path: meta.name, reason: 'The note is marked confidential.' });
        continue;
      }
      const row = { text, frontmatter, hash: sha256(text), mtime: at, kbId: kb.id, from: meta.name };
      if (had) {
        const sameTime = meta.modifiedTime && had.frontmatter?.kb_source_modified === meta.modifiedTime;
        const current = upstream.current(had.id);
        if (!upstream.off && !upstream.row(had.id) && sameTime) {
          // synced before migration 0031 and the file is unchanged: the note is its base when it still holds the
          // file's text; otherwise nothing tells an edit apart, so it is left as it is
          if (current != null && sameNote(current, text)) bases.push(baseRow(had.id, current));
          checked.push(had);
          continue;
        }
        const plan = upstream.plan(had, text);
        if (!plan.write) {
          // the copy has edits and the file's text did not change: the copy stays. A file Drive marked as modified
          // anyway gets its new time in the note, so it is not read again next time
          kept++;
          if (!sameTime && meta.modifiedTime && current != null) {
            const moved = localNotes.setFrontmatterKey(current, 'kb_source_modified', fmValue(meta.modifiedTime));
            updates.push({ note: had, plan: { ...plan, fresh: 0 }, keepUpstream: true, row: { ...row, text: moved, frontmatter: parseFrontmatter(moved), hash: sha256(moved), id: had.id, rel: had.path, folderId: had.folder_id ?? null } });
          } else checked.push(had);
          continue;
        }
        updates.push({ note: had, plan, row: { ...row, id: had.id, rel: had.path, folderId: had.folder_id ?? null } });
        continue;
      }
      const segs = folderId ? segsOf(folderId) : [];
      const base = noteFileName(meta.name).replace(/\.md$/, '');
      let file = `${base}.md`;
      for (let i = 2; taken.has(keyOf([...segs, file])); i++) file = `${base} (${i}).md`;
      taken.add(keyOf([...segs, file]));
      creates.push({ ...row, id: ulid(), rel: `${prefix}/${[...segs, file].join('/')}`, folderId: folderId ?? null });
    }

    const remote = createRemote({ client: account.client(), workspaceId: ws(), userId: me() });
    const failed = (from, err, fallback) => {
      log('kb-drive', from, err?.message ?? err);
      const msg = String(err?.message);
      skipped.push({ path: from, reason: /duplicate key|notes_workspace_path/i.test(msg) ? 'Another note in the workspace already uses this path.' : err?.code === 'DRIVE' ? err.message : plain(err, fallback) });
    };
    let synced = 0;
    let suggested = 0;
    for (const r of creates) { try { await remote.notes.push(r); synced++; bases.push(baseRow(r.id, r.text)); } catch (err) { failed(r.from, err, 'The note could not be written.'); } }
    // an attached note goes up with its upstream row in one call; without migration 0031, through 0028's write
    const res = updates.length ? await upstream.write(kb.id, updates.map((u) => ({
      note_id: u.note.id, body: u.row.text, frontmatter: u.row.frontmatter, hash: u.row.hash, mtime: u.row.mtime,
      upstream: u.keepUpstream ? null : baseRow(u.note.id, u.row.text, u.plan.suggestions),
    }))) : { written: new Set(), failed: new Map() };
    for (const u of updates) {
      const counts = !u.keepUpstream;
      if (res) {
        if (res.written.has(u.note.id)) { if (counts) { synced++; suggested += u.plan.fresh; } } else failed(u.row.from, res.failed.get(u.note.id), 'The note could not be written.');
        continue;
      }
      try { await updateNote(u.note, u.row, remote); if (counts) synced++; } catch (err) { failed(u.row.from, err, 'The note could not be written.'); }
    }
    await upstream.saveBases(kb.id, bases);
    for (const l of leaving) {
      try { await removeNote(l.note); skipped.push({ path: l.label, reason: NOW_CONFIDENTIAL }); } catch (err) { failed(l.label, err, 'The file is now marked confidential, and its note could not be taken out of the knowledge base.'); }
    }
    for (const n of checked) await markChecked(n, at);
    log('kb-drive', `${synced} written, ${checked.length} unchanged, ${kept} kept, ${suggested} suggested, ${skipped.length} skipped in ${kb.id}`);
    return { files: filesOf(await kbNotes(kb.id, COLUMNS)), synced, unchanged: checked.length, kept, suggested, skipped };
  }

  // reading and writing run one batch at a time; a second batch waits for the first
  let lock = Promise.resolve();
  const serial = (fn) => {
    const run = lock.then(fn, fn);
    lock = run.catch(() => {});
    return run;
  };
  const guarded = (fallback, fn) => async (req = {}) => {
    const no = ready(); if (no) return no;
    try { return await fn(req ?? {}); } catch (err) {
      log('kb-drive', err?.message ?? err);
      return { error: err?.code === 'DRIVE' ? err.message : plain(err, fallback) };
    }
  };

  const handlers = {
    'kb-drive-status': async () => {
      const a = driveAccount();
      return { connected: !!a?.connected, available: available(), account: a?.account ?? null };
    },
    'kb-drive-files': guarded('The Google Drive files could not be read.', async (kbId) => {
      if (!kbId || typeof kbId !== 'string') return { error: 'Pick the knowledge base first.' };
      return { files: filesOf(await kbNotes(kbId, COLUMNS)) };
    }),
    'kb-drive-add': guarded('The Google Drive files could not be added.', async (req) => {
      const a = await adminKb(req.kbId); if (a.error) return a;
      if (req.folderId && !(a.kb.folders ?? []).some((f) => f.id === req.folderId)) return { error: 'That folder is not in this knowledge base.' };
      if (!driveAccount()?.connected) return { error: NOT_CONNECTED };
      if (!available()) return { error: NOT_AVAILABLE };
      const picked = await pick({ apiKey: picker.apiKey, appId: picker.appId, accessToken: await token(), open });
      if (picked?.canceled || !picked?.files?.length) return { canceled: true };
      return serial(async () => {
        const fresh = await adminKb(req.kbId); if (fresh.error) return fresh;
        return syncInto(fresh.kb, picked.files, req.folderId ?? null);
      });
    }),
    'kb-drive-cancel': async () => ({ canceled: cancelPick() }),
    'kb-drive-sync': guarded('The Google Drive files could not be synced.', (req) => serial(async () => {
      const a = await adminKb(req.kbId); if (a.error) return a;
      if (!driveAccount()?.connected) return { error: NOT_CONNECTED };
      const picks = driveNotes(await kbNotes(a.kb.id, COLUMNS)).map((n) => ({ id: driveIdOf(n.frontmatter.kb_source), name: n.frontmatter?.title ?? null })).filter((p) => !req.fileId || p.id === req.fileId);
      if (req.fileId && !picks.length) return { error: 'That file is no longer attached to this knowledge base.' };
      return syncInto(a.kb, picks, null);
    })),
    'kb-drive-remove': guarded('The file could not be removed.', (req) => serial(async () => {
      const a = await adminKb(req.kbId); if (a.error) return a;
      const n = driveNotes(await kbNotes(a.kb.id, COLUMNS)).find((x) => driveIdOf(x.frontmatter.kb_source) === req.fileId);
      if (!n) return { error: 'That file is no longer attached to this knowledge base.' };
      await removeNote(n);
      return { files: filesOf(await kbNotes(a.kb.id, COLUMNS)) };
    })),
  };
  return { handlers };
}

export function registerKbDrive({ ipcMain, account, accounts, picker, open, log }) {
  const d = createKbDrive({ account, accounts, picker, open, log });
  for (const [name, fn] of Object.entries(d.handlers)) ipcMain.handle(name, (_e, ...a) => fn(...a));
  return d;
}
