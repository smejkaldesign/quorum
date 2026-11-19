// The main-process side of the Knowledge editor (vault-note-edit and vault-note-save in main.js): which notes open for
// editing, and the save written against the file as it is on disk now. A note opens read-only, without its text, when
// its bytes aren't valid UTF-8 (a save would rewrite them), when it has withheld lines (a redacted copy must never be
// saved over it) or when it mixes line endings. Bookmarks and today's daily note, which also write into the vault, are
// here too.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { bookmarkedFiles, parseBookmarks, renameBookmarks, setBookmark, writeBookmarks } from './bookmarks.js';
import { dailyConfig, dailyPath, fillTemplate, templatePath } from './dailyNote.js';
import { hashText, validFrontmatter } from './handnote.js';
import { editParts, withBody, withFrontmatter } from './noteEdit.js';
import { writeAtomic } from './relink.js';
import { readVaultNote } from './vault.js';

// a save from the editor against the file as it is now: a conflict when the file changed since the editor read it
// (hash), refused for a note this view can't edit, else the text to write (the file as it was when nothing changed).
// Properties that aren't valid frontmatter are left out, and the body still saves
export function planSave(raw, { hash, body, frontmatter, withheld }) {
  if (hashText(raw) !== hash) return { conflict: true };
  if (withheld || editParts(raw).mixed) return { error: 'This note can only be edited in the vault directly.' };
  const text = typeof body === 'string' ? withBody(raw, body) : String(raw);
  if (frontmatter === undefined) return { text };
  if (!validFrontmatter(String(frontmatter).replace(/\r\n/g, '\n'))) return { text, propsError: 'Those properties are not valid frontmatter, so they were not saved.' };
  return { text: withFrontmatter(text, frontmatter) };
}

export function readOnlyReason(n, isExcluded) {
  if (!n.utf8) return 'encoding';
  if (isExcluded(n.text)) return 'withheld';
  return editParts(n.text).mixed ? 'line-endings' : null;
}

export function openEdit(vault, rel, isExcluded) {
  const n = readVaultNote(vault, rel);
  if (!n) return null;
  const hash = hashText(n.text);
  const readOnly = readOnlyReason(n, isExcluded);
  if (readOnly) return { hash, readOnly, body: '', frontmatter: '' };
  const p = editParts(n.text);
  return { hash, readOnly: null, body: p.body, frontmatter: p.fm };
}

// writes the save when it changes the file; before and after are the file's text around the write (equal when nothing
// was written), frontmatter the file's frontmatter after it
export function saveEdit(vault, rel, payload, isExcluded) {
  const n = readVaultNote(vault, rel);
  if (!n) return { error: 'This note was moved or deleted.' };
  const plan = planSave(n.text, { hash: payload?.hash, body: payload?.body, frontmatter: typeof payload?.frontmatter === 'string' ? payload.frontmatter : undefined, withheld: readOnlyReason(n, isExcluded) !== null });
  if (!('text' in plan)) return plan;
  if (plan.text !== n.text) writeAtomic(n.abs, plan.text);
  return { hash: hashText(plan.text), before: n.text, after: plan.text, frontmatter: editParts(plan.text).fm, ...(plan.propsError ? { propsError: plan.propsError } : {}) };
}

// Obsidian's bookmarks file (bookmarks.js). A missing file is an empty list; one that can't be read or isn't a
// bookmarks file is null and is never written over
const bookmarksFile = (vault) => path.join(vault, '.obsidian', 'bookmarks.json');
function readBookmarks(vault) {
  let text;
  try { text = readFileSync(bookmarksFile(vault), 'utf8'); } catch (e) { return e?.code === 'ENOENT' ? { items: [] } : null; }
  return parseBookmarks(text);
}
const saveBookmarks = (vault, data) => { mkdirSync(path.dirname(bookmarksFile(vault)), { recursive: true }); writeAtomic(bookmarksFile(vault), writeBookmarks(data)); };
export const listBookmarks = (vault) => bookmarkedFiles(readBookmarks(vault));
export function toggleBookmark(vault, rel, on, now = Date.now()) {
  const data = readBookmarks(vault);
  if (!data) throw new Error("Your bookmarks file couldn't be read, so Quorum left it alone");
  const next = setBookmark(data, rel, on, now);
  if (next !== data) saveBookmarks(vault, next);
  return bookmarkedFiles(next);
}
// after a rename or move: bookmarks at the old path take the new one; true when the file changed
export function moveBookmarks(vault, from, to) {
  const data = readBookmarks(vault);
  const next = data && from !== to ? renameBookmarks(data, from, to) : data;
  if (!next || next === data) return false;
  saveBookmarks(vault, next);
  return true;
}

// today's daily note (dailyNote.js): its path, made from the template when it doesn't exist yet. An existing note is
// never written over, even one made between the check and the write
export function openToday(vault, now) {
  const read = (rel) => { try { return readFileSync(path.join(vault, rel), 'utf8'); } catch { return null; } };
  const config = dailyConfig(read('.obsidian/daily-notes.json'));
  const rel = dailyPath(config, now);
  const abs = path.resolve(vault, rel);
  if (!abs.startsWith(vault + path.sep)) throw new Error('The daily notes folder is outside the vault');
  if (existsSync(abs)) return { rel, created: false };
  const tpl = templatePath(config);
  const text = tpl && path.resolve(vault, tpl).startsWith(vault + path.sep) ? read(tpl) : null;
  const body = text == null ? '' : fillTemplate(text, now, path.basename(rel, '.md'));
  mkdirSync(path.dirname(abs), { recursive: true });
  try { writeFileSync(abs, body, { flag: 'wx' }); } catch (e) { if (e?.code === 'EEXIST') return { rel, created: false }; throw e; }
  return { rel, created: true };
}
