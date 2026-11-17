import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/Toasts', () => ({ toast: vi.fn() }));
const { toast } = await import('../src/Toasts');
const { toastWhenFixed, waitFix } = await import('../src/fixToast');

// a stand-in for the preload bridge: onFixRun listeners, and the read marks the toast sets
let listeners;
let marked;
const emit = (run) => { for (const f of [...listeners]) f(run); };
const run = (key, status, extra = {}) => ({ id: `fix:${key}`, key, target: key, status, items: undefined, ...extra });
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  listeners = new Set();
  marked = [];
  globalThis.window = {
    quorum: {
      onFixRun: (f) => { listeners.add(f); return () => listeners.delete(f); },
      activityMark: async (rows, unread) => { marked.push(...rows.map((r) => [r.id, unread])); return rows.length; },
    },
    dispatchEvent: () => true,
  };
  globalThis.Event = class { constructor(type) { this.type = type; } };
  toast.mockClear();
});
afterEach(() => { delete globalThis.window; });

describe('toastWhenFixed', () => {
  it('says nothing while the fix runs, and says Fixed once it succeeds', async () => {
    const done = waitFix('alpha');
    toastWhenFixed([{ key: 'alpha', target: 'Alpha', done }]);
    emit(run('alpha', 'running'));
    await settle();
    expect(toast).not.toHaveBeenCalled();
    emit(run('alpha', 'success'));
    await settle();
    expect(toast).toHaveBeenCalledWith('Fixed “Alpha”.');
    expect(marked).toEqual([]);
  });

  it('a failed fix toasts the reason, says the item is back in Needs review and marks it read', async () => {
    const done = waitFix('beta');
    toastWhenFixed([{ key: 'beta', target: 'Beta', done }]);
    emit(run('beta', 'error', { error: 'The note changed since the check.' }));
    await settle(); await settle();
    expect(toast).toHaveBeenCalledWith('Could not fix “Beta”: The note changed since the check. It is back in Needs review.', 'error');
    expect(marked).toEqual([['r:link:beta', false]]);
  });

  it('hears a link the agent fixes, which runs as a batch of one', async () => {
    const done = waitFix('Gamma');
    toastWhenFixed([{ key: 'Gamma', target: 'Gamma', done }]);
    emit({ id: 'batch:1', key: 'batch:1', kind: 'batch', status: 'success', items: [{ kind: 'link', key: 'gamma' }] });
    await settle();
    expect(toast).toHaveBeenCalledWith('Fixed “Gamma”.');
  });

  it('several: one toast once all end, counting the fixed and the failed', async () => {
    const a = waitFix('a'); const b = waitFix('b');
    toastWhenFixed([{ key: 'a', target: 'A', done: a }, { key: 'b', target: 'B', done: b }]);
    emit(run('a', 'success'));
    await settle();
    expect(toast).not.toHaveBeenCalled();
    emit(run('b', 'error', { error: 'You cancelled the batch' }));
    await settle(); await settle();
    expect(toast).toHaveBeenCalledWith('Fixed 1. Could not fix “B”: You cancelled the batch. It is back in Needs review.', 'error');
    expect(marked).toEqual([['r:link:b', false]]);
  });
});
