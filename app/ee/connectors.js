// workspace connectors (Settings › Admin › Connectors), hosted edition: the list, add or replace through the
// workspace_connector_set RPC, remove, and one read-only request to the provider that proves a key before anything is
// saved. A key crosses IPC once, goes into the RPC or the test request, and is never logged or kept here.
import { KEY_PROVIDER_IDS, ROLE_IDS } from '../connectors/catalog.js';
import { testConnector } from '../connectors/keys.js';
import { plain } from './account.js';

// the provider list and the read-only test request come from the shared catalog (connectors/catalog.js, keys.js)
export { testConnector };
const ROLES = new Set(ROLE_IDS);
const COLUMNS = 'id, workspace_id, provider, label, base_url, roles, created_by, created_at, updated_at';
const row = (r) => ({ id: r.id, workspaceId: r.workspace_id, provider: r.provider, label: r.label, baseUrl: r.base_url ?? null, roles: r.roles ?? [], createdBy: r.created_by ?? null, createdAt: r.created_at, updatedAt: r.updated_at });

// what the RPC takes, cleaned: a provider it knows, trimmed label and URL, roles from the fixed set, the key as pasted
export function cleanDraft(draft = {}) {
  const provider = String(draft.provider ?? '');
  if (!KEY_PROVIDER_IDS.includes(provider)) return { error: 'That provider is not supported.' };
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
    // hours this calendar month from the workspace_usage view; empty until the relay writes usage rows
    'workspace-usage': async () => {
      const no = ready(); if (no) return no;
      const since = new Date(); since.setUTCDate(1); since.setUTCHours(0, 0, 0, 0);
      try {
        const { data, error } = await account.client().from('workspace_usage').select('user_id, email, name, hours, managed_hours').eq('workspace_id', ws()).gte('period', since.toISOString());
        if (error) return fail(error);
        const seats = (data ?? []).map((r) => ({ userId: r.user_id, email: r.email ?? null, name: r.name ?? null, hours: Number(r.hours) || 0, managedHours: Number(r.managed_hours) || 0 }));
        const sum = (k) => Math.round(seats.reduce((n, s) => n + s[k], 0) * 100) / 100;
        return { usage: { period: since.toISOString(), hours: sum('hours'), managedHours: sum('managedHours'), seats } };
      } catch (err) { return fail(err); }
    },
    'workspace-voice-get': async () => {
      const no = ready(); if (no) return no;
      try {
        const { data, error } = await account.client().from('workspace_settings').select('voice').eq('workspace_id', ws()).maybeSingle();
        if (error) return fail(error);
        return { voice: cleanVoice(data?.voice) };
      } catch (err) { return fail(err); }
    },
    'workspace-voice-set': async (voice) => {
      const no = ready(); if (no) return no;
      try {
        const { data, error } = await account.client().rpc('workspace_voice_set', { workspace_id: ws(), voice: cleanVoice(voice) });
        if (error) return fail(error, 'The voice settings could not be saved.');
        return { voice: cleanVoice(data) };
      } catch (err) { return fail(err, 'The voice settings could not be saved.'); }
    },
  };
  return { handlers };
}

// the three managed steps, each a connector id or absent for Quorum managed
const STEPS = ['speech', 'summary', 'notes'];
export function cleanVoice(voice) {
  const out = {};
  if (!voice || typeof voice !== 'object') return out;
  for (const k of STEPS) { const v = String(voice[k] ?? '').trim(); if (v) out[k] = v; }
  // required: every member's calls run managed, whatever their own Settings say
  if (voice.required === true) out.required = true;
  return out;
}

export function registerConnectors({ ipcMain, account, log }) {
  const c = createConnectors({ account, log });
  for (const [name, fn] of Object.entries(c.handlers)) ipcMain.handle(name, (_e, ...a) => fn(...a));
  return c;
}
