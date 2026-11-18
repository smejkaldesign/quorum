import type { GithubInstallations } from './quorum';

// Reads of where the GitHub App is installed for a connector page. Each read costs one GitHub call per installation,
// so reads share one request in flight, and a read within gapMs of the last finished one is skipped unless forced (a
// return link). A failed read keeps the last good answer; with none yet, its error is what the page shows
export type InstallsView = { installs: GithubInstallations | null; error: string | null };
type Answer = GithubInstallations | { error: string };

export function createInstallsReader(load: () => Promise<Answer>, { now = Date.now, gapMs = 30000 }: { now?: () => number; gapMs?: number } = {}) {
  let view: InstallsView = { installs: null, error: null };
  let inflight: Promise<InstallsView> | null = null;
  let lastDone = -Infinity;
  let started = 0;
  let applied = 0;
  const subs = new Set<(v: InstallsView) => void>();
  const apply = (n: number, r: Answer) => {
    // an answer older than the one already shown never replaces it
    if (n < applied) return;
    applied = n;
    if (!('installations' in r)) view = { ...view, error: r.error };
    else if (r.stale) view = { installs: view.installs ?? (r.checkedAt ? r : null), error: r.error ?? null };
    else view = { installs: r, error: null };
    subs.forEach((f) => f(view));
  };
  const read = ({ force = false }: { force?: boolean } = {}): Promise<InstallsView> => {
    if (inflight) return inflight;
    if (!force && now() - lastDone < gapMs) return Promise.resolve(view);
    const n = ++started;
    inflight = load()
      .catch((err: Error) => ({ error: err.message }))
      .then((r) => { apply(n, r); return view; })
      .finally(() => { inflight = null; lastDone = now(); });
    return inflight;
  };
  return { read, get: () => view, subscribe: (f: (v: InstallsView) => void) => { subs.add(f); return () => { subs.delete(f); }; } };
}
