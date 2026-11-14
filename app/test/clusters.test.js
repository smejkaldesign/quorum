import { describe, expect, it } from 'vitest';
import { clusterAssign, clusterColors, clusterLabels, clusterNames, folderLabel, groupInfo, groupLabel, HUB, HUB_CLUSTER, PALETTE, sharedFolder, wrapperFolders } from '../clusters.js';

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
    expect(names).toEqual(['Work', 'Work', 'Work', 'y', 'y', 'y', 'Hubs']);
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

describe('cluster names, harder cases', () => {
  it('keeps two clusters in one folder apart by their most linked note', () => {
    const rest = ['p.md', 'q.md', 'r.md', 's.md', 't.md', 'u.md', 'v.md'];
    const names = clusterNames(['work/a.md', 'work/b.md', 'work/c.md', 'work/x.md', 'work/y.md', 'work/z.md', ...rest], [0, 0, 0, 1, 1, 1, ...rest.map(() => -1)], [3, 1, 1, 1, 4, 1, ...rest.map(() => 0)]);
    expect(names.slice(0, 6)).toEqual(['Work · a', 'Work · a', 'Work · a', 'Work · y', 'Work · y', 'Work · y']);
  });
  it('reads a regex group by its literal start only', () => {
    expect(groupLabel('path:/^01-daily\\/\\d{4}/')).toBe('01-daily');
    expect(groupLabel('path:/notes.*/')).toBe('notes');
    expect(groupLabel('path:/^MyBrain\\/05-knowledge\\/proj.*/')).toBe('05-knowledge');
    expect(groupLabel('path:/(work|personal)\\//')).toBe('(work|personal)/');
  });
});

describe('cluster names in plain words', () => {
  it('reads a folder the way a person would say it', () => {
    expect(folderLabel('01-daily')).toBe('Daily');
    expect(folderLabel('00-inbox')).toBe('Inbox');
    expect(folderLabel('MyBrain/04-projects')).toBe('Projects');
    expect(folderLabel('auto-memory')).toBe('Auto memory');
    expect(folderLabel('02_personal_notes')).toBe('Personal notes');
    expect(folderLabel('2026')).toBe('2026');
    expect(folderLabel('work')).toBe('Work');
  });
  it('keeps digits that belong to the name', () => {
    expect(folderLabel('3d-printing')).toBe('3d printing');
    expect(folderLabel('2fa')).toBe('2fa');
    expect(folderLabel('1password')).toBe('1password');
    expect(folderLabel('2026-11')).toBe('2026-11');
    expect(folderLabel('01.daily')).toBe('01.daily');
  });
  it('does not name a cluster after a folder that wraps most of the vault', () => {
    const rels = ['MyBrain/01-daily/a.md', 'MyBrain/04-projects/b.md', 'MyBrain/00-inbox/c.md', 'MyBrain/x.md'];
    const wrapper = wrapperFolders(rels);
    expect(wrapper('MyBrain')).toBe(true);
    expect(sharedFolder(rels, 0.6, wrapper)).toBe('');
    const labels = clusterLabels(rels, [0, 0, 0, -1], [1, 3, 1, 0]);
    expect(labels[0]).toEqual({ key: 'note:MyBrain/04-projects/b.md', name: 'b', folder: '' });
  });
  it('keys a folder cluster by its folder even when the name is shared, and applies a rename before telling names apart', () => {
    const rest = ['p.md', 'q.md', 'r.md', 's.md', 't.md', 'u.md', 'v.md'];
    const rels = ['work/a.md', 'work/b.md', 'work/c.md', 'home/x.md', 'home/y.md', 'home/z.md', ...rest];
    const cl = [0, 0, 0, 1, 1, 1, ...rest.map(() => -1)];
    const deg = [3, 1, 1, 1, 4, 1, ...rest.map(() => 0)];
    const labels = clusterLabels(rels, cl, deg, undefined, { 'folder:work': 'Notes', 'folder:home': 'Notes', 'folder:gone': 'Old' });
    expect(labels[0]).toEqual({ key: 'folder:work', name: 'Notes · a', folder: 'work' });
    expect(labels[3]).toEqual({ key: 'folder:home', name: 'Notes · y', folder: 'home' });
    expect(clusterNames(rels, cl, deg, undefined, { 'folder:work': 'Desk' })[0]).toBe('Desk');
  });
  it('finds the deepest folder most notes share, counting subfolders', () => {
    expect(sharedFolder(['04-projects/a/x.md', '04-projects/b/y.md', '04-projects/c.md'])).toBe('04-projects');
    expect(sharedFolder(['01-daily/a.md', '01-daily/b.md', '01-daily/c.md', '00-inbox/d.md'])).toBe('01-daily');
    expect(sharedFolder(['a.md', 'b.md', 'work/c.md'])).toBe('');
  });
  it('names a daily cluster Daily, with the folder it stands for and a key a rename can keep', () => {
    const rels = ['MyBrain/01-daily/2026-11-01.md', 'MyBrain/01-daily/2026-11-02.md', 'MyBrain/01-daily/2026-11-03.md', 'MyBrain/00-inbox/a.md', 'MyBrain/00-inbox/b.md', 'MyBrain/00-inbox/c.md'];
    const labels = clusterLabels(rels, [0, 0, 0, 1, 1, 1], [2, 2, 2, 2, 2, 2]);
    expect(labels[0]).toEqual({ key: 'folder:MyBrain/01-daily', name: 'Daily', folder: 'MyBrain/01-daily' });
    expect(labels[3]).toEqual({ key: 'folder:MyBrain/00-inbox', name: 'Inbox', folder: 'MyBrain/00-inbox' });
  });
  it('keys a cluster by its most linked note when the folder name is shared or missing', () => {
    const labels = clusterLabels(['work/a.md', 'work/b.md', 'work/c.md', 'work/x.md', 'work/y.md', 'work/z.md', 'p.md', 'q.md', 'r.md'], [0, 0, 0, 1, 1, 1, 2, 2, 2], [3, 1, 1, 1, 4, 1, 1, 5, 1]);
    expect(labels[0].key).toBe('note:work/a.md');
    expect(labels[3].key).toBe('note:work/y.md');
    expect(labels[6]).toEqual({ key: 'note:q.md', name: 'q', folder: '' });
  });
  it('names an Obsidian group by the folder its notes share, else by its query in plain words', () => {
    expect(groupInfo('path:/^01-/', ['01-daily/a.md', '01-daily/b.md'])).toEqual({ key: 'group:path:/^01-/', name: 'Daily', folder: '01-daily' });
    expect(groupInfo('path:"04-projects"', [])).toEqual({ key: 'group:path:"04-projects"', name: 'Projects', folder: '' });
    expect(groupInfo('path:"01-daily/2026-11-01.md"', []).name).toBe('2026-11-01');
    expect(groupInfo('path:/notes-2.*/', []).name).toBe('notes-2');
    expect(groupInfo('path:/(work|personal)\\//', []).name).toBe('(work|personal)/');
    expect(groupInfo('path:"04-projects"', [], undefined, { 'group:path:"04-projects"': 'Builds' }).name).toBe('Builds');
  });
});
