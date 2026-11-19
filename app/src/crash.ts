// a view that fails again within REPEAT_MS of Reload view fails on every draw, so the crash page stops advising a reload
export const REPEAT_MS = 5000;
export const failsEveryTime = (reloadedAt: number | null, errorAt: number) => reloadedAt != null && errorAt >= reloadedAt && errorAt - reloadedAt < REPEAT_MS;

// the one case the app can name: its own files changed underneath an open window (an update, or a rebuild in
// development). React.lazy keeps the failed load, so it fails again on every draw until the window reloads
export const STALE_BUNDLE = /dynamically imported module|Loading chunk|Importing a module script failed/i;

// which crash page to show. A stale bundle stays stale even when it repeats, because a window reload fixes it
export type CrashKind = 'stale' | 'repeat' | 'once';
export const crashKind = (message: string, reloadedAt: number | null, errorAt: number): CrashKind =>
  STALE_BUNDLE.test(message) ? 'stale' : failsEveryTime(reloadedAt, errorAt) ? 'repeat' : 'once';
