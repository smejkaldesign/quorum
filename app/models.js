// Model access (docs/open-source-strategy.md): every provider is the user's own, Quorum holds no key of its own.
//   claude-code        the Claude Code signed in on this Mac; the only provider with tools, so the only one that reads the Agent OS
//   anthropic          the user's Anthropic key from the Keychain, called straight at the Messages API; prompt in, text out
//   openai, google     the user's key, chat completions or Gemini generateContent; prompt in, text out
//   openai_compatible  any chat-completions server, with the base URL and model name from settings.connectors
//   ollama             an Ollama model at localhost; prompt in, text out
// Which provider runs which step comes from settings.providers (connectors/catalog.js); the legacy single switch
// settings.modelSource (SOURCES) still works and is derived both ways in main.js
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { runAgent } from './agent.js';
import { agyText, codexText, runnersStatus } from './runners.js';
import { BY_ID, OLLAMA_URL, modelFor, modelName, providerFor } from './connectors/catalog.js';
import { connectedKeys, connectorKey } from './connectors/keys.js';

export const SOURCES = ['none', 'claude-code', 'anthropic-api', 'local'];
export const ANTHROPIC = { url: `${BY_ID.anthropic.url}/messages`, version: '2023-06-01' };
export const OLLAMA = { url: OLLAMA_URL, defaultModel: 'llama3.1' };
export const NEEDS_SOURCE = 'Choose a model provider in Settings › Connectors before Quorum can answer';
export const NEEDS_TOOLS = 'This question needs the Agent OS; set the agent provider to Claude Code on this Mac';

// the picker's aliases are Claude Code's; the API wants full ids
export const apiModel = (alias) => modelFor('anthropic', alias);
export const localModelName = (name) => (String(name ?? '').trim() || OLLAMA.defaultModel);

// what the saved note records as the model, per provider
export function modelLabel(id, alias, local, connectors) {
  if (id === 'claude-code') return `claude-${alias}`;
  if (id === 'ollama') return `ollama/${localModelName(local)}`;
  return modelName(id, alias, local, connectors) ?? 'none';
}

// one entry point for every model call. role picks the provider from settings.providers (summary, notes, agent), with
// the legacy source as the fallback; tools: true is the Agent OS question path (agent.js, Claude Code only); without
// tools the prompt carries everything and any provider answers. async so a wrong provider rejects like any other failure
export async function runModel({ source = 'none', role = null, providers = null, connectors = null, tools = false, ...opts }) {
  const id = providerFor(role, providers, source);
  if (!id) throw new Error(NEEDS_SOURCE);
  if (tools) {
    if (id !== 'claude-code') throw new Error(NEEDS_TOOLS);
    return runAgent(opts);
  }
  if (id === 'claude-code') return claudeText(opts);
  if (id === 'codex') return codexText(opts);
  if (id === 'antigravity') return agyText(opts);
  if (id === 'anthropic') return anthropicText(opts);
  if (id === 'ollama') return ollamaText(opts);
  if (id === 'openai') return openaiText(opts);
  if (id === 'google') return googleText(opts);
  if (id === 'openai_compatible') return openaiText({ ...opts, provider: 'openai_compatible', ...connectors?.openai_compatible });
  throw new Error(`${BY_ID[id]?.name ?? id} cannot run this step`);
}

// Claude via the signed-in Claude Code (the user's own claude.ai sign-in), never a raw API key
// with onDelta the reply streams (stream-json with partial messages); onDelta gets the whole text so far each time
function claudeText({ prompt, system, model, cwd, onDelta = null }) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    const proc = spawn('claude', [
      '-p', '--output-format', onDelta ? 'stream-json' : 'text', ...(onDelta ? ['--verbose', '--include-partial-messages'] : []),
      '--model', model, '--tools', '', '--no-session-persistence',
      '--strict-mcp-config', '--setting-sources', 'user', '--system-prompt', system,
    ], { env, cwd });
    let out = '';
    let err = '';
    let result = null;
    let acc = '';
    if (onDelta) {
      createInterface({ input: proc.stdout }).on('line', (line) => {
        let evt;
        try { evt = JSON.parse(line); } catch { return; }
        const d = evt.type === 'stream_event' ? evt.event : null;
        if (d?.type === 'content_block_delta' && d.delta?.type === 'text_delta') { acc += d.delta.text; onDelta(acc); }
        if (evt.type === 'result') result = evt;
      });
    } else proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (onDelta) return result && !result.is_error ? resolve(String(result.result).trim()) : reject(new Error(result?.result || err.split('\n')[0] || `claude exited ${code}`));
      return code === 0 ? resolve(out.trim()) : reject(new Error(err || `claude exited ${code}`));
    });
    proc.stdin.end(prompt);
  });
}

// reads a streamed HTTP body line by line (server-sent events or newline-delimited JSON)
async function readLines(body, onLine) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    buf += done ? dec.decode() : dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) onLine(line); }
    if (done) break;
  }
  if (buf.trim()) onLine(buf.trim());
}

const noKey = (id) => new Error(`No ${BY_ID[id].name} API key saved. Add one in Settings › Connectors.`);
async function failure(r, name) { const data = await r.json().catch(() => ({})); return new Error(`${name} ${r.status}: ${data.error?.message ?? r.statusText}`); }

export const anthropicKey = () => connectorKey('anthropic');

async function anthropicText({ prompt, system, model, key, maxTokens = 8192, timeoutMs = 120000, onDelta = null }) {
  const k = key ?? await anthropicKey();
  if (!k) throw noKey('anthropic');
  const r = await fetch(ANTHROPIC.url, {
    method: 'POST',
    headers: { 'x-api-key': k, 'anthropic-version': ANTHROPIC.version, 'content-type': 'application/json' },
    body: JSON.stringify({ model: apiModel(model), max_tokens: maxTokens, system, stream: !!onDelta, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw await failure(r, 'Anthropic');
  if (!onDelta) {
    const data = await r.json().catch(() => ({}));
    if (data.stop_reason === 'refusal') throw new Error('The model declined this request');
    return (data.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
  }
  let acc = '';
  let stop = null;
  await readLines(r.body, (line) => {
    if (!line.startsWith('data:')) return;
    let evt;
    try { evt = JSON.parse(line.slice(5)); } catch { return; }
    if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') { acc += evt.delta.text; onDelta(acc); }
    if (evt.type === 'message_delta') stop = evt.delta?.stop_reason ?? stop;
    if (evt.type === 'error') throw new Error(`Anthropic: ${evt.error?.message ?? 'stream error'}`);
  });
  if (stop === 'refusal') throw new Error('The model declined this request');
  return acc.trim();
}

// chat completions, for OpenAI and any server with the same shape. OpenAI maps the picker alias to its own models; a
// compatible server answers with the model named in settings. The stream is server-sent events ending in [DONE]
const chatMessages = (system, prompt) => [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }];
async function openaiText({ prompt, system, model, key, provider = 'openai', baseUrl, maxTokens = 8192, timeoutMs = 120000, onDelta = null }) {
  const p = BY_ID[provider];
  const k = key ?? await connectorKey(provider);
  if (!k) throw noKey(provider);
  const base = String(provider === 'openai' ? p.url : baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!base) throw new Error(`No base URL saved for ${p.name}. Add one in Settings › Connectors.`);
  const name = provider === 'openai' ? modelFor('openai', model) : String(model ?? '').trim();
  if (!name) throw new Error(`No model name saved for ${p.name}. Add one in Settings › Connectors.`);
  const limit = provider === 'openai' ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens };
  const r = await fetch(`${base}/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${k}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: name, stream: !!onDelta, ...limit, messages: chatMessages(system, prompt) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw await failure(r, p.name);
  if (!onDelta) return openaiReply(await r.json().catch(() => ({})));
  let acc = '';
  await readLines(r.body, (line) => { const d = openaiDelta(line, p.name); if (d) { acc += d; onDelta(acc); } });
  return acc.trim();
}

export function openaiReply(data) {
  const c = data.choices?.[0];
  if (c?.finish_reason === 'content_filter') throw new Error('The model declined this request');
  return String(c?.message?.content ?? '').trim();
}

// one SSE line to the text it adds, or null for keep-alives, [DONE] and anything that is not a data line
export function openaiDelta(line, name = 'OpenAI') {
  if (!line.startsWith('data:')) return null;
  const s = line.slice(5).trim();
  if (!s || s === '[DONE]') return null;
  let evt;
  try { evt = JSON.parse(s); } catch { return null; }
  if (evt.error) throw new Error(`${name}: ${evt.error.message ?? 'stream error'}`);
  return evt.choices?.[0]?.delta?.content || null;
}

// Gemini generateContent, streamed as server-sent events with alt=sse; the system prompt rides as systemInstruction
async function googleText({ prompt, system, model, key, maxTokens = 8192, timeoutMs = 120000, onDelta = null }) {
  const k = key ?? await connectorKey('google');
  if (!k) throw noKey('google');
  const r = await fetch(`${BY_ID.google.url}/models/${modelFor('google', model)}:${onDelta ? 'streamGenerateContent?alt=sse' : 'generateContent'}`, {
    method: 'POST', headers: { 'x-goog-api-key': k, 'content-type': 'application/json' },
    body: JSON.stringify({ ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}), contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: maxTokens } }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw await failure(r, 'Google');
  if (!onDelta) return googleReply(await r.json().catch(() => ({})));
  let acc = '';
  await readLines(r.body, (line) => { const d = googleDelta(line); if (d) { acc += d; onDelta(acc); } });
  return acc.trim();
}

const partsText = (c) => (c?.content?.parts ?? []).map((p) => p.text ?? '').join('');
export function googleReply(data) {
  const c = data.candidates?.[0];
  if (data.promptFeedback?.blockReason || c?.finishReason === 'SAFETY') throw new Error('The model declined this request');
  return partsText(c).trim();
}

export function googleDelta(line) {
  if (!line.startsWith('data:')) return null;
  let evt;
  try { evt = JSON.parse(line.slice(5)); } catch { return null; }
  if (evt.error) throw new Error(`Google: ${evt.error.message ?? 'stream error'}`);
  return partsText(evt.candidates?.[0]) || null;
}

// Ollama's chat endpoint; the picker's Claude aliases mean nothing here, the configured local model always answers
async function ollamaText({ prompt, system, localModel, timeoutMs = 180000, onDelta = null }) {
  let r;
  try {
    r = await fetch(`${OLLAMA.url}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: localModelName(localModel), stream: !!onDelta, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error('Ollama is not running at localhost:11434');
  }
  if (!r.ok) { const data = await r.json().catch(() => ({})); throw new Error(`Ollama ${r.status}: ${data.error ?? r.statusText}`); }
  if (!onDelta) {
    const data = await r.json().catch(() => ({}));
    return String(data.message?.content ?? '').trim();
  }
  let acc = '';
  await readLines(r.body, (line) => {
    let evt;
    try { evt = JSON.parse(line); } catch { return; }
    if (evt.error) throw new Error(`Ollama: ${evt.error}`);
    if (evt.message?.content) { acc += evt.message.content; onDelta(acc); }
  });
  return acc.trim();
}

// is Ollama up, and does it have the model the user named
export async function ollamaStatus(localModel) {
  try {
    const r = await fetch(`${OLLAMA.url}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return { reachable: false, hasModel: false };
    const want = localModelName(localModel);
    const names = ((await r.json()).models ?? []).map((m) => String(m.name ?? ''));
    return { reachable: true, hasModel: names.some((n) => n === want || n === `${want}:latest` || n.split(':')[0] === want) };
  } catch {
    return { reachable: false, hasModel: false };
  }
}

// what this Mac can run right now: which keys are saved (booleans only), Ollama, and the effective providers table.
// claude comes from the caller, which already knows how to ask Claude Code
export async function sourceStatus({ source, localModel, claude, providers = {}, connectors = {} }) {
  const [keys, ollama, runners] = await Promise.all([connectedKeys(), ollamaStatus(localModel), runnersStatus()]);
  return { source, localModel: localModelName(localModel), claude, key: !!keys.anthropic, keys, ollama, runners, providers, connectors };
}
