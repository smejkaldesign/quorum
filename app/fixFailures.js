// The last fix of each Memory health item, read from the run list (main.js fix-runs). Plain JS, no Electron, so the
// window and main read it the same way.
//
// An item's newest run decides: a run still waiting or working clears it, a fix that worked clears it, and a fix that
// failed or was cancelled leaves its reason until a later run. A failed fix stops there and waits for the person; it
// never starts again on its own (holdFailed).
import { ROW } from './reviewItems.js';

const live = (r) => r.status === 'queued' || r.status === 'running';

// the items a run holds as [row id, link key or null, error]: a batch holds each of its items, a fix one link
function heldBy(r) {
  if (r.kind !== 'batch') return [[`${ROW.link}${r.key}`, r.key, r.error]];
  return (r.items ?? []).map((it) => {
    // an item fixed and then put back when the whole batch failed reads with the batch's reason
    const error = it.status === 'error' || r.status === 'error' ? (it.rolledBack ? r.error : it.error ?? r.error) : null;
    return [it.id, it.kind === 'link' ? it.key : null, error];
  });
}

// Map of row id -> { run, key, error, cancelled } for every item whose newest run failed. A run that was undone holds
// nothing: its items are back in review as they were before it
export function lastFailures(runs) {
  const out = new Map();
  for (const r of [...(runs ?? [])].sort((a, b) => a.queuedAt - b.queuedAt)) {
    if (r.undoneAt) continue;
    for (const [id, key, error] of heldBy(r)) {
      if (live(r) || r.status === 'success' && !error) { out.delete(id); continue; }
      if (r.status === 'success' || r.status === 'error') out.set(id, { run: r.id, key, error: error || 'The fix stopped before it finished', cancelled: !!r.cancelled });
    }
  }
  return out;
}

// the items Quorum may apply on its own, less every item whose last fix failed: the same fix on the same notes would
// fail the same way, so it waits until the person approves it again
export function holdFailed(items, runs) {
  const failed = lastFailures(runs);
  return items.filter((i) => !failed.has(i.id));
}
