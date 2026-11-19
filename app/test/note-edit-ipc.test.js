// The editor's main-process handlers on a real vault folder (vaultEdit.js), and the renderer's save and reload rules
// (editSession.ts) against a fake main
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashText } from '../handnote.js';
import { listBookmarks, moveBookmarks, openEdit, openToday, saveEdit, toggleBookmark } from '../vaultEdit.js';
import { createEditSession, SAVE_AFTER } from '../src/editor/editSession.ts';

const never = () => false;

describe('vault-note-edit and vault-note-save', () => {
  let vault;
  const put = (rel, data) => { mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true }); writeFileSync(path.join(vault, rel), data); };
  const bytes = (rel) => readFileSync(path.join(vault, rel));
  beforeEach(() => { vault = mkdtempSync(path.join(tmpdir(), 'q-edit-')); });

  it('opens a note with its body and hash, and saves an edit to the file', () => {
    put('a/Plan.md', '---\nk: v\n---\n\n# Plan\n\nOld.\n');
    const n = openEdit(vault, 'a/Plan.md', never);
    expect(n).toEqual({ hash: hashText('---\nk: v\n---\n\n# Plan\n\nOld.\n'), readOnly: null, body: 'Old.', frontmatter: '---\nk: v\n---\n' });
    const s = saveEdit(vault, 'a/Plan.md', { hash: n.hash, body: 'New.' }, never);
    expect(String(bytes('a/Plan.md'))).toBe('---\nk: v\n---\n\n# Plan\n\nNew.\n');
    expect(s.hash).toBe(hashText('---\nk: v\n---\n\n# Plan\n\nNew.\n'));
    expect(s.before).not.toBe(s.after);
  });

  it('refuses a save made from an older copy of the file', () => {
    put('n.md', 'One.\n');
    const n = openEdit(vault, 'n.md', never);
    put('n.md', 'Changed elsewhere.\n');
    expect(saveEdit(vault, 'n.md', { hash: n.hash, body: 'Mine.' }, never)).toEqual({ conflict: true });
    expect(String(bytes('n.md'))).toBe('Changed elsewhere.\n');
  });

  it('opens a note with withheld lines read-only, without its text, and never saves over it', () => {
    put('w.md', '# W\n\nAcme renewal.\n');
    const withheld = (t) => t.includes('Acme');
    const n = openEdit(vault, 'w.md', withheld);
    expect(n).toMatchObject({ readOnly: 'withheld', body: '', frontmatter: '' });
    expect(saveEdit(vault, 'w.md', { hash: n.hash, body: 'Gone.' }, withheld)).toHaveProperty('error');
    expect(String(bytes('w.md'))).toBe('# W\n\nAcme renewal.\n');
  });

  it('opens a note that is not UTF-8 read-only and keeps its bytes', () => {
    const latin1 = Buffer.from('# T\n\nCaf\xe9 bytes.\n', 'latin1');
    put('l.md', latin1);
    const n = openEdit(vault, 'l.md', never);
    expect(n).toMatchObject({ readOnly: 'encoding', body: '' });
    expect(saveEdit(vault, 'l.md', { hash: n.hash, body: 'x' }, never)).toHaveProperty('error');
    expect(bytes('l.md').equals(latin1)).toBe(true);
  });

  it('keeps a byte order mark', () => {
    put('b.md', '﻿# T\n\nText.\n');
    const n = openEdit(vault, 'b.md', never);
    expect(n.readOnly).toBeNull();
    saveEdit(vault, 'b.md', { hash: n.hash, body: 'More.' }, never);
    expect(bytes('b.md').subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(true);
    expect(String(bytes('b.md'))).toBe('﻿# T\n\nMore.\n');
  });

  it('writes a symlinked note at its target and leaves the link a link', () => {
    put('real/target.md', '# T\n\nreal\n');
    symlinkSync(path.join(vault, 'real/target.md'), path.join(vault, 'link.md'));
    const n = openEdit(vault, 'link.md', never);
    expect(n.body).toBe('real');
    saveEdit(vault, 'link.md', { hash: n.hash, body: 'edited' }, never);
    expect(lstatSync(path.join(vault, 'link.md')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(path.join(vault, 'link.md'))).toBe(path.join(vault, 'real/target.md'));
    expect(String(bytes('real/target.md'))).toBe('# T\n\nedited\n');
  });

  it('writes nothing for a save that changes nothing', () => {
    put('same.md', '# S\n\nBody   \n\n\n');
    const n = openEdit(vault, 'same.md', never);
    const s = saveEdit(vault, 'same.md', { hash: n.hash, body: n.body }, never);
    expect(s.after).toBe(s.before);
    expect(String(bytes('same.md'))).toBe('# S\n\nBody   \n\n\n');
  });

  it('says so when the note is gone', () => {
    expect(openEdit(vault, 'none.md', never)).toBeNull();
    expect(saveEdit(vault, 'none.md', { hash: 'x', body: 'y' }, never)).toEqual({ error: 'This note was moved or deleted.' });
    expect(saveEdit(vault, '../outside.md', { hash: 'x', body: 'y' }, never)).toHaveProperty('error');
  });
});

describe('the editor session', () => {
  const note = (body, hash = `h:${body}`, frontmatter = '') => ({ hash, readOnly: null, body, frontmatter });
  function setup({ save, load, copy = async () => {} } = {}) {
    const calls = { copied: [], toasts: [], notices: [], errors: [], taken: [], saved: [], props: [] };
    const api = {
      load: load ?? (async () => note('disk')),
      save: save ?? (async ({ body }) => ({ hash: `h:${body}` })),
      copy: vi.fn(async (t) => { calls.copied.push(t); return copy(t); }),
      toast: (t) => calls.toasts.push(t),
    };
    const s = createEditSession(api, { take: (n) => calls.taken.push(n.body), notice: (t) => calls.notices.push(t), error: (t) => calls.errors.push(t), saved: (b) => calls.saved.push(b), props: (fm, problem) => calls.props.push([fm, problem]) });
    s.take(note('start'));
    return { s, calls, api };
  }
  afterEach(() => vi.useRealTimers());

  it('saves an edit after a pause, with the hash it opened from', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async ({ body }) => ({ hash: `h:${body}` }));
    const { s, calls } = setup({ save });
    s.edit('typed');
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SAVE_AFTER);
    expect(save).toHaveBeenCalledWith({ hash: 'h:start', body: 'typed' });
    expect(calls.saved).toEqual(['typed']);
    expect(s.state.hash).toBe('h:typed');
  });

  it('on a conflict, copies the unsaved edit, reloads the note from disk and says so', async () => {
    const { s, calls } = setup({ save: async () => ({ conflict: true }), load: async () => note('from disk') });
    s.state.body = 'mine';
    await s.save();
    expect(calls.copied).toEqual(['mine']);
    expect(calls.taken).toEqual(['start', 'from disk']);
    expect(calls.notices.at(-1)).toMatch(/reloaded\. Your unsaved edit is on the clipboard/);
  });

  it("doesn't claim the edit is on the clipboard when copying fails", async () => {
    const { s, calls } = setup({ save: async () => ({ conflict: true }), copy: async () => { throw new Error('denied'); } });
    s.state.body = 'mine';
    await s.save();
    expect(calls.notices.at(-1)).toMatch(/couldn't copy your unsaved edit/);
    expect(calls.notices.at(-1)).not.toMatch(/is on the clipboard/);
  });

  it('after the view closes, a save to a note that was moved copies the edit and shows a toast', async () => {
    const { s, calls } = setup({ save: async () => ({ error: 'This note was moved or deleted.' }) });
    await s.close('last words');
    expect(calls.copied).toEqual(['last words']);
    expect(calls.toasts).toEqual(['This note was moved or deleted. Your edit is on the clipboard.']);
    expect(calls.errors).toEqual([]);
  });

  it('after the view closes, a conflict copies the edit and shows a toast without reloading', async () => {
    const load = vi.fn(async () => note('disk'));
    const { s, calls } = setup({ save: async () => ({ conflict: true }), load });
    await s.close('last words');
    expect(calls.copied).toEqual(['last words']);
    expect(calls.toasts[0]).toMatch(/Your edit is on the clipboard/);
    expect(load).not.toHaveBeenCalled();
  });

  it('shows a save error in the open view', async () => {
    const { s, calls } = setup({ save: async () => ({ error: 'This note can only be edited in the vault directly.' }) });
    s.state.body = 'x';
    await s.save();
    expect(calls.errors).toEqual(['This note can only be edited in the vault directly.']);
    expect(calls.copied).toEqual([]);
  });

  it('reloads on a change on disk only when the hash differs from its own last save', async () => {
    let disk = note('start');
    const { s, calls } = setup({ load: async () => disk });
    await s.changed();
    expect(calls.taken).toEqual(['start']);
    disk = note('someone else');
    await s.changed();
    expect(calls.taken).toEqual(['start', 'someone else']);
    expect(calls.copied).toEqual([]);
  });

  it('runs one save at a time and then saves the latest text', async () => {
    let release;
    const seen = [];
    const save = async ({ hash, body }) => { seen.push([hash, body]); if (seen.length === 1) await new Promise((r) => { release = r; }); return { hash: `h:${body}` }; };
    const { s } = setup({ save });
    s.state.body = 'one';
    const first = s.save();
    s.state.body = 'two';
    const second = s.save();
    await Promise.resolve();
    release();
    await Promise.all([first, second]);
    expect(seen).toEqual([['h:start', 'one'], ['h:one', 'two']]);
  });

  it('sends only what changed: properties alone, at once, without the body', async () => {
    const save = vi.fn(async () => ({ hash: 'h:2', frontmatter: '---\nb: 2\n---\n' }));
    const { s, calls } = setup({ save });
    await s.editProps('---\nb: 2\n---\n');
    expect(save).toHaveBeenCalledWith({ hash: 'h:start', frontmatter: '---\nb: 2\n---\n' });
    expect(calls.props).toEqual([['---\nb: 2\n---\n', null]]);
  });

  it('keeps properties that were turned down in the panel and does not send them again', async () => {
    const save = vi.fn(async () => ({ hash: 'h:start', frontmatter: '', propsError: 'Those properties are not valid frontmatter, so they were not saved.' }));
    const { s, calls } = setup({ save });
    await s.editProps('---\nbroken');
    expect(calls.props).toEqual([[null, 'Those properties are not valid frontmatter, so they were not saved.']]);
    await s.save();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('copies unsaved properties with the body on a conflict', async () => {
    const { s, calls } = setup({ save: async () => ({ conflict: true }) });
    s.state.fm = '---\nb: 2\n---\n';
    s.state.body = 'mine';
    await s.save();
    expect(calls.copied).toEqual(['---\nb: 2\n---\nmine']);
  });
});

describe('bookmarks and today on a real vault folder', () => {
  let vault;
  const file = (rel) => path.join(vault, rel);
  beforeEach(() => { vault = mkdtempSync(path.join(tmpdir(), 'q-bm-')); });

  it('stars and unstars a note in .obsidian/bookmarks.json, keeping its heading bookmarks', () => {
    mkdirSync(file('.obsidian'));
    writeFileSync(file('.obsidian/bookmarks.json'), JSON.stringify({ items: [{ type: 'file', ctime: 1, path: 'n.md', subpath: '#H' }] }));
    expect(listBookmarks(vault)).toEqual([]);
    expect(toggleBookmark(vault, 'n.md', true, 2)).toEqual(['n.md']);
    expect(toggleBookmark(vault, 'n.md', false)).toEqual([]);
    expect(JSON.parse(readFileSync(file('.obsidian/bookmarks.json'), 'utf8')).items).toEqual([{ type: 'file', ctime: 1, path: 'n.md', subpath: '#H' }]);
  });

  it('makes the file when there is none, and never writes over one that is not a bookmarks file', () => {
    expect(toggleBookmark(vault, 'n.md', true, 1)).toEqual(['n.md']);
    writeFileSync(file('.obsidian/bookmarks.json'), '{ broken');
    expect(() => toggleBookmark(vault, 'n.md', false)).toThrow(/left it alone/);
    expect(readFileSync(file('.obsidian/bookmarks.json'), 'utf8')).toBe('{ broken');
    expect(moveBookmarks(vault, 'n.md', 'm.md')).toBe(false);
  });

  it('moves bookmarks with a renamed note and leaves the file alone when none point at it', () => {
    toggleBookmark(vault, 'a/n.md', true, 1);
    expect(moveBookmarks(vault, 'a/n.md', 'b/n.md')).toBe(true);
    expect(listBookmarks(vault)).toEqual(['b/n.md']);
    const before = readFileSync(file('.obsidian/bookmarks.json'), 'utf8');
    expect(moveBookmarks(vault, 'other.md', 'x.md')).toBe(false);
    expect(readFileSync(file('.obsidian/bookmarks.json'), 'utf8')).toBe(before);
  });

  const day = new Date(2026, 10, 19, 8, 30);

  it("makes today's note in 01-daily from no settings, and in the root when the settings name no folder", () => {
    expect(openToday(vault, day)).toEqual({ rel: '01-daily/2026-11-19.md', created: true });
    mkdirSync(file('.obsidian'));
    writeFileSync(file('.obsidian/daily-notes.json'), JSON.stringify({ folder: '', format: 'Do MMMM YYYY' }));
    expect(openToday(vault, day)).toEqual({ rel: '19th November 2026.md', created: true });
  });

  it("fills the template, and never writes over today's note when it already exists", () => {
    mkdirSync(file('.obsidian'));
    mkdirSync(file('T'));
    writeFileSync(file('T/Daily.md'), '# {{title}}\n');
    writeFileSync(file('.obsidian/daily-notes.json'), JSON.stringify({ folder: 'J', template: 'T/Daily' }));
    expect(openToday(vault, day)).toEqual({ rel: 'J/2026-11-19.md', created: true });
    expect(readFileSync(file('J/2026-11-19.md'), 'utf8')).toBe('# 2026-11-19\n');
    writeFileSync(file('J/2026-11-19.md'), 'my notes');
    expect(openToday(vault, day)).toEqual({ rel: 'J/2026-11-19.md', created: false });
    expect(readFileSync(file('J/2026-11-19.md'), 'utf8')).toBe('my notes');
  });

  it('refuses a daily folder outside the vault and a format it cannot name', () => {
    mkdirSync(file('.obsidian'));
    writeFileSync(file('.obsidian/daily-notes.json'), JSON.stringify({ folder: '../out' }));
    expect(() => openToday(vault, day)).toThrow(/outside the vault/);
    writeFileSync(file('.obsidian/daily-notes.json'), JSON.stringify({ format: 'YYYY N' }));
    expect(() => openToday(vault, day)).toThrow(/doesn't support N/);
  });
});
