// The last fix of each Memory health item, read from the run list (main.js fix-runs). Plain JS, no Electron, so the
// window and main read it the same way.
//
// An item's newest run decides: a run still waiting or working clears it, a fix that worked clears it, and a fix that
// failed or was cancelled leaves its reason until a later run. A failed fix stops there and waits for the person; it
// never starts again on its own (holdFailed).
import { ROW } from './reviewItems.js';

const live = (r) => r.status === 'queued' || r.status === 'running';

// a bulk Approve: its plain fixes share a b: batch id, and a planned batch holds several items
const bulk = (r) => String(r.batch ?? '').startsWith('b:') || (r.kind === 'batch' && (r.items?.length ?? 0) > 1);
export const cancelText = (run) => `${run.cancelBy ?? 'You'} cancelled ${bulk(run) ? 'the batch' : 'the fix'}`;
// the error a running fix throws at its next step once it is cancelled; endFailed reads it as a cancel
export function cancelError(run) { return Object.assign(new Error(cancelText(run)), { cancelled: true }); }
// a run that threw: Failed with the reason, and marked cancelled when Stop or Cancel ended it
export function endFailed(run, e) {
  run.status = 'error';
  run.error = e?.message ?? String(e);
  if (run.cancel || e?.cancelled) run.cancelled = true;
  return run;
}
// Stop on one fix (by its run id) or Cancel on a bulk Approve (by its batch id). A queued run leaves the queue and ends
// cancelled at once; a running one is marked to stop before its next step, where its rollback puts back what it wrote.
// ended(run) is called for each run that ended here. Answers how many runs it stopped
export function cancelRuns(runs, id, { queue = [], by = null, ended = () => {}, now = Date.now } = {}) {
  let n = 0;
  for (const r of runs) {
    if (r.batch !== id && r.id !== id) continue;
    if (by && live(r)) r.cancelBy = by;
    if (r.status === 'queued') {
      const at = queue.indexOf(r);
      if (at >= 0) queue.splice(at, 1);
      Object.assign(r, { status: 'error', error: cancelText(r), cancelled: true, endedAt: now() });
      for (const it of r.items ?? []) it.status = 'error';
      ended(r);
      n++;
    } else if (r.status === 'running') { r.cancel = true; r.agentAbort?.abort(); n++; }
  }
  return n;
}

// whether a bulk Approve's runs ended in a cancel. The flag is set on every cancel; the text covers runs saved before it
export const batchCancelled = (runs) => runs.some((r) => r.cancelled || String(r.error ?? '').endsWith('cancelled the batch'));

// the items a run holds as [row id, link key or null, error, own]: a batch holds each of its items, a fix one link.
// own: the person cancelled it, or the item's own fix failed (its own reason, or the step running when the batch
// failed). An item put back or never started because another item failed is not, and neither is a run cut short when
// Quorum quit
function heldBy(r) {
  if (r.kind !== 'batch') return [[`${ROW.link}${r.key}`, r.key, r.error, !!r.cancelled || !r.interrupted]];
  return (r.items ?? []).map((it) => {
    // an item fixed and then put back when the whole batch failed reads with the batch's reason
    const error = it.status === 'error' || r.status === 'error' ? (it.rolledBack ? r.error : it.error ?? r.error) : null;
    const own = !!r.cancelled || !!it.cause || (!it.rolledBack && !!it.error);
    return [it.id, it.kind === 'link' ? it.key : null, error, own];
  });
}

// Map of row id -> { run, key, error, cancelled, own } for every item whose newest run failed. A run that was undone holds
// nothing: its items are back in review as they were before it
export function lastFailures(runs) {
  const out = new Map();
  for (const r of [...(runs ?? [])].sort((a, b) => a.queuedAt - b.queuedAt)) {
    if (r.undoneAt) continue;
    for (const [id, key, error, own] of heldBy(r)) {
      if (live(r) || (r.status === 'success' && !error)) { out.delete(id); continue; }
      if (r.status === 'success' || r.status === 'error') out.set(id, { run: r.id, key, error: error || 'The fix stopped before it finished', cancelled: !!r.cancelled, own });
    }
  }
  return out;
}

// the items Quorum may apply on its own, less every item whose own last fix failed or was stopped: the same fix on the
// same notes would fail the same way, and a stopped fix stays stopped, so it waits until the person approves it again.
// An item that was fixed and only put back because another item in its batch failed may run again
export function holdFailed(items, runs) {
  const failed = lastFailures(runs);
  return items.filter((i) => !failed.get(i.id)?.own);
}
