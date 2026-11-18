// feedCache.js: the Notifications rows are built once per change, whoever reads them
import { describe, expect, it } from 'vitest';
import { createFeedCache } from '../feedCache.js';

const counting = (opts = {}) => {
  let n = 0;
  const cache = createFeedCache({ build: async () => { n++; await new Promise((r) => setTimeout(r, 1)); return { rows: n }; }, ...opts });
  return { cache, builds: () => n };
};

describe('the feed cache', () => {
  it('builds once for readers that ask together and for readers that ask later', async () => {
    const { cache, builds } = counting();
    const [a, b] = await Promise.all([cache.get(), cache.get()]);
    expect(a).toBe(b);
    expect(await cache.get()).toBe(a);
    expect(builds()).toBe(1);
  });
  it('builds again after a change, and does not keep a build a change overtook', async () => {
    const { cache, builds } = counting();
    const first = cache.get();
    cache.touch();
    expect(await first).toEqual({ rows: 1 });
    expect(await cache.get()).toEqual({ rows: 2 });
    expect(await cache.get()).toEqual({ rows: 2 });
    expect(builds()).toBe(2);
  });
  it('builds again when the key moves or the rows are older than maxAge', async () => {
    let k = 'a';
    let t = 0;
    const { cache, builds } = counting({ key: () => k, now: () => t, maxAge: 100 });
    await cache.get();
    k = 'b';
    await cache.get();
    t = 50;
    await cache.get();
    t = 200;
    await cache.get();
    expect(builds()).toBe(3);
  });
  it('keeps a derived value with its rows, and works it out again after a change', async () => {
    const { cache } = counting();
    let runs = 0;
    const counts = () => cache.derived('counts', (rows) => { runs++; return { n: rows.rows }; });
    expect(await counts()).toEqual({ n: 1 });
    await counts();
    expect(runs).toBe(1);
    cache.touch();
    expect(await counts()).toEqual({ n: 2 });
    expect(runs).toBe(2);
  });
  it('does not keep a failed build', async () => {
    let fail = true;
    const cache = createFeedCache({ build: async () => { if (fail) throw new Error('no'); return 'ok'; } });
    await expect(cache.get()).rejects.toThrow('no');
    fail = false;
    expect(await cache.get()).toBe('ok');
  });
  it('builds three times for one save that sends three change events to four readers each', async () => {
    const { cache, builds } = counting();
    // the vault change, the save sweep and the gate run, each read by the bell, the Memory tab counts, Memory health
    // and Notifications (the reads before this cache: 12 full builds)
    for (let event = 0; event < 3; event++) {
      cache.touch();
      await Promise.all([cache.get(), cache.derived('counts', (r) => r), cache.get(), cache.get()]);
    }
    expect(builds()).toBe(3);
  });
});
