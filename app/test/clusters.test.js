import { describe, expect, it } from 'vitest';
import { clusterColors, HUB, PALETTE } from '../clusters.js';

// two tight groups joined through one hub that links to every note, plus a ring of notes only the hub links to
function vault() {
  const ids = ['index.md'];
  const links = [];
  const group = (prefix, size, start) => { for (let i = 0; i < size; i++) ids.push(`${prefix}-${i}.md`); for (let i = 0; i < size; i++) for (let j = i + 1; j < size; j++) if (j - i <= 2) links.push([start + i, start + j]); };
  group('a', 8, 1);
  group('b', 7, 9);
  for (let i = 0; i < 40; i++) ids.push(`ring-${i}.md`);
  for (let i = 1; i < ids.length; i++) links.push([0, i]);
  return { ids, links };
}

describe('cluster colors', () => {
  it('gives each linked group one color, the hub its own, and leaves ring notes uncolored', () => {
    const { ids, links } = vault();
    const c = clusterColors(ids, links);
    const a = new Set(c.slice(1, 9)), b = new Set(c.slice(9, 16));
    expect(a.size).toBe(1);
    expect(b.size).toBe(1);
    expect([...a][0]).not.toBe([...b][0]);
    expect(PALETTE).toContain([...a][0]);
    expect(c[0]).toBe(HUB);
    expect(new Set(c.slice(16))).toEqual(new Set([null]));
  });

  it('keeps a cluster color when notes are added around it', () => {
    const before = clusterColors(vault().ids, vault().links)[1];
    let kept = 0;
    for (const name of ['plan', 'retro', 'budget', 'kickoff', 'launch', 'review', 'notes', 'ideas']) {
      const { ids, links } = vault();
      ids.push(`a-${name}.md`); links.push([1, ids.length - 1], [2, ids.length - 1]);
      if (clusterColors(ids, links)[1] === before) kept++;
    }
    expect(kept).toBeGreaterThanOrEqual(7);
  });

  it('skips ghost nodes and handles an empty graph', () => {
    expect(clusterColors([], [])).toEqual([]);
    const c = clusterColors(['x.md', 'y.md', '?ghost'], [[0, 1], [1, 2], [0, 2]], (i) => i === 2);
    expect(c[2]).toBeNull();
  });
});
