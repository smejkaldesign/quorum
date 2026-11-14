// One sync run for one attachment: list the remote item, read what changed, and write the KB's notes the way
// app/ee/kbImport.js and app/ee/kbDrive.js write them. Each file becomes the attaching admin's notes row in the KB,
// shared, with kb_source naming the file and kb_attachment naming this attachment. A file synced before keeps its note
// (id, path, folder) and is matched by its remote id (kb_source). Subfolders become KB folders under the attachment's
// folder. A file gone upstream takes its note out of the KB, and so does a file that is now marked confidential. One
// file failing skips that file only; a refused grant or a rate limit stops the reads, and what was read is still written.
//
// Agent edits (docs/specs/workspace-knowledge.md, "Maintenance" and Decision 5). The worker uses the same planning as
// kbImport and kbDrive (app/ee/kbUpstream.js, migration 0031): each write records the upstream base; a note Quorum
// edited since stays as it is while the source has not changed, and when the source changes the source's text is
// written and the edit is kept as a suggestion (ready when it merges onto the new text, stale otherwise). The note and
// its base are written in one call. kbUpstream.js is plain Node with no packages, so the relay imports it from app/.
import { ulid } from '../lib/ids.js';
import { baseRow, sameNote, syncUpstream } from '../../app/ee/kbUpstream.js';
import { fmValue, isConfidential, noteFileName, parseFrontmatter, safeSeg, setFrontmatterKey, sha256, syncedNoteText } from './rules.js';

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

// the upstream store's database calls, made by the worker: the 0031 writes go through 0032's service-role wrappers,
// which run them as the attaching admin; reads use the service role directly
const upstreamClient = (db, a) => ({
  from: (table) => db.from(table),
  rpc: (name, args) => {
    if (name === 'kb_synced_notes_write') return db.rpc('kb_sync_notes_write', { attachment_id: a.id, rows: args.rows });
    if (name === 'kb_upstream_save') return db.rpc('kb_sync_upstream_save', { attachment_id: a.id, rows: args.rows });
    return db.rpc(name, args);
  },
});
// the note's own text with the provider's new change marker, for a copy that is kept
const withMarker = (text, f) => (f.sha ? setFrontmatterKey(text, 'kb_source_sha', fmValue(f.sha)) : f.modified ? setFrontmatterKey(text, 'kb_source_modified', fmValue(f.modified)) : text);

export async function syncAttachment({ db, attachment: a, provider, token, fetchImpl = fetch, sleep, now = () => new Date(), log = () => {} }) {
  const at = now().toISOString();
  const cursorIn = a.cursor && typeof a.cursor === 'object' ? a.cursor : {};
  const listing = await provider.list({ token, attachment: a, cursor: cursorIn, fetchImpl, sleep });
  if (listing.unchanged) return { cursor: { ...cursorIn, ...listing.cursor }, noteCount: a.note_count ?? 0, written: 0, unchanged: a.note_count ?? 0, kept: 0, suggested: 0, removed: 0, skipped: [], stop: null };

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
  // Quorum's edits to these notes since the last sync, read once for the run (app/ee/kbUpstream.js)
  const upstream = syncUpstream({ client: () => upstreamClient(db, a), ws: () => a.workspace_id, now: () => at, tag: 'kb-sync',
    log: (_tag, ...m) => log('kb_sync_upstream', { attachment: a.id, detail: m.map(String).join(' ').slice(0, 200) }) });
  await upstream.prepare([...bySource.values()].map((n) => ({ id: n.id, hash: n.hash })), { withoutBase: true });
  const held = new Set();
  const bases = [];
  const updates = [];
  const folders = folderIndex(Array.isArray(a.folders) ? a.folders : []);
  const baseSegs = a.folder_id ? folders.segsOf(a.folder_id) : [];
  const prefix = `Knowledge bases/${safeSeg(a.kb_name)}`;
  const seen = new Set();
  const gone = new Set();
  const skipped = [];
  let written = 0, unchanged = 0, kept = 0, suggested = 0, removed = 0, stop = null;

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
    const sameMarker = !!had && provider.unchanged(had, f);
    // an unchanged file is not read again, except once for a note synced before its base was recorded
    if (sameMarker && (upstream.off || upstream.row(had.id))) { unchanged++; held.add(had.id); continue; }
    if (stop) { skipped.push({ path: f.name, reason: stop.message }); if (had) held.add(had.id); continue; }
    let body;
    try { body = await provider.read({ token, attachment: a, file: f, fetchImpl, sleep }); }
    catch (err) {
      if (err?.code === 'auth' || err?.code === 'limited' || err?.code === 'network') stop = err;
      skipped.push({ path: f.name, reason: err?.code ? err.message : 'The file could not be read.' });
      if (had) held.add(had.id);
      continue;
    }
    const text = syncedNoteText({ text: body, source, attachmentId: a.id, name: f.name, url: f.url, syncedAt: at, modified: f.modified, sha: f.sha, where: provider.where });
    const frontmatter = parseFrontmatter(text);
    if (isConfidential(frontmatter)) {
      if (had) { await removeNote(had); skipped.push({ path: f.name, reason: NOW_CONFIDENTIAL }); } else skipped.push({ path: f.name, reason: 'The file is marked confidential.' });
      seen.delete(source);
      continue;
    }
    if (had) {
      held.add(had.id);
      const current = upstream.current(had.id);
      if (!upstream.off && !upstream.row(had.id) && sameMarker) {
        // synced before its base was recorded and the file is unchanged: the note is its base when it still holds the
        // file's text; otherwise nothing tells an edit apart, so it is left as it is
        if (current != null && sameNote(current, text)) bases.push(baseRow(had.id, current));
        unchanged++;
        continue;
      }
      const plan = upstream.off ? { write: true, suggestions: [], fresh: 0 } : upstream.plan(had, text);
      if (!plan.write) {
        // Quorum's copy has edits and the file's text did not change: the copy stays, with the new change marker so
        // the file is not read again next time
        kept++;
        if (!sameMarker && current != null) updates.push({ note: had, text: withMarker(current, f), keepUpstream: true, fresh: 0, from: f.name });
        continue;
      }
      updates.push({ note: had, text, suggestions: plan.suggestions, fresh: plan.fresh, from: f.name });
      continue;
    }
    let folderId;
    try { folderId = await folderFor(f.segs ?? []); } catch (err) { skipped.push({ path: f.name, reason: err.message }); continue; }
    const segs = [...baseSegs, ...(f.segs ?? []).map(folderName)];
    const base = noteFileName(f.name).replace(/\.md$/, '');
    const id = ulid();
    const hash = sha256(text);
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
    held.add(id);
    bases.push(baseRow(id, text));
    written++;
  }

  // a synced note goes up with its upstream row in one call (0031 through 0032's kb_sync_notes_write); without the
  // upstream store, as a plain write where the source's text wins
  const items = updates.map((u) => ({ note_id: u.note.id, body: u.text, frontmatter: parseFrontmatter(u.text), hash: sha256(u.text), mtime: at, upstream: u.keepUpstream ? null : baseRow(u.note.id, u.text, u.suggestions) }));
  const res = items.length ? await upstream.write(a.kb_id, items) : { written: new Set(), failed: new Map() };
  for (const [i, u] of updates.entries()) {
    const item = items[i];
    if (res) {
      if (res.failed.has(u.note.id)) { skipped.push({ path: u.from, reason: 'The note could not be written.' }); continue; }
      if (!res.written.has(u.note.id)) continue;
    } else {
      const { error } = await db.from('notes').update({ body: item.body, frontmatter: item.frontmatter, hash: item.hash, mtime: at, updated_at: at }).eq('id', u.note.id);
      if (error) { skipped.push({ path: u.from, reason: 'The note could not be written.' }); continue; }
    }
    if (!u.keepUpstream) written++;
    suggested += u.fresh ?? 0;
  }
  await upstream.saveBases(a.kb_id, bases);

  // removed upstream: only from a whole listing, and only notes this attachment wrote
  if (listing.complete && !stop) {
    for (const n of mine) if (!seen.has(n.frontmatter?.kb_source) && !gone.has(n.id)) await removeNote(n);
  }
  log('kb_sync_run', { attachment: a.id, provider: provider.id, written, unchanged, kept, suggested, removed, skipped: skipped.length });
  return {
    // a stopped run keeps the old change marker, so the next run reads again what this one could not
    cursor: stop ? cursorIn : listing.cursor,
    noteCount: held.size, written, unchanged, kept, suggested, removed, skipped, stop,
  };
}
