import { describe, expect, it } from 'vitest';
import { DEFAULT_RELAY, FALLBACK_RELAY, httpUrl, modelPlan, readSse, relayNotes, relayUrls, speechPlan, unreachable } from '../ee/relay.js';
import { cleanVoice } from '../ee/connectors.js';

const ws = { id: 'ws1' };
const sse = (events) => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });

describe('which model runs the summary and the notes', () => {
  it('follows the speech plan, then the Use Quorum\'s models choice, and never without a workspace', () => {
    expect(modelPlan({ signedIn: true, workspace: ws, engine: 'managed' }).managed).toBe(true);
    expect(modelPlan({ signedIn: true, workspace: ws, voice: { required: true } }).reason).toBe('required by the workspace');
    expect(modelPlan({ signedIn: true, workspace: ws, managedModels: true })).toEqual({ managed: true, reason: "Quorum's models" });
    expect(modelPlan({ signedIn: true, workspace: ws }).managed).toBe(false);
    expect(modelPlan({ signedIn: false, workspace: ws, managedModels: true }).managed).toBe(false);
    expect(modelPlan({ signedIn: true, workspace: null, managedModels: true }).managed).toBe(false);
    expect(speechPlan({ signedIn: true, workspace: ws, managedModels: true }).managed).toBe(false);
  });
  it('keeps the admin required flag and drops anything else', () => {
    expect(cleanVoice({ speech: 'c1', required: true, other: 1 })).toEqual({ speech: 'c1', required: true });
    expect(cleanVoice({ required: 'yes' })).toEqual({});
  });
});

describe('the relay notes call', () => {
  it('turns ws urls into http and reads every data line', async () => {
    expect(httpUrl('wss://relay.quorum.watch/')).toBe('https://relay.quorum.watch');
    expect(httpUrl('ws://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
    const seen = [];
    await readSse(sse([{ delta: 'a' }, { delta: 'b' }, { done: true, chars: 2 }]).body, (e) => seen.push(e));
    expect(seen).toEqual([{ delta: 'a' }, { delta: 'b' }, { done: true, chars: 2 }]);
  });
  it('streams deltas, returns the whole text, and sends the redacted turns with the bearer token', async () => {
    let got;
    const fetchImpl = async (url, init) => { got = { url, init }; return sse([{ delta: '{"summary":' }, { delta: ' "x"}' }, { done: true, chars: 16 }]); };
    const deltas = [];
    const text = await relayNotes({ url: 'wss://relay.example', token: 't0k', kind: 'summary', turns: [{ id: 1, channel: 'me', text: 'hi' }], state: {}, label: { me: 'Me', them: 'Them' }, context: { platform: 'Zoom' }, workspaceId: 'ws1', owner: 'Ana', onDelta: (t) => deltas.push(t), fetchImpl });
    expect(text).toBe('{"summary": "x"}');
    expect(deltas).toEqual(['{"summary":', '{"summary": "x"}']);
    expect(got.url).toBe('https://relay.example/v1/notes');
    expect(got.init.headers.authorization).toBe('Bearer t0k');
    expect(JSON.parse(got.init.body)).toMatchObject({ kind: 'summary', workspaceId: 'ws1', owner: 'Ana', turns: [{ id: 1, channel: 'me', text: 'hi' }] });
  });
  it('raises the relay\'s own sentence on a refusal and on a mid-stream error', async () => {
    const refused = async () => new Response(JSON.stringify({ error: 'This workspace has used its managed hours for the month.', code: 'allowance' }), { status: 402 });
    await expect(relayNotes({ url: 'wss://r', token: 't', kind: 'notes', turns: [], workspaceId: 'w', fetchImpl: refused })).rejects.toThrow('used its managed hours');
    const midway = async () => sse([{ delta: 'a' }, { error: 'The notes could not be generated.' }]);
    await expect(relayNotes({ url: 'wss://r', token: 't', kind: 'notes', turns: [], workspaceId: 'w', fetchImpl: midway })).rejects.toThrow('could not be generated');
  });
});

describe('relay addresses', () => {
  it('tries the custom domain then the Railway address in production, one address otherwise', () => {
    expect(relayUrls({ env: {}, source: 'production' })).toEqual([DEFAULT_RELAY, FALLBACK_RELAY]);
    expect(relayUrls({ env: {}, source: 'local' })).toEqual(['ws://127.0.0.1:8787']);
    expect(relayUrls({ env: { QUORUM_RELAY_URL: 'wss://x.example/' } })).toEqual(['wss://x.example']);
  });
  it('tells a connection failure from a refusal', () => {
    expect(unreachable(new Error('the relay could not be reached'))).toBe(true);
    expect(unreachable(Object.assign(new TypeError('fetch failed'), { cause: new Error('certificate has expired') }))).toBe(true);
    expect(unreachable(new Error('This workspace has used its managed hours for the month.'))).toBe(false);
  });
});
