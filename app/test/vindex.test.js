// vindex.js: the watcher names paths, and syncPaths re-reads only those; a folder change still walks the vault
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createVaultIndex } from '../vindex.js';

let vault;
const write = (rel, text) => { const abs = path.join(vault, rel); mkdirSync(path.dirname(abs), { recursive: true }); writeFileSync(abs, text); utimesSync(abs, new Date(), new Date(Date.now() + 1000)); };
const open = (opts = {}) => {
  const index = createVaultIndex({ vault, isExcludedPath: () => false, isExcludedText: () => false, redact: (t) => t, onChange: () => {}, ...opts });
  index.sync();
  return index;
};

afterEach(() => { if (vault) rmSync(vault, { recursive: true, force: true }); vault = null; });

describe('start', () => {
  it('reads the vault in batches, yielding between them, and reports every note once', async () => {
    vault = mkdtempSync(path.join(tmpdir(), 'vindex-'));
    for (let i = 0; i < 450; i++) write(`n-${i}.md`, `# N${i}\n\n[[n-${(i + 1) % 450}]]\n`);
    const changes = [];
    let yields = 0;
    const index = createVaultIndex({ vault, isExcludedPath: () => false, isExcludedText: () => false, redact: (t) => t, onChange: (rels) => changes.push(rels) });
    // counts the event loop turns the build lets through: one per batch boundary
    let probing = true;
    const probe = () => { if (!probing) return; yields++; setImmediate(probe); };
    setImmediate(probe);
    await index.start();
    probing = false;
    index.stop();
    expect(index.size()).toBe(450);
    expect(changes.length).toBe(1);
    expect(changes[0].length).toBe(450);
    expect(index.backlinks('n-0.md').map((b) => b.rel)).toEqual(['n-449.md']);
    // 450 notes in batches of 200 give the event loop at least two turns
    expect(yields).toBeGreaterThanOrEqual(2);
  });
});

describe('syncPaths', () => {
  it('re-reads only the named file and relinks what points at it', () => {
    vault = mkdtempSync(path.join(tmpdir(), 'vindex-'));
    write('a.md', '# A\n\n[[b]]\n');
    write('b.md', '# B\n');
    write('c.md', '# C\n');
    const index = open();
    expect(index.backlinks('b.md').map((b) => b.rel)).toEqual(['a.md']);
    write('c.md', '# C\n\n[[b]] now\n');
    expect(index.syncPaths(['c.md'])).toEqual(['c.md']);
    expect(index.backlinks('b.md').map((b) => b.rel).sort()).toEqual(['a.md', 'c.md']);
    // an unchanged file named by a noisy watcher costs a stat and nothing else
    expect(index.syncPaths(['a.md'])).toEqual([]);
  });

  it('drops a removed file and skips dot folders, non-notes and excluded paths', () => {
    vault = mkdtempSync(path.join(tmpdir(), 'vindex-'));
    write('a.md', '# A\n');
    write('private/p.md', '# P\n');
    write('.sessions/t.json', '{}');
    write('notes.txt', 'plain');
    const index = open({ isExcludedPath: (rel) => rel.startsWith('private/') });
    expect(index.rels()).toEqual(['a.md']);
    rmSync(path.join(vault, 'a.md'));
    expect(index.syncPaths(['a.md', '.sessions/t.json', 'notes.txt', 'private/p.md'])).toEqual(['a.md']);
    expect(index.rels()).toEqual([]);
  });

  it('walks the whole vault when a folder appears or goes away', () => {
    vault = mkdtempSync(path.join(tmpdir(), 'vindex-'));
    write('a.md', '# A\n');
    const index = open();
    write('topics/t1.md', '# T1\n');
    write('topics/t2.md', '# T2\n');
    expect(index.syncPaths(['topics']).sort()).toEqual(['topics/t1.md', 'topics/t2.md']);
    // a note edited in the same burst as the folder move is still reported, once
    write('a.md', '# A edited\n');
    rmSync(path.join(vault, 'topics'), { recursive: true });
    expect(index.syncPaths(['a.md', 'topics']).sort()).toEqual(['a.md', 'topics/t1.md', 'topics/t2.md']);
    expect(index.rels()).toEqual(['a.md']);
    expect(index.note('a.md').title).toBe('A edited');
  });
});

describe('graph cluster names', () => {
  it('names a cluster by its folder in plain words and keeps a rename over the generated name', () => {
    vault = mkdtempSync(path.join(tmpdir(), 'vindex-'));
    const days = ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04'];
    days.forEach((d, i) => write(`01-daily/${d}.md`, `# ${d}\n\n[[${days[(i + 1) % days.length]}]]\n`));
    const node = (g) => g.nodes.find((n) => n.id === '01-daily/2026-11-01.md');
    let renamed = {};
    const index = open({ renamed: () => renamed });
    expect(node(index.graph())).toMatchObject({ cluster: 'Daily', clusterKey: 'folder:01-daily', clusterPath: '01-daily' });
    renamed = { 'folder:01-daily': 'Journal' };
    expect(node(index.graph()).cluster).toBe('Journal');
    index.sync();
    expect(node(index.graph()).cluster).toBe('Journal');
  });
});
