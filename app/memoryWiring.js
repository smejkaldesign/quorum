// How main ties the memory engine to saves and to Check everything now. main.js builds these with its own state; the
// responsiveness test (test/memory-responsive.test.js) builds the same ones, so a change here is measured there.
// Plain Node, no Electron: main passes Electron's utilityProcess in.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createMemoryHost } from './memoryHost.js';

// The save sweeps: the notes saved in the last delayMs are checked together. A vault gets at most one save sweep per
// gapMs, so a note rewritten on every turn (a session log) does not start a sweep each time: the saves in between wait
// and go in the next one, and a last one runs once the saves stop. A run of saves that never pauses still gets a sweep
// gapMs after its first save. hold(): a recording or a catch-up runs, so the saves wait (a recording writes its note
// every few seconds; a catch-up sweeps once when it ends). key(): the open vault
export const SAVE_DELAY_MS = 3000;
export const SAVE_GAP_MS = 60000;
export function createSaveSweeps({ sweep, hold = () => false, delayMs = SAVE_DELAY_MS, gapMs = SAVE_GAP_MS, key = () => null, now = () => Date.now() }) {
  let timer = null;
  const rels = new Set();
  let first = 0;
  let latest = 0;
  const ran = new Map();
  function arm(ms) {
    clearTimeout(timer);
    timer = setTimeout(fire, Math.max(0, ms));
    timer.unref?.();
  }
  function due() {
    const last = ran.get(key()) ?? -Infinity;
    return Math.max(last + gapMs, Math.min(latest + delayMs, first + gapMs)) - now();
  }
  function fire() {
    timer = null;
    if (hold()) { arm(delayMs); return; }
    if (!rels.size) return;
    const only = [...rels];
    rels.clear();
    ran.set(key(), now());
    sweep('save', only);
  }
  function add(list) {
    const t = now();
    if (!rels.size) first = t;
    latest = t;
    for (const r of list ?? []) rels.add(r);
    if (!rels.size) { arm(delayMs); return; }
    arm(due());
  }
  // the saves that wait are dropped: a full sweep covers them
  function clear() { clearTimeout(timer); timer = null; rels.clear(); }
  // the saves that wait, handed over and dropped here: the vault closes or Quorum quits, and savesKept holds them
  function take() { const out = [...rels]; clear(); return out; }
  return { add, clear, take, pending: () => rels.size };
}

// The saves still waiting when a vault closes or Quorum quits, per vault, in a file in Quorum's data folder, so the save
// sweep after the vault opens again checks them
export function savesKept(file) {
  const read = () => { try { const j = JSON.parse(readFileSync(file, 'utf8')); return j && typeof j === 'object' && !Array.isArray(j) ? j : {}; } catch { return {}; } };
  const write = (all) => { try { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(`${file}.tmp`, JSON.stringify(all)); renameSync(`${file}.tmp`, file); } catch {} };
  return {
    keep(vault, rels) {
      if (!vault || !rels?.length) return;
      const all = read();
      all[vault] = [...new Set([...(all[vault] ?? []), ...rels])];
      write(all);
    },
    take(vault) {
      const all = read();
      const out = Array.isArray(all[vault]) ? all[vault].filter((r) => typeof r === 'string') : [];
      if (vault in all) { delete all[vault]; write(all); }
      return out;
    },
  };
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

// The memory engine as main starts it: no port at first, so the first call forks the engine through fork(). fork:
// forkEngine below in the app, a worker thread in the tests. The other options go to createMemoryHost as they are
export function startMemoryEngine({ fork, ...opts }) {
  return createMemoryHost({ ...opts, port: null, restart: fork });
}
// the engine in an Electron utility process, with its own heap. utilityProcess: Electron's; dir: the folder that holds
// memoryWorker.js; dataDir: Quorum's data folder, where the engine keeps its files
export const forkEngine = (utilityProcess, dir, dataDir) => () => utilityProcess.fork(path.join(dir, 'memoryWorker.js'), [dataDir], { serviceName: 'Quorum memory' });
