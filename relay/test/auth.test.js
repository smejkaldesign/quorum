import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { allowance, authorize, bearer, connectorSecret, RelayError, requireMember, verifyToken } from '../lib/auth.js';
import { baseTables, CONNECTOR, fakeAnon, fakeDb, TOKEN, USER, WS } from './helpers.js';

const anon = fakeAnon({ [TOKEN]: { id: USER, email: 'ana@example.com' } });

describe('token verification', () => {
  it('reads a bearer header', () => {
    assert.equal(bearer('Bearer abc.def'), 'abc.def');
    assert.equal(bearer('bearer abc'), 'abc');
    assert.equal(bearer('Token abc'), null);
    assert.equal(bearer(undefined), null);
  });
  it('accepts a token the project knows and refuses the rest', async () => {
    assert.deepEqual(await verifyToken(anon, TOKEN), { userId: USER, email: 'ana@example.com' });
    await assert.rejects(verifyToken(anon, 'stale'), (e) => e instanceof RelayError && e.code === 'unauthorized' && e.status === 401);
    await assert.rejects(verifyToken(anon, null), (e) => e.code === 'unauthorized');
  });
});

describe('membership and settings', () => {
  it('needs a live membership row', async () => {
    const db = fakeDb({ tables: baseTables() });
    assert.equal(await requireMember(db, WS, USER), 'member');
    await assert.rejects(requireMember(db, WS, 'someone-else'), (e) => e.code === 'forbidden' && e.status === 403);
    const gone = fakeDb({ tables: { ...baseTables(), members: [{ workspace_id: WS, user_id: USER, role: 'member', deleted_at: '2026-01-01' }] } });
    await assert.rejects(requireMember(gone, WS, USER), (e) => e.code === 'forbidden');
  });
  it('authorize returns the caller, role and voice overrides', async () => {
    const db = fakeDb({ tables: baseTables({ voice: { speech: CONNECTOR, required: true } }) });
    const who = await authorize({ anon, db }, { token: TOKEN, workspaceId: WS });
    assert.equal(who.userId, USER);
    assert.equal(who.role, 'member');
    assert.deepEqual(who.voice, { speech: CONNECTOR, required: true });
    await assert.rejects(authorize({ anon, db }, { token: TOKEN, workspaceId: '' }), (e) => e.code === 'bad_request');
  });
  it('reads a connector secret through the RPC and checks the role', async () => {
    const db = fakeDb({ rpcs: { relay_connector_secret: ({ connector_id }) => ({ data: [{ workspace_id: WS, provider: 'deepgram', base_url: null, roles: ['speech'], secret: `s-${connector_id}` }], error: null }) } });
    assert.deepEqual(await connectorSecret(db, CONNECTOR, 'speech'), { provider: 'deepgram', baseUrl: null, secret: `s-${CONNECTOR}`, workspaceId: WS });
    await assert.rejects(connectorSecret(db, CONNECTOR, 'notes'), (e) => e.code === 'connector');
  });
});

describe('allowance from the workspace and the usage view', () => {
  it('sums managed hours this month across seats', async () => {
    const period = '2026-11-01T00:00:00+00:00';
    const db = fakeDb({ tables: baseTables({ seats: 2, hourPacks: 1, usage: [{ workspace_id: WS, period, managed_hours: '10.5' }, { workspace_id: WS, period, managed_hours: 4 }, { workspace_id: WS, period: '2026-10-01T00:00:00+00:00', managed_hours: 99 }] }) });
    const a = await allowance(db, WS, new Date('2026-11-08T12:00:00Z'));
    assert.equal(a.usedHours, 14.5);
    assert.equal(a.remaining, (60 - 14.5) * 3600);
  });
  it('fails plainly when the workspace is gone', async () => {
    const db = fakeDb({ tables: { ...baseTables(), workspaces: [] } });
    await assert.rejects(allowance(db, WS), (e) => e.code === 'server');
  });
});
