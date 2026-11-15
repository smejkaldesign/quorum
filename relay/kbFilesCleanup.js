// The sweep for files of knowledge bases hosted by Quorum (migration 0034, supabase/migrations/0034_kb_hosted.sql).
// Objects whose rows are gone wait in kb_files_trash, each with its bucket: the app deletes them right after the call that put them there,
// and this sweep deletes what is left (an app that quit in between, a lapsed upload) through the Storage API, then
// clears the rows it deleted. kb_files_cleanup also moves uploads that never finished (older than a day) to the trash.
// It runs with the service role, in the process that runs the KB sync worker.

export const BUCKET = 'kb-files';
const BATCH = 100;

export function createKbFilesCleanup({ db, log = () => {}, everyMs = 6 * 3600 * 1000, firstMs = 60000, maxRows = 500 }) {
  let timer = null, stopped = true, running = null;

  // one pass: the trash, oldest first; the objects Storage deleted (or never had) are cleared from it
  async function once() {
    const { data, error } = await db.rpc('kb_files_cleanup', { max_rows: maxRows });
    if (error) throw Object.assign(new Error('kb_files_cleanup failed'), { code: 'db' });
    // a row names its bucket since migration 0039 (attachments of a deleted account or workspace); older rows are KB files
    const byBucket = new Map();
    for (const r of data ?? []) {
      const p = typeof r === 'string' ? r : r?.object_path;
      if (!p) continue;
      const b = (typeof r === 'object' && r?.bucket) || BUCKET;
      if (!byBucket.has(b)) byBucket.set(b, []);
      byBucket.get(b).push(p);
    }
    let cleared = 0, failed = 0, total = 0;
    for (const [bucket, paths] of byBucket) {
      total += paths.length;
      for (let i = 0; i < paths.length; i += BATCH) {
        const batch = paths.slice(i, i + BATCH);
        const r = await db.storage.from(bucket).remove(batch);
        if (r.error) { failed += batch.length; continue; }
        const done = await db.rpc('kb_files_trash_done', { paths: batch });
        if (done.error) { failed += batch.length; continue; }
        cleared += batch.length;
      }
    }
    if (total) log('kb_files_cleanup', { cleared, failed });
    return { cleared, failed };
  }

  const schedule = (ms) => {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      running = once().catch((err) => { log('kb_files_cleanup_failed', { code: err?.code ?? 'server' }); });
      await running;
      running = null;
      schedule(everyMs);
    }, ms);
    timer.unref?.();
  };

  return {
    once,
    start() { if (!stopped) return; stopped = false; schedule(firstMs); },
    stop() { stopped = true; clearTimeout(timer); return running ?? Promise.resolve(); },
  };
}
