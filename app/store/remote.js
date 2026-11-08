// the hosted edition's store: the same interface as local.js over Supabase. Step 3 of docs/backend-plan.md;
// today only notes and meetings push (upsert), everything else is still to come
import { createClient } from '@supabase/supabase-js';
import path from 'node:path';

const notImplemented = (name) => () => { throw new Error(`remote store: ${name} not implemented`); };
const stub = (ns, names) => Object.fromEntries(names.map((n) => [n, notImplemented(`${ns}.${n}`)]));
const now = () => new Date().toISOString();

export function createRemote({ url = process.env.QUORUM_SUPABASE_URL, key = process.env.QUORUM_SUPABASE_ANON_KEY, workspaceId = process.env.QUORUM_WORKSPACE_ID, userId = process.env.QUORUM_USER_ID } = {}) {
  if (!url || !key) throw new Error('remote store: QUORUM_SUPABASE_URL and QUORUM_SUPABASE_ANON_KEY are needed');
  const db = createClient(url, key, { auth: { persistSession: false } });
  const scoped = (row) => ({ workspace_id: workspaceId, user_id: userId, updated_at: now(), ...row });
  const upsert = async (table, rows) => {
    const { error } = await db.from(table).upsert(rows.map(scoped), { onConflict: 'id' });
    if (error) throw new Error(`remote store: ${table} upsert failed: ${error.message}`);
    return rows.length;
  };
  return {
    notes: {
      ...stub('notes', ['read', 'write', 'list', 'title', 'readFrontmatter', 'setFrontmatterKey']),
      // one row per vault file; path is relative to the vault, body is the whole markdown file
      push: ({ id, rel, text, frontmatter = {}, hash = '', mtime = null }) => upsert('notes', [{ id, path: rel, frontmatter, body: text, hash, mtime }]),
    },
    meetings: {
      ...stub('meetings', ['root', 'ensureRoot', 'dir', 'notesDir', 'sources', 'beginSegment', 'writeTranscript', 'deleteAudio', 'deleteSegments', 'deleteSession', 'saveNote']),
      push: ({ id, title = '', startedAt = null, endedAt = null, participants = [], visibility = 'private', noteId = null }) => upsert('meetings', [{ id, title, started_at: startedAt, ended_at: endedAt, participants, visibility, note_id: noteId }]),
      // private meetings keep their transcript on the Mac; only public ones send segments
      pushSegments: (meeting, segments) => (meeting.visibility === 'public' ? upsert('transcript_segments', segments.map((s) => ({ id: s.id, meeting_id: meeting.id, channel: s.channel, t: s.start ?? 0, text: s.text, who: s.who ?? null }))) : Promise.resolve(0)),
    },
    chats: stub('chats', ['list', 'read', 'write', 'remove']),
    settings: stub('settings', ['get', 'save', 'set']),
    attachments: stub('attachments', ['stage', 'unstage', 'stagedOnly', 'clear']),
    state: stub('state', ['write']),
    describe: () => ({ url, workspaceId, bucket: path.posix.join('attachments', workspaceId ?? '') }),
  };
}
