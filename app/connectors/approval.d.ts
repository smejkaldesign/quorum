import type { LibraryConnector } from './library';

export type ConnectorPolicy = { approvedOnly: boolean; enabled: string[]; org: string[] };
export type Approval = 'open' | 'org' | 'approved' | 'unapproved' | 'blocked';
export function isGoverned(connector: LibraryConnector | null | undefined): boolean;
export function hasLocalPart(connector: LibraryConnector | null | undefined): boolean;
export const ELIGIBLE_IDS: readonly string[];
export function policyOf(raw: unknown): ConnectorPolicy | null;
export function approvalOf(connector: LibraryConnector, policy: ConnectorPolicy | null, connected: boolean): Approval;
export function canConnect(approval: Approval): boolean;
export function hiddenFromList(connector: LibraryConnector, approval: Approval): boolean;
export const BLOCKED_SENTENCE: string;
export const UNAPPROVED_LABEL: string;
export const ORG_LABEL: string;
export function ORG_SENTENCE(name: string): string;
export function workspaceStateOf<R extends { provider: string; enabled: boolean; mode: 'org' | 'personal' }>(id: string, rows: readonly R[] | null | undefined): { state: 'off' | 'org' | 'personal'; row: R | null };
export const POLICY_CHANGED: string;
