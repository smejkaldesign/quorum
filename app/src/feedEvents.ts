import type { FeedCounts } from './quorum';

// One refresh for everything that reads the Notifications feed (the bell, the Memory tab counts, Notifications). The
// events main sends for one change (a save sends a vault change, then a sweep and a gate run) are taken together once
// they have been quiet for QUIET_MS; a change made in this window (an archive, a mark, an opened note) refreshes at once.
// Focusing the window and FALLBACK_MS refresh too, for a source with no event. The bell and the Memory tab share one
// counts read per change
const QUIET_MS = 250;
const FALLBACK_MS = 15 * 60000;
export const ACTIVITY_CHANGED = 'quorum:activity-changed';

type Listener = () => void;
const listeners = new Set<Listener>();
let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;
let counts: Promise<FeedCounts> | null = null;

const fire = () => {
  if (timer !== null) { clearTimeout(timer); timer = null; }
  counts = null;
  for (const fn of [...listeners]) fn();
};
const later = () => {
  counts = null;
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(fire, QUIET_MS);
};
function start() {
  if (started) return;
  started = true;
  const q = window.quorum;
  q.onKeeper?.(later);
  q.onMemoryUpdates?.(later);
  q.onVaultChanged?.(later);
  q.onSettings?.(later);
  q.onFixRun?.(later);
  window.addEventListener(ACTIVITY_CHANGED, fire);
  window.addEventListener('quorum:memory-seen', fire);
  window.addEventListener('focus', later);
  setInterval(fire, FALLBACK_MS);
}

export function onFeedChange(fn: Listener): () => void {
  start();
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// fresh: read again now, for a caller that acted and did not wait for the change event
export function feedCounts(fresh = false): Promise<FeedCounts> {
  if (fresh) counts = null;
  counts ??= window.quorum.feedCounts().catch((e) => { counts = null; throw e; });
  return counts;
}
