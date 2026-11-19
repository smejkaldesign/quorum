import { describe, expect, it } from 'vitest';
import { CHUNK_MAX_TOKENS, MAX_RUN_TOKENS, runGroups } from '../decide/models.js';

const enc = (n) => ({ ids: Array.from({ length: n }, (_, i) => i) });

describe('embed runs', () => {
  it('keeps every run at or under the padded token limit, in order, with nothing dropped', () => {
    const encs = [10, 384, 20, 384, 384, 5, 300, 384, 384, 384, 384, 384, 384, 384, 384, 2].map(enc);
    const groups = runGroups(encs);
    for (const g of groups) expect(g.length * Math.max(...g.map((e) => e.ids.length))).toBeLessThanOrEqual(MAX_RUN_TOKENS);
    expect(groups.flat()).toEqual(encs);
  });
  it('keeps short chunks in one run', () => {
    expect(runGroups(Array.from({ length: 16 }, () => enc(40)))).toHaveLength(1);
  });
  it('caps chunks below the 512-token sequences that crashed the runtime', () => {
    expect(CHUNK_MAX_TOKENS).toBeLessThan(512);
  });
});
