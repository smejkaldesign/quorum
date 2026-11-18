import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { vaultPath, vaultTarget } from './vault.js';
import { writeAtomic } from './relink.js';

// Undo for a Memory health fix. Before a fix changes a note, Quorum keeps its text (or notes that the fix made it);
// after, it keeps a hash of what the fix wrote. Undo puts each note back, and sends a note the fix wrote to the Trash. It
// refuses when any note changed after the fix, so it never throws away later edits
export const sha = (t) => createHash('sha256').update(t).digest('hex');

// the record to save once the fix has run: each note's text before, and the hash of its text now
// gone: the fix removed the note or moved it away, so after is null and Undo writes it back
export function undoRecord(vault, kept) {
  return kept.map((k) => { let after = null; try { after = sha(readFileSync(vaultPath(vault, k.rel), 'utf8')); } catch {} return { ...k, after }; }).filter((k) => k.after || (k.gone && k.before != null));
}

// puts the notes back; trash(abs) moves a file to the Trash. Answers with how many notes it restored
export async function applyUndo(vault, files, trash) {
  const list = files.map((f) => ({ ...f, abs: f.gone ? vaultTarget(vault, f.rel) : vaultPath(vault, f.rel) }));
  for (const f of list) {
    let now = null;
    if (!f.abs) throw new Error(`“${f.rel}” changed after the fix, so undoing it would lose those edits`);
    try { now = readFileSync(f.abs, 'utf8'); } catch {}
    if (f.gone && f.after == null) { if (now != null) throw new Error(`A note is at “${f.rel}” again since the fix, so undoing it would lose that note`); continue; }
    if (now == null || sha(now) !== f.after) throw new Error(`“${f.rel}” changed after the fix, so undoing it would lose those edits`);
  }
  // a note the fix wrote goes to the Trash before a note it moved away comes back at the same path
  for (const f of [...list].sort((a, b) => (a.before == null ? 0 : 1) - (b.before == null ? 0 : 1))) {
    if (f.before == null) await trash(f.abs);
    else { mkdirSync(path.dirname(f.abs), { recursive: true }); writeAtomic(f.abs, f.before); }
  }
  return list.length;
}
