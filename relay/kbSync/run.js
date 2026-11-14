// One sync run for one attachment: list the remote item, read what changed, and write the KB's notes the way
// app/ee/kbImport.js and app/ee/kbDrive.js write them. Each file becomes the attaching admin's notes row in the KB,
// shared, with kb_source naming the file and kb_attachment naming this attachment. A file synced before keeps its note
// (id, path, folder) and is matched by its remote id (kb_source). Subfolders become KB folders under the attachment's
// folder. A file gone upstream takes its note out of the KB, and so does a file that is now marked confidential. One
// file failing skips that file only; a refused grant or a rate limit stops the reads, and what was read is still written.
//
// Agent edits. The hash each run writes is kept in the attachment's cursor. When a note's hash no longer matches, the
// note was changed in Quorum after the last sync (by an agent or a person), and the upstream text replaces it. The
// onLocalEdit hook is where the agent's version is kept as a suggestion (docs/specs/workspace-knowledge.md,
// "Maintenance"); kb_note_upstream from the suggestions work is not on main yet, so the default only logs the event.
import { ulid } from '../lib/ids.js';
import { isConfidential, noteFileName, parseFrontmatter, safeSeg, sha256, syncedNoteText } from './rules.js';

const NOTE_COLUMNS = 'id, path, folder_id, user_id, frontmatter, hash';
const PAGE = 1000;
export const NOW_CONFIDENTIAL = 'The file is now marked confidential, so its note left the knowledge base.';
const OTHER_ATTACHMENT = 'Another synced folder in this knowledge base already holds this file.';
const folderName = (s) => String(s ?? '').replace(/[/\\]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Untitled';

async function kbNotes(db, kbId) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.from('notes').select(NOTE_COLUMNS).eq('kb_id', kbId).is('deleted_at', null).order('id').range(from, from + PAGE - 1);
    if (error) throw Object.assign(new Error('The knowledge base notes could not be read.'), { code: 'db' });
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
  }
}

// the KB's folders by id and by (parent, name), and the names on the way to a folder
function folderIndex(folders) {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const byName = new Map(folders.map((f) => [`${f.parent_id ?? ''}/${String(f.name).trim().toLowerCase()}`, f]));
  const segsOf = (id) => { const out = []; for (let f = byId.get(id), guard = 0; f && guard < 1000; f = byId.get(f.parent_id), guard++) out.unshift(f.name); return out; };
  return { byId, byName, segsOf };
}

export const keepUpstream = async ({ note, attachment, log }) => { log('kb_sync_local_edit_replaced', { attachment: attachment.id, note: note.id }); };

export async function syncAttachment({ db, attachment: a, provider, token, fetchImpl = fetch, sleep, now = () => new Date(), log = () => {}, onLocalEdit = keepUpstream }) {
  const at = now().toISOString();
  const cursorIn = a.cursor && typeof a.cursor === 'object' ? a.cursor : {};
  const listing = await provider.list({ token, attachment: a, cursor: cursorIn, fetchImpl, sleep });
  if (listing.unchanged) return { cursor: { ...cursorIn, ...listing.cursor, hashes: cursorIn.hashes ?? {} }, noteCount: a.note_count ?? 0, written: 0, unchanged: a.note_count ?? 0, removed: 0, skipped: [], stop: null };

  const rows = await kbNotes(db, a.kb_id);
  const mine = rows.filter((n) => n.frontmatter?.kb_attachment === a.id);
  // a note this attachment wrote, or one the attaching admin wrote from the same file before (Sync now on the Mac, an
  // import) and no other attachment holds
  const bySource = new Map();
  for (const n of rows) {
    const src = n.frontmatter?.kb_source;
    if (!src) continue;
    if (n.frontmatter?.kb_attachment === a.id || (!n.frontmatter?.kb_attachment && n.user_id === a.attached_by && !bySource.has(src))) bySource.set(src, n);
  }
  const elsewhere = new Set(rows.filter((n) => n.frontmatter?.kb_attachment && n.frontmatter.kb_attachment !== a.id).map((n) => n.frontmatter.kb_source));
  const taken = new Set(rows.map((n) => String(n.path).toLowerCase()));
  const lastHashes = cursorIn.hashes && typeof cursorIn.hashes === 'object' ? cursorIn.hashes : {};
  const hashes = {};
  const folders = folderIndex(Array.isArray(a.folders) ? a.folders : []);
  const baseSegs = a.folder_id ? folders.segsOf(a.folder_id) : [];
  const prefix = `Knowledge bases/${safeSeg(a.kb_name)}`;
  const seen = new Set();
  const gone = new Set();
  const skipped = [];
  let written = 0, unchanged = 0, removed = 0, stop = null;

  const removeNote = async (n) => {
    const { error } = await db.from('notes').update({ deleted_at: at, updated_at: at }).eq('id', n.id);
    if (error) throw Object.assign(new Error('A note could not be taken out of the knowledge base.'), { code: 'db' });
    gone.add(n.id);
    removed++;
  };
  // the KB folder for a file's segments under the attachment's folder, made when it is missing
  const folderFor = async (segs) => {
    let parent = a.folder_id ?? null;
    for (const raw of segs) {
      const name = folderName(raw);
      const key = `${parent ?? ''}/${name.toLowerCase()}`;
      let f = folders.byName.get(key);
      if (!f) {
        f = { id: ulid(), kb_id: a.kb_id, parent_id: parent, name, position: 0, created_by: a.attached_by };
        const { error } = await db.from('kb_folders').insert(f);
        if (error) throw Object.assign(new Error('A folder could not be made in the knowledge base.'), { code: 'db' });
        folders.byId.set(f.id, f);
        folders.byName.set(key, f);
      }
      parent = f.id;
    }
    return parent;
  };

  for (const f of listing.files) {
    const source = provider.sourceOf(f);
    if (elsewhere.has(source)) { skipped.push({ path: f.name, reason: OTHER_ATTACHMENT }); continue; }
    seen.add(source);
    const had = bySource.get(source);
    if (had && provider.unchanged(had, f)) { unchanged++; hashes[had.id] = lastHashes[had.id] ?? had.hash; continue; }
    if (stop) { skipped.push({ path: f.name, reason: stop.message }); if (had) hashes[had.id] = lastHashes[had.id] ?? had.hash; continue; }
    let body;
    try { body = await provider.read({ token, attachment: a, file: f, fetchImpl, sleep }); }
    catch (err) {
      if (err?.code === 'auth' || err?.code === 'limited' || err?.code === 'network') stop = err;
      skipped.push({ path: f.name, reason: err?.code ? err.message : 'The file could not be read.' });
      if (had) hashes[had.id] = lastHashes[had.id] ?? had.hash;
      continue;
    }
    const text = syncedNoteText({ text: body, source, attachmentId: a.id, name: f.name, url: f.url, syncedAt: at, modified: f.modified, sha: f.sha, where: provider.where });
    const frontmatter = parseFrontmatter(text);
    if (isConfidential(frontmatter)) {
      if (had) { await removeNote(had); skipped.push({ path: f.name, reason: NOW_CONFIDENTIAL }); } else skipped.push({ path: f.name, reason: 'The file is marked confidential.' });
      seen.delete(source);
      continue;
    }
    const hash = sha256(text);
    if (had) {
      if (lastHashes[had.id] && had.hash !== lastHashes[had.id]) await onLocalEdit({ db, note: had, upstreamText: text, attachment: a, log });
      const { error } = await db.from('notes').update({ body: text, frontmatter, hash, mtime: at, updated_at: at }).eq('id', had.id);
      if (error) { skipped.push({ path: f.name, reason: 'The note could not be written.' }); hashes[had.id] = lastHashes[had.id] ?? had.hash; continue; }
      hashes[had.id] = hash;
      written++;
      continue;
    }
    let folderId;
    try { folderId = await folderFor(f.segs ?? []); } catch (err) { skipped.push({ path: f.name, reason: err.message }); continue; }
    const segs = [...baseSegs, ...(f.segs ?? []).map(folderName)];
    const base = noteFileName(f.name).replace(/\.md$/, '');
    const id = ulid();
    let ok = false;
    for (let i = 1; i <= 20 && !ok; i++) {
      const rel = `${prefix}/${[...segs, i === 1 ? `${base}.md` : `${base} (${i}).md`].join('/')}`;
      if (taken.has(rel.toLowerCase())) continue;
      const { error } = await db.from('notes').insert({ id, user_id: a.attached_by, workspace_id: a.workspace_id, path: rel, frontmatter, body: text, hash, mtime: at, kb_id: a.kb_id, folder_id: folderId });
      taken.add(rel.toLowerCase());
      if (!error) { ok = true; break; }
      // another note in the workspace (outside this KB) has the path: try the next name
      if (error.code !== '23505') break;
    }
    if (!ok) { skipped.push({ path: f.name, reason: 'The note could not be written.' }); continue; }
    hashes[id] = hash;
    written++;
  }

  // removed upstream: only from a whole listing, and only notes this attachment wrote
  if (listing.complete && !stop) {
    for (const n of mine) if (!seen.has(n.frontmatter?.kb_source) && !gone.has(n.id)) await removeNote(n);
  }
  const kept = Object.keys(hashes).length;
  log('kb_sync_run', { attachment: a.id, provider: provider.id, written, unchanged, removed, skipped: skipped.length });
  return {
    // a stopped run keeps the old change marker, so the next run reads again what this one could not
    cursor: stop ? { ...cursorIn, hashes: { ...lastHashes, ...hashes } } : { ...listing.cursor, hashes },
    noteCount: kept, written, unchanged, removed, skipped, stop,
  };
}
