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
const bench = (...args) => JSON.parse(execFileSync(process.execPath, ['--expose-gc', SCRIPT, ...args], { encoding: 'utf8', timeout: 120000 }));
// the heap's low points (what it keeps after a collection) in the later half of the run against the earlier half: a
// heap that keeps memory call after call fails it. The peaks depend on when the collector runs, so they are not used
const climbs = (lows) => {
  const half = Math.floor(lows.length / 2);
  return Math.min(...lows.slice(half)) > Math.max(...lows.slice(0, half)) * 1.25 + 5;
};

describe('a catch-up and the main process', () => {
  it('keeps main responsive over 2,000 notes and asks the model once per note and per pair', () => {
    const r = bench('--notes', '2000');
    expect(r.end).toBe('done');
    expect(r.items).toBeGreaterThan(1000);
    expect(r.repeats).toBe(0);
    // the pass adds less than 50 ms to the p95 delay the idle process shows on this machine just before it
    expect(r.lagP95 - r.idleLagP95).toBeLessThan(50);
    // every call saved a note, and still one sweep ran: the one that ends the pass. Progress goes at most once a second
    expect(r.sweeps).toBe(1);
    expect(r.emits).toBeLessThanOrEqual(Math.ceil(r.ms / 1000) + 3);
    expect(climbs(r.heapLowsMB)).toBe(false);
    expect(r.heapEndMB - r.heapStartMB).toBeLessThan(20);
  }, 130000);

  it('keeps main heap flat while a large log note grows during the pass', () => {
    const r = bench('--notes', '300', '--big', '8000000', '--grow', '20000');
    expect(r.end).toBe('done');
    // the pass adds less than 50 ms to the p95 delay the idle process shows on this machine just before it
    expect(r.lagP95 - r.idleLagP95).toBeLessThan(50);
    expect(climbs(r.heapLowsMB)).toBe(false);
    // the index holds the note and its lowercased copy for search; the rules' caches are in the engine
    expect(r.heapEndMB - r.heapStartMB).toBeLessThan(40);
  }, 130000);
});
