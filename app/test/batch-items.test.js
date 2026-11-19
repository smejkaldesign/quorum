// batchItems (batchItems.js) with the real itemUndo and vault resolver against a temp vault: one item failing alone,
// the final link check putting back the item it blames, the run's undo record after release, Undo of a batch that
// fixed some items, and how a whole-batch rollback labels its items
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { itemUndo } from '../batchItemUndo.js';
import { batchItems, rollBackItems } from '../batchItems.js';
import { applyUndo, undoRecord } from '../fixUndo.js';

let vault;
const put = (rel, text) => { mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true }); writeFileSync(path.join(vault, rel), text); };
const get = (rel) => (existsSync(path.join(vault, rel)) ? readFileSync(path.join(vault, rel), 'utf8') : null);
const trash = async (abs) => rmSync(abs);

// a run the way pumpFixes keeps one: kept is the run's undo record, release drops a put-back item's notes from it
function setup(ids) {
  const run = { items: ids.map((id) => ({ id, status: 'queued' })) };
  const kept = [];
  const journal = [];
  const putBacks = [];
  const keep = (rel, created = false, gone = false) => { if (kept.some((k) => k.rel === rel)) return; try { kept.push({ rel, before: created ? null : get(rel), ...(gone ? { gone: true } : {}) }); } catch {} };
  const release = (rels) => { for (const r of rels) { const at = kept.findIndex((k) => k.rel === r); if (at >= 0) kept.splice(at, 1); } };
  const mark = (id, status, why = null) => { const it = run.items.find((x) => x.id === id); it.status = status; if (why) it.error = why; };
  const items = ids.map((id) => ({ id }));
  const undo = itemUndo(vault);
  const batch = batchItems({ items, undo, mark, release, journal: (e) => journal.push(e), trash, onPutBack: (i) => putBacks.push(i.id) });
  return { run, kept, journal, putBacks, keep, undo, batch, item: (id) => run.items.find((x) => x.id === id) };
}

// one plan step: writes is a list of [rel, text | null (trash), 'create' | 'gone'?]
const op = (u, keep, writes) => async (item) => {
  const k = u.track(item.id, keep);
  for (const [rel, text, how] of writes) {
    k(rel, how === 'create', how === 'gone');
    if (text == null) rmSync(path.join(vault, rel)); else put(rel, text);
  }
};

beforeEach(() => { vault = mkdtempSync(path.join(tmpdir(), 'quorum-batch-items-')); });
afterEach(() => rmSync(vault, { recursive: true, force: true }));

describe('batchItems', () => {
  it('puts back an item that fails partway and keeps the other items fixed', async () => {
    put('a.md', 'A [[old]]');
    put('b.md', 'B [[old]]');
    put('c.md', 'C');
    const t = setup(['one', 'two']);
    const steps = {
      s1: op(t.undo, t.keep, [['a.md', 'A [[new]]']]),
      s2: op(t.undo, t.keep, [['b.md', 'B [[new]]'], ['c.md', null, 'gone']]),
      s3: async (item) => { t.undo.track(item.id, t.keep)('b.md'); put('b.md', 'B half'); throw new Error('The move target is taken'); },
    };
    await t.batch.runSteps([{ item: 'one', id: 's1' }, { item: 'two', id: 's2' }, { item: 'two', id: 's3' }], (item, s) => steps[s.id](item));
    expect(get('a.md')).toBe('A [[new]]');
    expect(get('b.md')).toBe('B [[old]]');
    expect(get('c.md')).toBe('C');
    expect(t.item('one').status).toBe('success');
    expect(t.item('two')).toMatchObject({ status: 'error', error: 'The move target is taken' });
    expect(t.batch.fixed().map((i) => i.id)).toEqual(['one']);
    expect(t.kept.map((k) => k.rel)).toEqual(['a.md']);
    expect(t.journal).toEqual([{ step: 'item-rolled-back', item: 'two', rels: ['b.md', 'c.md'], restored: ['b.md', 'c.md'], skipped: [], why: 'The move target is taken' }]);
    expect(t.putBacks).toEqual(['two']);
  });

  it('skips the later steps of an item it put back', async () => {
    put('a.md', 'A');
    const t = setup(['one']);
    let ran = 0;
    const runOne = async (item, s) => { ran++; if (s.id === 'x') throw new Error('no'); await op(t.undo, t.keep, [['a.md', 'A2']])(item); };
    await t.batch.runSteps([{ item: 'one', id: 'x' }, { item: 'one', id: 'y' }], runOne);
    expect(ran).toBe(1);
    expect(get('a.md')).toBe('A');
  });

  it('rethrows on cancel without putting the item back alone', async () => {
    put('a.md', 'A');
    const t = setup(['one']);
    const runOne = async (item) => { await op(t.undo, t.keep, [['a.md', 'A2']])(item); throw new Error('You cancelled the batch'); };
    await expect(t.batch.runSteps([{ item: 'one' }], runOne, () => true)).rejects.toThrow('You cancelled the batch');
    expect(t.journal).toEqual([]);
    expect(get('a.md')).toBe('A2');
  });

  it('puts back the item the final link check blames, then checks again', async () => {
    put('a.md', 'A');
    put('b.md', 'B');
    const t = setup(['one', 'two']);
    await t.batch.runSteps([{ item: 'one' }, { item: 'two' }], (item) => op(t.undo, t.keep, [[item.id === 'one' ? 'a.md' : 'b.md', item.id === 'one' ? 'A [[x]]' : 'B [[gone]]']])(item));
    const before = new Map([['a.md', new Set()], ['b.md', new Set()]]);
    // b.md links to a note that is not there; a.md links to x, which exists
    const missingNow = () => new Map([['a.md', new Set()], ['b.md', new Set(get('b.md').includes('[[gone]]') ? ['gone'] : [])]]);
    let passes = 0;
    await t.batch.blame(before, () => { passes++; return missingNow(); });
    expect(passes).toBe(2);
    expect(get('b.md')).toBe('B');
    expect(get('a.md')).toBe('A [[x]]');
    expect(t.item('two')).toMatchObject({ status: 'error', error: 'The fix left a new broken link to “gone” in b.md' });
    expect(t.batch.fixed().map((i) => i.id)).toEqual(['one']);
  });

  it('throws when the new broken link is in a note no item wrote', async () => {
    const t = setup(['one']);
    await expect(t.batch.blame(new Map(), () => new Map([['z.md', new Set(['q'])]]))).rejects.toThrow(/new broken link to “q” in z\.md/);
  });

  it('rolls back whole when two items wrote the blamed note, and labels the culprit failed, not put back', async () => {
    put('a.md', 'A');
    const t = setup(['one', 'two', 'three']);
    put('c.md', 'C');
    const writes = { one: [['a.md', 'A1']], two: [['a.md', 'A1 [[gone]]']], three: [['c.md', 'C2']] };
    await t.batch.runSteps([{ item: 'one' }, { item: 'two' }, { item: 'three' }], (item) => op(t.undo, t.keep, writes[item.id])(item));
    const missingNow = () => new Map([['a.md', new Set(get('a.md').includes('[[gone]]') ? ['gone'] : [])]]);
    await expect(t.batch.blame(new Map([['a.md', new Set()]]), missingNow)).rejects.toThrow('The fix left a new broken link to “gone” in a.md. Another item in this batch changed the same note, so Quorum put back the whole batch');
    // the culprit is marked failed with its reason before the throw, so pumpFixes' rollback does not count it as fixed
    expect(t.item('one')).toMatchObject({ status: 'error', error: 'The fix left a new broken link to “gone” in a.md' });
    rollBackItems(t.run.items);
    expect(t.item('one').rolledBack).toBeUndefined();
    expect(t.item('two')).toMatchObject({ status: 'error', rolledBack: true });
    expect(t.item('three')).toMatchObject({ status: 'error', rolledBack: true });
  });

  it('leaves Undo with only the fixed items: the run undo record after release restores those notes and no others', async () => {
    put('a.md', 'A');
    put('b.md', 'B');
    put('moved.md', 'M');
    const t = setup(['one', 'two']);
    const steps = {
      one: op(t.undo, t.keep, [['a.md', 'A fixed'], ['moved.md', null, 'gone'], ['archive/moved.md', 'M', 'create']]),
      two: async (item) => { await op(t.undo, t.keep, [['b.md', 'B broken']])(item); throw new Error('Two failed'); },
    };
    await t.batch.runSteps([{ item: 'one' }, { item: 'two' }], (item) => steps[item.id](item));
    put('b.md', 'B edited by a person after the batch');
    const record = undoRecord(vault, t.kept);
    expect(record.map((r) => r.rel).sort()).toEqual(['a.md', 'archive/moved.md', 'moved.md']);
    await applyUndo(vault, record, trash);
    expect(get('a.md')).toBe('A');
    expect(get('moved.md')).toBe('M');
    expect(get('archive/moved.md')).toBe(null);
    expect(get('b.md')).toBe('B edited by a person after the batch');
  });

  it('refuses to put back alone an item whose note could not be read, and the batch rolls back whole', async () => {
    mkdirSync(path.join(vault, 'odd.md'));
    const t = setup(['one']);
    const runOne = async (item) => { t.undo.track(item.id, t.keep)('odd.md'); throw new Error('Could not write odd.md'); };
    await expect(t.batch.runSteps([{ item: 'one' }], runOne)).rejects.toThrow(/Could not write odd\.md\. Quorum could not read “odd\.md” before this item changed it, so Quorum put back the whole batch/);
    expect(existsSync(path.join(vault, 'odd.md'))).toBe(true);
    expect(t.item('one')).toMatchObject({ status: 'error', error: 'Could not write odd.md' });
  });

  it('says which note it left alone when a person edited it after the item wrote it', async () => {
    put('a.md', 'A');
    const t = setup(['one']);
    await t.batch.runSteps([{ item: 'one' }], (item) => op(t.undo, t.keep, [['a.md', 'A [[gone]]']])(item));
    put('a.md', 'A [[gone]] and a person typed here');
    await t.batch.blame(new Map([['a.md', new Set()]]), (() => { let n = 0; return () => new Map([['a.md', new Set(n++ ? [] : ['gone'])]]); })());
    expect(get('a.md')).toBe('A [[gone]] and a person typed here');
    expect(t.item('one').error).toBe('The fix left a new broken link to “gone” in a.md. “a.md” changed after this item wrote it, so Quorum left it as it is');
  });
});
