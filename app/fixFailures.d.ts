export type FixFailure = { run: string; key: string | null; error: string; cancelled: boolean };
type RunLike = { id: string; key: string; status: string; queuedAt: number; error: string | null; kind?: string; undoneAt?: number | null; cancelled?: boolean; items?: { id: string; kind: string; key: string; status: string; error?: string | null; rolledBack?: boolean }[] };
export function lastFailures(runs: RunLike[]): Map<string, FixFailure>;
export function holdFailed<T extends { id: string }>(items: T[], runs: RunLike[]): T[];
