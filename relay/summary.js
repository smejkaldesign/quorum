// POST /v1/notes: the running summary or the final notes for one call, on Quorum's Anthropic key or the organization's
// connector, streamed back as server-sent events. The prompts are the app's own (app/notes.js), imported, not copied.
// The app redacts the turns before they leave the Mac, so the relay sees what the model sees and nothing more.
import { notesPrompt, notesSystem, summaryPrompt } from '../app/notes.js';
import { allowance, authorize, bearer, connectorSecret, RelayError } from './lib/auth.js';
import { pickModel, streamAnthropic, streamOpenAI } from './lib/models.js';
import { usageEvent, writeUsage } from './lib/usage.js';

const MAX_BODY = 4 * 1024 * 1024;
const STEPS = new Set(['summary', 'notes']);

export function readJson(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new RelayError('bad_request', 'The request is too large.', 413)); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new RelayError('bad_request', 'The body must be JSON.', 400)); } });
    req.on('error', reject);
  });
}

// the request as the prompt builders want it; turns keep only the fields the lines use
export function cleanNotesRequest(b = {}) {
  const kind = STEPS.has(b.kind) ? b.kind : null;
  const turns = Array.isArray(b.turns) ? b.turns.slice(0, 5000).map((t) => ({ id: Number(t?.id) || 0, channel: t?.channel === 'me' ? 'me' : 'them', text: String(t?.text ?? '').slice(0, 4000), speaker: typeof t?.speaker === 'string' ? t.speaker : undefined, confidence: Number(t?.confidence) || 0 })) : [];
  const state = b.state && typeof b.state === 'object' ? b.state : { summary: '', decisions: [], actions: [], questions: [], coveredUntil: null };
  const label = { me: String(b.label?.me ?? 'me').slice(0, 80), them: String(b.label?.them ?? 'them').slice(0, 80) };
  const context = { platform: String(b.context?.platform ?? 'A').slice(0, 40), solo: b.context?.solo === true, title: String(b.context?.title ?? '').slice(0, 200) };
  return { kind, workspaceId: String(b.workspaceId ?? ''), meetingId: b.meetingId == null ? null : String(b.meetingId), turns, state, label, context, outline: String(b.outline ?? '').slice(0, 20000), owner: String(b.owner ?? 'me').slice(0, 80), about: String(b.about ?? '').slice(0, 4000) };
}

export function buildPrompt(r) {
  const system = notesSystem({ owner: r.owner, about: r.about });
  const prompt = r.kind === 'summary'
    ? summaryPrompt({ state: r.state, turns: r.turns, label: r.label, context: r.context })
    : notesPrompt({ state: r.state, turns: r.turns, label: r.label, context: r.context, outline: r.outline });
  return { system, prompt };
}

const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

export async function handleNotes(req, res, { clients, config, log = () => {}, fetchImpl = fetch }) {
  const t0 = Date.now();
  let r, model;
  try {
    if (req.method !== 'POST') throw new RelayError('bad_request', 'POST only.', 405);
    r = cleanNotesRequest(await readJson(req));
    if (!r.kind) throw new RelayError('bad_request', 'kind must be summary or notes.', 400);
    if (!r.turns.length) throw new RelayError('bad_request', 'Send at least one turn.', 400);
    const user = await authorize(clients, { token: bearer(req.headers.authorization), workspaceId: r.workspaceId });
    const connector = user.voice[r.kind] ? await connectorSecret(clients.db, user.voice[r.kind], r.kind) : null;
    try { model = pickModel({ step: r.kind, connector, quorumKey: config.keys.anthropic, openaiModel: config.openaiModel }); }
    catch (err) { throw new RelayError('connector', err.message, 400); }
    if (model.counted) {
      const a = await allowance(clients.db, r.workspaceId);
      if (a.remaining <= 0) throw new RelayError('allowance', 'This workspace has used its managed hours for the month.', 402);
    }
    const { system, prompt } = buildPrompt(r);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const ac = new AbortController();
    req.on('close', () => ac.abort());
    const call = model.kind === 'anthropic' ? streamAnthropic : streamOpenAI;
    const text = await call({ ...model, system, prompt, onDelta: (d) => sse(res, { delta: d }), signal: ac.signal, fetchImpl });
    sse(res, { done: true, chars: text.length });
    res.end();
    const row = usageEvent({ workspaceId: r.workspaceId, userId: user.userId, role: r.kind, seconds: 0, engine: model.model, connectorId: connector ? user.voice[r.kind] : null, meetingId: r.meetingId });
    try { await writeUsage(clients.db, row); } catch (err) { log('usage_write_failed', { message: err.message }); }
    log('notes_done', { kind: r.kind, model: model.model, counted: model.counted, turns: r.turns.length, chars: text.length, wallMs: Date.now() - t0 });
  } catch (err) {
    const status = err instanceof RelayError ? err.status : 500;
    const message = err instanceof RelayError ? err.message : 'The notes could not be generated.';
    log('notes_failed', { kind: r?.kind ?? null, model: model?.model ?? null, status, message: err.message });
    if (res.headersSent) { sse(res, { error: message }); res.end(); return; }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: message, code: err instanceof RelayError ? err.code : 'server' }));
  }
}
