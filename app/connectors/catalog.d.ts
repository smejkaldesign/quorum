import type { ConnectorId, ConnectorRole, ModelSource, ProviderConnectors, Providers } from '../src/quorum';

export type ConnectorAuth = 'none' | 'key' | 'key+url' | 'signin';
export type ConnectorTest = ((key: string, base: string) => { url: string; headers: Record<string, string> }) | null;
export type ConnectorManifest = {
  id: ConnectorId; name: string; roles: ConnectorRole[]; auth: ConnectorAuth; test: ConnectorTest;
  docs: string; pricing: string | null; free?: boolean; keyHint: string; placeholder: string; url?: string;
  models?: Record<'opus' | 'sonnet' | 'haiku', string>;
};

export const ROLES: { id: ConnectorRole; label: string }[];
export const ROLE_IDS: ConnectorRole[];
export const ROLE_LABEL: Record<ConnectorRole, string>;
export const MODEL_ROLES: ConnectorRole[];
export const OLLAMA_URL: string;
export const CATALOG: ConnectorManifest[];
export const BY_ID: Record<ConnectorId, ConnectorManifest>;
export const PROVIDER_IDS: ConnectorId[];
export const KEY_PROVIDERS: ConnectorManifest[];
export const KEY_PROVIDER_IDS: ConnectorId[];
export function needsKey(id: string): boolean;
export function needsBaseUrl(id: string): boolean;
export function rolesFor(id: string): ConnectorRole[];
export function canServe(id: string, role: ConnectorRole): boolean;
export function providersFor(role: ConnectorRole): ConnectorId[];
export function validRoles(id: string, roles: ConnectorRole[]): ConnectorRole[];
export function modelFor(id: string, alias: string): string | null;
export function providersFromSource(source: ModelSource | undefined, base?: Providers): Providers;
export function sourceFromProviders(providers?: Providers): ModelSource;
export function cleanProviders(next: unknown, cur?: Providers): Providers;
export function providerFor(role: ConnectorRole | null | undefined, providers: Providers | null | undefined, source: ModelSource | undefined): ConnectorId | null;
export function cleanConnectors(next: unknown, cur?: ProviderConnectors): ProviderConnectors;
export function modelName(id: string | null, alias: string, local?: string, connectors?: ProviderConnectors): string | null;
