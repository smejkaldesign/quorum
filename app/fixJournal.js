// The step journal of a Memory health fix run, and the checks that keep a fix from doing harm. Plain Node, no Electron.
//
// Each run appends one JSON line per step to <dir>/<run id>.jsonl: queued (with the hash of every note it will touch),
// started, each note it is about to write (keep), the re-check, and how it ended. A run that was still queued or running
// when Quorum quit is recovered on the next start: the notes it wrote go back from its undo record and it is marked
// Failed with a plain reason. Journals and undo records are deleted only when their run drops off the run list.
import { appendFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { sha } from './fixUndo.js';
import { writeAtomic } from './relink.js';
import { vaultPath } from './vault.js';

const safe = (id) => String(id).replace(/[^a-z0-9_-]/gi, '_').slice(0, 200);

export function createFixJournal(dir) {
  const file = (id) => path.join(dir, `${safe(id)}.jsonl`);
  return {
    file,
    append(id, entry) {
      try { mkdirSync(dir, { recursive: true }); appendFileSync(file(id), `${JSON.stringify({ at: Date.now(), ...entry })}\n`); } catch {}
    },
    read(id) {
      let raw = '';
      try { raw = readFileSync(file(id), 'utf8'); } catch { return []; }
      return raw.split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
    },
    remove(id) { try { rmSync(file(id), { force: true }); } catch {} },
  };
}

const readText = (vault, rel) => { try { return readFileSync(vaultPath(vault, rel), 'utf8'); } catch { return null; } };

// the hash of each note's text now, or null for a note that is not there
export function hashNotes(vault, rels) {
  const out = {};
  for (const rel of new Set(rels)) { const t = readText(vault, rel); out[rel] = t == null ? null : sha(t); }
  return out;
}

// the notes whose text is not what it was when the issue was found
export function changedSince(vault, hashes = {}) {
  return Object.entries(hashes).filter(([rel, h]) => { const t = readText(vault, rel); return (t == null ? null : sha(t)) !== h; }).map(([rel]) => rel);
}

// the re-check after a fix: before and after map each touched note to the link targets it could not open (lowercased).
// Answers a plain reason when the fix made things worse, or null. stillMissing: the fixed link still opens nothing.
// targetGone: the note the fix points at, or the note it wrote, is not in the vault
export function fixCheck({ before, after, stillMissing = false, targetGone = false, target = '' }) {
  if (targetGone) return 'The note the fix points at is not in the vault after the fix';
  for (const [rel, now] of after) {
    const was = before.get(rel) ?? new Set();
    const added = [...now].filter((t) => !was.has(t));
    if (added.length) return `The fix left a new broken link to “${added[0]}” in ${rel}`;
  }
  if (stillMissing) return `The links to “${target}” still open nothing after the fix`;
  return null;
}

// puts back the notes a run wrote, from its undo record (files: { rel, before, after }). A note whose text no longer
// matches what the fix wrote (when the record has that hash) is left alone, so later edits are never lost. trash(abs)
// removes a note the run made. Answers the notes put back and the ones left alone
export async function rollback(vault, files, trash) {
  const restored = [];
  const skipped = [];
  for (const f of files ?? []) {
    const abs = vaultPath(vault, f.rel);
    const now = readText(vault, f.rel);
    if (now === f.before) continue;
    if (f.after && (now == null ? null : sha(now)) !== f.after) { skipped.push(f.rel); continue; }
    if (f.before == null) { if (now != null) { await trash(abs); restored.push(f.rel); } }
    else { writeAtomic(abs, f.before); restored.push(f.rel); }
  }
  return { restored, skipped };
}

// the line a recovered run shows as its error
export function recoveryReason({ restored, skipped }) {
  const n = restored.length;
  const put = n ? `Quorum quit while this fix was writing, and put back the ${n === 1 ? 'note' : `${n} notes`} it had changed.` : 'Quorum quit before this fix finished. It changed no notes.';
  const left = skipped.length ? ` ${skipped.length === 1 ? `“${skipped[0]}” changed` : `${skipped.length} notes changed`} after the fix started, so Quorum left ${skipped.length === 1 ? 'it' : 'them'} as ${skipped.length === 1 ? 'it is' : 'they are'}.` : '';
  return `${put}${left} Approve it again to fix it.`;
}
