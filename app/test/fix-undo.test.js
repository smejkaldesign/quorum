import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyUndo, sha, undoRecord } from '../fixUndo.js';

let vault;
const put = (rel, t) => { mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true }); writeFileSync(path.join(vault, rel), t); };
const get = (rel) => readFileSync(path.join(vault, rel), 'utf8');
afterEach(() => { if (vault) rmSync(vault, { recursive: true, force: true }); });

describe('fix undo', () => {
  it('puts changed notes back and trashes the note the fix wrote', async () => {
    vault = mkdtempSync(path.join(tmpdir(), 'qundo-'));
    put('p/a.md', 'see [[Roadmap]]');
    const kept = [{ rel: 'p/a.md', before: get('p/a.md') }, { rel: 'p/Roadmap.md', before: null }];
    put('p/a.md', 'see [[Plan]]');
    put('p/Roadmap.md', '# Roadmap');
    const files = undoRecord(vault, kept);
    const trashed = [];
    expect(await applyUndo(vault, files, async (abs) => { trashed.push(path.relative(vault, abs)); rmSync(abs); })).toBe(2);
    expect(get('p/a.md')).toBe('see [[Roadmap]]');
    expect(trashed).toEqual(['p/Roadmap.md']);
    expect(existsSync(path.join(vault, 'p/Roadmap.md'))).toBe(false);
  });
  it('refuses when a note changed after the fix, and changes nothing', async () => {
    vault = mkdtempSync(path.join(tmpdir(), 'qundo-'));
    put('a.md', 'one');
    const kept = [{ rel: 'a.md', before: 'one' }, { rel: 'b.md', before: 'two' }];
    put('a.md', 'fixed a');
    put('b.md', 'fixed b');
    const files = undoRecord(vault, kept);
    put('b.md', 'edited later');
    await expect(applyUndo(vault, files, async () => {})).rejects.toThrow('changed after the fix');
    expect(get('a.md')).toBe('fixed a');
  });
  it('refuses a record that points outside the vault, and writes nothing there', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'qundo-root-'));
    vault = path.join(root, 'vault');
    mkdirSync(vault);
    writeFileSync(path.join(root, 'outside.md'), 'mine');
    put('a.md', 'fixed a');
    const files = [{ rel: 'a.md', before: 'one', after: undoRecord(vault, [{ rel: 'a.md', before: 'one' }])[0].after }, { rel: '../outside.md', before: 'overwritten', after: sha('mine') }];
    expect(undoRecord(vault, [{ rel: '../outside.md', before: 'x' }])).toEqual([]);
    const trashed = [];
    await expect(applyUndo(vault, files, async (abs) => { trashed.push(abs); })).rejects.toThrow('changed after the fix');
    expect(readFileSync(path.join(root, 'outside.md'), 'utf8')).toBe('mine');
    expect(get('a.md')).toBe('fixed a');
    expect(trashed).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });
});
