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
export const BUSY_WAIT_MS = 5000;
// how many times the pass reads the vault again when both queues look empty, before it calls the pass done
const RESWEEPS = 2;

export const catchupLabel = (notes, done, total) => `Checking all ${notes} ${notes === 1 ? 'note' : 'notes'}: ${done} of ${total} ${total === 1 ? 'call' : 'calls'}`;

export function createCatchup({ drafter, agent, activity, refresh = async () => {}, bind = () => {}, after = async () => {}, notes = () => 0, emit = () => {}, wait = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); }), busyWaitMs = BUSY_WAIT_MS, log = () => {} }) {
  let run = null;
  let last = null;
  // the calls a pass would make now, for the estimate in onboarding and Settings > Memory
  const remaining = () => drafter.pendingCalls() + agent.pendingCalls();
  const status = () => (run ? { running: true, done: run.done, total: run.total, notes: run.notes, id: run.work.id } : { running: false, last });

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
      try { await after(res, kind); } catch (e) { log('memory catchup after', e?.message); }
      r.total = Math.max(r.total, r.done + remaining());
      r.work.progress(r.done, r.total, catchupLabel(r.notes, r.done, r.total));
      emit(status());
    }
    return 'cancelled';
  }

  // starts a pass. Answers its status; a pass that runs already is left as it is
  async function start() {
    if (run) return status();
    const r = { done: 0, total: 0, notes: notes(), stopped: false, ctl: null, work: null };
    r.work = activity.start({ kind: 'catchup', label: catchupLabel(r.notes, 0, 0), cancellable: true, immediate: true, onCancel: () => { r.stopped = true; r.ctl?.abort(); } });
    run = r;
    emit(status());
    const startedAt = Date.now();
    r.promise = (async () => {
      let end = 'done';
      try {
        await refresh();
        r.total = remaining();
        r.work.progress(0, r.total, catchupLabel(r.notes, 0, r.total));
        emit(status());
        end = await loop(r);
      } catch (e) {
        end = 'failed';
        log('memory catchup', e?.message);
      } finally {
        last = { end, done: r.done, total: r.total, notes: r.notes, startedAt, endedAt: Date.now() };
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
  // waits for the pass that runs, for the tests and the dev script
  const done = () => (run ? run.promise : Promise.resolve(last));
  return { start, cancel, status, remaining, done, running: () => !!run };
}
