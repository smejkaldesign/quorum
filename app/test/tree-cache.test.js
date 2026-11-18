// treeCache.js: the Memory tab's notes tree is walked again only when the watcher names something the tree does not hold
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SKIP, vaultTree } from '../vault.js';
import { createTreeCache } from '../treeCache.js';

let vault;
afterEach(() => { if (vault) rmSync(vault, { recursive: true, force: true }); vault = null; });
const put = (rel, text = '# x') => { const abs = path.join(vault, rel); mkdirSync(path.dirname(abs), { recursive: true }); writeFileSync(abs, text); };
const setup = () => {
  vault = mkdtempSync(path.join(tmpdir(), 'tree-cache-'));
  put('a.md');
  put('f/b.md');
  let walks = 0;
  const cache = createTreeCache({
    walk: (v) => { walks++; return vaultTree(v, () => false); },
    statOf: (v, rel) => { try { return statSync(path.join(v, rel)); } catch { return null; } },
    skip: (rel) => rel.split('/').some((s) => s.startsWith('.') || SKIP.has(s)),
  });
  return { cache, walks: () => walks };
};

describe('the notes tree cache', () => {
  it('walks once, and keeps the tree through edits of the notes it lists, with their new times', () => {
    const { cache, walks } = setup();
    cache.get(vault, true);
    const later = new Date(Date.now() + 60000);
    utimesSync(path.join(vault, 'f/b.md'), later, later);
    put('f/data.json', '{}');
    cache.paths(['f/b.md', 'f/data.json', '.obsidian/workspace.json']);
    const tree = cache.get(vault, true);
    expect(walks()).toBe(1);
    expect(tree.find((t) => t.path === 'f').children[0].mtime).toBe(statSync(path.join(vault, 'f/b.md')).mtimeMs);
  });
  it('walks again after a new note, a gone note, a new folder or an unnamed change', () => {
    const { cache, walks } = setup();
    cache.get(vault, true);
    put('c.md');
    cache.paths(['c.md']);
    expect(cache.get(vault, true).some((t) => t.path === 'c.md')).toBe(true);
    rmSync(path.join(vault, 'a.md'));
    cache.paths(['a.md']);
    expect(cache.get(vault, true).some((t) => t.path === 'a.md')).toBe(false);
    mkdirSync(path.join(vault, 'g'));
    cache.paths(['g']);
    expect(cache.get(vault, true).some((t) => t.path === 'g')).toBe(true);
    cache.paths(null);
    cache.get(vault, true);
    expect(walks()).toBe(5);
  });
  it('keeps nothing while the watcher is not running, and drops the tree on request', () => {
    const { cache, walks } = setup();
    cache.get(vault, false);
    cache.get(vault, false);
    expect(walks()).toBe(2);
    cache.get(vault, true);
    cache.drop();
    cache.get(vault, true);
    expect(walks()).toBe(4);
  });
});
