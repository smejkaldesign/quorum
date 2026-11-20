// Community detection off the main process: a worker thread opens the vault's memory database read-only, reads the
// current graph and answers detectCommunities (communities.js). graph/topics.js starts it and writes the answer.
import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import { detectCommunities, readGraph } from './communities.js';

try {
  const t0 = performance.now();
  const db = new DatabaseSync(workerData.file, { readOnly: true });
  let input;
  try { input = readGraph(db); } finally { db.close(); }
  const t1 = performance.now();
  const r = detectCommunities(input);
  parentPort.postMessage({ ok: true, ...r, readMs: Math.round(t1 - t0), ms: Math.round(performance.now() - t1) });
} catch (err) {
  parentPort.postMessage({ ok: false, error: String(err?.message ?? err) });
}
