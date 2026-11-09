// workspace connectors (Settings › Admin › Connectors), hosted edition: the list, add or replace through the
// workspace_connector_set RPC, remove, and one read-only request to the provider that proves a key before anything is
// saved. A key crosses IPC once, goes into the RPC or the test request, and is never logged or kept here.
import { ANTHROPIC } from '../models.js';
import { plain } from './account.js';

const NAMES = { assemblyai: 'AssemblyAI', deepgram: 'Deepgram', elevenlabs: 'ElevenLabs', openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google', openai_compatible: 'The provider' };
const ROLES = new Set(['speech', 'summary', 'notes', 'agent', 'voice']);
const COLUMNS = 'id, workspace_id, provider, label, base_url, roles, created_by, created_at, updated_at';
const row = (r) => ({ id: r.id, workspaceId: r.workspace_id, provider: r.provider, label: r.label, baseUrl: r.base_url ?? null, roles: r.roles ?? [], createdBy: r.created_by ?? null, createdAt: r.created_at, updatedAt: r.updated_at });

// the cheapest request each provider answers only with a valid key; Anthropic takes the same headers models.js sends
const TESTS = {
  anthropic: (key) => ({ url: new URL('/v1/models?limit=1', ANTHROPIC.url).href, headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC.version } }),
  openai: (key) => ({ url: 'https://api.openai.com/v1/models', headers: { authorization: `Bearer ${key}` } }),
  openai_compatible: (key, base) => ({ url: `${base.replace(/\/+$/, '')}/models`, headers: { authorization: `Bearer ${key}` } }),
  google: (key) => ({ url: `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=${encodeURIComponent(key)}`, headers: {} }),
  deepgram: (key) => ({ url: 'https://api.deepgram.com/v1/projects', headers: { authorization: `Token ${key}` } }),
  assemblyai: (key) => ({ url: 'https://api.assemblyai.com/v2/transcript?limit=1', headers: { authorization: key } }),
  elevenlabs: (key) => ({ url: 'https://api.elevenlabs.io/v1/user', headers: { 'xi-api-key': key } }),
};

export async function testConnector({ provider, baseUrl, secret } = {}, fetchImpl = fetch) {
  const make = TESTS[provider];
  if (!make) return { error: 'That provider is not supported.' };
  const key = String(secret ?? '').trim();
  if (!key) return { error: 'Paste the provider key first.' };
  const base = String(baseUrl ?? '').trim();
  if (provider === 'openai_compatible' && !/^https?:\/\/\S+$/.test(base)) return { error: 'Enter the base URL, starting with https://.' };
  let r;
  try {
    const req = make(key, base);
    r = await fetchImpl(req.url, { headers: req.headers, signal: AbortSignal.timeout(15000) });
  } catch {
    return { error: `Quorum could not reach ${NAMES[provider]}. Check your connection${provider === 'openai_compatible' ? ' and the base URL' : ''}.` };
  }
  if (r.status === 401 || r.status === 403) return { error: `${NAMES[provider]} did not accept that key.` };
  if (!r.ok) return { error: `${NAMES[provider]} answered ${r.status}. Try again in a minute.` };
  return { ok: true };
}

// what the RPC takes, cleaned: a provider it knows, trimmed label and URL, roles from the fixed set, the key as pasted
export function cleanDraft(draft = {}) {
  const provider = String(draft.provider ?? '');
  if (!(provider in TESTS)) return { error: 'That provider is not supported.' };
  const roles = [...new Set((Array.isArray(draft.roles) ? draft.roles : []).map(String).filter((r) => ROLES.has(r)))];
  return {
    provider,
    label: String(draft.label ?? '').trim().slice(0, 80),
    base_url: provider === 'openai_compatible' ? String(draft.baseUrl ?? '').trim() || null : null,
    roles,
    secret: String(draft.secret ?? '').trim(),
  };
}

export function createConnectors({ account, log = () => {} }) {
  const fail = (err, fallback) => { log('connectors', err?.message ?? err); return { error: plain(err, fallback) }; };
  const ready = () => {
    if (!account.client()) return { error: 'Hosted accounts are not set up in this build.' };
    const s = account.state();
    if (!s.signedIn) return { error: 'Sign in first.' };
    if (!s.workspace) return { error: 'Pick a workspace first.' };
    return null;
  };
  const ws = () => account.state().workspace.id;
  const handlers = {
    'connectors-list': async () => {
      const no = ready(); if (no) return no;
      try {
        const { data, error } = await account.client().from('workspace_connectors').select(COLUMNS).eq('workspace_id', ws()).order('created_at');
        if (error) return fail(error);
        return { connectors: (data ?? []).map(row) };
      } catch (err) { return fail(err); }
    },
    'connector-set': async (draft) => {
      const no = ready(); if (no) return no;
      const clean = cleanDraft(draft);
      if (clean.error) return clean;
      try {
        const { data, error } = await account.client().rpc('workspace_connector_set', { workspace_id: ws(), ...clean });
        if (error) return fail(error, 'The connector could not be saved.');
        return { connector: row(data) };
      } catch (err) { return fail(err, 'The connector could not be saved.'); }
    },
    'connector-remove': async (id) => {
      const no = ready(); if (no) return no;
      try {
        const { error } = await account.client().rpc('workspace_connector_remove', { id: String(id ?? '') });
        if (error) return fail(error, 'That connector could not be removed.');
        return { ok: true };
      } catch (err) { return fail(err, 'That connector could not be removed.'); }
    },
    'connector-test': (p) => testConnector(p),
  };
  return { handlers };
}

export function registerConnectors({ ipcMain, account, log }) {
  const c = createConnectors({ account, log });
  for (const [name, fn] of Object.entries(c.handlers)) ipcMain.handle(name, (_e, ...a) => fn(...a));
  return c;
}
