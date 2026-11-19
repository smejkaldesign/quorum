// The search index: heading-scoped chunks (chunk.js) in SQLite with FTS5 over them, and one vector per chunk from the
// embedder (embed.js). Updates are incremental: a note whose text hash is unchanged is skipped, a chunk whose hash is
// unchanged keeps its row and its vector, and a chunk that moved to another note (a rename) takes the vector it had.
// Writes run in small transactions with a yield to the event loop between them, so the window keeps drawing. Vectors
// come from a background queue that runs one small batch at a time in the memory engine's process and waits while
// paused() holds (a recording is live). The text comes from the vault index (vindex.js), with opted-out lines
// already withheld, and notes the guardrails deny never reach it.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { chunkNote, embedText } from './chunk.js';
import { openMemoryDb } from './db.js';
import { createHybridSearch } from './hybrid.js';

export const NOTES_PER_TX = 25;
export const EMBED_BATCH = 16;
export const PAUSE_MS = 5000;
export const RETRY_MS = 60000;

const sha = (t) => createHash('sha256').update(String(t)).digest('hex');
const tick = () => new Promise((r) => setImmediate(r));
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });

// the folder conventions the graph also reads; the frontmatter type wins
const FOLDER_KINDS = [[/(^|\/)people\//i, 'person'], [/(^|\/)projects\//i, 'project'], [/(^|\/)(\d+-)?meetings\//i, 'meeting'], [/(^|\/)decisions\//i, 'decision']];
export function kindOf(rel, note) {
  const t = note?.props?.type;
  if (typeof t === 'string' && t.trim()) return t.trim().toLowerCase();
  for (const [re, k] of FOLDER_KINDS) if (re.test(rel)) return k;
  return 'note';
}
// the date a note speaks for: a date in its file name, then its frontmatter date, then its file time
export function dateOf(rel, note, mtime) {
  const named = path.basename(rel).match(/^(\d{4}-\d{2}-\d{2})/)?.[1];
  const p = note?.props ?? {};
  for (const d of [named, p.date, p.created, p.created_at]) { const t = d ? Date.parse(String(d)) : NaN; if (!Number.isNaN(t)) return t; }
  return Number(mtime) || 0;
}

export function createSearchIndex({ db, embedder = null, paused = () => false, log = () => {}, now = () => Date.now(), notesPerTx = NOTES_PER_TX, embedBatch = EMBED_BATCH, pauseMs = PAUSE_MS, retryMs = RETRY_MS }) {
  const q = {
    file: db.prepare('SELECT hash FROM search_files WHERE rel = ?'),
    putFile: db.prepare('INSERT OR REPLACE INTO search_files(rel, hash, title, kind, date, mtime) VALUES (?, ?, ?, ?, ?, ?)'),
    dropFile: db.prepare('DELETE FROM search_files WHERE rel = ?'),
    rels: db.prepare('SELECT rel FROM search_files'),
    chunksOf: db.prepare('SELECT id, hash FROM chunks WHERE rel = ?'),
    insert: db.prepare('INSERT INTO chunks(rel, heading, start_line, end_line, text, hash, tokens) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    lines: db.prepare('UPDATE chunks SET start_line = ?, end_line = ? WHERE id = ?'),
    drop: db.prepare('DELETE FROM chunks WHERE id = ?'),
    dropRel: db.prepare('DELETE FROM chunks WHERE rel = ?'),
    reuse: db.prepare('SELECT v.vec AS vec, v.dim AS dim FROM chunks c JOIN vectors v ON v.chunk = c.id WHERE c.hash = ? AND v.model = ? LIMIT 1'),
    putVec: db.prepare('INSERT OR REPLACE INTO vectors(chunk, model, dim, vec) VALUES (?, ?, ?, ?)'),
    pending: db.prepare('SELECT c.id AS id, c.heading AS heading, c.text AS text, c.hash AS hash FROM chunks c WHERE NOT EXISTS (SELECT 1 FROM vectors v WHERE v.chunk = c.id AND v.model = ?) ORDER BY c.id DESC LIMIT ?'),
    hashOf: db.prepare('SELECT hash FROM chunks WHERE id = ?'),
    counts: db.prepare('SELECT (SELECT COUNT(*) FROM search_files) AS notes, (SELECT COUNT(*) FROM chunks) AS chunks'),
    embedded: db.prepare('SELECT COUNT(*) AS n FROM vectors WHERE model = ?'),
  };
  const st = { state: 'idle', building: false, error: null, lastBuildMs: null, built: false, embedRate: null };
  let version = 0;
  let stopped = false;
  let draining = null;

  function tx(fn) {
    db.exec('BEGIN');
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  // one note in; false when its text is the same as last time
  function apply({ rel, text, note, mtime }) {
    const h = sha(text);
    if (q.file.get(rel)?.hash === h) return false;
    const title = note?.title ?? path.basename(rel, '.md');
    const fresh = chunkNote({ text, title });
    const old = new Map();
    for (const r of q.chunksOf.all(rel)) (old.get(r.hash) ?? old.set(r.hash, []).get(r.hash)).push(r.id);
    for (const c of fresh) {
      const id = old.get(c.hash)?.shift();
      if (id != null) { q.lines.run(c.start_line, c.end_line, id); continue; }
      const got = embedder ? q.reuse.get(c.hash, embedder.id) : null;
      const { lastInsertRowid } = q.insert.run(rel, c.heading, c.start_line, c.end_line, c.text, c.hash, c.tokens);
      if (got) q.putVec.run(lastInsertRowid, embedder.id, got.dim, got.vec);
    }
    for (const ids of old.values()) for (const id of ids) q.drop.run(id);
    q.putFile.run(rel, h, title, kindOf(rel, note), dateOf(rel, note, mtime), Number(mtime) || 0);
    version++;
    return true;
  }
  function remove(rel) { q.dropRel.run(rel); q.dropFile.run(rel); version++; }

  // notes: [{ rel, text, note, mtime }] that changed; removed: rels that left the vault. New text goes in before the
  // removals, so a renamed note's chunks find their vectors
  async function update(notes = [], removed = []) {
    let changed = 0;
    for (let i = 0; i < notes.length; i += notesPerTx) {
      if (stopped) return changed;
      const part = notes.slice(i, i + notesPerTx);
      changed += tx(() => part.reduce((n, x) => n + (apply(x) ? 1 : 0), 0));
      if (i + notesPerTx < notes.length) await tick();
    }
    if (removed.length) tx(() => { for (const r of removed) remove(r); });
    if (changed || removed.length) drain();
    return changed;
  }

  // the whole vault as the index holds it now; notes no longer in it are dropped
  async function build(notes) {
    const at = now();
    st.building = true; st.state = 'building';
    try {
      const keep = new Set(notes.map((n) => n.rel));
      const gone = q.rels.all().map((r) => r.rel).filter((r) => !keep.has(r));
      const changed = await update(notes, gone);
      st.lastBuildMs = now() - at; st.built = true;
      log('search', 'build', notes.length, 'notes', changed, 'changed', st.lastBuildMs, 'ms');
      return changed;
    } finally { st.building = false; st.state = draining ? 'embedding' : 'idle'; }
  }

  // the embed queue: one batch at a time, newest chunks first, waiting while paused and after a failure
  function drain() {
    if (!embedder || draining || stopped) return draining;
    draining = (async () => {
      let done = 0;
      const at = now();
      try {
        while (!stopped) {
          if (paused()) { st.state = 'paused'; await sleep(pauseMs); continue; }
          const rows = q.pending.all(embedder.id, embedBatch);
          if (!rows.length) break;
          st.state = 'embedding';
          let vecs;
          try { vecs = await embedder.embed(rows.map(embedText)); st.error = null; } catch (e) {
            st.error = String(e?.message ?? e); st.state = 'waiting';
            log('search', 'embed failed', st.error);
            await sleep(retryMs);
            continue;
          }
          if (stopped) break;
          tx(() => rows.forEach((r, i) => {
            const v = vecs[i];
            // a chunk edited while its batch ran is embedded again on the next pass
            if (!v || q.hashOf.get(r.id)?.hash !== r.hash) return;
            q.putVec.run(r.id, embedder.id, v.length, new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
          }));
          done += rows.length;
          version++;
          await tick();
        }
      } finally {
        if (done) st.embedRate = Math.round((done / Math.max(1, now() - at)) * 1000 * 10) / 10;
        draining = null;
        if (!st.building) st.state = 'idle';
      }
    })();
    return draining;
  }

  function status() {
    const c = q.counts.get();
    const embedded = embedder ? q.embedded.get(embedder.id).n : 0;
    return { state: st.state, notes: c.notes, chunks: c.chunks, embedded, pending: embedder ? c.chunks - embedded : 0, model: embedder?.id ?? null, error: st.error, lastBuildMs: st.lastBuildMs, built: st.built, embedPerSecond: st.embedRate };
  }

  return { build, update, apply, remove, drain, status, idle: () => draining ?? Promise.resolve(), version: () => version, stop: () => { stopped = true; } };
}

// Main's side: one index per vault, opened on the first change the vault index reports and built from its snapshot;
// later changes update it note by note. vindex() is the vault index, vault() the open vault, embed(texts, maxTokens)
// the memory host's embed, graph() the memory graph's store or null, paused() a recording is live
export function createMemorySearch({ dataDir, vault, vindex, embedder = null, graph = () => null, paused = () => false, log = () => {} }) {
  let cur = null;
  const close = () => { if (!cur) return; cur.index.stop(); if (cur.own) try { cur.db.close(); } catch {} cur = null; };
  function open() {
    const v = vault();
    const ix = vindex();
    if (!v || !ix) { close(); return null; }
    if (cur?.vault === v) return cur;
    close();
    const { db, own } = openMemoryDb({ dataDir, vault: v, store: graph() });
    const index = createSearchIndex({ db, embedder, paused, log });
    const hybrid = createHybridSearch({ db, embedder, graph: () => graph(), version: index.version });
    cur = { vault: v, db, own, index, hybrid, ready: null };
    cur.ready = index.build(ix.snapshot()).catch((e) => log('search', 'build failed', e?.message));
    return cur;
  }
  // the rels the vault index reported changed (its onChange)
  async function changed(rels) {
    const was = cur;
    const c = open();
    if (!c) return;
    if (c !== was) return c.ready;
    await c.ready;
    const want = new Set(rels);
    const notes = vindex().snapshot().filter((n) => want.has(n.rel));
    const seen = new Set(notes.map((n) => n.rel));
    return c.index.update(notes, rels.filter((r) => !seen.has(r)));
  }
  return {
    changed,
    async search(opts = {}) { const c = open(); if (!c) return { results: [], truncated: { shown: 0, total: 0, budgetNeeded: 0 } }; await c.ready; return c.hybrid.search(opts); },
    status() { const c = open(); return c ? c.index.status() : { state: 'off', notes: 0, chunks: 0, embedded: 0, pending: 0, model: embedder?.id ?? null, error: null, lastBuildMs: null, built: false, embedPerSecond: null }; },
    close,
  };
}
