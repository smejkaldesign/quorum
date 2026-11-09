import type { ConnectorProvider, ConnectorRole, WorkspaceConnector } from '../../src/quorum';

// which provider can serve which role, the same table as connector_roles() in supabase/migrations/0006. Speech:
// assemblyai, deepgram, elevenlabs, openai, google. Models (summary, notes, agent): anthropic, openai, google,
// openai_compatible. Voice: elevenlabs, openai.
export const ROLES: { id: ConnectorRole; label: string }[] = [
  { id: 'speech', label: 'Speech to text' },
  { id: 'summary', label: 'Running summary' },
  { id: 'notes', label: 'Final notes' },
  { id: 'agent', label: 'Agent' },
  { id: 'voice', label: 'Voice' },
];
export const ROLE_LABEL: Record<ConnectorRole, string> = Object.fromEntries(ROLES.map((r) => [r.id, r.label])) as Record<ConnectorRole, string>;

export const PROVIDERS: Record<ConnectorProvider, { name: string; roles: ConnectorRole[]; keyHint: string; placeholder: string; baseUrl?: boolean }> = {
  assemblyai: { name: 'AssemblyAI', roles: ['speech'], keyHint: 'AssemblyAI API key', placeholder: 'Your AssemblyAI key' },
  deepgram: { name: 'Deepgram', roles: ['speech'], keyHint: 'Deepgram API key', placeholder: 'Your Deepgram key' },
  elevenlabs: { name: 'ElevenLabs', roles: ['speech', 'voice'], keyHint: 'ElevenLabs API key', placeholder: 'Your ElevenLabs key' },
  openai: { name: 'OpenAI', roles: ['speech', 'summary', 'notes', 'agent', 'voice'], keyHint: 'OpenAI API key', placeholder: 'sk-...' },
  anthropic: { name: 'Anthropic', roles: ['summary', 'notes', 'agent'], keyHint: 'Anthropic API key', placeholder: 'sk-ant-...' },
  google: { name: 'Google', roles: ['speech', 'summary', 'notes', 'agent'], keyHint: 'Google AI API key', placeholder: 'AIza...' },
  openai_compatible: { name: 'OpenAI-compatible', roles: ['summary', 'notes', 'agent'], keyHint: 'API key', placeholder: 'Your key', baseUrl: true },
};
export const PROVIDER_IDS = Object.keys(PROVIDERS) as ConnectorProvider[];

export const rolesFor = (provider: ConnectorProvider): ConnectorRole[] => PROVIDERS[provider]?.roles ?? [];
export const canServe = (provider: ConnectorProvider, role: ConnectorRole): boolean => rolesFor(provider).includes(role);
export const providersFor = (role: ConnectorRole): ConnectorProvider[] => PROVIDER_IDS.filter((p) => canServe(p, role));
export const needsBaseUrl = (provider: ConnectorProvider): boolean => !!PROVIDERS[provider]?.baseUrl;
// drops roles the provider cannot do; what the picker shows and what the RPC accepts
export const validRoles = (provider: ConnectorProvider, roles: ConnectorRole[]): ConnectorRole[] => roles.filter((r) => canServe(provider, r));
// the connectors that may handle a role: given the role, and able to do it
export const serving = (list: WorkspaceConnector[], role: ConnectorRole): WorkspaceConnector[] => list.filter((c) => c.roles.includes(role) && canServe(c.provider, role));
