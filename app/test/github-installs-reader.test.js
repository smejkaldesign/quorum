import { describe, expect, it } from 'vitest';
import { createInstallsReader } from '../src/githubInstalls.ts';

const one = (repositories) => ({ installations: [{ id: 1, owner: 'smejster', selection: 'selected', repositories }], checkedAt: '2026-11-17T10:00:00Z' });
// a load the test answers by hand, counting the calls
const manual = () => {
  const pending = [];
  const load = () => new Promise((resolve) => pending.push(resolve));
  return { load, pending };
};

describe('GitHub installations reads on a connector page', () => {
  it('a focus and a return link at the same moment share one read', async () => {
    const m = manual();
    const r = createInstallsReader(m.load);
    const a = r.read();
    const b = r.read({ force: true });
    expect(m.pending).toHaveLength(1);
    m.pending[0](one(3));
    await Promise.all([a, b]);
    expect(r.get().installs.installations[0].repositories).toBe(3);
  });
  it('skips a focus read within 30 seconds of the last one; a return link still reads', async () => {
    let t = 0;
    const m = manual();
    const r = createInstallsReader(m.load, { now: () => t });
    const first = r.read(); m.pending[0](one(1)); await first;
    t = 10_000;
    await r.read();
    expect(m.pending).toHaveLength(1);
    const forced = r.read({ force: true }); m.pending[1](one(2)); await forced;
    expect(r.get().installs.installations[0].repositories).toBe(2);
    t = 50_000;
    r.read();
    expect(m.pending).toHaveLength(3);
  });
  it('a failed first read shows its error; a failed later read keeps the last answer quietly', async () => {
    let t = 0;
    const m = manual();
    const r = createInstallsReader(m.load, { now: () => t });
    const a = r.read(); m.pending[0]({ installations: [], checkedAt: null, stale: true, error: 'GitHub is limiting requests right now. Try again in a few minutes.' }); await a;
    expect(r.get()).toEqual({ installs: null, error: 'GitHub is limiting requests right now. Try again in a few minutes.' });
    t = 40_000;
    const b = r.read(); m.pending[1](one(4)); await b;
    t = 80_000;
    const c = r.read(); m.pending[2]({ ...one(4), stale: true, error: 'Quorum could not reach GitHub.' }); await c;
    expect(r.get().installs.installations[0].repositories).toBe(4);
  });
  it('a bridge failure becomes the error and tells subscribers', async () => {
    const seen = [];
    const r = createInstallsReader(() => Promise.reject(new Error('Refused')));
    r.subscribe((v) => seen.push(v));
    await r.read();
    expect(seen).toEqual([{ installs: null, error: 'Refused' }]);
  });
});
