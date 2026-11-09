import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CLOSE, handleConnection } from '../lib/session.js';
import { baseTables, CONNECTOR, fakeAnon, fakeDb, fakeEngine, FakeSocket, frame, pcm, relayConfig, tick, TOKEN, USER, WS } from './helpers.js';

const anon = fakeAnon({ [TOKEN]: { id: USER, email: 'ana@example.com' } });
const hello = (over = {}) => ({ token: TOKEN, workspaceId: WS, meetingId: '2026-11-08T16-00-00-000Z', channels: ['me', 'them'], sampleRate: 16000, terms: ['Ana'], locale: 'en-US', ...over });

function connect({ tables = baseTables(), config = relayConfig(), engines, rpcs, headers = {}, failInsert } = {}) {
  const ws = new FakeSocket();
  const db = fakeDb({ tables, rpcs, failInsert });
  const logs = [];
  engines ??= { assemblyai: fakeEngine(), deepgram: fakeEngine() };
  handleConnection(ws, { headers }, { clients: { anon, db }, config, engines, log: (event, fields) => logs.push({ event, ...fields }) });
  return { ws, db, engines, logs };
}

describe('transcribe session', () => {
  it('answers the hello with ready, opens one engine socket per channel with the keyterms, and forwards frames by channel', async () => {
    const { ws, engines } = connect();
    ws.text(hello());
    await tick(5);
    const ready = ws.events('ready')[0];
    assert.deepEqual(ready, { event: 'ready', engine: 'assemblyai', counted: true, remainingSeconds: 72000, budgetSeconds: 14400 });
    assert.equal(engines.assemblyai.sessions.length, 2);
    assert.deepEqual(engines.assemblyai.sessions.map((s) => s.opts.channel), ['me', 'them']);
    assert.deepEqual(engines.assemblyai.sessions[0].opts.terms, ['Ana']);
    assert.equal(engines.assemblyai.sessions[0].opts.key, 'k-a');
    ws.binary(frame(1, pcm(0.1)));
    ws.binary(frame(0, pcm(0.1)));
    ws.binary(frame(0, pcm(0.1)));
    assert.equal(engines.assemblyai.sessions[0].fed.length, 2);
    assert.equal(engines.assemblyai.sessions[1].fed.length, 1);
    engines.assemblyai.sessions[1].emit({ event: 'transcript', channel: 'them', text: 'Hi.', isFinal: true, start: 0, end: 0.4 });
    assert.deepEqual(ws.events('transcript'), [{ event: 'transcript', channel: 'them', text: 'Hi.', isFinal: true, start: 0, end: 0.4 }]);
  });

  it('writes one usage row with the recorded seconds and the engine when the client closes', async () => {
    const { ws, db, engines } = connect();
    ws.text(hello());
    await tick(5);
    for (let i = 0; i < 30; i++) { ws.binary(frame(0, pcm(1))); ws.binary(frame(1, pcm(1))); }
    ws.text({ event: 'stop' });
    await tick(10);
    assert.equal(ws.closedWith.code, CLOSE.client);
    assert.ok(engines.assemblyai.sessions.every((s) => s.finished && s.closed));
    assert.equal(db.inserted.length, 1);
    const row = db.inserted[0];
    assert.equal(row.workspace_id, WS);
    assert.equal(row.user_id, USER);
    assert.equal(row.role, 'speech');
    assert.equal(row.seconds, 30);
    assert.equal(row.engine, 'assemblyai');
    assert.equal(row.connector_id, null);
    assert.equal(row.meeting_id, null);
  });

  it('refuses a bad token, a non-member and an empty allowance before any engine opens', async () => {
    const bad = connect();
    bad.ws.text(hello({ token: 'stale' }));
    await tick(5);
    assert.equal(bad.ws.events('error')[0].code, 'unauthorized');
    assert.equal(bad.ws.closedWith.code, CLOSE.unauthorized);
    assert.equal(bad.engines.assemblyai.sessions.length, 0);

    const other = connect({ tables: { ...baseTables(), members: [] } });
    other.ws.text(hello());
    await tick(5);
    assert.equal(other.ws.events('error')[0].code, 'forbidden');

    const spent = connect({ tables: baseTables({ usage: [{ workspace_id: WS, period: new Date().toISOString(), managed_hours: 20 }] }) });
    spent.ws.text(hello());
    await tick(5);
    assert.equal(spent.ws.events('error')[0].code, 'allowance');
    assert.equal(spent.ws.closedWith.code, CLOSE.allowance);
    assert.equal(spent.db.inserted.length, 0);
  });

  it('routes speech to the organization connector, does not count its hours, and records the connector on the row', async () => {
    const rpcs = { relay_connector_secret: () => ({ data: [{ workspace_id: WS, provider: 'deepgram', base_url: null, roles: ['speech'], secret: 'org-key' }] }) };
    const { ws, db, engines } = connect({ tables: baseTables({ voice: { speech: CONNECTOR }, usage: [{ workspace_id: WS, period: new Date().toISOString(), managed_hours: 20 }] }), rpcs });
    ws.text(hello());
    await tick(5);
    const ready = ws.events('ready')[0];
    assert.equal(ready.engine, 'deepgram');
    assert.equal(ready.counted, false);
    assert.equal(ready.remainingSeconds, null);
    assert.equal(engines.deepgram.sessions[0].opts.key, 'org-key');
    assert.equal(engines.assemblyai.sessions.length, 0);
    ws.binary(frame(0, pcm(2)));
    ws.close(1000);
    await tick(10);
    assert.equal(db.inserted[0].connector_id, CONNECTOR);
    assert.equal(db.inserted[0].engine, 'deepgram');
    assert.equal(db.inserted[0].seconds, 2);
  });

  it('closes with cap when the audio passes the budget, and the row keeps what was heard', async () => {
    const { ws, db } = connect({ tables: baseTables({ usage: [{ workspace_id: WS, period: new Date().toISOString(), managed_hours: 19.999 }] }) });
    ws.text(hello());
    await tick(5);
    assert.ok(ws.events('ready')[0].remainingSeconds <= 4);
    for (let i = 0; i < 6; i++) ws.binary(frame(0, pcm(1)));
    await tick(10);
    assert.equal(ws.events('error')[0].code, 'cap');
    assert.equal(ws.closedWith.code, CLOSE.cap);
    assert.equal(db.inserted[0].seconds, 5);
  });

  it('closes an idle connection and one whose engine fails, with the matching codes', async () => {
    const idle = connect({ config: relayConfig({ idleMs: 30 }) });
    idle.ws.text(hello());
    await tick(5);
    idle.ws.binary(frame(0, pcm(0.1)));
    await tick(60);
    assert.equal(idle.ws.closedWith.code, CLOSE.idle);

    const down = connect({ engines: { assemblyai: fakeEngine({ fail: true }), deepgram: fakeEngine() } });
    down.ws.text(hello());
    await tick(5);
    assert.equal(down.ws.events('error')[0].code, 'server');
    assert.equal(down.ws.events('ready').length, 0);

    const drops = connect();
    drops.ws.text(hello());
    await tick(5);
    drops.engines.assemblyai.sessions[0].fail(new Error('upstream reset'));
    await tick(5);
    assert.equal(drops.ws.events('error')[0].code, 'engine');
    assert.equal(drops.ws.closedWith.code, CLOSE.engine);
  });

  it('takes the token from the Authorization header when the hello carries none, and rejects audio before the hello', async () => {
    const { ws } = connect({ headers: { authorization: `Bearer ${TOKEN}` } });
    ws.text(hello({ token: undefined }));
    await tick(5);
    assert.equal(ws.events('ready').length, 1);
    const early = connect();
    early.ws.binary(frame(0, pcm(0.1)));
    assert.equal(early.ws.closedWith.code, CLOSE.bad_request);
  });

  it('never logs audio or keys', async () => {
    const { ws, logs } = connect();
    ws.text(hello());
    await tick(5);
    ws.binary(frame(0, pcm(1)));
    ws.close(1000);
    await tick(10);
    const text = JSON.stringify(logs);
    assert.equal(text.includes('k-a'), false);
    assert.equal(text.includes(TOKEN), false);
    assert.equal(text.includes('data'), false);
    assert.ok(logs.some((l) => l.event === 'session_end' && l.seconds === 1 && l.engine === 'assemblyai'));
  });
});
