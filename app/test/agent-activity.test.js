import { describe, expect, it } from 'vitest';
import { SHOW_AFTER_MS, createAgentActivity } from '../agentActivity.js';

// a fake clock: timers fire only when the test moves the time on
function clock() {
  let t = 1000;
  const timers = [];
  return {
    now: () => t,
    setTimer: (fn, ms) => { const x = { at: t + ms, fn, done: false }; timers.push(x); return x; },
    clearTimer: (x) => { x.done = true; },
    advance: (ms) => { t += ms; for (const x of timers) if (!x.done && x.at <= t) { x.done = true; x.fn(); } },
  };
}

describe('agent activity', () => {
  it('shows work only once it has run 30 seconds, and hides it when it ends', () => {
    const c = clock();
    const seen = [];
    const a = createAgentActivity({ ...c, emit: (s) => seen.push(s) });
    const w = a.start({ kind: 'check', label: 'Checking your memory' });
    expect(a.state()).toBeNull();
    c.advance(SHOW_AFTER_MS - 1);
    expect(a.state()).toBeNull();
    c.advance(1);
    expect(a.state()).toMatchObject({ kind: 'check', label: 'Checking your memory', startedAt: 1000, progress: null, cancellable: false, more: 0 });
    w.progress(1, 3, 'Checking each suggestion');
    expect(a.state()).toMatchObject({ label: 'Checking each suggestion', progress: { done: 1, total: 3 } });
    w.end();
    expect(a.state()).toBeNull();
    expect(seen.at(-1)).toBeNull();
    expect(seen).toHaveLength(3);
  });
  it('never shows quick work', () => {
    const c = clock();
    const seen = [];
    const a = createAgentActivity({ ...c, emit: (s) => seen.push(s) });
    a.start({ kind: 'sweep', label: 'x' }).end();
    c.advance(SHOW_AFTER_MS * 2);
    expect(seen).toEqual([]);
    expect(a.running()).toBe(0);
  });
  it('shows the oldest work and counts the rest', () => {
    const c = clock();
    const a = createAgentActivity(c);
    a.start({ kind: 'batch', label: 'Applying 12 fixes' });
    c.advance(1000);
    a.start({ kind: 'draft', label: 'Drafting' });
    c.advance(SHOW_AFTER_MS);
    expect(a.state()).toMatchObject({ kind: 'batch', more: 1 });
  });
  it('cancels once, only work that can stop, and calls its stop', () => {
    const c = clock();
    const a = createAgentActivity(c);
    let stopped = 0;
    const w = a.start({ kind: 'batch', label: 'Applying', cancellable: true, onCancel: () => { stopped++; } });
    const fixed = a.start({ kind: 'sweep', label: 'Sweeping' });
    c.advance(SHOW_AFTER_MS);
    expect(a.cancel(fixed.id)).toBe(false);
    expect(a.cancel(w.id)).toBe(true);
    expect(a.cancel(w.id)).toBe(false);
    expect(stopped).toBe(1);
    expect(w.cancelled).toBe(true);
    expect(a.state()).toMatchObject({ id: w.id, label: 'Stopping', cancellable: false });
  });
});
