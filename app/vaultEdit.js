// The main-process side of the Knowledge editor (vault-note-edit and vault-note-save in main.js): which notes open for
// editing, and the save written against the file as it is on disk now. A note opens read-only, without its text, when
// its bytes aren't valid UTF-8 (a save would rewrite them), when it has withheld lines (a redacted copy must never be
// saved over it) or when it mixes line endings.
import { hashText } from './handnote.js';
import { editParts, withBody } from './noteEdit.js';
import { writeAtomic } from './relink.js';
import { readVaultNote } from './vault.js';

// a save from the editor against the file as it is now: a conflict when the file changed since the editor read it
// (hash), refused for a note this view can't edit, else the text to write (the file as it was when nothing changed)
export function planSave(raw, { hash, body, withheld }) {
  if (hashText(raw) !== hash) return { conflict: true };
  if (withheld || editParts(raw).mixed) return { error: 'This note can only be edited in the vault directly.' };
  return { text: typeof body === 'string' ? withBody(raw, body) : String(raw) };
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
// was written)
export function saveEdit(vault, rel, payload, isExcluded) {
  const n = readVaultNote(vault, rel);
  if (!n) return { error: 'This note was moved or deleted.' };
  const plan = planSave(n.text, { hash: payload?.hash, body: payload?.body, withheld: readOnlyReason(n, isExcluded) !== null });
  if (!('text' in plan)) return plan;
  if (plan.text !== n.text) writeAtomic(n.abs, plan.text);
  return { hash: hashText(plan.text), before: n.text, after: plan.text };
}
