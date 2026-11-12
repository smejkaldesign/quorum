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
    rmSync(path.join(vault, 'topics'), { recursive: true });
    expect(index.syncPaths(['topics']).sort()).toEqual(['topics/t1.md', 'topics/t2.md']);
    expect(index.rels()).toEqual(['a.md']);
  });
});
