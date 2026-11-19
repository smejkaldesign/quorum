// One undo record per item in a batch run (runBatch in main.js). track(item, keep) wraps the run's keep(): the first
// time an item touches a note, the note's text as it reads then (null when it does not exist yet) is saved for that
// item. seal(item) hashes the item's notes as they read after its last write. restore(item) writes the saved texts back
// and trashes the notes the item created, so a failed item leaves its notes as it found them while the batch's other
// items keep their fixes. A note that no longer reads as the item left it (a person edited it) is left alone.
// blocked(item) answers why the item cannot be put back on its own, or null: another item also wrote one of its notes
// (putting back only one would undo the other's work), or a note could not be read before the item changed it. The
// batch then rolls back whole. abs(rel) is the note's path in the vault whether or not it exists now, null outside it
// (vaultTarget), so a note the item trashed or moved away can be written back at its path.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { sha } from './fixUndo.js';
import { writeAtomic } from './relink.js';
import { vaultTarget } from './vault.js';

const UNREAD = Symbol('unreadable');
const MISSING = new Set(['ENOENT', 'ENOTDIR']);

export function itemUndo(vault, abs = (rel) => vaultTarget(vault, rel)) {
  const snaps = new Map();
  const sealed = new Map();
  const owners = new Map();
  // the note's text, null when it does not exist, UNREAD when it exists and cannot be read or lies outside the vault
  const read = (rel) => {
    const f = abs(rel);
    if (!f) return UNREAD;
    try { return readFileSync(f, 'utf8'); } catch (e) { return MISSING.has(e?.code) ? null : UNREAD; }
  };
  const hash = (t) => (t === UNREAD ? 'unreadable' : t == null ? null : sha(t));
  const rels = (item) => [...(snaps.get(item)?.keys() ?? [])];
  return {
    track: (item, keep) => (rel, created = false, gone = false) => {
      let m = snaps.get(item);
      if (!m) snaps.set(item, (m = new Map()));
      if (!m.has(rel)) m.set(rel, created ? null : read(rel));
      if (!owners.has(rel)) owners.set(rel, new Set());
      owners.get(rel).add(item);
      return keep(rel, created, gone);
    },
    seal: (item) => { const h = new Map(); for (const rel of rels(item)) h.set(rel, hash(read(rel))); sealed.set(item, h); },
    rels,
    blocked: (item) => {
      const m = snaps.get(item) ?? new Map();
      const unread = [...m].find(([, t]) => t === UNREAD);
      if (unread) return `Quorum could not read “${unread[0]}” before this item changed it`;
      if (![...m.keys()].every((r) => owners.get(r)?.size === 1)) return 'Another item in this batch changed the same note';
      return null;
    },
    // answers the notes put back and the ones left alone because they changed after the item wrote them. A note the
    // item created goes to the Trash before a note it moved away comes back, in case both use one path
    restore: async (item, trash) => {
      const m = snaps.get(item) ?? new Map();
      const h = sealed.get(item) ?? new Map();
      const restored = [];
      const skipped = [];
      const list = [...m].sort(([, a], [, b]) => (a == null ? 0 : 1) - (b == null ? 0 : 1));
      for (const [rel, text] of list) {
        if (text === UNREAD) throw new Error(`Quorum could not read “${rel}” before this item changed it`);
        const f = abs(rel);
        const now = read(rel);
        if (now === text) continue;
        if (h.has(rel) && hash(now) !== h.get(rel)) { skipped.push(rel); continue; }
        if (text == null) { if (existsSync(f)) { await trash(f); restored.push(rel); } continue; }
        mkdirSync(path.dirname(f), { recursive: true });
        writeAtomic(f, text);
        restored.push(rel);
      }
      for (const rel of m.keys()) owners.get(rel)?.delete(item);
      snaps.delete(item);
      sealed.delete(item);
      return { restored, skipped };
    },
  };
}
