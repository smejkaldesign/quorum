import type { MissingLink } from './src/quorum';

export type HealthCategory = 'missing' | 'alias' | 'similar' | 'unlink' | 'outside' | 'elsewhere';
export type HealthAction = 'create' | 'alias' | 'relink' | 'unlink' | 'leave';
export type Issue = {
  key: string; target: string; category: HealthCategory; title: string; fix: string; problem: string; effect: string; recommend: string; solution: string; value: string; decline: string; action: HealthAction; next: HealthAction | null; sources: string[]; contexts: { rel: string; title?: string; text: string }[]; createIn: string;
  candidate: (MissingLink['candidates'][number] & { folder?: boolean }) | null; path: string; reviewOnly: boolean; found: MissingLink['found'] | null; confidential: string | null; links: number; notes: number;
  folder: { folder: string; count: number } | null; lastAt: number | null;
  group?: LineGroup;
};
// the dead links one line holds, as one issue (groupByLine)
export type LineGroup = { rel: string; line: number; targets: string[] };
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
export function optionsOf(m: MissingLink): HealthAction[];
export function contextWords(m: MissingLink): number;
export function issueMeta(issue: Issue, opts?: { date?: (t: number) => string }): [string, string][];
export const LINE_KEY: string;
export const MIN_LINE: number;
export function groupByLine(items: MissingLink[], opts?: { left?: Set<string> }): MissingLink[];
