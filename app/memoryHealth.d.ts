import type { MissingLink } from './src/quorum';

export type HealthCategory = 'missing' | 'alias' | 'similar' | 'outside';
export type HealthAction = 'create' | 'alias' | 'relink' | 'leave';
export type Issue = {
  key: string; target: string; category: HealthCategory; title: string; fix: string; problem: string; effect: string; recommend: string; action: HealthAction; sources: string[];
  candidate: MissingLink['candidates'][number] | null; path: string; links: number; notes: number;
  folder: { folder: string; count: number } | null; lastAt: number | null;
};
export type CategoryCount = { id: HealthCategory | 'left'; label: string; count: number };
export const CATEGORIES: { id: HealthCategory; label: string }[];
export const LEFT_LABEL: string;
export function categoryOf(m: MissingLink): HealthCategory;
export function topFolder(sources: string[]): { folder: string; count: number } | null;
export function issueOf(m: MissingLink): Issue;
export function categoryCounts(items: MissingLink[], left?: Set<string>): CategoryCount[];
export function countsLine(counts: CategoryCount[]): string;
export function footerFacts(issue: Issue, opts?: { date?: (t: number) => string }): string[];
export function fileIssues(lines: { target: string; line: number }[], items: MissingLink[], left?: Set<string>): { line: number; issue: Issue }[];
export function healthMarks(items: MissingLink[], left?: Set<string>): { files: Record<string, number>; folders: Record<string, number> };
export type HealthSort = 'links' | 'recent' | 'az';
export const HEALTH_SORTS: [HealthSort, string][];
export function healthList(items: MissingLink[], opts?: { tab?: 'open' | 'left'; categories?: HealthCategory[]; q?: string; sort?: HealthSort; left?: Set<string> }): Issue[];
