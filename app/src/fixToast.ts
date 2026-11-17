import type { FixRun } from './quorum';
import { toast } from './Toasts';

// resolves with an approved link's fix run once it has finished
export function waitFix(key: string): Promise<FixRun> {
  return new Promise((resolve) => {
    // a link the agent fixes on Approve runs as a batch of one (main.js startFixes), so its run holds it as an item
    const mine = (r: FixRun) => r.key === key.toLowerCase() || (r.kind === 'batch' && !!r.items?.some((i) => i.kind === 'link' && i.key === key.toLowerCase()));
    const off = window.quorum.onFixRun((r) => { if (mine(r) && (r.status === 'success' || r.status === 'error')) { off(); resolve(r); } });
  });
}
// the toast for approved fixes shows once they end. A fix that failed puts its issue back in Needs review, marked read,
// and the toast says why. done is waitFix, called before fixStart so a fix that ends at once is still heard
export function toastWhenFixed(issues: { key: string; target: string; done: Promise<FixRun> }[]) {
  if (!issues.length) return;
  Promise.all(issues.map((i) => i.done)).then((runs) => {
    const bad = issues.filter((_, n) => runs[n].status !== 'success');
    const good = issues.length - bad.length;
    if (!bad.length) { toast(issues.length === 1 ? `Fixed “${issues[0].target}”.` : `Fixed ${issues.length} issues.`); return; }
    window.quorum.activityMark(bad.map((i) => ({ id: `r:link:${i.key.toLowerCase()}`, abs: '' })), false).catch(() => 0).then(() => window.dispatchEvent(new Event('quorum:activity-changed')));
    const why = (runs[issues.indexOf(bad[0])].error ?? '').replace(/\.$/, '');
    const what = bad.length === 1 ? `Could not fix “${bad[0].target}”` : `Could not fix ${bad.length} of ${issues.length} issues`;
    toast(`${good ? `Fixed ${good}. ` : ''}${what}${why ? `: ${why}` : ''}. ${bad.length === 1 ? 'It is' : 'They are'} back in Needs review.`, 'error');
  });
}
