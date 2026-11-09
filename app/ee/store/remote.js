// the hosted edition's store: the same interface as local.js over Supabase, scoped to one workspace and written as
// the signed-in user. Setup in docs/self-hosting.md; today only notes and meetings push (upsert), the rest is to come.
// The client comes from account.js, which holds the session; this module never signs in on its own.
import path from 'node:path';

const notImplemented = (name) => () => { throw new Error(`remote store: ${name} not implemented`); };
const stub = (ns, names) => Object.fromEntries(names.map((n) => [n, notImplemented(`${ns}.${n}`)]));
const now = () => new Date().toISOString();

export function createRemote({ client, workspaceId, userId } = {}) {
  if (!client) throw new Error('remote store: a signed-in Supabase client is needed');
  if (!workspaceId || !userId) throw new Error('remote store: workspaceId and userId are needed');
  const scoped = (row) => ({ workspace_id: workspaceId, user_id: userId, updated_at: now(), ...row });
  const upsert = async (table, rows) => {
    if (!rows.length) return 0;
    const { error } = await client.from(table).upsert(rows.map(scoped), { onConflict: 'id' });
    if (error) throw new Error(`remote store: ${table} upsert failed: ${error.message}`);
    return rows.length;
  };
  // one row per vault file; path is relative to the vault, body is the whole markdown file
  const noteRow = ({ id, rel, text, frontmatter = {}, hash = '', mtime = null }) => ({ id, path: rel, frontmatter, body: text, hash, mtime });
  const meetingRow = ({ id, title = '', startedAt = null, endedAt = null, participants = [], visibility = 'private', noteId = null }) => ({ id, title, started_at: startedAt, ended_at: endedAt, participants, visibility, note_id: noteId });
  return {
    notes: {
      ...stub('notes', ['read', 'write', 'list', 'title', 'readFrontmatter', 'setFrontmatterKey']),
      push: (note) => upsert('notes', [noteRow(note)]),
      pushMany: (notes) => upsert('notes', notes.map(noteRow)),
    },
    meetings: {
      ...stub('meetings', ['root', 'ensureRoot', 'dir', 'notesDir', 'sources', 'beginSegment', 'writeTranscript', 'deleteAudio', 'deleteSegments', 'deleteSession', 'saveNote']),
      push: (meeting) => upsert('meetings', [meetingRow(meeting)]),
      pushMany: (meetings) => upsert('meetings', meetings.map(meetingRow)),
      // private meetings keep their transcript on the Mac; only public ones send segments
      pushSegments: (meeting, segments) => (meeting.visibility === 'public' ? upsert('transcript_segments', segments.map((s) => ({ id: s.id, meeting_id: meeting.id, channel: s.channel, t: s.start ?? 0, text: s.text, who: s.who ?? null }))) : Promise.resolve(0)),
    },
    chats: stub('chats', ['list', 'read', 'write', 'remove']),
    settings: stub('settings', ['get', 'save', 'set']),
    attachments: stub('attachments', ['stage', 'unstage', 'stagedOnly', 'clear']),
    state: stub('state', ['write']),
    describe: () => ({ workspaceId, userId, bucket: path.posix.join('attachments', workspaceId) }),
  };
}
