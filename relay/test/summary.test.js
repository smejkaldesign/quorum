import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pickModel, streamAnthropic, streamOpenAI } from '../lib/models.js';
import { createLimiter } from '../platform.js';
import { buildPrompt, cleanNotesRequest, handleNotes } from '../summary.js';
import { baseTables, fakeAnon, fakeDb, relayConfig, TOKEN, USER, WS } from './helpers.js';

const sseBody = (lines) => new Response(lines.map((l) => `${l}\n`).join('')).body;

describe('notes request to the shared prompt builders', () => {
  const req = cleanNotesRequest({ kind: 'notes', workspaceId: 'W', turns: [{ id: 1, channel: 'me', text: 'We ship Friday.' }, { id: 2, channel: 'them', text: 'Agreed.', speaker: 'Sam', confidence: 0.95 }], label: { me: 'Ana', them: 'them' }, context: { platform: 'Zoom', title: 'Launch' }, outline: '- date', owner: 'Ana', about: 'Ana runs design.' });
  it('keeps the fields the prompt lines use and drops the rest', () => {
    assert.equal(req.kind, 'notes');
    assert.deepEqual(req.turns[1], { id: 2, channel: 'them', text: 'Agreed.', speaker: 'Sam', confidence: 0.95 });
    assert.equal(cleanNotesRequest({ kind: 'poem' }).kind, null);
    assert.equal(cleanNotesRequest({ turns: 'x' }).turns.length, 0);
  });
  it('builds the same final notes prompt the app builds, with the owner outline and turn ids', () => {
    const { system, prompt } = buildPrompt(req);
    assert.match(system, /You write meeting notes for Ana/);
    assert.match(system, /Ana runs design\./);
    assert.match(prompt, /Zoom call, topic: Launch/);
    assert.match(prompt, /\[t1\] Ana: We ship Friday\./);
    assert.match(prompt, /\[t2\] Sam: Agreed\./);
    assert.match(prompt, /Use them as the outline/);
    assert.match(prompt, /"sections"/);
  });
  it('builds the running summary prompt from the state and the new turns', () => {
    const { prompt } = buildPrompt(cleanNotesRequest({ kind: 'summary', turns: req.turns, state: { summary: 'So far.', decisions: [], actions: [], questions: [] }, label: req.label, context: { platform: 'Meet' } }));
    assert.match(prompt, /Running state so far/);
    assert.match(prompt, /"summary":"So far\."/);
    assert.match(prompt, /Update the state with the new turns/);
  });
});

describe('which model answers a step', () => {
  it('uses Quorum’s Anthropic key by default and counts the call', () => {
    assert.deepEqual(pickModel({ step: 'summary', connector: null, quorumKey: 'q', openaiModel: 'gpt-4o-mini' }), { kind: 'anthropic', key: 'q', model: 'claude-haiku-5-5', counted: true });
    assert.equal(pickModel({ step: 'notes', connector: null, quorumKey: 'q' }).model, 'claude-sonnet-5-5');
  });
  it('uses the organization connector without counting, and refuses a non-model provider', () => {
    assert.equal(pickModel({ step: 'notes', connector: { provider: 'anthropic', secret: 'o' }, quorumKey: 'q' }).counted, false);
    const oa = pickModel({ step: 'notes', connector: { provider: 'openai_compatible', secret: 'o', baseUrl: 'https://llm.example.com/v1' }, quorumKey: 'q', openaiModel: 'm' });
    assert.deepEqual(oa, { kind: 'openai', key: 'o', baseUrl: 'https://llm.example.com/v1', model: 'm', counted: false });
    assert.throws(() => pickModel({ step: 'notes', connector: { provider: 'deepgram', secret: 'o' }, quorumKey: 'q' }), /not a model provider/);
    assert.throws(() => pickModel({ step: 'notes', connector: null, quorumKey: undefined }), /not set up/);
  });
});

describe('streamed replies', () => {
  it('collects Anthropic text deltas and sends the right headers', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push({ url, init }); return new Response(sseBody(['event: content_block_delta', 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"{\\"title\\""}}', '', 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":":\\"Launch\\"}"}}', 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}']), { status: 200 }); };
    const deltas = [];
    const text = await streamAnthropic({ key: 'k', model: 'claude-haiku-5-5', system: 's', prompt: 'p', onDelta: (d) => deltas.push(d), fetchImpl });
    assert.equal(text, '{"title":"Launch"}');
    assert.deepEqual(deltas, ['{"title"', ':"Launch"}']);
    assert.equal(calls[0].init.headers['x-api-key'], 'k');
    assert.equal(JSON.parse(calls[0].init.body).stream, true);
  });
  it('surfaces an Anthropic refusal and an HTTP error', async () => {
    await assert.rejects(streamAnthropic({ key: 'k', model: 'm', system: 's', prompt: 'p', onDelta: () => {}, fetchImpl: async () => new Response(sseBody(['data: {"type":"message_delta","delta":{"stop_reason":"refusal"}}']), { status: 200 }) }), /declined/);
    await assert.rejects(streamAnthropic({ key: 'k', model: 'm', system: 's', prompt: 'p', onDelta: () => {}, fetchImpl: async () => new Response('{"error":{"message":"bad key"}}', { status: 401, statusText: 'Unauthorized' }) }), /Anthropic 401: bad key/);
  });
  it('collects OpenAI chat deltas up to [DONE] and honours the base URL', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push({ url, init }); return new Response(sseBody(['data: {"choices":[{"delta":{"role":"assistant"}}]}', 'data: {"choices":[{"delta":{"content":"Hel"}}]}', 'data: {"choices":[{"delta":{"content":"lo"}}]}', 'data: [DONE]']), { status: 200 }); };
    const text = await streamOpenAI({ key: 'k', baseUrl: 'https://llm.example.com/v1/', model: 'm', system: 's', prompt: 'p', onDelta: () => {}, fetchImpl });
    assert.equal(text, 'Hello');
    assert.equal(calls[0].url, 'https://llm.example.com/v1/chat/completions');
    assert.equal(calls[0].init.headers.authorization, 'Bearer k');
  });
});

describe('notes route limits', () => {
  const anon = fakeAnon({ [TOKEN]: { id: USER, email: 'ana@example.com' } });
  const fakeReq = (body) => {
    const listeners = {};
    const req = { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, on: (ev, fn) => { listeners[ev] = fn; return req; }, destroy() {} };
    setTimeout(() => { listeners.data?.(Buffer.from(body)); listeners.end?.(); }, 0);
    return req;
  };
  const fakeRes = () => ({ status: 0, body: '', headersSent: false, writeHead(st) { this.status = st; this.headersSent = true; }, write() {}, end(b) { this.body = String(b ?? ''); } });
  const deps = (over = {}) => ({ clients: { anon, db: fakeDb({ tables: baseTables() }) }, config: relayConfig(), log: () => {}, ...over });
  const body = (over = {}) => JSON.stringify({ kind: 'summary', workspaceId: WS, turns: [{ id: 1, channel: 'them', text: 'Hello.' }], ...over });

  it('refuses a caller over the per-user rate before any model call', async () => {
    let called = false;
    const res = fakeRes();
    await handleNotes(fakeReq(body()), res, deps({ notesLimit: createLimiter({ max: 0 }), fetchImpl: async () => { called = true; throw new Error('no model call expected'); } }));
    assert.equal(res.status, 429);
    assert.equal(JSON.parse(res.body).code, 'rate_limit');
    assert.equal(called, false);
  });
  it('refuses a body over 1 MB', async () => {
    const res = fakeRes();
    await handleNotes(fakeReq(body({ about: 'x'.repeat(1024 * 1024) })), res, deps());
    assert.equal(res.status, 413);
  });
});
