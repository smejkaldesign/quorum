import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
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
    expect(u.blocked('two')).toBe(null);
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
    expect(u.blocked('two')).toMatch(/Another item in this batch changed the same note/);
    expect(u.blocked('one')).toMatch(/Another item/);
    expect(u.rels('two')).toEqual(['a.md']);
  });
  it('frees the notes of an item it put back, so a later item that writes them alone can be put back too', async () => {
    put('a.md', 'A');
    const u = itemUndo(vault);
    u.track('one', () => {})('a.md');
    await u.restore('one', trash);
    u.track('two', () => {})('a.md');
    expect(u.blocked('two')).toBe(null);
    expect(u.rels('one')).toEqual([]);
  });
  it('writes back a note the item trashed, at its path, with the real vault resolver', async () => {
    put('notes/old.md', 'old text');
    const u = itemUndo(vault);
    u.track('one', () => {})('notes/old.md', false, true);
    rmSync(path.join(vault, 'notes/old.md'));
    rmSync(path.join(vault, 'notes'), { recursive: true });
    u.seal('one');
    expect(await u.restore('one', trash)).toEqual({ restored: ['notes/old.md'], skipped: [] });
    expect(get('notes/old.md')).toBe('old text');
  });
  it('puts back a move: the note returns to its path and the moved copy goes to the Trash', async () => {
    put('a.md', 'A');
    const u = itemUndo(vault);
    const k = u.track('one', () => {});
    k('a.md', false, true);
    k('archive/a.md', true);
    put('archive/a.md', 'A');
    rmSync(path.join(vault, 'a.md'));
    u.seal('one');
    const r = await u.restore('one', trash);
    expect(r.restored.sort()).toEqual(['a.md', 'archive/a.md']);
    expect(get('a.md')).toBe('A');
    expect(get('archive/a.md')).toBe(null);
  });
  it('leaves a note alone when it changed after the item last wrote it', async () => {
    put('a.md', 'before');
    put('b.md', 'b before');
    const u = itemUndo(vault);
    const k = u.track('one', () => {});
    k('a.md');
    k('b.md');
    put('a.md', 'fixed');
    put('b.md', 'b fixed');
    u.seal('one');
    put('a.md', 'fixed, then a person typed here');
    expect(await u.restore('one', trash)).toEqual({ restored: ['b.md'], skipped: ['a.md'] });
    expect(get('a.md')).toBe('fixed, then a person typed here');
    expect(get('b.md')).toBe('b before');
  });
  it('blocks a put-back alone when a note could not be read, and never trashes it', async () => {
    mkdirSync(path.join(vault, 'odd.md'));
    const u = itemUndo(vault);
    u.track('one', () => {})('odd.md');
    expect(u.blocked('one')).toMatch(/could not read “odd\.md”/);
    await expect(u.restore('one', trash)).rejects.toThrow(/could not read/);
    expect(existsSync(path.join(vault, 'odd.md'))).toBe(true);
  });
  it('blocks a note outside the vault', () => {
    const u = itemUndo(vault);
    u.track('one', () => {})('../outside.md');
    expect(u.blocked('one')).toMatch(/could not read/);
  });
  it('writes with a temp file and rename, leaving no temp file behind', async () => {
    put('a.md', 'A');
    const u = itemUndo(vault);
    u.track('one', () => {})('a.md');
    put('a.md', 'B');
    u.seal('one');
    await u.restore('one', trash);
    expect(readdirSync(vault)).toEqual(['a.md']);
  });
});
