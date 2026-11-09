import type { ConnectorProvider, ConnectorRole, WorkspaceConnector } from '../../src/quorum';
import { KEY_PROVIDERS, ROLES as CATALOG_ROLES, ROLE_LABEL as CATALOG_ROLE_LABEL } from '../../connectors/catalog';

// which provider can serve which role, from the shared catalog (connectors/catalog.js), the same table as
// connector_roles() in supabase/migrations/0006. The workspace list is the catalog's key providers: Speech: assemblyai,
// deepgram, elevenlabs, openai, google. Models (summary, notes, agent): anthropic, openai, google, openai_compatible.
// Voice: elevenlabs, openai.
export const ROLES = CATALOG_ROLES;
export const ROLE_LABEL = CATALOG_ROLE_LABEL;

export const PROVIDERS = Object.fromEntries(KEY_PROVIDERS.map((p) => [p.id, { name: p.name, roles: p.roles, keyHint: p.keyHint, placeholder: p.placeholder, baseUrl: p.auth === 'key+url' }])) as Record<ConnectorProvider, { name: string; roles: ConnectorRole[]; keyHint: string; placeholder: string; baseUrl?: boolean }>;
export const PROVIDER_IDS = Object.keys(PROVIDERS) as ConnectorProvider[];

export const rolesFor = (provider: ConnectorProvider): ConnectorRole[] => PROVIDERS[provider]?.roles ?? [];
export const canServe = (provider: ConnectorProvider, role: ConnectorRole): boolean => rolesFor(provider).includes(role);
export const providersFor = (role: ConnectorRole): ConnectorProvider[] => PROVIDER_IDS.filter((p) => canServe(p, role));
export const needsBaseUrl = (provider: ConnectorProvider): boolean => !!PROVIDERS[provider]?.baseUrl;
// drops roles the provider cannot do; what the picker shows and what the RPC accepts
export const validRoles = (provider: ConnectorProvider, roles: ConnectorRole[]): ConnectorRole[] => roles.filter((r) => canServe(provider, r));
// the connectors that may handle a role: given the role, and able to do it
export const serving = (list: WorkspaceConnector[], role: ConnectorRole): WorkspaceConnector[] => list.filter((c) => c.roles.includes(role) && canServe(c.provider, role));
