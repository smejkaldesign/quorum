// the hosted edition's store: the same interface as local.js over Supabase, scoped to one workspace and written as
// the signed-in user. Setup in docs/self-hosting.md. Notes, meetings, chats, settings and attachments read and write
// against the tables in supabase/migrations; what only makes sense on one Mac (session folders, audio, the live state
// file) throws a "not available in the hosted store" error that names the reason.
// The client comes from account.js, which holds the session; this module never signs in on its own.
// Ids are ULIDs the caller already made (sync.js keeps the local path to id map); chats.write needs ULID ids too.
import { readFileSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { notes as localNotes } from '../../store/local.js';

const PAGE = 1000;
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const now = () => new Date().toISOString();

// Crockford base32 ULID, the same shape sync.js makes; kept here so the store can mint ids for rows it creates
export function ulid(time = Date.now()) {
  let t = '';
  for (let i = 0; i < 10; i++) { t = B32[time % 32] + t; time = Math.floor(time / 32); }
  let r = '';
  for (const b of randomBytes(16)) r += B32[b & 31];
  return t + r;
}

const unavailable = (name, why) => () => { throw new Error(`remote store: ${name} is not available in the hosted store (${why})`); };
const first = (data) => (Array.isArray(data) ? data[0] ?? null : data ?? null);

export function createRemote({ client, workspaceId, userId } = {}) {
  if (!client) throw new Error('remote store: a signed-in Supabase client is needed');
  if (!workspaceId || !userId) throw new Error('remote store: workspaceId and userId are needed');
  const scoped = (row) => ({ workspace_id: workspaceId, user_id: userId, updated_at: now(), ...row });
  const run = async (builder, what) => {
    const { data, error } = await builder;
    if (error) throw new Error(`remote store: ${what} failed: ${error.message}`);
    return data ?? [];
  };
  const upsert = async (table, rows) => {
    if (!rows.length) return 0;
    await run(client.from(table).upsert(rows.map(scoped), { onConflict: 'id' }), `${table} upsert`);
    return rows.length;
  };
  // live rows of one table in this workspace; filters chain on the returned builder
  const live = (table, columns = '*') => client.from(table).select(columns).eq('workspace_id', workspaceId).is('deleted_at', null);
  // every row changed after `since`, soft-deleted ones included, oldest first and paged so a pull can walk them all
  const changedSince = (table, columns) => async (since = null, { limit = PAGE, offset = 0 } = {}) => {
    let b = client.from(table).select(columns).eq('workspace_id', workspaceId);
    if (since) b = b.gt('updated_at', since);
    return run(b.order('updated_at', { ascending: true }).order('id', { ascending: true }).range(offset, offset + limit - 1), `${table} read`);
  };
  const softDelete = (table, ids) => (ids.length ? run(client.from(table).update({ deleted_at: now() }).in('id', ids), `${table} delete`) : Promise.resolve([]));

  // one row per vault file; path is relative to the vault, body is the whole markdown file
  const noteRow = ({ id, rel, text, frontmatter = {}, hash = '', mtime = null }) => ({ id, path: rel, frontmatter, body: text, hash, mtime });
  const meetingRow = ({ id, title = '', startedAt = null, endedAt = null, participants = [], visibility = 'private', noteId = null }) => ({ id, title, started_at: startedAt, ended_at: endedAt, participants, visibility, note_id: noteId });
  const noteByPath = async (rel) => first(await run(live('notes').eq('path', rel).limit(1), 'notes read'));
  const noteBody = async (rel) => { const r = await noteByPath(rel); if (!r) throw new Error(`remote store: note not found: ${rel}`); return r.body; };
  const titleOf = (text, rel) => text.match(/^#\s+(.+)$/m)?.[1].trim() ?? path.posix.basename(rel, '.md');

  const notes = {
    // read and write take the vault-relative path the row stores; local.js takes an absolute path
    read: noteBody,
    write: async (rel, text) => {
      const existing = await noteByPath(rel);
      const row = noteRow({ id: existing?.id ?? ulid(), rel, text, frontmatter: localNotes.readFrontmatter(text), mtime: now() });
      await upsert('notes', [row]);
      return row.id;
    },
    // the .md files directly under one folder, as local.js lists a directory on disk
    list: async (dir = '') => {
      const prefix = dir ? `${dir.replace(/\/+$/, '')}/` : '';
      const rows = await run((prefix ? live('notes', 'path').like('path', `${prefix}%`) : live('notes', 'path')).order('path'), 'notes list');
      return rows.map((r) => r.path).filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/')).map((p) => p.slice(prefix.length)).filter((f) => f.endsWith('.md') && f !== 'index.md' && f !== 'README.md');
    },
    title: async (rel) => { try { return titleOf(await noteBody(rel), rel); } catch { return path.posix.basename(rel, '.md'); } },
    readFrontmatter: localNotes.readFrontmatter,
    setFrontmatterKey: localNotes.setFrontmatterKey,
    byId: async (id) => first(await run(client.from('notes').select('*').eq('workspace_id', workspaceId).eq('id', id).limit(1), 'notes read')),
    changedSince: changedSince('notes', 'id, user_id, path, frontmatter, body, hash, mtime, updated_at, deleted_at'),
    // the live notes other members share with this one (the read policy admits only public, included notes), ids and
    // versions only, so a pull can drop the local copy of anything no longer shared
    shared: ({ limit = PAGE, offset = 0 } = {}) => run(client.from('notes').select('id, hash').eq('workspace_id', workspaceId).neq('user_id', userId).is('deleted_at', null).order('id', { ascending: true }).range(offset, offset + limit - 1), 'notes shared'),
    remove: (id) => softDelete('notes', [id]),
    push: (note) => upsert('notes', [noteRow(note)]),
    pushMany: (notes) => upsert('notes', notes.map(noteRow)),
  };

  const SESSION_WHY = 'capture sessions and audio stay on the Mac that recorded them';
  const meetings = {
    get root() { return unavailable('meetings.root', SESSION_WHY)(); },
    ensureRoot: unavailable('meetings.ensureRoot', SESSION_WHY),
    dir: unavailable('meetings.dir', 'the meetings folder is a vault folder on disk; notes rows carry their vault path'),
    notesDir: unavailable('meetings.notesDir', 'the meetings folder is a vault folder on disk; notes rows carry their vault path'),
    sources: unavailable('meetings.sources', 'other apps write their notes into local folders'),
    beginSegment: unavailable('meetings.beginSegment', SESSION_WHY),
    writeTranscript: unavailable('meetings.writeTranscript', SESSION_WHY),
    deleteAudio: unavailable('meetings.deleteAudio', SESSION_WHY),
    deleteSegments: unavailable('meetings.deleteSegments', SESSION_WHY),
    deleteSession: unavailable('meetings.deleteSession', SESSION_WHY),
    saveNote: (rel, text) => notes.write(rel, text),
    list: ({ limit = 200, offset = 0 } = {}) => run(live('meetings').order('started_at', { ascending: false, nullsFirst: false }).range(offset, offset + limit - 1), 'meetings list'),
    read: async (id) => {
      const m = first(await run(live('meetings').eq('id', id).limit(1), 'meetings read'));
      return m ? { ...m, segments: await meetings.segments(id) } : null;
    },
    segments: (meetingId) => run(live('transcript_segments', 'id, channel, t, text, who').eq('meeting_id', meetingId).order('t'), 'segments read'),
    changedSince: changedSince('meetings', 'id, title, started_at, ended_at, participants, visibility, note_id, updated_at, deleted_at'),
    remove: (id) => softDelete('meetings', [id]),
    push: (meeting) => upsert('meetings', [meetingRow(meeting)]),
    pushMany: (meetings) => upsert('meetings', meetings.map(meetingRow)),
    // private meetings keep their transcript on the Mac; only public ones send segments
    pushSegments: (meeting, segments) => (meeting.visibility === 'public' ? upsert('transcript_segments', segments.map((s) => ({ id: s.id, meeting_id: meeting.id, channel: s.channel, t: s.start ?? 0, text: s.text, who: s.who ?? null }))) : Promise.resolve(0)),
  };

  // chats: a chats row plus one chat_turns row per turn, returned in the shape local.js keeps in chats/*.json
  const turnOut = (t) => ({ id: t.id, q: t.question, a: t.answer, sources: t.sources ?? [], steps: t.steps ?? [], at: t.created_at });
  const chatOut = (c) => ({ id: c.id, title: c.title, meetingId: c.meeting_id ?? undefined, noteId: c.note_id ?? undefined, createdAt: c.created_at, updatedAt: c.updated_at, turns: (c.turns ?? []).filter((t) => !t.deleted_at).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))).map(turnOut) });
  const turnRow = (chatId, t, id) => ({ id, chat_id: chatId, question: String(t.q ?? ''), answer: String(t.a ?? ''), sources: t.sources ?? [], steps: t.steps ?? [], created_at: t.at ?? now() });
  const needUlid = (id, what) => { if (!ULID.test(String(id))) throw new Error(`remote store: ${what} needs a ULID id, got ${id}`); return String(id); };
  const chats = {
    list: async () => (await run(live('chats', '*, turns:chat_turns(*)').order('updated_at', { ascending: false }), 'chats list')).map(chatOut),
    read: async (id) => { const c = first(await run(live('chats', '*, turns:chat_turns(*)').eq('id', id).limit(1), 'chats read')); return c ? chatOut(c) : null; },
    // the chat row is upserted; turns reuse the ids already stored for the chat in order, so writing twice keeps one row per turn
    write: async (c) => {
      const id = needUlid(c.id, 'chats.write');
      await upsert('chats', [{ id, title: String(c.title ?? ''), meeting_id: ULID.test(String(c.meetingId)) ? c.meetingId : null, note_id: ULID.test(String(c.noteId)) ? c.noteId : null }]);
      const had = (await run(live('chat_turns', 'id, created_at').eq('chat_id', id).order('created_at'), 'turns read')).map((t) => t.id);
      const turns = (c.turns ?? []).map((t, i) => turnRow(id, t, t.id && ULID.test(String(t.id)) ? t.id : had[i] ?? ulid()));
      await upsert('chat_turns', turns);
      const keep = new Set(turns.map((t) => t.id));
      await softDelete('chat_turns', had.filter((h) => !keep.has(h)));
      return id;
    },
    append: async (chatId, turn) => { const row = turnRow(needUlid(chatId, 'chats.append'), turn, ulid()); await upsert('chat_turns', [row]); await upsert('chats', [{ id: chatId }]); return row.id; },
    remove: async (id) => {
      const turns = (await run(live('chat_turns', 'id').eq('chat_id', id), 'turns read')).map((t) => t.id);
      await softDelete('chat_turns', turns);
      await softDelete('chats', [id]);
    },
  };

  // settings: one row per user in the workspace (scope 'user') and one shared row (scope 'workspace'); load first,
  // then get reads the cache the way local.js reads its in-memory object
  const cache = { user: null, workspace: null };
  const rowIds = { user: null, workspace: null };
  const scopeRow = async (scope) => first(await run(live('settings').eq('scope', scope).limit(1), 'settings read'));
  const settings = {
    existed: true,
    load: async (scope = 'user') => {
      const r = await scopeRow(scope);
      rowIds[scope] = r?.id ?? null;
      cache[scope] = r?.data ?? {};
      return cache[scope];
    },
    get: (scope = 'user') => cache[scope] ?? {},
    save: async (scope = 'user') => {
      if (!rowIds[scope]) rowIds[scope] = (await scopeRow(scope))?.id ?? ulid();
      await upsert('settings', [{ id: rowIds[scope], scope, data: cache[scope] ?? {} }]);
    },
    set: async (patch, scope = 'user') => { cache[scope] = { ...(cache[scope] ?? {}), ...patch }; await settings.save(scope); return cache[scope]; },
  };

  // attachments: the file goes to the attachments bucket under <workspace>/<ulid>/<name> and a metadata row points at
  // it; the object path is what stage returns and what unstage takes back
  const bucket = 'attachments';
  const objectPrefix = `${workspaceId}/`;
  const attachments = {
    stage: async (from, { chatId = null, noteId = null, mime = null } = {}) => {
      const size = statSync(from).size;
      if (size > 25 * 1024 * 1024) throw new Error('Files over 25 MB can\'t be attached');
      const id = ulid(), name = path.basename(from), object = `${objectPrefix}${id}/${name}`;
      const { error } = await client.storage.from(bucket).upload(object, readFileSync(from), { upsert: false, ...(mime ? { contentType: mime } : {}) });
      if (error) throw new Error(`remote store: attachment upload failed: ${error.message}`);
      await upsert('attachments', [{ id, bucket, object_path: object, name, size, mime, chat_id: chatId, note_id: noteId }]);
      return object;
    },
    unstage: async (objects) => {
      const ours = attachments.stagedOnly(objects);
      if (!ours.length) return;
      const { error } = await client.storage.from(bucket).remove(ours);
      if (error) throw new Error(`remote store: attachment delete failed: ${error.message}`);
      await run(client.from('attachments').update({ deleted_at: now() }).eq('workspace_id', workspaceId).in('object_path', ours), 'attachments delete');
    },
    stagedOnly: (objects) => (Array.isArray(objects) ? objects.map(String).filter((o) => o.startsWith(objectPrefix)) : []),
    clear: unavailable('attachments.clear', 'clear removes one Mac\'s leftover copies at launch; hosted attachments belong to the chats that hold them'),
    list: () => run(live('attachments').order('created_at', { ascending: false }), 'attachments list'),
  };

  const state = {
    write: unavailable('state.write', 'state.json carries the live transcript for the quorum CLI on this Mac, and private transcripts never leave it'),
  };

  return { notes, meetings, chats, settings, attachments, state, describe: () => ({ workspaceId, userId, bucket: path.posix.join(bucket, workspaceId) }) };
}
