// The workspace connector form's checks (migration 0030), shared by the admin page (ee/src/WorkspaceIntegrations.tsx)
// and the main process (ee/integrations.js), so the form can say what is wrong before a round trip. The database runs
// the same checks again in workspace_integration_save.
import { connectorsFor } from '../connectors/library.js';
import { workspaceEligible } from '../connectors/approval.js';

const SCOPE = /^[A-Za-z0-9._:/+-]{1,200}$/;
const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
// the library connectors an admin can enable: the cloud-import copy of the meeting apps, so Zoom's cloud import counts
export const ELIGIBLE_IDS = workspaceEligible(connectorsFor({ meetingCapture: false })).map((x) => x.id);
const ELIGIBLE = new Set(ELIGIBLE_IDS);

// one scope as typed into the custom scopes field: trimmed, or an error sentence
export function checkScope(raw) {
  const v = String(raw ?? '').trim();
  if (!v) return { error: 'Type a scope first.' };
  if (!SCOPE.test(v)) return { error: `"${v.slice(0, 60)}" is not a scope. Use letters, numbers and . _ : / + - only.` };
  return { scope: v };
}

// what the save RPC takes. existing is the stored row for this provider, if any: a blank secret keeps its secret.
// Returns { error } or { provider, mode, config, secret, enabled } with config in the database's key names.
export function cleanIntegrationDraft(draft = {}, existing = null) {
  const provider = String(draft?.provider ?? '');
  if (!ELIGIBLE.has(provider)) return { error: 'That connector cannot be enabled for a workspace.' };
  const mode = draft.mode === 'org' || draft.mode === 'personal' ? draft.mode : null;
  if (!mode) return { error: 'Pick org or personal identity.' };
  const secret = String(draft.secret ?? '').trim();
  const c = draft.config ?? {};
  const mock = c.mock === true;
  const custom = c.customScopes === true;
  const scopes = [];
  if (custom) {
    for (const s of Array.isArray(c.scopes) ? c.scopes : []) {
      if (!String(s ?? '').trim()) continue;
      const r = checkScope(s);
      if (r.error) return r;
      if (!scopes.includes(r.scope)) scopes.push(r.scope);
    }
    if (scopes.length > 50) return { error: 'Keep it to 50 scopes or fewer.' };
  }
  const domain = String(c.domain ?? '').trim().toLowerCase();
  if (domain && !DOMAIN.test(domain)) return { error: 'That domain does not look right.' };
  const auth = mode === 'org' && c.auth === 'oauth_client' ? 'oauth_client' : 'api_key';
  const clientId = String(c.clientId ?? '').trim();
  if (mode === 'personal' && secret) return { error: 'A personal connector has no shared secret. Each member signs in with their own account.' };
  if (mode === 'org') {
    if (secret && secret.length < 8) return { error: auth === 'oauth_client' ? 'Paste the whole client secret.' : 'Paste the whole API key.' };
    if (secret.length > 4000) return { error: 'That secret is too long.' };
    const stored = existing?.mode === 'org' && existing?.secretSet === true;
    if (!secret && !stored && !mock) return { error: auth === 'oauth_client' ? 'Paste the client secret, or turn on mock mode.' : 'Paste the API key, or turn on mock mode.' };
    if (auth === 'oauth_client' && !clientId) return { error: 'Add the OAuth client id.' };
    if (clientId.length > 300) return { error: 'That client id is too long.' };
  }
  const ownerId = String(c.ownerId ?? '').trim();
  const config = { scopes, custom_scopes: custom, mock: mode === 'org' && mock, auth };
  if (ownerId) config.owner_id = ownerId;
  if (domain) config.domain = domain;
  if (auth === 'oauth_client') config.client_id = clientId;
  return { provider, mode, config, secret: mode === 'org' && secret ? secret : null, enabled: typeof draft.enabled === 'boolean' ? draft.enabled : null };
}
