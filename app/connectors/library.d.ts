export type ConnectorStatus = 'available' | 'soon';
export type ConnectorKind = 'mcp-source' | 'macos' | 'quorum-mcp' | 'oauth' | 'meeting-app';
export type ConnectorCategory = { id: string; name: string; blurb: string };
// listen: false on a meeting app means the copy runs with meeting capture off, so only its cloud import is offered
export type LibraryConnector = { id: string; name: string; category: string; domain: string; description: string; status: ConnectorStatus; kind: ConnectorKind; source?: string; app?: string; listen?: boolean; account?: boolean };
export const CATEGORIES: readonly ConnectorCategory[];
export const CONNECTORS: readonly LibraryConnector[];
export const CONNECTOR_BY_ID: Record<string, LibraryConnector>;
export function byCategory(categoryId: string): LibraryConnector[];
export function featuresOf(connector: LibraryConnector): string[];
export function aboutOf(connector: LibraryConnector): string;
export function connectorsFor(opts?: { meetingCapture?: boolean }): readonly LibraryConnector[];
export function aboutFor(connector: LibraryConnector, opts?: { meetingCapture?: boolean }): string;
export function featuresFor(connector: LibraryConnector, opts?: { meetingCapture?: boolean }): string[];
// what the main process reports about connections; added is settings.meetingProviders, the apps the person turned on
export type ConnectionLive = {
  sources?: readonly { id: string; connected: boolean }[];
  providers?: readonly { id: string; enabled: boolean; installed: boolean; access: boolean | null }[];
  platforms?: readonly { id: string; connected: boolean }[];
  accounts?: readonly { id: string; connected: boolean }[];
  cal?: { enabled?: boolean; status?: string; google?: { connected: boolean } | null } | null;
  mcp?: { added: boolean } | null;
  added?: Record<string, { enabled: boolean }>;
};
export function isConnected(connector: LibraryConnector, live: ConnectionLive, opts?: { explicit?: boolean }): boolean;
export const NEW_NOTE_CATEGORIES: readonly string[];
export function canNewNote(live: ConnectionLive, list?: readonly LibraryConnector[]): boolean;
export const CONNECTORS_CHANGED: string;
// what each path gives when the person's agent also has the provider's own MCP server
export type McpPathRow = { id: string; label: string; connector: string; mcp: string };
export type McpPaths = { title: string; ingest: boolean; rows: McpPathRow[]; explain: string; recommend: string; alone: string | null };
export const MCP_PATH_ROWS: Record<string, string>;
export const MCP_EXPLAIN_INGEST: string;
export const MCP_RECOMMEND_INGEST: string;
export const MCP_ALONE: string;
export function mcpPathsOf(connector: LibraryConnector): McpPaths | null;
