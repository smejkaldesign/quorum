export const DAY: number;
export const MAX_VERSIONS: number;
export const MAX_AGE_DAYS: number;
export const DOT_DAYS: number;
export function seqOps(x: string[], y: string[], max?: number): { op: ' ' | '-' | '+'; i: number; j: number }[];
export function lineDiff(a: string | null, b: string | null): { changed: number[]; blocks: number };
export function noteBody(text: string): string;
