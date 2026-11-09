import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ULID } from '../lib/ids.js';
import { usageEvent, writeUsage } from '../lib/usage.js';
import { CONNECTOR, fakeDb, USER, WS } from './helpers.js';

describe('usage event shape', () => {
  it('matches the workspace_usage_events columns', () => {
    const row = usageEvent({ workspaceId: WS, userId: USER, role: 'speech', seconds: 1799.6, engine: 'assemblyai', meetingId: '2026-11-08T16-00-00-000Z' });
    assert.match(row.id, ULID);
    assert.deepEqual({ ...row, id: 'x' }, { id: 'x', workspace_id: WS, user_id: USER, role: 'speech', seconds: 1800, engine: 'assemblyai', connector_id: null, meeting_id: null });
  });
  it('keeps a connector id and a ULID meeting id, and never a negative count', () => {
    const row = usageEvent({ workspaceId: WS, userId: USER, role: 'notes', seconds: -3, engine: 'claude-sonnet-5-5', connectorId: CONNECTOR, meetingId: WS });
    assert.equal(row.seconds, 0);
    assert.equal(row.connector_id, CONNECTOR);
    assert.equal(row.meeting_id, WS);
  });
  it('retries without the meeting when that row is not synced yet', async () => {
    const db = fakeDb({ failInsert: (row) => (row.meeting_id ? { code: '23503', message: 'violates foreign key' } : null) });
    const written = await writeUsage(db, usageEvent({ workspaceId: WS, userId: USER, role: 'speech', seconds: 5, engine: 'deepgram', meetingId: WS }));
    assert.equal(written.meeting_id, null);
    assert.equal(db.inserted.length, 1);
  });
  it('throws when the insert fails for another reason', async () => {
    const db = fakeDb({ failInsert: () => ({ message: 'permission denied' }) });
    await assert.rejects(writeUsage(db, usageEvent({ workspaceId: WS, userId: USER, role: 'speech', seconds: 5, engine: 'deepgram' })), /permission denied/);
  });
});
