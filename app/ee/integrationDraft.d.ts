import type { IntegrationDraft, WorkspaceIntegration } from '../src/quorum';

export const ELIGIBLE_IDS: readonly string[];
export function checkScope(raw: string): { scope: string; error?: undefined } | { error: string; scope?: undefined };
export type CleanIntegrationDraft = { provider: string; mode: 'org' | 'personal'; config: Record<string, unknown>; secret: string | null; enabled: boolean | null };
export function cleanIntegrationDraft(draft: Partial<IntegrationDraft> | null | undefined, existing?: Pick<WorkspaceIntegration, 'mode' | 'secretSet'> | null): CleanIntegrationDraft | { error: string };
