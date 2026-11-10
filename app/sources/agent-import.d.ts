// The renderer imports only the trade-off text; the run itself stays in the main process.
export const SCHEDULES: readonly ['off', 'hourly', 'daily'];
export const TIMEOUT_MS: number;
export function TRADEOFFS(runner: string, source: string): string[];
export function importPrompt(p: { source: { id: string; name: string }; server: string; since?: string | null; limit?: number }): string;
export function parseSummary(text: string): { imported: number; skipped: number } | null;
export function dueFor(schedule: string, lastRunAt: string | null, now?: number): boolean;
