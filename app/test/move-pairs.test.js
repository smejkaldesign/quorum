// movePairs.js and the watcher's move detection (vindex.js movesIn, relink.js relinkMoved): a note moved outside the
// app keeps its links, and anything that is not one clear move rewrites nothing
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pairMoves } from '../movePairs.js';
import { createVaultIndex } from '../vindex.js';
import { relinkMoved } from '../relink.js';

const note = (rel, text) => ({ rel, text, size: Buffer.byteLength(text) });

describe('pairMoves', () => {
  it('pairs one removed note with one added note of the same text', () => {
    expect(pairMoves([note('a.md', '# A\n')], [note('x/a.md', '# A\n')])).toEqual([{ from: 'a.md', to: 'x/a.md' }]);
  });

  it('pairs several moves in one burst when each text is unique', () => {
    const gone = [note('a.md', '# A\n'), note('b.md', '# B\n')];
    const added = [note('x/b.md', '# B\n'), note('x/a.md', '# A\n')];
    expect(pairMoves(gone, added)).toEqual([{ from: 'a.md', to: 'x/a.md' }, { from: 'b.md', to: 'x/b.md' }]);
  });

  it('pairs nothing when two removed or two added notes share the text', () => {
    expect(pairMoves([note('a.md', 'same'), note('b.md', 'same')], [note('x/a.md', 'same')])).toEqual([]);
    expect(pairMoves([note('a.md', 'same')], [note('x/a.md', 'same'), note('y/a.md', 'same')])).toEqual([]);
  });

  it('keeps the clear pairs when another text in the burst is ambiguous', () => {
    const gone = [note('a.md', 'same'), note('b.md', 'same'), note('c.md', '# C\n')];
    const added = [note('x/a.md', 'same'), note('x/b.md', 'same'), note('x/c.md', '# C\n')];
    expect(pairMoves(gone, added)).toEqual([{ from: 'c.md', to: 'x/c.md' }]);
  });

  it('pairs nothing for a delete alone, an add alone, or an edit on the way', () => {
    expect(pairMoves([note('a.md', '# A\n')], [])).toEqual([]);
    expect(pairMoves([], [note('a.md', '# A\n')])).toEqual([]);
    expect(pairMoves([note('a.md', '# A\n')], [note('x/a.md', '# A edited\n')])).toEqual([]);
  });

  it('needs the same size as well as the same text', () => {
    expect(pairMoves([{ rel: 'a.md', text: '# A\n', size: 4 }], [{ rel: 'x/a.md', text: '# A\n', size: 9 }])).toEqual([]);
  });

  it('skips blank notes and non-markdown files', () => {
    expect(pairMoves([note('a.md', '  \n')], [note('x/a.md', '  \n')])).toEqual([]);
    expect(pairMoves([note('a.txt', 'hello')], [note('x/a.txt', 'hello')])).toEqual([]);
    expect(pairMoves([note('a.md', 'hello')], [note('x/a.png', 'hello')])).toEqual([]);
  });
});

let vault;
const write = (rel, text) => { const abs = path.join(vault, rel); mkdirSync(path.dirname(abs), { recursive: true }); writeFileSync(abs, text); utimesSync(abs, new Date(), new Date(Date.now() + 1000)); };
const read = (rel) => readFileSync(path.join(vault, rel), 'utf8');
const move = (from, to) => { mkdirSync(path.dirname(path.join(vault, to)), { recursive: true }); renameSync(path.join(vault, from), path.join(vault, to)); };
const open = (opts = {}) => {
  const index = createVaultIndex({ vault, isExcludedPath: () => false, isExcludedText: () => false, redact: (t) => t, onChange: () => {}, ...opts });
  index.sync();
  return index;
};
const fresh = () => { vault = mkdtempSync(path.join(tmpdir(), 'moves-')); };
afterEach(() => { if (vault) rmSync(vault, { recursive: true, force: true }); vault = null; });

describe('movesIn', () => {
  it('finds a note moved between folders and the links follow it', () => {
    fresh();
    write('notes/plan.md', '# Plan\n');
    write('notes/other/plan.md', '# Another plan\n');
    write('a.md', 'see [[notes/plan]] and [doc](notes/plan.md)\n');
    const index = open();
    move('notes/plan.md', 'archive/plan.md');
    const moves = index.movesIn(['notes/plan.md', 'archive/plan.md']);
    expect(moves).toEqual([{ from: 'notes/plan.md', to: 'archive/plan.md' }]);
    expect(relinkMoved({ vault, index, moves })).toEqual({ files: 1, links: 2 });
    expect(read('a.md')).toBe('see [[archive/plan]] and [doc](archive/plan.md)\n');
    index.syncPaths(['notes/plan.md', 'archive/plan.md', 'a.md']);
    expect([...new Set(index.backlinks('archive/plan.md').map((b) => b.rel))]).toEqual(['a.md']);
  });

  it('finds the notes of a folder moved as a whole', () => {
    fresh();
    write('proj/spec.md', '# Spec\n');
    write('index.md', '[[proj/spec]]\n');
    const index = open();
    move('proj', 'done/proj');
    const moves = index.movesIn(['proj', 'done/proj']);
    expect(moves).toEqual([{ from: 'proj/spec.md', to: 'done/proj/spec.md' }]);
    relinkMoved({ vault, index, moves });
    expect(read('index.md')).toBe('[[spec]]\n');
  });

  it('looks at the whole vault when the watcher could not name paths', () => {
    fresh();
    write('a.md', '# A unique\n');
    const index = open();
    move('a.md', 'b/a.md');
    expect(index.movesIn(null)).toEqual([{ from: 'a.md', to: 'b/a.md' }]);
  });

  it('reports nothing for a delete, a note moved out of the vault, or a note moved in', () => {
    fresh();
    write('a.md', '# A\n');
    write('b.md', '# B\n');
    const index = open();
    unlinkSync(path.join(vault, 'a.md'));
    expect(index.movesIn(['a.md'])).toEqual([]);
    const outside = mkdtempSync(path.join(tmpdir(), 'moves-out-'));
    try {
      renameSync(path.join(vault, 'b.md'), path.join(outside, 'b.md'));
      expect(index.movesIn(['b.md'])).toEqual([]);
      writeFileSync(path.join(outside, 'c.md'), '# C\n');
      renameSync(path.join(outside, 'c.md'), path.join(vault, 'c.md'));
      expect(index.movesIn(['c.md'])).toEqual([]);
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });

  it('reports nothing when two identical notes move in one burst', () => {
    fresh();
    write('a.md', 'same text\n');
    write('b.md', 'same text\n');
    write('i.md', '[[a]] [[b]]\n');
    const index = open();
    move('a.md', 'x/a.md');
    move('b.md', 'x/b.md');
    expect(index.movesIn(['a.md', 'b.md', 'x/a.md', 'x/b.md'])).toEqual([]);
    expect(read('i.md')).toBe('[[a]] [[b]]\n');
  });

  it('ignores non-markdown files and paths the index excludes', () => {
    fresh();
    write('a.md', '# A\n');
    write('pic.png', 'png');
    const index = open({ isExcludedPath: (rel) => rel.startsWith('private/') });
    move('pic.png', 'x/pic.png');
    expect(index.movesIn(['pic.png', 'x/pic.png'])).toEqual([]);
    move('a.md', 'private/a.md');
    expect(index.movesIn(['a.md', 'private/a.md'])).toEqual([]);
  });

  it('never pairs an in-app move, which syncs the index before the watcher hears of it', () => {
    fresh();
    write('a.md', '# A\n');
    write('i.md', '[[a]]\n');
    const index = open();
    move('a.md', 'x/a.md');
    index.sync();
    expect(index.movesIn(['a.md', 'x/a.md'])).toEqual([]);
  });
});

describe('the watcher', () => {
  const until = async (test, ms = 4000) => { const end = Date.now() + ms; while (!test() && Date.now() < end) await new Promise((r) => setTimeout(r, 50)); return test(); };

  it('reports a move made outside the app, and only the watcher turns detection on', async () => {
    fresh();
    write('a.md', '# A watched\n');
    write('i.md', '[[a]]\n');
    const heard = [];
    const index = createVaultIndex({ vault, isExcludedPath: () => false, isExcludedText: () => false, redact: (t) => t, onChange: () => {}, onMoves: (m) => heard.push(...m) });
    await index.start();
    try {
      await new Promise((r) => setTimeout(r, 100));
      move('a.md', 'x/a.md');
      expect(await until(() => heard.length > 0)).toBe(true);
      expect(heard).toEqual([{ from: 'a.md', to: 'x/a.md' }]);
      // the move went through the watcher; a manual sync afterwards reports nothing more
      index.sync();
      expect(heard.length).toBe(1);
    } finally { index.stop(); }
  });

  it('stays quiet for an in-app move', async () => {
    fresh();
    write('a.md', '# A in app\n');
    const heard = [];
    const index = createVaultIndex({ vault, isExcludedPath: () => false, isExcludedText: () => false, redact: (t) => t, onChange: () => {}, onMoves: (m) => heard.push(...m) });
    await index.start();
    try {
      await new Promise((r) => setTimeout(r, 100));
      // relocate in main.js: the move and the index sync run in one turn, before any watcher callback
      move('a.md', 'x/a.md');
      index.sync();
      await new Promise((r) => setTimeout(r, 800));
      expect(heard).toEqual([]);
    } finally { index.stop(); }
  });
});
