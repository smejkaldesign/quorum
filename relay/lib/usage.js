import { ULID, ulid } from './ids.js';

// the row the relay writes when a session or a model call ends. connector_id null means Quorum's key, which is what
// the workspace_usage view counts against the allowance; the engine column names what ran.
export function usageEvent({ workspaceId, userId, role, seconds, engine, connectorId = null, meetingId = null, now = Date.now() }) {
  return {
    id: ulid(now),
    workspace_id: workspaceId,
    user_id: userId,
    role,
    seconds: Math.max(0, Math.round(Number(seconds) || 0)),
    engine: engine ?? null,
    connector_id: connectorId ?? null,
    meeting_id: meetingId && ULID.test(meetingId) ? meetingId : null,
  };
}

// the app's meeting id is a timestamp, not a row, until sync pushes the meeting; a reference that is not there yet is dropped
export async function writeUsage(db, row) {
  const asError = (e) => (e instanceof Error ? e : Object.assign(new Error(e?.message ?? String(e)), { code: e?.code }));
  const first = await db.from('workspace_usage_events').insert(row);
  if (!first.error) return row;
  if (!row.meeting_id) throw asError(first.error);
  const retry = await db.from('workspace_usage_events').insert({ ...row, meeting_id: null });
  if (retry.error) throw asError(retry.error);
  return { ...row, meeting_id: null };
}
