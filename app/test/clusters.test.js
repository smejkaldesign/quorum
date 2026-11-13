import { describe, expect, it } from 'vitest';
import { clusterAssign, clusterColors, clusterNames, groupLabel, HUB, HUB_CLUSTER, PALETTE } from '../clusters.js';

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

describe('cluster names', () => {
  it('names a cluster by the folder most of its notes share, else by its most linked note', () => {
    const rels = ['work/a.md', 'work/b.md', 'work/c.md', 'x.md', 'y.md', 'z.md', 'index.md'];
    const names = clusterNames(rels, [0, 0, 0, 1, 1, 1, HUB_CLUSTER], [2, 2, 2, 1, 4, 1, 40]);
    expect(names).toEqual(['work', 'work', 'work', 'y', 'y', 'y', 'Hubs']);
  });
  it('leaves a note with no cluster unnamed', () => {
    expect(clusterNames(['a.md'], [-1], [0])).toEqual([null]);
  });
  it('assigns the same clusters it colors', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const links = [[0, 1], [1, 2], [0, 2], [3, 4], [4, 5], [3, 5]];
    const { colors, cluster } = clusterAssign(ids, links);
    expect(colors).toEqual(clusterColors(ids, links));
    expect(new Set(cluster.slice(0, 3)).size).toBe(1);
    expect(cluster[0]).not.toBe(cluster[3]);
  });
  it('reads an Obsidian group query as the name it points at', () => {
    expect(groupLabel('path:"01-daily/today.md"')).toBe('today');
    expect(groupLabel('path:/^MyBrain\\/05-knowledge\\//')).toBe('05-knowledge');
    expect(groupLabel('path:/Projects/ OR path:"a.md"')).toBe('Projects');
    expect(groupLabel('')).toBe('Group');
  });
});
