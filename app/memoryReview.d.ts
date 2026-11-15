export const DAY: number;
export const MAX_VERSIONS: number;
export const MAX_AGE_DAYS: number;
export const DOT_DAYS: number;
export function lineDiff(a: string | null, b: string | null): { changed: number[]; blocks: number };
export function noteBody(text: string): string;
export function changeBlocks(lines: number[], text?: string | null): number[][];
