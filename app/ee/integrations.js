// Workspace connectors from the library (Settings > Admin > Workspace > Connectors), hosted edition, migration 0030.
// An owner or admin enables a library connector for the workspace in org mode (one shared identity: an API key or the
// organization's OAuth client secret, kept in Supabase Vault) or personal mode (each member signs in with their own
// account through sources/accounts.js). A secret crosses IPC once, goes into workspace_integration_save and is never
// logged or kept here; reads report only whether one is set and its last four characters.
//
// Members' side: connector-policy tells Settings > Connections whether only approved connectors may be used and which
// ones the workspace enabled; member-integrations-sync records which enabled personal connectors this member has
// connected, so the admin page can count connections. No tokens go to the server in this step.
import { plain } from './account.js';
import { cleanIntegrationDraft } from './integrationDraft.js';
import { policyOf } from '../connectors/approval.js';

export { cleanIntegrationDraft };

// the row as the admin page uses it; the RPC already left out the Vault id
export const integrationRow = (r) => ({
  id: r.id, workspaceId: r.workspace_id, provider: r.provider, mode: r.mode === 'org' ? 'org' : 'personal', enabled: r.enabled === true,
  config: {
    scopes: Array.isArray(r.config?.scopes) ? r.config.scopes.map(String) : [],
    customScopes: r.config?.custom_scopes === true,
    ownerId: r.config?.owner_id ?? null,
    domain: r.config?.domain ?? null,
    mock: r.config?.mock === true,
    auth: r.config?.auth === 'oauth_client' ? 'oauth_client' : 'api_key',
    clientId: r.config?.client_id ?? null,
  },
  secretSet: r.secret_set === true, secretLast4: r.secret_last4 ?? null, connections: Number(r.connections) || 0,
  createdBy: r.created_by ?? null, createdAt: r.created_at, updatedAt: r.updated_at,
});

// the member-side policy: approvedOnly only with a team on and the switch on; enabled is the providers turned on
export const policyRow = (p) => ({
  teamEnabled: p?.team_enabled === true,
  approvedConnectorsOnly: p?.approved_connectors_only !== false,
  approvedOnly: p?.approved_only === true,
  enabled: (Array.isArray(p?.enabled) ? p.enabled : []).map((e) => ({ id: String(e.id), provider: String(e.provider), mode: e.mode === 'org' ? 'org' : 'personal' })),
});

export function createIntegrations({ account, log = () => {} }) {
  const fail = (err, fallback) => { log('integrations', err?.message ?? err); return { error: plain(err, fallback) }; };
  const ready = () => {
    if (!account.client()) return { error: 'Hosted accounts are not set up in this build.' };
    const s = account.state();
    if (!s.signedIn) return { error: 'Sign in first.' };
    if (!s.workspace) return { error: 'Pick a workspace first.' };
    return null;
  };
  const ws = () => account.state().workspace.id;
  // the last policy read for a workspace: a failed read answers with it, so a dropped connection does not lift the policy
  const known = new Map();
  const readPolicy = async () => {
    if (ready()) return null;
    const id = ws();
    try {
      const { data, error } = await account.client().rpc('workspace_connector_policy', { workspace_id: id });
      if (error) throw error;
      const p = policyRow(data);
      known.set(id, p);
      return p;
    } catch (err) {
      log('integrations', err?.message ?? err);
      return known.get(id) ?? null;
    }
  };
  const adminList = async () => {
    const { data, error } = await account.client().rpc('workspace_integrations_admin', { workspace_id: ws() });
    if (error) throw error;
    return (Array.isArray(data) ? data : []).map(integrationRow);
  };
  const handlers = {
    'integrations-admin': async () => {
      const no = ready(); if (no) return no;
      try {
        const [integrations, p] = await Promise.all([adminList(), account.client().rpc('workspace_connector_policy', { workspace_id: ws() })]);
        if (p.error) return fail(p.error);
        return { integrations, policy: policyRow(p.data) };
      } catch (err) { return fail(err); }
    },
    'integration-save': async (draft) => {
      const no = ready(); if (no) return no;
      try {
        const existing = (await adminList()).find((r) => r.provider === draft?.provider) ?? null;
        const clean = cleanIntegrationDraft(draft, existing);
        if (clean.error) return clean;
        const { data, error } = await account.client().rpc('workspace_integration_save', { workspace_id: ws(), ...clean });
        if (error) return fail(error, 'The connector could not be saved.');
        return { integration: integrationRow(data) };
      } catch (err) { return fail(err, 'The connector could not be saved.'); }
    },
    'integration-enable': async (id, on) => {
      const no = ready(); if (no) return no;
      try {
        const { data, error } = await account.client().rpc('workspace_integration_set_enabled', { id: String(id ?? ''), enabled: on === true });
        if (error) return fail(error, 'The connector could not be changed.');
        return { integration: integrationRow(data) };
      } catch (err) { return fail(err, 'The connector could not be changed.'); }
    },
    'integration-remove': async (id) => {
      const no = ready(); if (no) return no;
      try {
        const { error } = await account.client().rpc('workspace_integration_remove', { id: String(id ?? '') });
        if (error) return fail(error, 'The connector could not be removed.');
        return { ok: true };
      } catch (err) { return fail(err, 'The connector could not be removed.'); }
    },
    'approved-only-set': async (on) => {
      const no = ready(); if (no) return no;
      try {
        const { error } = await account.client().rpc('workspace_set_approved_connectors_only', { ws: ws(), enabled: on === true });
        if (error) return fail(error, 'The setting could not be saved.');
        return { ok: true, approvedConnectorsOnly: on === true };
      } catch (err) { return fail(err, 'The setting could not be saved.'); }
    },
    // read by every member's Connections page; signed out or without a workspace, no policy applies
    'connector-policy': async () => {
      return { policy: await readPolicy() };
    },
    'member-integrations-sync': async (connected) => {
      if (ready()) return { ok: false };
      const ids = (Array.isArray(connected) ? connected : []).map(String).filter((id) => /^[a-z0-9][a-z0-9-]{0,39}$/.test(id)).slice(0, 100);
      try {
        const { error } = await account.client().rpc('member_integrations_sync', { workspace_id: ws(), connected: ids });
        if (error) { log('integrations', error.message ?? error); return { ok: false }; }
        return { ok: true };
      } catch (err) { log('integrations', err?.message ?? err); return { ok: false }; }
    },
  };
  // the connect guard's view (connectors/connectGuard.js): read fresh at each connect
  const guardPolicy = async () => policyOf(await readPolicy());
  return { handlers, guardPolicy };
}
