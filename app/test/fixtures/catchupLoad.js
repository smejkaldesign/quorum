// Drives Check everything now (memoryCatchup.js) over a generated vault (synthVault.js) with a fake model, the way main
// wires it, and measures the thread that plays main: its event loop delay and its heap. Used by
// test/memory-responsive.test.js and scripts/memory-catchup-bench.mjs. Never calls a real model.
//
// mode 'engine': the memory engine runs in a worker thread through memoryHost.js, and the pass runs with the hooks and
//   the save sweeps main.js builds (memoryWiring.js). Every call also saves a note, as the person or a session log
//   does, so a hook that sweeps between calls shows in the sweep count. mode 'main': the rules, the pipeline and the agent run on the measured thread and a save sweep runs
//   after every call, a few milliseconds after it ends (main.js before the memory engine), for the before numbers.
// grow: characters appended to the big log note after every call, as a session log that keeps growing
// vault: an existing vault to read instead of a generated one. It is only read: grow is ignored and nothing is written there
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';
import { Worker } from 'node:worker_threads';
import { createVaultIndex } from '../../vindex.js';
import { createAgentActivity } from '../../agentActivity.js';
import { createCatchup } from '../../memoryCatchup.js';
import { createDrafter } from '../../memoryDraft.js';
import { createMemoryHost } from '../../memoryHost.js';
import { catchupHooks, createSaveSweeps, slotBinder } from '../../memoryWiring.js';
import { createMemorySweep, scanTags } from '../../memorySweep.js';
import { analyze } from '../../rules/contradictions.js';
import { synthModel, writeSynthVault } from './synthVault.js';

const WORKER = new URL('../../memoryWorker.js', import.meta.url);
const heap = () => getHeapStatistics().used_heap_size;
const settle = async () => { for (let i = 0; i < 3; i++) { globalThis.gc?.(); await new Promise((r) => setTimeout(r, 20)); } };

export async function runCatchupLoad({ mode = 'engine', notes = 2000, big = 0, grow = 0, delay = 5, agentModule = '../../contradictionAgent.js', samples = 8, vault: existing = null } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'qload-'));
  const vault = existing ?? path.join(root, 'vault');
  const data = path.join(root, 'data');
  if (existing) grow = 0; else writeSynthVault(vault, { notes, big });
  const vindex = createVaultIndex({ vault, isExcludedPath: () => false, isExcludedText: () => false, redact: (t) => t, onChange: () => {} });
  vindex.sync();
  if (existing) notes = vindex.rels().length;
  // each id the model was asked about, with how many times
  const asked = new Map();
  const count = (prompt) => {
    const j = prompt.match(/Claim A in (\S+) \(line \d+\)[\s\S]*Claim B in (\S+) \(line \d+\)/);
    const ids = j ? [`judge:${[j[1], j[2]].sort().join('|')}`] : prompt.split('<note path="').slice(1).map((b) => `claims:${b.slice(0, b.indexOf('"'))}`);
    for (const id of ids) asked.set(id, (asked.get(id) ?? 0) + 1);
  };
  let calls = 0;
  const model = async (prompt) => {
    calls++;
    count(prompt);
    await new Promise((r) => setTimeout(r, delay));
    if (grow && big) { appendFileSync(path.join(vault, 'logs/2026-11-16.md'), 'x'.repeat(grow - 1) + '\n'); vindex.syncPaths(['logs/2026-11-16.md']); }
    saved?.(prompt);
    return synthModel(prompt);
  };
  const cond = () => ({ enabled: true, cap: 0, busy: false, idleMs: 0, drafts: true, bar: null, folders: {}, terms: [] });

  let agent;
  let refresh;
  let after = async () => {};
  let finish = async () => {};
  let close = () => {};
  let sweepRuns = 0;
  let saved = null;
  let hooks = null;
  let running = () => false;
  if (mode === 'engine') {
    const worker = new Worker(WORKER, { workerData: { dataDir: data } });
    const host = createMemoryHost({ port: worker, index: () => vindex, vault: () => vault, mayRead: () => true, cond, model });
    agent = host.agent;
    // main.js sweep, counted
    const sweep = async (kind, only) => { sweepRuns++; return host.sweep(kind, only); };
    // a save waits SAVE_DELAY_MS in the app; here a few milliseconds, so a save that does not wait sweeps during the run
    const saves = createSaveSweeps({ sweep, hold: () => running(), delayMs: 2 });
    saved = (prompt) => { const m = prompt.match(/<note path="([^"]+)"/); if (m) saves.add([m[1]]); };
    const slots = { draft: null, claims: null };
    hooks = catchupHooks({ engine: host, ready: () => true, sweep, gate: async () => {}, saves, kind: () => 'first', bind: slotBinder({ get: (k) => slots[k], set: (k, c) => { slots[k] = c; } }) });
    close = () => { saves.clear(); worker.terminate(); };
  } else {
    const { createContradictionAgent } = await import(agentModule);
    agent = createContradictionAgent({ file: path.join(data, 'contra.json'), model, enabled: () => true, cap: () => 0, idleMs: () => 0, readable: () => true });
    const sweeps = createMemorySweep({ file: path.join(data, 'findings.json') });
    const ctx = () => ({ notes: vindex.snapshot(), resolve: (t, f) => vindex.resolve(t, f), tags: scanTags(vault), folders: {}, contradictions: { provider: agent.provider, bar: null } });
    refresh = async () => { analyze({ notes: vindex.snapshot(), resolve: (t, f) => vindex.resolve(t, f), contradictions: { provider: agent.provider } }); };
    // main.js sweepOnSave: the notes a call read are checked a moment later, while the next call waits on the model
    after = async (res) => { if (res?.rels?.length) { const only = res.rels; setTimeout(() => { sweepRuns++; sweeps.run(vault, 'save', ctx(), { only }); }, Math.max(1, Math.floor(delay / 2))); } };
  }
  const drafter = createDrafter({ file: path.join(data, 'drafts.json'), model, items: () => [], evidence: () => null, enabled: () => true, cap: () => 0, idleMs: () => 0 });
  const activity = createAgentActivity({ emit: () => {}, setTimer: () => null, clearTimer: () => {} });
  let emits = 0;
  const catchup = createCatchup({ drafter, agent, activity, ...(hooks ?? { refresh, after, finish }), notes: () => notes, emit: () => { emits++; }, wait: async () => {}, busyWaitMs: 0 });
  running = () => catchup.running();

  await settle();
  const heapStart = heap();
  const heaps = [];
  const lag = monitorEventLoopDelay({ resolution: 5 });
  lag.enable();
  const t0 = Date.now();
  let sampler = setInterval(() => heaps.push(heap()), 50);
  await catchup.start();
  const last = await catchup.done();
  clearInterval(sampler);
  lag.disable();
  const ms = Date.now() - t0;
  // the heap once the pass is over and the garbage is collected, against the heap before it started
  await settle();
  const heapEnd = heap();
  close();
  rmSync(root, { recursive: true, force: true });
  // the heap across the run in `samples` slices: the peak of each, to tell growth from noise
  const slice = Math.max(1, Math.ceil(heaps.length / samples));
  const peaks = [];
  for (let i = 0; i < heaps.length; i += slice) peaks.push(Math.max(...heaps.slice(i, i + slice)));
  const repeats = [...asked.values()].filter((n) => n > 1).length;
  return {
    mode, notes, calls, end: last.end, done: last.done, ms, emits, sweeps: sweepRuns,
    items: asked.size, repeats, callsPerItem: asked.size ? [...asked.values()].reduce((a, b) => a + b, 0) / asked.size : 0,
    lagP95: lag.percentile(95) / 1e6, lagMax: lag.max / 1e6,
    heapStartMB: heapStart / 1e6, heapEndMB: heapEnd / 1e6, heapPeaksMB: peaks.map((p) => Math.round(p / 1e5) / 10),
  };
}
