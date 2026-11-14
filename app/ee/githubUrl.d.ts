export const ADDRESS: string;
export type GithubAddress = { owner: string; repo: string; branch: string | null; tree: string | null; url: string };
export function checkBranch(b: unknown): { branch: string | null; error?: undefined } | { error: string; branch?: undefined };
export function parseGithubUrl(url: unknown, branch?: unknown): (GithubAddress & { error?: undefined }) | { error: string };
export function resolveTree(
  target: { owner: string; repo: string; tree: string | null; branch?: string | null },
  request: (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>,
): Promise<{ branch: string | null; path: string | null; error?: undefined } | { error: string; code?: 'limited' | 'network' }>;
