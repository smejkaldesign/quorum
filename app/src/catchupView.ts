import type { CatchupEstimate, CatchupLast, CatchupStatus } from './quorum';

// Check everything now (Catchup.tsx): the words and numbers the plan, the progress, the Cancel confirmation and the
// last-run card show. No React, so the tests read them directly

// a date and time the way Memory health shows them (MemoryUpdates.tsx when)
export const ranAt = (at: number) => new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
export const fmt = (n: number) => n.toLocaleString('en-US');
const count = (n: number, one: string, many: string) => `${fmt(n)} ${n === 1 ? one : many}`;

// Cancel stops a pass at once in its first minute; after that it asks first
export const CONFIRM_AFTER_MS = 60000;
export const needsConfirm = (startedAt: number | null | undefined, now: number) => startedAt != null && now - startedAt > CONFIRM_AFTER_MS;
export const STOP_TITLE = 'Stop the check?';
export const STOP_BODY = 'What it found so far is kept. The rest runs later under the daily limit, or when you start the check again.';

// Cancel on the activity banner and its Stop the check? dialog. asking: the id of the activity the dialog was opened
// for, so the dialog shows only while that activity runs and Stop can only cancel that one. Each step answers the next
// state and the activity to cancel now, if any
export type StopEvent =
  | { type: 'cancel'; activity: { id: string; kind: string; startedAt: number }; now: number }
  | { type: 'keep' }
  | { type: 'stop'; current: string | null }
  | { type: 'activity'; current: string | null };
export function stopFlow(asking: string | null, e: StopEvent): { asking: string | null; cancel: string | null } {
  if (e.type === 'cancel') {
    if (e.activity.kind === 'catchup' && needsConfirm(e.activity.startedAt, e.now)) return { asking: e.activity.id, cancel: null };
    return { asking: null, cancel: e.activity.id };
  }
  if (e.type === 'stop') return { asking: null, cancel: asking && asking === e.current ? asking : null };
  if (e.type === 'activity') return { asking: asking && asking === e.current ? asking : null, cancel: null };
  return { asking: null, cancel: null };
}

// a length of time in hours and minutes, rounded: "under a minute", "about 25 minutes", "about 2 hours 10 minutes"
export function duration(seconds: number) {
  if (!(seconds >= 60)) return 'under a minute';
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `about ${count(mins, 'minute', 'minutes')}`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `about ${count(h, 'hour', 'hours')}${m ? ` ${count(m, 'minute', 'minutes')}` : ''}`;
}

// what the pass costs in calls, from main's estimate: the claim calls, the judge calls for the estimated pairs and the
// drafts that wait
const callCount = (n: number) => `${fmt(n)} ${n === 1 ? 'call' : 'calls'}`;
export function catchupCost(e: CatchupEstimate | null) {
  return e ? `This uses your Claude plan for about ${callCount(e.calls)} and runs in the background.` : 'This uses your Claude plan and runs in the background.';
}

// the plan shown before a pass starts, one row per fact. Pairs and time are estimates and say so
export function planRows(e: CatchupEstimate): [string, string][] {
  const saved = e.saved ?? 0;
  const rows: [string, string][] = [['Notes to check', count(e.toCheck ?? saved + e.read, 'note', 'notes')]];
  if (saved) rows.push(['Already checked', `${count(saved, 'note', 'notes')}, saved from earlier checks`]);
  rows.push(['Left to read', count(e.read, 'note', 'notes')]);
  if (e.draftCalls) rows.push(['Fixes to draft', count(e.draftCalls, 'model call', 'model calls')]);
  if (e.pairs != null) rows.push(['Pairs to judge', `About ${fmt(e.pairs)}, an estimate`]);
  if (e.seconds != null) { const d = duration(e.seconds); rows.push(['Time', `${d[0].toUpperCase()}${d.slice(1)}, an estimate`]); }
  // what the model calls would cost at API rates; on a Claude Code sign-in they count against the plan's limits instead
  if (e.costLabel) rows.push(['API-rate equivalent', `${e.costLabel}, an estimate. A Claude plan is not billed per token; the check uses the plan's usage.`]);
  return rows;
}
// the same plan in one sentence, for onboarding
export function planSentence(e: CatchupEstimate | null) {
  if (!e) return '';
  const saved = e.saved ?? 0;
  const parts = [`${count(e.toCheck ?? saved + e.read, 'note', 'notes')} to check${saved ? ` (${fmt(saved)} already checked)` : ''}`];
  if (e.pairs != null) parts.push(`about ${fmt(e.pairs)} pairs to judge`);
  if (e.seconds != null) parts.push(duration(e.seconds));
  return `${parts.join(', ')}. The pairs and the time are estimates.`;
}

type Running = Extract<CatchupStatus, { running: true }>;
// the progress of a pass that runs: notes checked of notes to check, saved ones included; calls before it knows them
export function progressText(st: Running) {
  if (st.of) return `Checked ${fmt(st.checked ?? 0)} of ${count(st.of, 'note', 'notes')}`;
  return `Checking all ${count(st.notes, 'note', 'notes')}: ${fmt(st.done)} of ${count(st.total, 'call', 'calls')}`;
}
export function progressShare(st: Running) {
  if (st.of) return Math.min(1, (st.checked ?? 0) / st.of);
  return st.total ? Math.min(1, st.done / st.total) : null;
}

// the last-run card in Memory health: a headline by how the pass ended, then what it checked and what it added
const HEAD: Record<CatchupLast['end'], string> = {
  done: 'The check finished',
  cancelled: 'You stopped the check',
  off: 'The check stopped: Let the agent draft fixes or background checks are off',
  failed: 'The check stopped on an error',
  crashed: 'Stopped early',
};
export function addedText(a: CatchupLast['added']) {
  if (!a) return null;
  const parts = [
    a.contradictions ? count(a.contradictions, 'contradiction', 'contradictions') : '',
    a.drafts ? count(a.drafts, 'drafted fix', 'drafted fixes') : '',
    a.other ? count(a.other, 'other item', 'other items') : '',
  ].filter(Boolean);
  const total = a.contradictions + a.drafts + a.other;
  return parts.length ? `${count(total, 'item needs', 'items need')} review: ${parts.join(', ')}.` : 'Nothing new needs review.';
}
export function summaryOf(last: CatchupLast) {
  const checked = last.of ? `Checked ${fmt(last.checked ?? 0)} of ${count(last.of, 'note', 'notes')}.` : `Made ${count(last.done, 'model call', 'model calls')}.`;
  const why = last.end === 'crashed' ? ' Quorum closed while it ran. What it checked until then is saved.' : '';
  // notes whose call failed: not checked, and asked for again after a day
  const skipped = last.skipped ? ` ${count(last.skipped, 'note', 'notes')} could not be read. The agent tries ${last.skipped === 1 ? 'it' : 'them'} again after a day.` : '';
  return {
    head: HEAD[last.end] ?? HEAD.failed,
    state: last.end === 'failed' || last.end === 'crashed' ? ('error' as const) : ('success' as const),
    // what it checked, then how many items now need review and of what kind, then what it could not read
    line: [checked, addedText(last.added), `${skipped}${why}`.trim()].filter(Boolean).join(' '),
    // how long it ran: a crashed pass ran until its last save, which is after its last call; with no call done the last
    // save is the one at its start, so the length is not known
    took: last.endedAt != null && (last.end !== 'crashed' || last.done > 0) ? Math.max(0, last.endedAt - last.startedAt) : null,
  };
}
// the card shows for a pass that ended and was not dismissed
export const showSummary = (st: CatchupStatus | null): st is { running: false; last: CatchupLast } => !!st && !st.running && !!st.last && !st.last.dismissed;
