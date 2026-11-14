// The sweep for hosted KB files (relay/kbFilesCleanup.js): the trash is deleted from Storage in batches and each batch
// Storage deleted is cleared from the trash; a batch Storage refused stays for the next pass.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createKbFilesCleanup } from '../kbFilesCleanup.js';

function fakeDb({ trash = [], failRemove = () => false } = {}) {
  const calls = [];
  return {
    calls,
    rpc: async (name, args) => {
      calls.push(['rpc', name, args]);
      if (name === 'kb_files_cleanup') return { data: trash.map((p) => ({ object_path: p })), error: null };
      if (name === 'kb_files_trash_done') return { data: args.paths.length, error: null };
      return { data: null, error: { message: 'unknown' } };
    },
    storage: { from: (bucket) => ({ remove: async (paths) => { calls.push(['remove', bucket, paths.length]); return failRemove(paths) ? { error: { message: 'boom' } } : { data: [], error: null }; } }) },
  };
}

test('deletes the trash in batches of 100 and clears each batch', async () => {
  const trash = Array.from({ length: 230 }, (_, i) => `W/K/N/F${i}.png`);
  const db = fakeDb({ trash });
  const r = await createKbFilesCleanup({ db }).once();
  assert.deepEqual(r, { cleared: 230, failed: 0 });
  assert.deepEqual(db.calls.filter((c) => c[0] === 'remove').map((c) => c[2]), [100, 100, 30]);
  assert.deepEqual(db.calls.filter((c) => c[1] === 'kb_files_trash_done').map((c) => c[2].paths.length), [100, 100, 30]);
  assert.deepEqual(db.calls[0], ['rpc', 'kb_files_cleanup', { max_rows: 500 }]);
});

test('keeps a batch Storage refused in the trash', async () => {
  const trash = Array.from({ length: 150 }, (_, i) => `W/K/N/F${i}.pdf`);
  const db = fakeDb({ trash, failRemove: (paths) => paths[0] === 'W/K/N/F0.pdf' });
  const r = await createKbFilesCleanup({ db }).once();
  assert.deepEqual(r, { cleared: 50, failed: 100 });
  assert.equal(db.calls.filter((c) => c[1] === 'kb_files_trash_done').length, 1);
});

test('an empty trash makes no Storage call', async () => {
  const db = fakeDb();
  assert.deepEqual(await createKbFilesCleanup({ db }).once(), { cleared: 0, failed: 0 });
  assert.equal(db.calls.filter((c) => c[0] === 'remove').length, 0);
});
