import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { itemUndo } from '../batchItemUndo.js';

let vault;
const put = (rel, text) => { mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true }); writeFileSync(path.join(vault, rel), text); };
const get = (rel) => (existsSync(path.join(vault, rel)) ? readFileSync(path.join(vault, rel), 'utf8') : null);
const trash = async (abs) => rmSync(abs);

beforeEach(() => { vault = mkdtempSync(path.join(tmpdir(), 'quorum-item-undo-')); });
afterEach(() => rmSync(vault, { recursive: true, force: true }));

describe('itemUndo', () => {
  it('puts back one failed item and leaves the other items fixed', async () => {
    put('a.md', 'A [[old]]');
    put('b.md', 'B [[old]]');
    const kept = [];
    const keep = (rel) => kept.push(rel);
    const u = itemUndo(vault);
    u.track('one', keep)('a.md');
    put('a.md', 'A [[new]]');
    u.track('two', keep)('b.md');
    put('b.md', 'B [[wrong]]');
    expect(u.alone('two')).toBe(true);
    await u.restore('two', trash);
    expect(get('a.md')).toBe('A [[new]]');
    expect(get('b.md')).toBe('B [[old]]');
    expect(kept).toEqual(['a.md', 'b.md']);
  });
  it('saves the text from the first time an item touches a note, so a second write does not move the restore point', async () => {
    put('a.md', 'v1');
    const u = itemUndo(vault);
    const k = u.track('one', () => {});
    k('a.md');
    put('a.md', 'v2');
    k('a.md');
    put('a.md', 'v3');
    await u.restore('one', trash);
    expect(get('a.md')).toBe('v1');
  });
  it('trashes a note the item created', async () => {
    const u = itemUndo(vault);
    u.track('one', () => {})('new/stub.md', true);
    put('new/stub.md', 'stub');
    await u.restore('one', trash);
    expect(get('new/stub.md')).toBe(null);
  });
  it('is not alone when another item wrote one of its notes', () => {
    put('a.md', 'A');
    const u = itemUndo(vault);
    u.track('one', () => {})('a.md');
    u.track('two', () => {})('a.md');
    expect(u.alone('two')).toBe(false);
    expect(u.alone('one')).toBe(false);
    expect(u.rels('two')).toEqual(['a.md']);
  });
  it('frees the notes of an item it put back, so a later item that writes them alone can be put back too', async () => {
    put('a.md', 'A');
    const u = itemUndo(vault);
    u.track('one', () => {})('a.md');
    await u.restore('one', trash);
    u.track('two', () => {})('a.md');
    expect(u.alone('two')).toBe(true);
    expect(u.rels('one')).toEqual([]);
  });
});
