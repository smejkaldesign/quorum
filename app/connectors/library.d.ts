export type ConnectorStatus = 'available' | 'soon';
export type ConnectorKind = 'mcp-source' | 'macos' | 'quorum-mcp' | 'oauth' | 'meeting-app';
export type ConnectorCategory = { id: string; name: string; blurb: string };
// listen: false on a meeting app means the copy runs with meeting capture off, so only its cloud import is offered
export type LibraryConnector = { id: string; name: string; category: string; domain: string; description: string; status: ConnectorStatus; kind: ConnectorKind; source?: string; app?: string; listen?: boolean };
export const CATEGORIES: readonly ConnectorCategory[];
export const CONNECTORS: readonly LibraryConnector[];
export const CONNECTOR_BY_ID: Record<string, LibraryConnector>;
export function byCategory(categoryId: string): LibraryConnector[];
export function featuresOf(connector: LibraryConnector): string[];
export function aboutOf(connector: LibraryConnector): string;
export function connectorsFor(opts?: { meetingCapture?: boolean }): readonly LibraryConnector[];
export function aboutFor(connector: LibraryConnector, opts?: { meetingCapture?: boolean }): string;
export function featuresFor(connector: LibraryConnector, opts?: { meetingCapture?: boolean }): string[];
