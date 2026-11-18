import type { FixRun } from './quorum';
import { toast } from './Toasts';

// resolves with an approved link's fix run once it has finished
// one link's outcome in a run: a batch reports each item, and an item it skipped fails while the batch succeeds
const linkOf = (r: FixRun, key: string) => (r.kind === 'batch' ? r.items?.find((i) => i.kind === 'link' && i.key === key) : undefined);
export const outcomeOf = (r: FixRun, key: string): { ok: boolean; error: string | null } => {
  const it = linkOf(r, key.toLowerCase());
  if (r.status !== 'success') return { ok: false, error: r.error };
  return it && it.status === 'error' ? { ok: false, error: (it as { error?: string }).error ?? null } : { ok: true, error: null };
};
// off drops the listener, for an Approve that started nothing. A run that ended before this call (Undo and Dismiss send
// old runs again) never answers it
export function waitFix(key: string): Promise<FixRun> & { off: () => void } {
  const since = Date.now();
  const k = key.toLowerCase();
  let off = () => {};
  const done = new Promise<FixRun>((resolve) => {
    // a link the agent fixes on Approve runs as a batch of one (main.js startFixes), so its run holds it as an item
    const mine = (r: FixRun) => r.key === k || !!linkOf(r, k);
    off = window.quorum.onFixRun((r) => { if (mine(r) && (r.status === 'success' || r.status === 'error') && (r.endedAt ?? 0) >= since) { off(); resolve(r); } });
  });
  return Object.assign(done, { off: () => off() });
}
// the toast for approved fixes shows once they end. A fix that failed puts its issue back in Needs review, marked read,
// and the toast says why. done is waitFix, called before fixStart so a fix that ends at once is still heard
export function toastWhenFixed(issues: { key: string; target: string; done: Promise<FixRun> }[]) {
  if (!issues.length) return;
  Promise.all(issues.map((i) => i.done)).then((runs) => {
    const outs = issues.map((i, n) => outcomeOf(runs[n], i.key));
    const bad = issues.filter((_, n) => !outs[n].ok);
    const good = issues.length - bad.length;
    if (!bad.length) { toast(issues.length === 1 ? `Fixed “${issues[0].target}”.` : `Fixed ${issues.length} issues.`); return; }
    window.quorum.activityMark(bad.map((i) => ({ id: `r:link:${i.key.toLowerCase()}`, abs: '' })), false).catch(() => 0).then(() => window.dispatchEvent(new Event('quorum:activity-changed')));
    const why = (outs[issues.indexOf(bad[0])].error ?? '').replace(/\.$/, '');
    const what = bad.length === 1 ? `Could not fix “${bad[0].target}”` : `Could not fix ${bad.length} of ${issues.length} issues`;
    toast(`${good ? `Fixed ${good}. ` : ''}${what}${why ? `: ${why}` : ''}. ${bad.length === 1 ? 'It is' : 'They are'} back in Needs review.`, 'error');
  });
}
