import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { changedSince, createFixJournal, fixCheck, hashNotes, recoveryReason, rollback } from '../fixJournal.js';
import { sha } from '../fixUndo.js';
import { createVaultIndex } from '../vindex.js';

let vault;
const put = (rel, t) => { mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true }); writeFileSync(path.join(vault, rel), t); };
const get = (rel) => readFileSync(path.join(vault, rel), 'utf8');
const trash = async (abs) => rmSync(abs);
afterEach(() => { if (vault) rmSync(vault, { recursive: true, force: true }); vault = null; });
const fresh = () => { vault = mkdtempSync(path.join(tmpdir(), 'qjournal-')); };

describe('run journal', () => {
  it('appends one line per step and reads them back in order', () => {
    fresh();
    const j = createFixJournal(path.join(vault, 'journal'));
    j.append('fix:orbit:1', { step: 'queued', hashes: { 'a.md': 'x' } });
    j.append('fix:orbit:1', { step: 'keep', rel: 'a.md' });
    expect(j.read('fix:orbit:1').map((e) => e.step)).toEqual(['queued', 'keep']);
    expect(j.read('fix:other:2')).toEqual([]);
    j.remove('fix:orbit:1');
    expect(existsSync(j.file('fix:orbit:1'))).toBe(false);
  });
});

describe('notes changed since the issue was found', () => {
  it('lists the notes whose text changed or that are gone', () => {
    fresh();
    put('a.md', 'see [[orbit]]');
    put('b.md', 'also [[orbit]]');
    const h = hashNotes(vault, ['a.md', 'b.md', 'c.md']);
    expect(h['c.md']).toBeNull();
    expect(changedSince(vault, h)).toEqual([]);
    put('a.md', 'see [[orbit]] and an edit');
    rmSync(path.join(vault, 'b.md'));
    expect(changedSince(vault, h)).toEqual(['a.md', 'b.md']);
  });
});

describe('the re-check after a fix', () => {
  const sets = (o) => new Map(Object.entries(o).map(([k, v]) => [k, new Set(v)]));
  it('passes a fix that removed the broken link and added none', () => {
    expect(fixCheck({ before: sets({ 'a.md': ['orbit'] }), after: sets({ 'a.md': [] }), target: 'orbit' })).toBeNull();
  });
  it('fails a fix that left a new broken link', () => {
    expect(fixCheck({ before: sets({ 'a.md': ['orbit'] }), after: sets({ 'a.md': ['orbit-tracker'] }), target: 'orbit' })).toBe('The fix left a new broken link to “orbit-tracker” in a.md');
  });
  it('fails a fix whose target is gone or whose links still open nothing', () => {
    expect(fixCheck({ before: sets({}), after: sets({}), targetGone: true })).toMatch(/not in the vault/);
    expect(fixCheck({ before: sets({ 'a.md': ['orbit'] }), after: sets({ 'a.md': ['orbit'] }), stillMissing: true, target: 'orbit' })).toBe('The links to “orbit” still open nothing after the fix');
  });
  it('catches a write that breaks a link, read from the vault index', async () => {
    fresh();
    put('notes/a.md', 'see [[orbit]] and [[plan]]');
    put('notes/plan.md', '# Plan');
    const idx = createVaultIndex({ vault, isExcludedPath: () => false, isExcludedText: () => false, redact: (t) => t, onChange: () => {} });
    idx.sync();
    await idx.refreshPaths();
    const missing = () => new Map([['notes/a.md', new Set(idx.missingIn('notes/a.md').map((l) => l.target.toLowerCase()))]]);
    const before = missing();
    put('notes/a.md', 'see [[orbit-notes]] and [[plan-old]]');
    idx.sync();
    expect(fixCheck({ before, after: missing(), target: 'orbit' })).toBe('The fix left a new broken link to “orbit-notes” in notes/a.md');
  });
});

describe('rollback and recovery', () => {
  it('puts back changed notes and removes a note the run made', async () => {
    fresh();
    put('a.md', 'fixed text');
    put('p/orbit.md', '# Orbit');
    const res = await rollback(vault, [{ rel: 'a.md', before: 'see [[orbit]]', after: null }, { rel: 'p/orbit.md', before: null, after: null }], trash);
    expect(res).toEqual({ restored: ['a.md', 'p/orbit.md'], skipped: [] });
    expect(get('a.md')).toBe('see [[orbit]]');
    expect(existsSync(path.join(vault, 'p/orbit.md'))).toBe(false);
  });
  it('leaves a note alone when it changed after the fix wrote it', async () => {
    fresh();
    put('a.md', 'edited by hand later');
    const res = await rollback(vault, [{ rel: 'a.md', before: 'one', after: sha('what the fix wrote') }], trash);
    expect(res).toEqual({ restored: [], skipped: ['a.md'] });
    expect(get('a.md')).toBe('edited by hand later');
  });
  it('leaves a note deleted after the fix deleted and still puts the others back', async () => {
    fresh();
    put('b.md', 'what the fix wrote');
    const res = await rollback(vault, [{ rel: 'a.md', before: 'one', after: null }, { rel: 'b.md', before: 'two', after: null }], trash);
    expect(res).toEqual({ restored: ['b.md'], skipped: ['a.md'] });
    expect(existsSync(path.join(vault, 'a.md'))).toBe(false);
    expect(get('b.md')).toBe('two');
  });
  it('writes back a note the run removed or moved away', async () => {
    fresh();
    put('vault/moved.md', '# Moved');
    const res = await rollback(vault, [{ rel: 'loose/moved.md', before: '# Moved', after: null, gone: true }, { rel: 'vault/moved.md', before: null, after: null }], trash);
    expect(res).toEqual({ restored: ['loose/moved.md', 'vault/moved.md'], skipped: [] });
    expect(get('loose/moved.md')).toBe('# Moved');
    expect(existsSync(path.join(vault, 'vault/moved.md'))).toBe(false);
  });
  it('does nothing for a run that never wrote', async () => {
    fresh();
    put('a.md', 'one');
    expect(await rollback(vault, [{ rel: 'a.md', before: 'one', after: null }], trash)).toEqual({ restored: [], skipped: [] });
    expect(await rollback(vault, [], trash)).toEqual({ restored: [], skipped: [] });
  });
  it('says plainly what recovery did', () => {
    expect(recoveryReason({ restored: [], skipped: [] })).toBe('Quorum quit before this fix finished. It changed no notes. Approve it again to fix it.');
    expect(recoveryReason({ restored: ['a.md', 'b.md'], skipped: [] })).toBe('Quorum quit while this fix was writing, and put back the 2 notes it had changed. Approve it again to fix it.');
    expect(recoveryReason({ restored: ['a.md'], skipped: ['b.md'] })).toBe('Quorum quit while this fix was writing, and put back the note it had changed. “b.md” changed after the fix started, so Quorum left it as it is. Approve it again to fix it.');
  });
});
