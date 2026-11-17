// Check everything now must leave main free: a catch-up over a generated vault of 2,000 notes with a fake model
// (test/fixtures/catchupLoad.js), measured in its own Node process with the garbage collector exposed. It fails when
// main's event loop stalls (p95 over 50 ms), when main's heap keeps climbing across the run, or when a note or a pair
// is sent to the model twice. Every note is generated; no real model is called.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = path.join(path.dirname(new URL(import.meta.url).pathname), '../scripts/memory-catchup-bench.mjs');
const bench = (...args) => JSON.parse(execFileSync(process.execPath, ['--expose-gc', SCRIPT, ...args], { encoding: 'utf8', timeout: 120000 }));
// the peaks of the later half of the run against the earlier half: a heap that climbs call after call fails it
const climbs = (peaks) => {
  const half = Math.floor(peaks.length / 2);
  return Math.max(...peaks.slice(half)) > Math.max(...peaks.slice(0, half)) * 1.25 + 5;
};

describe('a catch-up and the main process', () => {
  it('keeps main responsive over 2,000 notes and asks the model once per note and per pair', () => {
    const r = bench('--notes', '2000');
    expect(r.end).toBe('done');
    expect(r.items).toBeGreaterThan(1000);
    expect(r.repeats).toBe(0);
    expect(r.lagP95).toBeLessThan(50);
    // one sweep when the pass ends, and progress at most once a second plus the start and the end
    expect(r.sweeps).toBe(1);
    expect(r.emits).toBeLessThanOrEqual(Math.ceil(r.ms / 1000) + 3);
    expect(climbs(r.heapPeaksMB)).toBe(false);
    expect(r.heapEndMB - r.heapStartMB).toBeLessThan(20);
  }, 130000);

  it('keeps main heap flat while a large log note grows during the pass', () => {
    const r = bench('--notes', '300', '--big', '8000000', '--grow', '20000');
    expect(r.end).toBe('done');
    expect(r.lagP95).toBeLessThan(50);
    expect(climbs(r.heapPeaksMB)).toBe(false);
    // the index holds the note and its lowercased copy for search; the rules' caches are in the engine
    expect(r.heapEndMB - r.heapStartMB).toBeLessThan(40);
  }, 130000);
});
