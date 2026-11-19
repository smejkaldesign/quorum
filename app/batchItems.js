// The per-item part of a batch run (runBatch in main.js): each step runs for its item, an item that fails puts back
// its own notes (itemUndo in batchItemUndo.js) while the other items go on, and the final link check puts back each
// item that wrote a note with a new broken link. A failure that cannot be kept to one item throws, and the run then
// puts every note back. mark(id, status, why) shows an item's state; release(rels) drops a put-back item's notes from
// the run's undo record; journal(entry) appends to the run's journal; trash(abs) sends a note to the Trash; sync()
// reads the vault again; onPutBack(item) runs after an item's notes are back.
import { fixCheck } from './fixJournal.js';

export function batchItems({ items, undo, mark, release, journal, trash, sync = () => {}, onPutBack = () => {} }) {
  const failed = new Set();
  const plural = (n, one, many) => (n === 1 ? one : many);
  // puts back one item's notes and marks it failed. When the item cannot be put back alone it is marked failed with
  // its own reason first, so the whole-batch rollback does not count it among the items it had fixed
  const putBack = async (item, why) => {
    const rels = undo.rels(item.id);
    const stop = undo.blocked(item.id);
    if (stop) { mark(item.id, 'error', why); throw new Error(`${why}. ${stop}, so Quorum put back the whole batch`); }
    const { restored, skipped } = await undo.restore(item.id, trash);
    release(rels);
    failed.add(item.id);
    const left = skipped.length ? `. ${plural(skipped.length, `“${skipped[0]}” changed`, `${skipped.length} notes changed`)} after this item wrote ${plural(skipped.length, 'it', 'them')}, so Quorum left ${plural(skipped.length, 'it as it is', 'them as they are')}` : '';
    mark(item.id, 'error', `${why}${left}`);
    journal({ step: 'item-rolled-back', item: item.id, rels, restored, skipped, why });
    onPutBack(item);
    sync();
  };
  return {
    failed,
    putBack,
    fixed: () => items.filter((i) => !failed.has(i.id)),
    // each step in plan order; runOne(item, step) does the step's writes through undo.track(item.id, keep). The item's
    // notes are sealed after every step, failed or not, so a put-back compares against what the item last wrote
    async runSteps(steps, runOne, cancelled = () => false) {
      const byId = new Map(items.map((i) => [i.id, i]));
      const left = new Map(items.map((i) => [i.id, steps.filter((s) => s.item === i.id).length]));
      for (const s of steps) {
        const item = byId.get(s.item);
        if (failed.has(item.id)) continue;
        mark(item.id, 'running');
        let err = null;
        try { await runOne(item, s); } catch (e) { err = e; }
        undo.seal(item.id);
        if (err) {
          if (cancelled()) throw err;
          await putBack(item, err?.message ?? String(err));
          continue;
        }
        left.set(item.id, left.get(item.id) - 1);
        if (!left.get(item.id)) mark(item.id, 'success');
      }
    },
    // the final link check. missingNow() maps each touched note to the link targets it cannot open now; a new one
    // puts back each item that wrote that note, and the check runs again. A new broken link no item wrote throws
    async blame(before, missingNow) {
      for (let pass = 0; pass <= items.length; pass++) {
        const after = missingNow();
        const reason = fixCheck({ before, after });
        if (!reason) return;
        const worse = [...after].filter(([rel, now]) => [...now].some((t) => !(before.get(rel) ?? new Set()).has(t))).map(([rel]) => rel);
        const blamed = items.filter((i) => !failed.has(i.id) && undo.rels(i.id).some((r) => worse.includes(r)));
        if (!blamed.length) throw new Error(reason);
        for (const item of blamed) await putBack(item, reason);
      }
    },
  };
}

// a batch that rolled back whole: an item it had fixed (or was running) is marked rolled back, and one that failed on
// its own keeps its reason
export function rollBackItems(items) {
  for (const it of items ?? []) { if (it.status === 'success' || it.status === 'running') it.rolledBack = true; it.status = 'error'; }
}
