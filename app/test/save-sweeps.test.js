// The save sweeps main runs (memoryWiring.js createSaveSweeps): the saves of a few seconds go in one sweep, a vault gets
// at most one save sweep a minute however often a note is rewritten, every note saved since the last sweep goes in the
// next one, and a last sweep runs once the saves stop.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SAVE_DELAY_MS, SAVE_GAP_MS, createSaveSweeps, savesKept } from '../memoryWiring.js';

describe('save sweeps', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  afterEach(() => { vi.useRealTimers(); });
  const make = (opts = {}) => {
    const runs = [];
    const saves = createSaveSweeps({ sweep: (kind, only) => runs.push({ kind, only, at: Date.now() }), ...opts });
    return { saves, runs };
  };

  it('checks the notes saved a few seconds apart in one sweep', () => {
    const { saves, runs } = make();
    saves.add(['a.md']);
    vi.advanceTimersByTime(1000);
    saves.add(['b.md', 'a.md']);
    vi.advanceTimersByTime(SAVE_DELAY_MS - 1);
    expect(runs).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(runs).toEqual([{ kind: 'save', only: ['a.md', 'b.md'], at: 1000 + SAVE_DELAY_MS }]);
  });

  it('runs at most one save sweep a minute for a note rewritten on every turn, and a last one when the saves stop', () => {
    const { saves, runs } = make({ key: () => '/vault' });
    // a session log rewritten every 10 seconds for five minutes, and another note saved once in between
    for (let t = 0; t < 300000; t += 10000) {
      vi.setSystemTime(t);
      saves.add(['memory/sessions/today.md']);
      if (t === 90000) saves.add(['projects/atlas.md']);
      vi.advanceTimersByTime(10000 - (Date.now() - t));
    }
    vi.advanceTimersByTime(2 * SAVE_GAP_MS);
    for (let i = 1; i < runs.length; i++) expect(runs[i].at - runs[i - 1].at).toBeGreaterThanOrEqual(SAVE_GAP_MS);
    expect(runs.length).toBeGreaterThanOrEqual(5);
    expect(runs.length).toBeLessThanOrEqual(7);
    expect(runs.filter((r) => r.only.includes('projects/atlas.md'))).toHaveLength(1);
    expect(runs.every((r) => r.only.includes('memory/sessions/today.md'))).toBe(true);
    // the last save at 290 s is in the last sweep
    expect(runs.at(-1).at).toBeGreaterThanOrEqual(290000 + SAVE_DELAY_MS);
    expect(saves.pending()).toBe(0);
  });

  it('keeps the minute per vault and drops the waiting saves on clear', () => {
    let vault = '/one';
    const { saves, runs } = make({ key: () => vault });
    saves.add(['a.md']);
    vi.advanceTimersByTime(SAVE_DELAY_MS);
    expect(runs).toHaveLength(1);
    vault = '/two';
    saves.add(['b.md']);
    vi.advanceTimersByTime(SAVE_DELAY_MS);
    expect(runs).toHaveLength(2);
    saves.add(['c.md']);
    saves.clear();
    vi.advanceTimersByTime(2 * SAVE_GAP_MS);
    expect(runs).toHaveLength(2);
  });

  it('waits while held and sweeps once the hold ends', () => {
    let held = true;
    const { saves, runs } = make({ hold: () => held });
    saves.add(['a.md']);
    vi.advanceTimersByTime(5 * SAVE_GAP_MS);
    expect(runs).toHaveLength(0);
    held = false;
    vi.advanceTimersByTime(SAVE_DELAY_MS);
    expect(runs.map((r) => r.only)).toEqual([['a.md']]);
  });

  it('hands over the saves that wait when the vault closes, and keeps them per vault until it opens again', () => {
    const { saves, runs } = make({ key: () => '/one' });
    saves.add(['a.md']);
    vi.advanceTimersByTime(SAVE_DELAY_MS);
    saves.add(['b.md', 'c.md']);
    const dir = mkdtempSync(path.join(tmpdir(), 'saves-kept-'));
    const kept = savesKept(path.join(dir, 'waiting.json'));
    kept.keep('/one', saves.take());
    kept.keep('/two', ['x.md']);
    kept.keep('/one', ['c.md', 'd.md']);
    vi.advanceTimersByTime(2 * SAVE_GAP_MS);
    expect(runs).toHaveLength(1);
    expect(saves.pending()).toBe(0);
    const again = savesKept(path.join(dir, 'waiting.json'));
    expect(again.take('/one')).toEqual(['b.md', 'c.md', 'd.md']);
    expect(again.take('/one')).toEqual([]);
    expect(again.take('/two')).toEqual(['x.md']);
    expect(readdirSync(dir)).toEqual(['waiting.json']);
  });
});
