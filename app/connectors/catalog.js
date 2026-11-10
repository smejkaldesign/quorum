// The connector catalog (docs/open-source-strategy.md): every provider Quorum can run a step on, what each one can do,
// how it signs in and how a key is proven. Pure data and pure functions; the main process (models.js, keys.js), the
// renderer (Settings › Connectors) and the hosted Admin page (ee/) all read this one list.
//   roles  speech: audio to text · summary: the running summary · notes: the final notes · agent: questions · voice: read aloud
//   auth   none: nothing to set up · key: an API key · key+url: a key and a base URL · signin: a CLI signed in on this Mac
//   test   one read-only request that only a valid key answers; null when the provider is proven another way
//   models which model answers for each picker alias (opus, sonnet, haiku); absent when the user names the model
export const ROLES = [
  { id: 'speech', label: 'Speech to text' },
  { id: 'summary', label: 'Running summary' },
  { id: 'notes', label: 'Final notes' },
  { id: 'agent', label: 'Agent' },
  { id: 'voice', label: 'Voice' },
];
export const ROLE_IDS = ROLES.map((r) => r.id);
export const ROLE_LABEL = Object.fromEntries(ROLES.map((r) => [r.id, r.label]));
export const MODEL_ROLES = ['summary', 'notes', 'agent'];

export const OLLAMA_URL = 'http://127.0.0.1:11434';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1';
const OPENAI_URL = 'https://api.openai.com/v1';
const GOOGLE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const bearer = (key) => ({ authorization: `Bearer ${key}` });

export const CATALOG = [
  { id: 'apple', name: 'Apple', roles: ['speech'], auth: 'none', test: null, docs: 'https://developer.apple.com/documentation/speech', pricing: null, free: true, keyHint: '', placeholder: '' },
  { id: 'assemblyai', name: 'AssemblyAI', roles: ['speech'], auth: 'key', test: (key) => ({ url: 'https://api.assemblyai.com/v2/transcript?limit=1', headers: { authorization: key } }), docs: 'https://www.assemblyai.com/docs', pricing: 'https://www.assemblyai.com/pricing', keyHint: 'AssemblyAI API key', placeholder: 'Your AssemblyAI key' },
  { id: 'deepgram', name: 'Deepgram', roles: ['speech'], auth: 'key', test: (key) => ({ url: 'https://api.deepgram.com/v1/projects', headers: { authorization: `Token ${key}` } }), docs: 'https://developers.deepgram.com/docs', pricing: 'https://deepgram.com/pricing', keyHint: 'Deepgram API key', placeholder: 'Your Deepgram key' },
  { id: 'elevenlabs', name: 'ElevenLabs', roles: ['speech', 'voice'], auth: 'key', test: (key) => ({ url: 'https://api.elevenlabs.io/v1/user', headers: { 'xi-api-key': key } }), docs: 'https://elevenlabs.io/docs', pricing: 'https://elevenlabs.io/pricing', keyHint: 'ElevenLabs API key', placeholder: 'Your ElevenLabs key' },
  { id: 'openai', name: 'OpenAI', roles: ['speech', 'summary', 'notes', 'agent', 'voice'], auth: 'key', test: (key) => ({ url: `${OPENAI_URL}/models`, headers: bearer(key) }), docs: 'https://platform.openai.com/docs', pricing: 'https://openai.com/api/pricing', keyHint: 'OpenAI API key', placeholder: 'sk-...', url: OPENAI_URL, models: { opus: 'gpt-5', sonnet: 'gpt-5', haiku: 'gpt-5-mini' } },
  { id: 'anthropic', name: 'Anthropic', roles: ['summary', 'notes', 'agent'], auth: 'key', test: (key) => ({ url: `${ANTHROPIC_URL}/models?limit=1`, headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } }), docs: 'https://docs.claude.com', pricing: 'https://www.anthropic.com/pricing', keyHint: 'Anthropic API key', placeholder: 'sk-ant-...', url: ANTHROPIC_URL, models: { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' } },
  { id: 'google', name: 'Google', roles: ['speech', 'summary', 'notes', 'agent'], auth: 'key', test: (key) => ({ url: `${GOOGLE_URL}/models?pageSize=1`, headers: { 'x-goog-api-key': key } }), docs: 'https://ai.google.dev/gemini-api/docs', pricing: 'https://ai.google.dev/pricing', keyHint: 'Google AI API key', placeholder: 'AIza...', url: GOOGLE_URL, models: { opus: 'gemini-2.5-pro', sonnet: 'gemini-2.5-pro', haiku: 'gemini-2.5-flash' } },
  { id: 'claude-code', name: 'Claude Code', roles: ['summary', 'notes', 'agent'], auth: 'signin', test: null, docs: 'https://docs.claude.com/en/docs/claude-code', pricing: 'https://claude.com/pricing', free: true, keyHint: '', placeholder: '' },
  // runners on the person's own subscription, print mode (app/runners.js): summary and notes only; the agent role needs Quorum's read guard, which only Claude Code's hooks carry
  { id: 'codex', name: 'Codex', roles: ['summary', 'notes'], auth: 'signin', test: null, docs: 'https://developers.openai.com/codex/cli', pricing: 'https://openai.com/pricing', free: true, keyHint: '', placeholder: '' },
  { id: 'antigravity', name: 'Antigravity', roles: ['summary', 'notes'], auth: 'signin', test: null, docs: 'https://antigravity.google/docs', pricing: null, free: true, keyHint: '', placeholder: '' },
  { id: 'ollama', name: 'Ollama', roles: ['summary', 'notes', 'agent'], auth: 'none', test: () => ({ url: `${OLLAMA_URL}/api/tags`, headers: {} }), docs: 'https://docs.ollama.com', pricing: null, free: true, keyHint: '', placeholder: '', url: OLLAMA_URL },
  { id: 'openai_compatible', name: 'OpenAI-compatible', roles: ['summary', 'notes', 'agent'], auth: 'key+url', test: (key, base) => ({ url: `${base.replace(/\/+$/, '')}/models`, headers: bearer(key) }), docs: 'https://platform.openai.com/docs/api-reference/chat', pricing: null, keyHint: 'API key', placeholder: 'Your key' },
];
export const BY_ID = Object.fromEntries(CATALOG.map((p) => [p.id, p]));
export const PROVIDER_IDS = CATALOG.map((p) => p.id);
export const needsKey = (id) => /^key/.test(BY_ID[id]?.auth ?? '');
export const needsBaseUrl = (id) => BY_ID[id]?.auth === 'key+url';
// the providers a key connects; the hosted Admin page lists exactly these
export const KEY_PROVIDERS = CATALOG.filter((p) => needsKey(p.id));
export const KEY_PROVIDER_IDS = KEY_PROVIDERS.map((p) => p.id);

export const rolesFor = (id) => BY_ID[id]?.roles ?? [];
// managed transcription hours each Cloud seat includes per month (docs/open-source-strategy.md)
export const INCLUDED_HOURS = 20;
export const canServe = (id, role) => rolesFor(id).includes(role);
export const providersFor = (role) => PROVIDER_IDS.filter((id) => canServe(id, role));
export const validRoles = (id, roles) => roles.filter((r) => canServe(id, r));
// the model a provider runs for a picker alias; providers without a table (Ollama, OpenAI-compatible) take the user's name
export const modelFor = (id, alias) => { const m = BY_ID[id]?.models; return m ? m[alias] ?? m.sonnet : null; };

// settings.providers = { speech, summary, notes, agent, voice }, each a provider id that can serve the role. The legacy
// single switch settings.modelSource keeps working: with providers unset it is read as the three model roles on one
// provider, and when the user picks providers the switch is written back for the paths that still read it
const FROM_SOURCE = { 'claude-code': 'claude-code', 'anthropic-api': 'anthropic', local: 'ollama' };
const TO_SOURCE = { 'claude-code': 'claude-code', anthropic: 'anthropic-api', ollama: 'local' };

export function providersFromSource(source, base = {}) {
  const out = { ...base };
  for (const r of MODEL_ROLES) delete out[r];
  const id = FROM_SOURCE[source];
  if (id) for (const r of MODEL_ROLES) out[r] = id;
  return out;
}

// the switch value for a providers table; providers without a legacy value (OpenAI, Google, compatible) read as none
export function sourceFromProviders(providers = {}) {
  const id = providers.agent ?? providers.notes ?? providers.summary;
  return TO_SOURCE[id] ?? 'none';
}

// a partial update merged over the current table: a valid id sets the role, null or '' clears it, anything else is ignored
export function cleanProviders(next, cur = {}) {
  const out = { ...cur };
  if (!next || typeof next !== 'object') return out;
  for (const role of ROLE_IDS) {
    if (!(role in next)) continue;
    const v = next[role];
    if (v === null || v === '') delete out[role];
    else if (typeof v === 'string' && canServe(v, role)) out[role] = v;
  }
  return out;
}

// who runs a role: the role's own pick, then for a model role the other model roles, then the legacy switch, then the
// free default (Apple for speech). A call without a role runs where the final notes run
export function providerFor(role, providers, source) {
  const r = role ?? 'notes';
  const p = providers ?? {};
  if (p[r] && canServe(p[r], r)) return p[r];
  if (MODEL_ROLES.includes(r)) {
    for (const other of MODEL_ROLES) if (p[other] && canServe(p[other], r)) return p[other];
    return FROM_SOURCE[source] ?? null;
  }
  return r === 'speech' ? 'apple' : null;
}

// settings.connectors = { <id>: { baseUrl?, model? } }: an entry marks a provider the user added (Claude Code, Ollama
// have nothing else to keep); a key+url provider also keeps its base URL and model name. null removes the entry
export function cleanConnectors(next, cur = {}) {
  const out = { ...cur };
  if (!next || typeof next !== 'object') return out;
  for (const id of PROVIDER_IDS) {
    if (!(id in next)) continue;
    const v = next[id];
    if (v === null) { delete out[id]; continue; }
    if (!v || typeof v !== 'object') continue;
    const entry = { ...out[id] };
    if (needsBaseUrl(id)) {
      if (typeof v.baseUrl === 'string') { const u = v.baseUrl.trim(); if (/^https?:\/\/\S+$/.test(u)) entry.baseUrl = u; else if (!u) delete entry.baseUrl; }
      if (typeof v.model === 'string') { const m = v.model.trim(); if (/^[\w.\-/:]{1,120}$/.test(m)) entry.model = m; else if (!m) delete entry.model; }
    }
    out[id] = entry;
  }
  return out;
}

// the model name a provider answers with, for labels: the alias table, the local name, or the compatible server's name
export function modelName(id, alias, local, connectors) {
  if (id === 'ollama') return String(local ?? '').trim() || 'llama3.1';
  if (id === 'openai_compatible') return String(connectors?.openai_compatible?.model || '').trim() || 'OpenAI-compatible';
  return modelFor(id, alias);
}
