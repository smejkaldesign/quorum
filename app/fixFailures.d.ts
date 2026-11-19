export type FixFailure = { run: string; key: string | null; error: string; cancelled: boolean; own: boolean };
type RunLike = { id: string; key: string; status: string; interrupted?: boolean; batch?: string | null; cancelBy?: string; queuedAt: number; error: string | null; kind?: string; undoneAt?: number | null; cancelled?: boolean; items?: { id: string; kind: string; key: string; status: string; error?: string | null; rolledBack?: boolean; cause?: boolean }[] };
export function lastFailures(runs: RunLike[]): Map<string, FixFailure>;
export function holdFailed<T extends { id: string }>(items: T[], runs: RunLike[]): T[];
export function cancelText(run: RunLike): string;
export function cancelError(run: RunLike): Error & { cancelled: true };
export function endFailed<T extends RunLike>(run: T, e: unknown): T;
export function cancelRuns<T extends RunLike>(runs: T[], id: string, opts?: { queue?: T[]; by?: string | null; ended?: (r: T) => void; now?: () => number }): number;
export function batchCancelled(runs: RunLike[]): boolean;
