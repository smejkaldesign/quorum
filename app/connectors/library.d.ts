export type ConnectorStatus = 'available' | 'soon';
export type ConnectorKind = 'mcp-source' | 'macos' | 'quorum-mcp' | 'oauth';
export type ConnectorCategory = { id: string; name: string; blurb: string };
export type LibraryConnector = { id: string; name: string; category: string; domain: string; description: string; status: ConnectorStatus; kind: ConnectorKind; source?: string; app?: string };
export const CATEGORIES: readonly ConnectorCategory[];
export const CONNECTORS: readonly LibraryConnector[];
export const CONNECTOR_BY_ID: Record<string, LibraryConnector>;
export function byCategory(categoryId: string): LibraryConnector[];
export function featuresOf(connector: LibraryConnector): string[];
