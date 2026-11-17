import { diffReview, progressOf } from './catchupPlan.js';
// Check everything now: a one-time catch-up pass over a vault. The agent's first full pass (claim reading for every note
// stage 1 sends on, plus the pending drafts) normally runs under the daily cap, about a week for 2,000 notes. A catch-up
// lifts the cap for one pass only: it runs every pending draft and claim batch one model call at a time, with the
// drafter's and the contradiction agent's own timeouts and gates (the read guard, confidential marks), and stops on
// its own when nothing is left. Its calls do not count against the daily cap, so the normal cap applies again after it.
// It writes nothing to the vault; what it finds waits in Needs review.
//
// Cancel stops the model call that runs (its place is given back, and the call is asked for again later under the
// normal cap) and ends the pass. A recording or a fix that runs pauses it between calls. Plain Node with no Electron,
// so the tests drive it with a fake model.
//   drafter   createDrafter (memoryDraft.js); agent  createContradictionAgent (contradictionAgent.js)
//   activity  createAgentActivity (agentActivity.js): the banner on Home and in Memory health
//   refresh() fills the agent's queues from the vault as it reads now (main runs stage 1 to 4 with the provider)
//   bind(kind, ctl) hands main the AbortController of the call that runs ('draft' or 'claims'), so Cancel stops the
//   model call; ctl is null once it ends
//   after(result, kind) runs after each call, kind 'draft' or 'claims' (main checks the notes it read again)
//   notes()   how many notes the vault holds, for the label
//   emit(status) tells the windows when the pass starts, moves on or ends
//   saved()   how many notes the agent read in earlier passes (claims stored), so the note count starts there
//   left()    how many notes the agent still has queued to read; without it the label counts calls
//   review()  the Needs review items now ([{ id, type, drafted }]), to tell what the pass added
//   store     createLastRunStore (catchupPlan.js): keeps the last pass in the data folder
export const BUSY_WAIT_MS = 5000;
// how many times the pass reads the vault again when both queues look empty, before it calls the pass done
const RESWEEPS = 2;

const fmt = (n) => Number(n).toLocaleString('en-US');
export const catchupLabel = (notes, done, total) => `Checking all ${fmt(notes)} ${notes === 1 ? 'note' : 'notes'}: ${fmt(done)} of ${fmt(total)} ${total === 1 ? 'call' : 'calls'}`;
// the label once the pass knows its notes: the notes checked, saved ones included, of the notes to check
// the label until the pass knows its totals
export const readyLabel = (notes) => `Getting ready to check ${fmt(notes)} ${notes === 1 ? 'note' : 'notes'}`;
export const notesLabel = (checked, of) => `Checked ${fmt(checked)} of ${fmt(of)} ${of === 1 ? 'note' : 'notes'}`;

export function createCatchup({ drafter, agent, activity, refresh = async () => {}, bind = () => {}, after = async () => {}, notes = () => 0, emit = () => {}, saved = () => 0, left = null, review = () => null, store = null, wait = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); }), busyWaitMs = BUSY_WAIT_MS, log = () => {} }) {
  let run = null;
  let last = store?.load() ?? null;
  // the calls a pass would make now, for the estimate in onboarding and Settings > Memory
  const remaining = () => drafter.pendingCalls() + agent.pendingCalls();
  // a pass a crash stopped kept the items listed when it started, so what it added is told once the vault reads again
  const settle = () => {
    if (!last?.before || last.added) return;
    try { const now = review(); if (!now) return; last = { ...last, added: diffReview(last.before, now) }; } catch { return; }
    delete last.before;
    store?.save(last);
    store?.clearBefore?.();
  };
  const shown = (l) => (l ? Object.fromEntries(Object.entries(l).filter(([k]) => k !== 'before')) : null);
  const status = () => { if (run) return { running: true, done: run.done, total: run.total, notes: run.notes, id: run.work.id, checked: run.checked, of: run.of, saved: run.saved, skipped: run.skipped, startedAt: run.startedAt }; settle(); return { running: false, last: shown(last) }; };
  const record = (r, end) => ({ end, done: r.done, total: r.total, notes: r.notes, checked: r.checked, of: r.of, saved: r.saved, skipped: r.skipped, startedAt: r.startedAt });
  // the bar and the label: the notes checked when the pass knows them, the calls otherwise
  const show = (r) => {
    if (left) { const p = progressOf(r.of, { saved: r.saved, read: r.read, left: left() }); r.checked = p.checked; r.of = p.of; }
    if (r.of) r.work.progress(r.checked, r.of, notesLabel(r.checked, r.of));
    else if (r.total) r.work.progress(r.done, r.total, catchupLabel(r.notes, r.done, r.total));
    else r.work.progress(0, 0, readyLabel(r.notes));
  };

  async function loop(r) {
    let empty = 0;
    while (!r.stopped) {
      const ctl = new AbortController();
      r.ctl = ctl;
      let res;
      let kind = 'draft';
      try {
        bind('draft', ctl);
        try { res = await drafter.tick({ uncapped: true }); } finally { bind('draft', null); }
        if (res?.skipped === 'nothing' && !r.stopped) {
          kind = 'claims';
          bind('claims', ctl);
          try { res = await agent.tick({ uncapped: true }); } finally { bind('claims', null); }
        }
      } finally { r.ctl = null; }
      if (r.stopped || res?.cancelled) return 'cancelled';
      if (res?.skipped === 'off') return 'off';
      if (res?.skipped === 'busy' || res?.skipped === 'running') { await wait(busyWaitMs); continue; }
      if (res?.skipped === 'nothing') {
        // both queues are empty: read the vault once more, since a note the agent read can bring a pair to judge
        if (empty++ >= RESWEEPS) return 'done';
        await refresh();
        if (!remaining()) return 'done';
        continue;
      }
      empty = 0;
      r.done++;
      if (kind === 'claims' && Array.isArray(res?.extracted)) r.read += res.extracted.length;
      // a claim call that failed: its notes leave the queue unread, and the agent asks for them again after a day
      if (kind === 'claims' && Array.isArray(res?.dropped)) r.skipped += res.dropped.length;
      try { await after(res, kind); } catch (e) { log('memory catchup after', e?.message); }
      r.total = Math.max(r.total, r.done + remaining());
      show(r);
      store?.save(record(r, 'running'));
      emit(status());
    }
    return 'cancelled';
  }

  // starts a pass. Answers its status; a pass that runs already is left as it is
  async function start() {
    if (run) return status();
    const r = { done: 0, total: 0, notes: notes(), stopped: false, ctl: null, work: null, read: 0, skipped: 0, checked: 0, of: 0, saved: 0, startedAt: Date.now(), before: null };
    try { r.saved = saved() ?? 0; r.before = review(); } catch (e) { log('memory catchup plan', e?.message); }
    r.checked = r.saved;
    r.work = activity.start({ kind: 'catchup', label: readyLabel(r.notes), cancellable: true, immediate: true, onCancel: () => { r.stopped = true; r.ctl?.abort(); } });
    run = r;
    emit(status());
    const { startedAt } = r;
    store?.saveBefore?.(r.before);
    store?.save(record(r, 'running'));
    r.promise = (async () => {
      let end = 'done';
      try {
        await refresh();
        r.total = remaining();
        show(r);
        emit(status());
        end = await loop(r);
      } catch (e) {
        end = 'failed';
        log('memory catchup', e?.message);
      } finally {
        let added = null;
        try { const now = review(); if (r.before && now) added = diffReview(r.before, now); } catch (e) { log('memory catchup review', e?.message); }
        last = { ...record(r, end), startedAt, endedAt: Date.now(), added };
        store?.save(last);
        store?.clearBefore?.();
        run = null;
        r.work.end();
        emit(status());
        log('memory catchup', end, `${r.done} of ${r.total} calls`);
      }
      return last;
    })();
    return status();
  }
  // Cancel from Settings or the banner: stops the call that runs and ends the pass
  function cancel() {
    if (!run) return false;
    return activity.cancel(run.work.id);
  }
  // Dismiss on the last-run card in Memory health: kept, so the card stays hidden after a restart
  function dismiss() {
    if (run || !last) return false;
    last = { ...last, dismissed: true };
    store?.save(last);
    emit(status());
    return true;
  }
  // waits for the pass that runs, for the tests and the dev script
  const done = () => (run ? run.promise : Promise.resolve(last));
  return { start, cancel, dismiss, status, remaining, done, running: () => !!run };
}
