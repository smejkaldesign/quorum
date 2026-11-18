#!/usr/bin/env node
// Times the chain a save starts: the save sweep in the memory engine (a worker thread here, a utility process in the
// app) and the quality gate run after it, the way main.js wires them. It reports the time the thread that plays main was
// busy (event loop utilization), its longest single block, and the wall time, for one save and for a run of session
// log rewrites. Every write goes to a temporary copy; the source vault is only read.
//
//   node scripts/save-sweep-bench.mjs [--app DIR] [--legacy] [--copy VAULT] [--notes 2200] [--items 400] [--turns 40]
//
//   --app     the app folder whose engine and rules run (default: this one), so a checkout of main gives the before
//             numbers
//   --legacy  the gate and save sweeps as main.js ran them before gateRun.js: two full builds of the items with a
//             read of every note each, a walk of the whole vault between them, and the verdict file read and written
//             whole and in place on every run; a save sweep 3 seconds after each save
//   --copy    a vault to copy into the temporary folder in place of the generated one (test/fixtures/sweepVault.js)
//   --items   how many findings the gate builds items for, picked by key so the same ones stay picked across sweeps
//   --turns   session log rewrites in the run, one every 15 seconds of app time, played 100 times faster
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';

const args = process.argv.slice(2);
const opt = (name, d) => { const i = args.indexOf(`--${name}`); return i < 0 ? d : args[i + 1]; };
const HERE = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const APP = path.resolve(opt('app', HERE));
const LEGACY = args.includes('--legacy');
const ITEMS = Number(opt('items', 400));
const TURNS = Number(opt('turns', 40));
const SPEED = 100;
const load = (rel) => import(path.join(APP, rel));

const { createVaultIndex } = await load('vindex.js');
const { createMemoryHost } = await load('memoryHost.js');
const { createSaveSweeps } = await load('memoryWiring.js');
const { findingItem } = await load('reviewItems.js');
const { logGate, runGate, signature } = await import(path.join(HERE, 'qualityGate.js'));
const { hashNotes, createNoteHashes, noteMemo } = await import(path.join(HERE, 'fixJournal.js'));
const { createGateStore, gatePasses } = await import(path.join(HERE, 'gateRun.js'));
const { hashText } = await import(path.join(HERE, 'contradictionIndex.js'));
const { writeSweepVault } = await import(path.join(HERE, 'test/fixtures/sweepVault.js'));

const root = mkdtempSync(path.join(tmpdir(), 'qsave-bench-'));
const vault = path.join(root, 'vault');
const data = path.join(root, 'data');
let logs;
const src = opt('copy', null);
if (src) {
  cpSync(src, vault, { recursive: true, filter: (p) => !/(^|\/)(\.git|node_modules|\.venv|\.obsidian|\.trash)(\/|$)/.test(p) });
  logs = null;
} else ({ logs } = writeSweepVault(vault, { notes: Number(opt('notes', 2200)) }));

const vindex = createVaultIndex({ vault, isExcludedPath: () => false, isExcludedText: () => false, redact: (t) => t, onChange: () => {} });
vindex.sync();
const rels = vindex.rels();
logs ??= rels.filter((r) => /sessions?\//.test(r)).slice(0, 5);
if (!logs.length) logs = rels.slice(0, 1);
const worker = new Worker(new URL(`file://${path.join(APP, 'memoryWorker.js')}`), { workerData: { dataDir: data } });
const cond = () => ({ enabled: false, cap: 0, busy: false, idleMs: 0, drafts: false, bar: null, folders: {}, terms: [] });
const host = createMemoryHost({ port: worker, index: () => vindex, vault: () => vault, mayRead: () => true, cond, model: async () => { throw new Error('no model'); } });

// the review items main builds (main.js reviewItems), for the findings picked and the missing links, each with the hash
// of every note it touches
let state = null;
let pick = null;
const tick = () => new Promise((r) => setImmediate(r));
function build({ ids = null, hashes }) {
  const findings = state?.findings ?? [];
  pick ??= Math.min(256, Math.ceil((256 * ITEMS) / Math.max(1, findings.length)));
  const want = ids ? new Set(ids) : null;
  const out = [];
  for (const m of vindex.linkHealth()) {
    const id = `r:link:${m.target.toLowerCase()}`;
    if (want && !want.has(id)) continue;
    out.push({ id, kind: 'link', key: m.target.toLowerCase(), target: m.target, ops: [{ op: 'unlink', target: m.target }], hashes: hashes(m.sources) });
  }
  for (const f of findings) {
    if (parseInt(hashText(f.key).slice(0, 2), 16) >= pick) continue;
    const item = findingItem(f);
    if (want && !want.has(item.id)) continue;
    out.push({ ...item, hashes: hashes([...new Set([...f.notes, ...(item.ops ?? []).map((o) => o.rel).filter(Boolean)])]) });
  }
  return out;
}
const STUB = 'Quorum made this note because';
const readVault = (rel) => { try { return readFileSync(path.join(vault, rel), 'utf8'); } catch { return null; } };
const gateFile = path.join(data, 'memory-gate.json');
const gateLog = path.join(data, 'memory-gate-log.jsonl');

// main.js gateNow before gateRun.js
async function legacyGate() {
  await tick();
  const first = build({ hashes: (r) => hashNotes(vault, r) });
  await tick();
  vindex.sync();
  const second = build({ hashes: (r) => hashNotes(vault, r) });
  const g = runGate([first, second], [], { isStub: (rel) => (readVault(rel) ?? '').includes(STUB) });
  const sigs = new Map(first.map((i) => [i.id, signature(i)]));
  const verdicts = new Map([...g.verdicts].map(([id, v]) => [id, { ...v, sig: sigs.get(id) }]));
  let all = {};
  try { all = JSON.parse(readFileSync(gateFile, 'utf8')) ?? {}; } catch {}
  all[vault] = { at: Date.now(), verdicts: Object.fromEntries(verdicts) };
  writeFileSync(gateFile, JSON.stringify(all));
  logGate(gateLog, vault, g, { passes: 2 });
  return { items: first.length, rebuilt: first.length, wrote: true };
}
// main.js gateNow with gateRun.js
const noteHashes = createNoteHashes();
const stubOf = noteMemo((t) => t.includes(STUB));
const store = createGateStore(gateFile);
let kept = null;
async function gate() {
  await tick();
  const first = build({ hashes: (r) => noteHashes(vault, r) });
  const again = async (items) => {
    await tick();
    const fresh = (r) => noteHashes(vault, r, { fresh: true });
    if (!items) { vindex.sync(); return build({ hashes: fresh }); }
    if (!vindex.syncPaths([...new Set(items.flatMap((i) => Object.keys(i.hashes ?? {})))]).length) return items.map((i) => ({ ...i, hashes: fresh(Object.keys(i.hashes ?? {})) }));
    return build({ ids: items.map((i) => i.id), hashes: fresh });
  };
  const r = await gatePasses({ first, kept, again, isStub: (rel) => !!stubOf(vault, rel) });
  kept = r.verdicts;
  if (!r.same) { await store.put(vault, { at: Date.now(), verdicts: Object.fromEntries(r.verdicts) }); logGate(gateLog, vault, r.g, { passes: 2 }); }
  return { items: first.length, rebuilt: r.rebuilt, wrote: !r.same };
}
const runGateNow = LEGACY ? legacyGate : gate;

// what the thread that plays main did over fn: busy ms (event loop utilization), its longest block and the wall time
async function measure(fn) {
  let longest = 0;
  let last = performance.now();
  const probe = setInterval(() => { const t = performance.now(); longest = Math.max(longest, t - last - 1); last = t; }, 1);
  const e0 = performance.eventLoopUtilization();
  const t0 = performance.now();
  const out = await fn();
  const wall = performance.now() - t0;
  const e = performance.eventLoopUtilization(e0);
  clearInterval(probe);
  longest = Math.max(longest, performance.now() - last - 1);
  return { ...out, busyMs: Math.round(e.active), longestMs: Math.round(longest), wallMs: Math.round(wall) };
}
const touch = (rel) => { appendFileSync(path.join(vault, rel), `**Turn**: one more line ${Date.now()}\n`); vindex.syncPaths([rel]); };

try {
  // the first sweep and gate run, as the app makes them at launch
  state = (await host.sweep('first', null)).state;
  await (LEGACY ? legacyGate() : gate());
  const out = { app: APP, legacy: LEGACY, notes: rels.length, findings: state.findings.length };
  // one save: the sweep of the saved note and the gate run after it
  const one = async (rel) => measure(async () => {
    touch(rel);
    const t = performance.now();
    const r = await host.sweep('save', [rel]);
    state = r.state;
    const sweepMs = Math.round(performance.now() - t);
    const e0 = performance.eventLoopUtilization();
    const g = await runGateNow();
    const gateBusyMs = Math.round(performance.eventLoopUtilization(e0).active);
    return { sweepMs, engineMs: state.last.ms, contradictionMs: state.last.rules['note.contradiction'], gate: { ...g, busyMs: gateBusyMs } };
  });
  out.saveLog = await one(logs[0]);
  out.saveLogAgain = await one(logs[0]);
  const project = rels.find((r) => r.startsWith('projects/')) ?? rels[1];
  out.saveNote = await one(project);
  // a run of turns: the session log rewritten every 15 s of app time, and one other note saved partway through. The
  // save sweeps go through createSaveSweeps and the gate runs 4 s after each sweep, as in main.js, all 100 times faster
  let sweeps = 0;
  let gates = 0;
  let gateTimer = null;
  let chain = Promise.resolve();
  const sweep = (kind, only) => { sweeps++; chain = chain.then(async () => { state = (await host.sweep(kind, only)).state; clearTimeout(gateTimer); gateTimer = setTimeout(() => { gates++; chain = chain.then(runGateNow); }, 4000 / SPEED); }); return chain; };
  const saves = LEGACY ? createSaveSweeps({ sweep, delayMs: 3000 / SPEED }) : createSaveSweeps({ sweep, delayMs: 3000 / SPEED, gapMs: 60000 / SPEED, key: () => vault });
  out.turns = await measure(async () => {
    for (let i = 0; i < TURNS; i++) {
      touch(logs[i % logs.length]);
      saves.add([logs[i % logs.length]]);
      if (i === Math.floor(TURNS / 2)) { touch(project); saves.add([project]); }
      await new Promise((r) => setTimeout(r, 15000 / SPEED));
    }
    await new Promise((r) => setTimeout(r, 70000 / SPEED));
    // until the last sweep and the gate run it schedules are done
    for (;;) { const c = chain; await c; await new Promise((r) => setTimeout(r, 4000 / SPEED + 20)); if (c === chain) break; }
    return { turns: TURNS, appMinutes: Math.round((TURNS * 15) / 6) / 10, sweeps, gates };
  });
  console.log(JSON.stringify(out, null, 1));
} finally {
  await worker.terminate();
  rmSync(root, { recursive: true, force: true });
}
