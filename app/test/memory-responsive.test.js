// Check everything now must leave main free: a catch-up over a generated vault of 2,000 notes with a fake model
// (test/fixtures/catchupLoad.js), with the hooks and save sweeps main.js uses (memoryWiring.js), measured in its own
// Node process with the garbage collector exposed. It fails when the pass adds more than 50 ms to main's event loop
// p95 delay, measured against the same process idle just before the pass, so a busy machine does not fail it (the
// pass measures about 7 ms), when main's heap keeps climbing across the run, when a
// sweep runs before the pass ends, or when a note or a pair is sent to the model twice. Every note is generated; no
// real model is called.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = path.join(path.dirname(new URL(import.meta.url).pathname), '../scripts/memory-catchup-bench.mjs');
const run = (...args) => JSON.parse(execFileSync(process.execPath, ['--expose-gc', SCRIPT, ...args], { encoding: 'utf8', timeout: 120000 }));
// the lag the pass adds over the idle process. Other test files run beside this one, and a burst of their work can land
// in the pass and not in the idle measurement; a second run is then measured. A pass that blocks main adds the lag in
// both runs, so it still fails
const added = (r) => r.lagP95 - r.idleLagP95;
const bench = (...args) => { const r = run(...args); return added(r) < 50 ? r : run(...args); };
// how much main's heap grew across the pass, in MB. The runs sample the heap after a forced collection (--gc-samples),
// so a sample holds only what main keeps; without that, garbage that waits for the collector moved the samples by tens
// of MB from one run to the next. A main that keeps 2 MB a call grows by more than 30 MB in either run
const grew = (lows) => Math.max(...lows) - lows[0];

describe('a catch-up and the main process', () => {
  it('keeps main responsive over 2,000 notes and asks the model once per note and per pair', () => {
    const r = bench('--notes', '2000', '--delay', '20', '--gc-samples');
    expect(r.end).toBe('done');
    expect(r.items).toBeGreaterThan(1000);
    expect(r.repeats).toBe(0);
    // the pass adds less than 50 ms to the p95 delay the idle process shows on this machine just before it
    expect(added(r), JSON.stringify(r)).toBeLessThan(50);
    // every call saved a note, and still one sweep ran: the one that ends the pass. Progress goes at most once a second
    expect(r.sweeps).toBe(1);
    expect(r.emits).toBeLessThanOrEqual(Math.ceil(r.ms / 1000) + 3);
    expect(r.heapLowsMB.length, JSON.stringify(r.heapLowsMB)).toBeGreaterThan(3);
    expect(grew(r.heapLowsMB), JSON.stringify(r.heapLowsMB)).toBeLessThan(10);
    expect(r.heapEndMB - r.heapStartMB).toBeLessThan(10);
  }, 130000);

  it('keeps main heap flat while a large log note grows during the pass', () => {
    // 600 notes and a fake model of 60 ms: about 35 calls, each one saving the log, over a few heap samples
    const r = bench('--notes', '600', '--big', '8000000', '--grow', '20000', '--delay', '60', '--gc-samples');
    expect(r.end).toBe('done');
    // the pass adds less than 50 ms to the p95 delay the idle process shows on this machine just before it
    expect(added(r), JSON.stringify(r)).toBeLessThan(50);
    expect(r.heapLowsMB.length, JSON.stringify(r.heapLowsMB)).toBeGreaterThan(3);
    expect(grew(r.heapLowsMB), JSON.stringify(r.heapLowsMB)).toBeLessThan(10);
    // the index holds the note's 2 MB head and its lowercased copy for search; the rules' caches are in the engine
    expect(r.heapEndMB - r.heapStartMB).toBeLessThan(10);
  }, 130000);
});
