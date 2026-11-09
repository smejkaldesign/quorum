// Model access (docs/open-source-strategy.md): every source is the user's own, Quorum holds no key of its own.
//   claude-code    the Claude Code signed in on this Mac; the only source with tools, so the only one that reads the Agent OS
//   anthropic-api  the user's Anthropic key from the Keychain, called straight at the Messages API; prompt in, text out
//   local          an Ollama model at localhost; prompt in, text out
//   none           the fresh-install default: nothing runs and the app says so
import { execFile, spawn } from 'node:child_process';
import { runAgent } from './agent.js';

export const SOURCES = ['none', 'claude-code', 'anthropic-api', 'local'];
export const ANTHROPIC = { service: 'quorum-model-anthropic', account: 'quorum', url: 'https://api.anthropic.com/v1/messages', version: '2023-06-01', verifyModel: 'claude-haiku-5-5' };
export const OLLAMA = { url: 'http://127.0.0.1:11434', defaultModel: 'llama3.1' };
export const NEEDS_SOURCE = 'Choose a model source in Settings › Connectors before Quorum can answer';
export const NEEDS_TOOLS = 'This question needs the Agent OS; switch the model source to Claude Code on this Mac';

// the picker's aliases are Claude Code's; the API wants full ids
const API_MODELS = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' };
export const apiModel = (alias) => API_MODELS[alias] ?? API_MODELS.sonnet;
export const localModelName = (name) => (String(name ?? '').trim() || OLLAMA.defaultModel);

// what the saved note records as the model, per source
export function modelLabel(source, alias, local) {
  if (source === 'claude-code') return `claude-${alias}`;
  if (source === 'anthropic-api') return apiModel(alias);
  if (source === 'local') return `ollama/${localModelName(local)}`;
  return 'none';
}

// one entry point for every model call. tools: true is the Agent OS question path (agent.js, Claude Code only); without
// tools the prompt carries everything and any source answers. async so a wrong source rejects like any other failure
export async function runModel({ source, tools = false, ...opts }) {
  if (source === 'none') throw new Error(NEEDS_SOURCE);
  if (tools) {
    if (source !== 'claude-code') throw new Error(NEEDS_TOOLS);
    return runAgent(opts);
  }
  if (source === 'claude-code') return claudeText(opts);
  if (source === 'anthropic-api') return anthropicText(opts);
  if (source === 'local') return ollamaText(opts);
  throw new Error(`unknown model source ${source}`);
}

// Claude via the signed-in Claude Code (the user's own claude.ai sign-in), never a raw API key
function claudeText({ prompt, system, model, cwd }) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    const proc = spawn('claude', [
      '-p', '--output-format', 'text', '--model', model, '--tools', '', '--no-session-persistence',
      '--strict-mcp-config', '--setting-sources', 'user', '--system-prompt', system,
    ], { env, cwd });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err || `claude exited ${code}`))));
    proc.stdin.end(prompt);
  });
}

// the key stays in the Keychain and in this process; it is never logged, never returned over IPC and never written to settings
const security = (args) => new Promise((resolve) => execFile('/usr/bin/security', args, (err, out) => resolve(err ? null : out.trim())));
let keyCache; // undefined until looked up, null when there's no key

export async function anthropicKey() {
  if (keyCache === undefined) keyCache = (await security(['find-generic-password', '-s', ANTHROPIC.service, '-a', ANTHROPIC.account, '-w'])) || null;
  return keyCache;
}

async function anthropicText({ prompt, system, model, key, maxTokens = 8192, timeoutMs = 120000 }) {
  const k = key ?? await anthropicKey();
  if (!k) throw new Error('No Anthropic API key saved. Add one in Settings › Connectors.');
  const r = await fetch(ANTHROPIC.url, {
    method: 'POST',
    headers: { 'x-api-key': k, 'anthropic-version': ANTHROPIC.version, 'content-type': 'application/json' },
    body: JSON.stringify({ model: apiModel(model), max_tokens: maxTokens, system, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${data.error?.message ?? r.statusText}`);
  if (data.stop_reason === 'refusal') throw new Error('The model declined this request');
  return (data.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
}

// checks the key with one tiny request before keeping it
export async function setAnthropicKey(key) {
  try {
    await anthropicText({ prompt: 'Reply with the word ok.', system: 'You answer in one word.', model: 'haiku', key, maxTokens: 8, timeoutMs: 15000 });
  } catch (err) {
    return { error: /Anthropic 40[13]/.test(err.message) ? "Anthropic didn't accept that key" : /Anthropic \d+/.test(err.message) ? err.message : "Couldn't reach Anthropic. Check your connection and try again." };
  }
  const saved = await security(['add-generic-password', '-U', '-s', ANTHROPIC.service, '-a', ANTHROPIC.account, '-l', 'Anthropic API key (Quorum)', '-w', key]);
  keyCache = undefined;
  return saved === null ? { error: "Couldn't save the key to your Keychain" } : { ok: true };
}

export async function removeAnthropicKey() {
  await security(['delete-generic-password', '-s', ANTHROPIC.service, '-a', ANTHROPIC.account]);
  keyCache = null;
}

// Ollama's chat endpoint; the picker's Claude aliases mean nothing here, the configured local model always answers
async function ollamaText({ prompt, system, localModel, timeoutMs = 180000 }) {
  let r;
  try {
    r = await fetch(`${OLLAMA.url}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: localModelName(localModel), stream: false, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error('Ollama is not running at localhost:11434');
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Ollama ${r.status}: ${data.error ?? r.statusText}`);
  return String(data.message?.content ?? '').trim();
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

// which sources this Mac can run right now; claude comes from the caller, which already knows how to ask Claude Code
export async function sourceStatus({ source, localModel, claude }) {
  const [key, ollama] = await Promise.all([anthropicKey(), ollamaStatus(localModel)]);
  return { source, localModel: localModelName(localModel), claude, key: !!key, ollama };
}
