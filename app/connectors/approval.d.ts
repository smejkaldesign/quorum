import type { LibraryConnector } from './library';

export type ConnectorPolicy = { approvedOnly: true; enabled: string[] };
export type Approval = 'open' | 'approved' | 'unapproved' | 'blocked';
export function isGoverned(connector: LibraryConnector | null | undefined): boolean;
export function workspaceEligible(list: readonly LibraryConnector[]): LibraryConnector[];
export function policyOf(raw: unknown): ConnectorPolicy | null;
export function approvalOf(connector: LibraryConnector, policy: ConnectorPolicy | null, connected: boolean): Approval;
export const BLOCKED_SENTENCE: string;
export const UNAPPROVED_LABEL: string;
export function workspaceStateOf<R extends { provider: string; enabled: boolean; mode: 'org' | 'personal' }>(id: string, rows: readonly R[] | null | undefined): { state: 'off' | 'org' | 'personal'; row: R | null };
