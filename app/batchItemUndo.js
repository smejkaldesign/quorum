// One undo record per item in a batch run (runBatch in main.js). track(item, keep) wraps the run's keep(): the first
// time an item touches a note, the note's text as it reads then (null when it does not exist yet) is saved for that
// item. restore(item) writes those texts back and trashes the notes the item created, so a failed item leaves its
// notes as it found them while the batch's other items keep their fixes. alone(item) is false when another item
// also wrote one of its notes; putting back only one of them would undo the other's work, so the batch then rolls
// back whole. abs(rel) resolves a vault path (main.js passes vaultPath, which refuses paths outside the vault).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function itemUndo(vault, abs = (rel) => path.join(vault, rel)) {
  const snaps = new Map();
  const owners = new Map();
  const read = (rel) => { try { const f = abs(rel); return existsSync(f) ? readFileSync(f, 'utf8') : null; } catch { return null; } };
  return {
    track: (item, keep) => (rel, created = false, gone = false) => {
      let m = snaps.get(item);
      if (!m) snaps.set(item, (m = new Map()));
      if (!m.has(rel)) m.set(rel, created ? null : read(rel));
      if (!owners.has(rel)) owners.set(rel, new Set());
      owners.get(rel).add(item);
      return keep(rel, created, gone);
    },
    rels: (item) => [...(snaps.get(item)?.keys() ?? [])],
    alone: (item) => [...(snaps.get(item)?.keys() ?? [])].every((r) => owners.get(r)?.size === 1),
    restore: async (item, trash) => {
      for (const [rel, text] of snaps.get(item) ?? []) {
        const f = abs(rel);
        if (text == null) { if (existsSync(f)) await trash(f); continue; }
        mkdirSync(path.dirname(f), { recursive: true });
        writeFileSync(f, text);
      }
      for (const rel of snaps.get(item)?.keys() ?? []) owners.get(rel)?.delete(item);
      snaps.delete(item);
    },
  };
}
