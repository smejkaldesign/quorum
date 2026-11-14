import type { IntegrationConfig, IntegrationDraft, WorkspaceIntegration } from '../src/quorum';

type Stored = Pick<WorkspaceIntegration, 'mode' | 'secretSet'> & { config?: Pick<IntegrationConfig, 'auth'> };
export const ELIGIBLE_IDS: readonly string[];
export function checkScope(raw: string): { scope: string; error?: undefined } | { error: string; scope?: undefined };
export function keepsSecret(existing: Stored | null | undefined, auth: IntegrationConfig['auth']): boolean;
export type CleanIntegrationDraft = { provider: string; mode: 'org' | 'personal'; config: Record<string, unknown>; secret: string | null; enabled: boolean | null };
export function cleanIntegrationDraft(draft: Partial<IntegrationDraft> | null | undefined, existing?: Stored | null): CleanIntegrationDraft | { error: string };
