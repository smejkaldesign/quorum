// Agent activity: the long memory work the agent does in the background (the first memory check, a full sweep, a bulk
// batch, a drafting run), as one state that Home and Memory health both read. A piece of work shows once it has run
// SHOW_AFTER_MS; quicker work never shows. Plain Node with no Electron, so the tests drive it with a fake clock.
//
// The state is null or { id, kind, label, startedAt, progress, cancellable, more }:
//   kind         'check' | 'sweep' | 'batch' | 'draft'
//   label        what runs now, in plain words
//   progress     { done, total } or null when the work cannot count its steps
//   cancellable  whether Cancel can stop it cleanly
//   more         how many other pieces of work run at the same time and have shown
// The oldest shown work is the state. Cancel asks the work to stop: it stops at its next safe point (a batch between
// steps, rolling back every note it wrote; a check before it saves its verdicts; a draft by stopping the model call).
export const SHOW_AFTER_MS = 30000;
export const KINDS = ['check', 'sweep', 'batch', 'draft'];

export function createAgentActivity({ emit = () => {}, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout, showAfterMs = SHOW_AFTER_MS } = {}) {
  const works = new Map();
  let seq = 0;
  let last = 'null';
  const view = (w) => ({ id: w.id, kind: w.kind, label: w.label, startedAt: w.startedAt, progress: w.progress, cancellable: w.cancellable && !w.cancelled });
  function state() {
    const shown = [...works.values()].filter((w) => w.shown).sort((a, b) => a.startedAt - b.startedAt);
    return shown.length ? { ...view(shown[0]), more: shown.length - 1 } : null;
  }
  // tells the windows when what they show changes
  function changed() {
    const s = state();
    const key = JSON.stringify(s);
    if (key === last) return;
    last = key;
    emit(s);
  }
  // starts a piece of work. onCancel runs once when a person presses Cancel. Answers a handle the work updates
  function start({ kind, label, cancellable = false, onCancel = null }) {
    const w = { id: `${kind}:${now()}:${++seq}`, kind, label, startedAt: now(), progress: null, cancellable: cancellable && typeof onCancel === 'function', cancelled: false, onCancel, shown: false, timer: null };
    works.set(w.id, w);
    w.timer = setTimer(() => { w.timer = null; if (works.has(w.id)) { w.shown = true; changed(); } }, showAfterMs);
    w.timer?.unref?.();
    return {
      id: w.id,
      get cancelled() { return w.cancelled; },
      // done of total steps, and what runs now when it changed
      progress(done, total, next = null) { w.progress = Number.isFinite(total) && total > 0 ? { done: Math.max(0, Math.min(done, total)), total } : null; if (next) w.label = next; if (w.shown) changed(); },
      label(next) { w.label = next; if (w.shown) changed(); },
      end() { if (w.timer) clearTimer(w.timer); works.delete(w.id); changed(); },
    };
  }
  // Cancel from Home or Memory health. Answers whether the work was asked to stop
  function cancel(id) {
    const w = works.get(id);
    if (!w || !w.cancellable || w.cancelled) return false;
    w.cancelled = true;
    w.label = 'Stopping';
    changed();
    try { w.onCancel(); } catch {}
    return true;
  }
  return { start, cancel, state, running: () => works.size };
}
