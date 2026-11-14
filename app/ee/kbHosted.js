// Knowledge bases hosted by Quorum (Cloud edition; migration 0034, docs/specs/workspace-knowledge.md). A hosted KB has
// no upstream source: its editors and admins write notes in the Knowledge tab with the note editor, and each save goes
// straight to Supabase through kb_hosted_note_save. No note of a hosted KB passes through anyone's personal vault;
// pull sync (ee/sync.js) writes every hosted note, the person's own included, to the workspace folder.
//
// IPC API (preload exposes each as window.quorum.<camelName>). Every handler resolves to { error } on a refusal.
//
//   kb-hosted-create      (name, teamId?)                               -> { kb }         owners and admins, paid plan
//   kb-hosted-note        (noteId)                                      -> { note }
//   kb-hosted-note-save   ({ kbId, noteId?, folderId, title, content, baseHash, baseContent })
//                                                                       -> { note } | { conflict }
//   kb-hosted-note-move   (noteId, folderId)                            -> { note }
//   kb-hosted-note-delete (noteId, baseHash)                            -> { ok } | { conflict }
//   kb-files              (noteId)                                      -> { files }
//   kb-file-attach        (noteId)                                      -> { file } | { canceled }   picks a file
//   kb-file-open          (fileIdOrLink)                                -> { ok }         downloads it, then opens it
//   kb-file-data          (fileIdOrLink)                                -> { name, mime, dataUrl? }   a picture's bytes
//   kb-file-remove        (fileId)                                      -> { ok }
//   kb-files-usage        ()                                            -> { used, quota }
//
//   HostedNote { id, kbId, folderId, path, title, content, hash, updatedAt, editedBy }   content has no frontmatter
//   Conflict   { theirs: HostedNote | null, merged: string | null }
//              theirs is the version saved since the editor opened the note (null: it was deleted); merged is the
//              person's edit put onto it when the two do not touch the same lines, else null
//   KbFile     { id, noteId, name, mime, size, link, createdAt }   link is quorum://kb-file/<id>
//
// Saving takes the hash the editor opened. The server writes only when the note still has it; otherwise the answer
// carries the newer version and the renderer offers to use the merge, keep the person's text (saved on top of the
// newer version, which it then replaces) or take the newer version.
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile as fsReadFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { kbSession, removeKbObjects, shapeKb } from './knowledgeBases.js';
import { merge3 } from './kbUpstream.js';
import { stripFrontmatter, ulid } from './sync.js';

export const BUCKET = 'kb-files';
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const SIGNED_SECONDS = 300;
export const MIME_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', pdf: 'application/pdf' };
const ID = '[0-9A-HJKMNP-TV-Z]{26}';
const LINK = new RegExp(`^quorum://kb-file/(${ID})$`);
const LINKS = new RegExp(`quorum://kb-file/(${ID})`, 'g');

// the file id in a quorum://kb-file link, or a bare id; null for anything else
export function parseFileLink(s) {
  const v = String(s ?? '').trim();
  if (new RegExp(`^${ID}$`).test(v)) return v;
  return v.match(LINK)?.[1] ?? null;
}
// every file a note's text links to, once each, in order
export const fileLinks = (text) => [...new Set([...String(text ?? '').matchAll(LINKS)].map((m) => m[1]))];
// the markdown a note holds for a file: an image for a picture, a link for a PDF, with the file's name as the text and
// brackets taken out so it stays one link (ee/src/kbFiles.ts writes the same for the editor)
export const fileMarkdown = (f) => `${String(f.mime ?? '').startsWith('image/') ? '!' : ''}[${String(f.name ?? 'File').replace(/[[\]]/g, '')}](${f.link ?? `quorum://kb-file/${f.id}`})`;
const EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/heic': 'heic', 'application/pdf': 'pdf' };
// a name for the downloaded copy on disk: no slashes, colons or control characters, and the type's extension
export function diskName(name, mime) {
  const ext = EXT_BY_MIME[mime] ?? '';
  let n = [...String(name ?? '')].map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c)).join('').replace(/[/\\:]+/g, ' ').replace(/ {2,}/g, ' ').trim().replace(/^\.+/, '').slice(0, 120) || 'File';
  if (ext && path.extname(n).slice(1).toLowerCase() !== ext && !(ext === 'jpg' && /\.jpe?g$/i.test(n))) n = `${n}.${ext}`;
  return n;
}
export const mimeOf = (file) => MIME_BY_EXT[path.extname(String(file)).slice(1).toLowerCase()] ?? null;

export const shapeNote = (r) => (r ? {
  id: r.id, kbId: r.kb_id ?? null, folderId: r.folder_id ?? null, path: r.path ?? '', title: r.title ?? r.frontmatter?.title ?? '',
  content: stripFrontmatter(r.body ?? ''), hash: r.hash ?? '', updatedAt: r.updated_at ?? null, editedBy: r.edited_by_name ?? null,
} : null);
export const shapeFile = (f) => ({ id: f.id, noteId: f.note_id, name: f.name, mime: f.mime, size: Number(f.size) || 0, link: f.link ?? `quorum://kb-file/${f.id}`, createdAt: f.created_at ?? null });

// what the renderer gets back from a save the server refused as stale: the newer version, and the person's edit put
// onto it when that merges cleanly. A note deleted since has no newer version and nothing to merge onto
export function conflictOf({ theirs, base, mine }) {
  const t = shapeNote(theirs);
  if (!t || theirs.deleted) return { theirs: null, merged: null };
  if (typeof base !== 'string') return { theirs: t, merged: null };
  const nl = (s) => (s.endsWith('\n') ? s : `${s}\n`);
  const m = merge3(nl(base), nl(mine), nl(t.content));
  const merged = m.clean ? (mine.endsWith('\n') || t.content.endsWith('\n') ? m.text : m.text.replace(/\n$/, '')) : null;
  return { theirs: t, merged: merged === t.content ? null : merged };
}

export function createKbHosted({ account, log = () => {}, pickFile = async () => null, openPath = async () => '', cacheDir, readFile = fsReadFile, statFile = stat, fetch: get = globalThis.fetch }) {
  const { ws, rpc, call } = kbSession({ account, log, tag: 'kb-hosted' });
  const need = (v, what) => { if (!v || typeof v !== 'string') throw Object.assign(new Error(`Pick the ${what} first.`), { code: 'P0001' }); return v; };
  const storage = () => account.client().storage.from(BUCKET);
  const fileRow = async (id) => {
    const { data, error } = await account.client().from('kb_files').select('id, note_id, kb_id, name, mime, size, object_path, created_at').eq('id', id).limit(1);
    if (error) throw error;
    return data?.[0] ?? null;
  };
  const removeObjects = (paths) => removeKbObjects(account.client(), paths, log);
  // pictures shown in a note's preview, as data URLs (the page's content policy loads images from the app only), kept
  // for the session by file id
  const pictures = new Map();
  const signed = async (f) => {
    const { data, error } = await storage().createSignedUrl(f.object_path, SIGNED_SECONDS);
    if (error || !data?.signedUrl) { log('kb-hosted', 'sign', error?.message); return null; }
    return data.signedUrl;
  };

  const handlers = {
    // teamId makes it a team's KB (migration 0035); the server checks the team is in this workspace
    'kb-hosted-create': call(true, 'The knowledge base could not be created.', async (name, teamId = null) => {
      const n = String(name ?? '').trim();
      if (!n) return { error: 'A knowledge base needs a name.' };
      if (n.length > 120) return { error: 'That name is too long.' };
      return { kb: shapeKb(await rpc('kb_create_hosted', { workspace_id: ws(), name: n, team_id: teamId || null })) };
    }),
    'kb-hosted-note': call(false, 'The note could not be opened.', async (noteId) => {
      const { data, error } = await account.client().from('notes').select('id, kb_id, folder_id, path, frontmatter, body, hash, updated_at')
        .eq('workspace_id', ws()).eq('id', need(noteId, 'note')).is('deleted_at', null).limit(1);
      if (error) throw error;
      const r = data?.[0];
      if (!r) return { error: 'That note is no longer in this knowledge base.' };
      return { note: shapeNote(r) };
    }),
    // baseHash null with no noteId makes a note; baseContent is the text the editor opened, for the merge on a conflict
    'kb-hosted-note-save': call(false, 'The note could not be saved.', async (draft = {}) => {
      const title = String(draft.title ?? '').trim();
      if (!title) return { error: 'A note needs a title.' };
      if (title.length > 200) return { error: 'That title is too long.' };
      const content = String(draft.content ?? '');
      const noteId = draft.noteId ?? ulid();
      const r = await rpc('kb_hosted_note_save', { kb_id: need(draft.kbId, 'knowledge base'), note_id: noteId, folder_id: draft.folderId ?? null, title, content, expected_hash: draft.noteId ? draft.baseHash ?? null : null });
      if (r?.conflict) return { conflict: conflictOf({ theirs: r.note, base: draft.baseContent, mine: content }) };
      return { note: shapeNote(r.note) };
    }),
    'kb-hosted-note-move': call(false, 'The note could not be moved.', async (noteId, folderId) => {
      const r = await rpc('kb_hosted_note_move', { note_id: need(noteId, 'note'), folder_id: folderId ?? null });
      return { note: shapeNote(r.note) };
    }),
    'kb-hosted-note-delete': call(false, 'The note could not be deleted.', async (noteId, baseHash) => {
      const r = await rpc('kb_hosted_note_delete', { note_id: need(noteId, 'note'), expected_hash: baseHash ?? null });
      if (r?.conflict) return { conflict: conflictOf({ theirs: r.note }) };
      await removeObjects(r.objects);
      return { ok: true };
    }),
    'kb-files': call(false, 'The attachments could not be read.', async (noteId) => {
      const { data, error } = await account.client().from('kb_files').select('id, note_id, name, mime, size, created_at').eq('note_id', need(noteId, 'note')).order('created_at');
      if (error) throw error;
      return { files: (data ?? []).map(shapeFile) };
    }),
    // a file picked on the Mac: checked here for type and size so a refusal comes before the upload, then begun
    // (rights and quota on the server), uploaded to its object, and marked done
    'kb-file-attach': call(false, 'The file could not be attached.', async (noteId) => {
      need(noteId, 'note');
      const file = await pickFile();
      if (!file) return { canceled: true };
      const mime = mimeOf(file);
      if (!mime) return { error: 'Attach an image or a PDF.' };
      let size;
      try { size = (await statFile(file)).size; } catch { return { error: 'That file could not be read.' }; }
      if (size > MAX_FILE_BYTES) return { error: 'A file can be up to 25 MB.' };
      if (size < 1) return { error: 'That file is empty.' };
      const begun = await rpc('kb_file_begin', { note_id: noteId, name: path.basename(file), mime, size });
      const bytes = await readFile(file);
      const { error } = await storage().upload(begun.object_path, bytes, { contentType: mime, upsert: false });
      if (error) { log('kb-hosted', 'upload', error.message); return { error: 'The upload did not finish. Attach the file again.' }; }
      const done = await rpc('kb_file_done', { id: begun.id });
      // the server counts the size Storage reports; a file larger than begun or past the quota is refused and goes
      if (done?.rejected) { await removeObjects([done.object_path]); return { error: `${String(done.reason ?? 'The file could not be attached').replace(/\.$/, '')}.` }; }
      return { file: shapeFile(done) };
    }),
    // on demand: the file is fetched through a short signed URL into this Mac's cache, then opened in its own app
    'kb-file-open': call(false, 'The file could not be opened.', async (idOrLink) => {
      const id = parseFileLink(idOrLink);
      if (!id) return { error: 'That link is not a Quorum file.' };
      const f = await fileRow(id);
      if (!f) return { error: 'That file is not one you can read, or it was removed.' };
      const url = await signed(f);
      if (!url) return { error: 'That file is not one you can read, or it was removed.' };
      if (!cacheDir) return { url };
      const res = await get(url);
      if (!res.ok) return { error: 'The file could not be downloaded.' };
      const dir = path.join(cacheDir, ws(), f.id);
      mkdirSync(dir, { recursive: true });
      const to = path.join(dir, diskName(f.name, f.mime));
      writeFileSync(to, Buffer.from(await res.arrayBuffer()));
      const why = await openPath(to);
      return why ? { error: 'The file was downloaded but no app opened it.' } : { ok: true };
    }),
    // a picture for the preview: its bytes through a short signed URL, as a data URL. A PDF answers with its name only
    'kb-file-data': call(false, 'The picture could not be shown.', async (idOrLink) => {
      const id = parseFileLink(idOrLink);
      if (!id) return { error: 'That link is not a Quorum file.' };
      if (pictures.has(id)) return pictures.get(id);
      const f = await fileRow(id);
      if (!f) return { error: 'That file is not one you can read, or it was removed.' };
      if (!String(f.mime).startsWith('image/')) return { name: f.name, mime: f.mime };
      const url = await signed(f);
      if (!url) return { error: 'That file is not one you can read, or it was removed.' };
      const res = await get(url);
      if (!res.ok) return { error: 'The picture could not be downloaded.' };
      const out = { name: f.name, mime: f.mime, dataUrl: `data:${f.mime};base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}` };
      if (pictures.size >= 40) pictures.delete(pictures.keys().next().value);
      pictures.set(id, out);
      return out;
    }),
    'kb-file-remove': call(false, 'The file could not be removed.', async (fileId) => {
      const object = await rpc('kb_file_remove', { id: need(fileId, 'file') });
      pictures.delete(fileId);
      await removeObjects([object]);
      return { ok: true };
    }),
    'kb-files-usage': call(false, 'The storage use could not be read.', async () => {
      const r = await rpc('kb_files_usage', { workspace_id: ws() });
      return { used: Number(r?.used) || 0, quota: Number(r?.quota) || 0 };
    }),
  };
  return { handlers };
}

export function registerKbHosted({ ipcMain, account, log, pickFile, openPath, cacheDir }) {
  const h = createKbHosted({ account, log, pickFile, openPath, cacheDir });
  for (const [name, fn] of Object.entries(h.handlers)) ipcMain.handle(name, (_e, ...a) => fn(...a));
  return h;
}
