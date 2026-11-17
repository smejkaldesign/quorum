// How main ties the memory engine to saves and to Check everything now. main.js builds these with its own state; the
// responsiveness test (test/memory-responsive.test.js) builds the same ones, so a change here is measured there.
// Plain Node, no Electron.

// The save sweeps: the notes saved in the last delayMs are checked together. hold(): a recording or a catch-up runs, so
// the saves wait (a recording writes its note every few seconds; a catch-up sweeps once when it ends)
export const SAVE_DELAY_MS = 3000;
export function createSaveSweeps({ sweep, hold = () => false, delayMs = SAVE_DELAY_MS }) {
  let timer = null;
  const rels = new Set();
  function fire() {
    timer = null;
    if (hold()) { add([]); return; }
    if (!rels.size) return;
    const only = [...rels];
    rels.clear();
    sweep('save', only);
  }
  function add(list) {
    for (const r of list ?? []) rels.add(r);
    clearTimeout(timer);
    timer = setTimeout(fire, delayMs);
    timer.unref?.();
  }
  // the saves that wait are dropped: the vault changed, or a full sweep covers them
  function clear() { clearTimeout(timer); timer = null; rels.clear(); }
  return { add, clear, pending: () => rels.size };
}

// A catch-up call holds the same abort slot as a scheduled call, so the two never run at once; a slot another call
// holds is left alone. get(kind) and set(kind, ctl) read and write main's slot for 'draft' or 'claims'
export function slotBinder({ get, set }) {
  const owns = { draft: null, claims: null };
  return (kind, ctl) => {
    const cur = get(kind);
    if (ctl ? cur : cur !== owns[kind]) return;
    owns[kind] = ctl;
    set(kind, ctl);
  };
}

// The hooks of createCatchup (memoryCatchup.js) as main runs them:
//   engine  createMemoryHost (memoryHost.js); ready() a vault and its index are open
//   sweep(kind, only, opts) main's sweep; gate() the quality gate run; saves createSaveSweeps
//   kind()  the kind of the sweep that ends a pass ('full', or 'first' for a vault never swept)
export function catchupHooks({ engine, ready, sweep, gate, saves, kind, bind }) {
  return {
    // stage 1 to 4 over the whole vault with the agent's provider, so its queues hold every note still to read
    refresh: async () => { if (ready()) await engine.refresh(); },
    bind,
    // nothing runs between calls: the saves of the pass and of the person wait for the one sweep at the end
    after: async () => {},
    // one full sweep and one gate run, so what the pass found reaches Needs review once. The saves that waited are in it
    finish: async () => {
      if (!ready()) return;
      saves.clear();
      await sweep(kind(), null, { after: false });
      await gate();
    },
  };
}
