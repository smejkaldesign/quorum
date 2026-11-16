import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { vaultPath } from './vault.js';
import { writeAtomic } from './relink.js';

// Undo for a Memory health fix. Before a fix changes a note, Quorum keeps its text (or notes that the fix made it);
// after, it keeps a hash of what the fix wrote. Undo puts each note back, and sends a note the fix wrote to the Trash. It
// refuses when any note changed after the fix, so it never throws away later edits
export const sha = (t) => createHash('sha256').update(t).digest('hex');

// the record to save once the fix has run: each note's text before, and the hash of its text now
export function undoRecord(vault, kept) {
  return kept.map((k) => { let after = null; try { after = sha(readFileSync(vaultPath(vault, k.rel), 'utf8')); } catch {} return { ...k, after }; }).filter((k) => k.after);
}

// puts the notes back; trash(abs) moves a file to the Trash. Answers with how many notes it restored
export async function applyUndo(vault, files, trash) {
  const list = files.map((f) => ({ ...f, abs: vaultPath(vault, f.rel) }));
  for (const f of list) {
    let now = null;
    try { now = readFileSync(f.abs, 'utf8'); } catch {}
    if (now == null || sha(now) !== f.after) throw new Error(`“${f.rel}” changed after the fix, so undoing it would lose those edits`);
  }
  for (const f of list) {
    if (f.before == null) await trash(f.abs);
    else writeAtomic(f.abs, f.before);
  }
  return list.length;
}
