// The memory graph for one vault: a full build when the vault connects (batched, yielding between batches), then
// incremental updates from vindex's watcher by content hash, moves included. The text comes from vindex, so opted-out
// lines are already withheld and excluded or denied notes never arrive.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { DEFAULT_CONVENTIONS, ENTITY_FOLDERS, edgeKey, entityId, entityIds, extractNote, folderKind, noteKind, slugKey } from './extract.js';
import { createQuery } from './query.js';
import { NOTE_IDENTITY, openStore } from './store.js';
import { subjectOf, supersessions } from './temporal.js';

// notes per transaction: about 25 ms of work on a laptop, so the window keeps drawing between them
const BATCH = 50;
const sha = (t) => createHash('sha256').update(t).digest('hex');
const tick = () => new Promise((r) => setImmediate(r));

export function createMemoryGraph({ dataDir, vault, vindex, log = () => {}, isExcluded = () => false, conventions = DEFAULT_CONVENTIONS, now = Date.now }) {
  const store = openStore({ dir: path.join(dataDir, 'memory'), vault, log, now });
  const query = createQuery(store);
  const listeners = { progress: new Set(), ready: new Set() };
  const fileHooks = new Set();
  const state = { phase: 'idle', done: 0, total: 0, ms: null, builtAt: null };
  let building = null;
  let closed = false;
  const pending = new Set();
  // moves the index or the app reported (vindex onMoves, an in-app move), from -> to, waiting for the update that sees them
  const reported = new Map();

  const emit = (ev, v) => { for (const fn of listeners[ev]) { try { fn(v); } catch (err) { log('memory graph listener', String(err)); } } };
  const hook = (change) => { for (const fn of fileHooks) { try { fn(change); } catch (err) { log('memory graph file hook', String(err)); } } };
  // a name or path the opt-out list names stays out, its slug too (companies/acme-corp.md for Acme Corp)
  const hidden = (t) => isExcluded(t) || isExcluded(String(t ?? '').replace(/[-_]+/g, ' '));
  // a note the opt-out list names in its path stays out, the same as its withheld lines
  const textOf = (rel) => { if (hidden(rel)) return null; const t = vindex.text?.(rel); return typeof t === 'string' ? t : null; };

  // what a node is called after its note moves
  const idFor = (n, to) => (n.kind === 'note' ? `note:${to}` : n.kind === 'decision' && n.id.includes('#') ? `decision:${to}${n.id.slice(n.id.indexOf('#'))}` : entityId(n.kind, to, shared));

  // ---- entity folder notes (extract.js noteKind) ----
  // A note in a people, projects or companies folder is that entity when its type says so, when it is the folder's hub
  // note, or when another note links it as one: an attended, works_on or member_of edge on its entity node, or an about
  // edge from a meeting or a person. recheck holds the notes whose answer may have changed in this pass
  const recheck = new Set();
  // notes of one kind with one file name slug (extract.js entityIds): one entity when their folders are related, else
  // one per folder by path. slugs holds each such note's id over the vault, read again at each pass; a note whose id or
  // backing changed is read again with its linkers
  let slugs = new Map();
  const countSlugs = () => {
    const keys = new Map();
    for (const r of vindex.rels()) { const props = vindex.note?.(r)?.props ?? {}; const k = slugKey(r, props, conventions); if (k) (keys.get(k) ?? keys.set(k, []).get(k)).push({ rel: r, props }); }
    const next = new Map();
    for (const list of keys.values()) for (const [r, v] of entityIds(list)) next.set(r, v);
    const same = (a, b) => (a?.id ?? null) === (b?.id ?? null) && (a?.backs ?? null) === (b?.backs ?? null);
    const flipped = [...new Set([...slugs.keys(), ...next.keys()])].filter((r) => !same(slugs.get(r), next.get(r)));
    slugs = next;
    return flipped;
  };
  const shared = (kind, rel) => { const v = slugs.get(rel); return v && v.id.startsWith(`${kind}:`) ? v : null; };
  const entityFolder = (rel) => { const k = folderKind(rel, conventions); return ENTITY_FOLDERS.has(k) ? k : null; };
  const LINKING = ['attended', 'works_on', 'member_of', 'about'];
  const linkedAs = (rel) => {
    const k = entityFolder(rel);
    if (!k) return null;
    const by = store.edgesOf(entityId(k, rel, shared), { dir: 'both', kinds: LINKING }).some((e) => e.source_rel && e.source_rel !== rel && (e.kind !== 'about' || /^(meeting|person):/.test(e.src)));
    return by ? k : null;
  };
  const kindOf = (rel) => noteKind(rel, vindex.note?.(rel)?.props ?? {}, conventions, linkedAs(rel)).kind;
  // whether the note's entity node in the store disagrees with what it is now
  const stale = (rel) => { const k = entityFolder(rel); return !!k && (kindOf(rel) === k) !== store.nodesByRel(rel).some((n) => n.kind === k); };
  const backers = (ids) => { for (const id of ids) { const r = store.node(id)?.rel; if (r) recheck.add(r); } };
  // ---- end entity folder notes ----

  // the note's facts replace what it said before: kept edges keep their id and history, new ones are added and checked
  // for supersession, and the rest go
  function reindex(rel, text, hash) {
    const ex = extractNote({ rel, text, note: vindex.note?.(rel) ?? null, resolve: (t, from) => vindex.resolve(t, from), conventions, isExcluded: hidden, linkedAs, kindOf, shared });
    for (const r of ex.refs) recheck.add(r);
    const backed = new Set(ex.nodes.filter((n) => n.rel).map((n) => n.id));
    const touched = new Set();
    for (const p of store.nodesByRel(rel)) {
      // a decision the model pass read from the note is its to keep or drop (memoryModelPass.js)
      if (backed.has(p.id) || p.props?.by === 'model') continue;
      if (NOTE_IDENTITY.has(p.kind)) for (const t of store.dropNode(p.id)) touched.add(t);
      else { store.unback(p.id); touched.add(p.id); }
    }
    for (const n of ex.nodes) {
      const fresh = !store.node(n.id);
      store.upsertNode(n);
      if (n.rel) store.setAliases(n.id, [n.name, ...(n.aliases ?? [])]);
      else if (fresh) store.setAliases(n.id, [n.name, ...(n.aliases ?? [])]);
      else store.addAliases(n.id, [n.name, ...(n.aliases ?? [])]);
    }
    // what the note said before, superseded facts included: a fact another note replaced is still this note's, and
    // matching it keeps it superseded instead of adding it again. An edge another writer added (props.by: the keeper,
    // the contradiction checker, a supersession) is not the note's to retract
    const old = new Map();
    for (const e of store.edgesBySource(rel)) if (!e.props?.by) (old.get(edgeKey(e)) ?? old.set(edgeKey(e), []).get(edgeKey(e))).push(e);
    for (const list of old.values()) list.sort((a, b) => (a.superseded_by == null ? 0 : 1) - (b.superseded_by == null ? 0 : 1) || a.id - b.id);
    const matched = new Set();
    const added = [];
    for (const e of ex.edges) {
      const k = edgeKey(e);
      const cur = old.get(k)?.shift();
      if (cur) {
        matched.add(k);
        // a new date can change which fact is the newer one: that edge competes again
        if (cur.valid_from !== e.valid_from && subjectOf(cur)) { store.removeEdge(cur.id); added.push(store.addEdge({ ...e, source_rel: rel })); continue; }
        if (cur.source_line !== e.source_line || cur.valid_from !== e.valid_from) store.updateEdge(cur.id, e);
        continue;
      }
      added.push(store.addEdge({ ...e, source_rel: rel }));
    }
    // a single-valued fact the note no longer states may be replaced by one it now states: supersede it, then drop the
    // rest of what the note stopped saying
    for (const id of added) {
      const e = store.edge(id);
      const sub = subjectOf(e);
      if (!sub) continue;
      const current = store.edgesOf(sub.id, { dir: sub.by === 'src' ? 'out' : 'in', kinds: [e.kind] });
      for (const p of supersessions(current, e, now())) {
        store.supersede(p.old, p.by, p.at);
        if (e.kind === 'decision_about') {
          const older = store.edge(p.old), newer = store.edge(p.by);
          if (older && newer && older.src !== newer.src) store.addSupersedes({ src: newer.src, dst: older.src, old: p.old, by: p.by, source_rel: newer.source_rel, source_line: newer.source_line, valid_from: newer.valid_from });
        }
      }
    }
    // the rest the note stopped saying goes; a superseded fact stays as history, unless it is a second copy of one the
    // note still states
    for (const e of [...old.entries()].flatMap(([k, list]) => list.map((x) => [k, x]))) {
      const [k, x] = e;
      if (store.edge(x.id)?.superseded_by != null && !matched.has(k)) continue;
      touched.add(x.src); touched.add(x.dst);
      store.removeEdge(x.id);
    }
    backers(touched);
    store.prune(touched);
    store.upsertFile({ rel, hash });
  }

  // the notes whose links resolve differently once rel appears or goes
  const linkersOf = (rel) => new Set([
    ...(vindex.backlinks?.(rel) ?? []).map((b) => b.rel),
    ...store.edgesOf(`note:${rel}`, { dir: 'in', kinds: ['links_to', 'embeds'] }).map((e) => e.source_rel).filter(Boolean),
  ]);

  // one pass over a set of changed paths, in one transaction: moves first, then removals, then every changed or new note
  // and the notes that link to the ones that came or went. A move is a pair the index or the app reported; a burst they
  // could not pair falls back to the same text under a new path
  // isolate: each note's work in its own savepoint, so a note that throws is logged and skipped, its file row stays
  // unwritten for the next build to read again, and the rest of the batch still commits. A batch runs without it first
  // (savepoints cost a third more) and again with it only when it threw
  const one = (isolate) => (rel, fn) => {
    if (!isolate) return fn();
    try { store.tx(fn); } catch (err) { log('memory graph note', rel, String(err?.stack ?? err)); }
    return undefined;
  };
  const applyBatch = (rels, opts = {}) => {
    try { apply(rels, opts); } catch (err) {
      log('memory graph batch', String(err?.message ?? err), 'reading its notes one at a time');
      apply(rels, { ...opts, isolate: true });
    }
  };

  function apply(rels, { all = false, isolate = false } = {}) {
    const each = one(isolate);
    const pairs = [...reported].filter(([from, to]) => rels.includes(from) || rels.includes(to) || (store.fileHash(from) != null && textOf(from) === null));
    rels = [...new Set([...rels, ...pairs.flat()])];
    // the stored hashes of these paths only: reading every file row per batch made a large build slower the smaller its
    // batches were
    const known = new Map(rels.map((r) => [r, store.fileHash(r)]).filter(([, h]) => h != null));
    const flipped = countSlugs();
    const texts = new Map();
    const gone = [];
    for (const rel of rels) {
      const t = textOf(rel);
      if (t === null) { if (known.has(rel)) gone.push(rel); } else texts.set(rel, t);
    }
    const hashes = new Map([...texts].map(([rel, t]) => [rel, sha(t)]));
    const moves = [];
    const taken = new Set();
    for (const [from, to] of pairs) {
      if (!gone.includes(from) || !texts.has(to) || known.has(to) || taken.has(from) || taken.has(to)) continue;
      moves.push([from, to, hashes.get(to)]);
      taken.add(from); taken.add(to);
    }
    const byHash = new Map();
    for (const rel of gone) { if (taken.has(rel)) continue; const h = known.get(rel); byHash.set(h, byHash.has(h) ? null : rel); }
    for (const [rel, h] of hashes) {
      if (known.has(rel) || taken.has(rel)) continue;
      const from = byHash.get(h);
      if (from) { moves.push([from, rel, h]); byHash.set(h, null); }
    }
    const moved = new Set(moves.map((m) => m[0]));
    const deps = new Set();
    store.tx(() => {
      for (const [from, to, h] of moves) {
        const before = known.get(from);
        each(to, () => {
          store.moveFile(from, to, idFor);
          hook({ type: 'move', from, to, hash: h });
          // a reported move can change the text too (its own links rewritten): search hears the new text
          if (h !== before) hook({ type: 'upsert', rel: to, text: texts.get(to), hash: h });
          for (const r of linkersOf(to)) deps.add(r);
          // the path is part of what the note is (its folder, its kind): read again, same history
          reindex(to, texts.get(to), h);
        });
      }
      for (const rel of gone) {
        if (moved.has(rel)) continue;
        each(rel, () => {
          for (const r of linkersOf(rel)) deps.add(r);
          backers(store.removeFile(rel) ?? []);
          hook({ type: 'remove', rel });
        });
      }
      for (const [rel, t] of texts) {
        if (moves.some((m) => m[1] === rel)) continue;
        const h = hashes.get(rel);
        const prev = known.get(rel);
        if (prev === h) continue;
        each(rel, () => {
          if (!prev && !all) for (const r of linkersOf(rel)) deps.add(r);
          reindex(rel, t, h);
          hook({ type: 'upsert', rel, text: t, hash: h });
        });
      }
      for (const rel of deps) {
        if (texts.has(rel) && known.get(rel) !== hashes.get(rel)) continue;
        const t = textOf(rel);
        if (t !== null) each(rel, () => reindex(rel, t, sha(t)));
      }
      // notes whose id changed with a shared slug, and the notes that link them
      if (flipped.length) {
        const again = new Set(flipped);
        for (const r of flipped) for (const l of linkersOf(r)) again.add(l);
        for (const r of again) { if (texts.has(r) && known.get(r) !== hashes.get(r)) continue; const t = textOf(r); if (t !== null) each(r, () => reindex(r, t, sha(t))); }
      }
      // a folder note that became an entity or stopped being one is read again, and so are the notes that link it,
      // whose mentions of it change too
      for (let round = 0; round < 3 && recheck.size; round++) {
        const now = [...recheck].filter((r) => textOf(r) !== null && stale(r));
        recheck.clear();
        const again = new Set(now);
        for (const r of now) for (const l of linkersOf(r)) again.add(l);
        for (const r of again) { const t = textOf(r); if (t !== null) each(r, () => reindex(r, t, sha(t))); }
      }
      recheck.clear();
    });
    for (const [from] of pairs) reported.delete(from);
  }

  // the new paths whose text has the hash of a path that went: the other half of a move. Hashed in batches with a
  // yield between them; nothing to pair when no path went
  async function pairedWith(gone, fresh, known) {
    if (!gone.length || !fresh.length) return [];
    const want = new Set(gone.map((r) => known.get(r)));
    const out = [];
    for (let i = 0; i < fresh.length; i += BATCH) {
      for (const rel of fresh.slice(i, i + BATCH)) { const t = textOf(rel); if (t !== null && want.has(sha(t))) out.push(rel); }
      if (i + BATCH < fresh.length) await tick();
      if (closed) return [];
    }
    return out;
  }

  function build() {
    if (building) return building;
    building = (async () => {
      const t0 = now();
      state.phase = 'building';
      const rels = vindex.rels();
      const live = new Set(rels);
      const known = store.files();
      const stale = [...known.keys()].filter((r) => !live.has(r));
      state.total = rels.length;
      state.done = 0;
      emit('progress', status());
      // a note moved while Quorum was closed: its old path is stale and its new one is unknown, with the same text.
      // Both go in the first batch, wherever the new path sorts, so the move keeps the note's history
      const first = await pairedWith(stale, rels.filter((r) => !known.has(r)), known);
      let lastProgress = now();
      if (closed) return;
      for (let i = 0; i < rels.length || (i === 0 && stale.length); i += BATCH) {
        if (closed) return;
        const batch = rels.slice(i, i + BATCH);
        try { applyBatch(i === 0 ? [...new Set([...stale, ...first, ...batch])] : batch, { all: true }); } catch (err) { log('memory graph build', String(err?.stack ?? err)); }
        state.done = Math.min(rels.length, i + BATCH);
        // status() counts every node and edge: a progress event at most every 250 ms
        if (now() - lastProgress >= 250) { lastProgress = now(); emit('progress', status()); }
        await tick();
      }
      if (closed) return;
      state.phase = 'ready';
      state.ms = now() - t0;
      state.builtAt = now();
      try { store.meta('built_at', state.builtAt); } catch { /* closed */ }
      log('memory graph', `built ${rels.length} notes in ${state.ms}ms`);
      emit('ready', status());
      if (pending.size) { const p = [...pending]; pending.clear(); update(p); }
    })();
    return building;
  }

  // the watcher's changed paths; while the first build runs, or a large update is still going, they wait for it. Up to
  // BATCH paths apply at once; a larger burst (a git checkout) goes in batches with a yield between them, its moves and
  // removals in the first one
  let updating = null;
  // status() counts every node and edge, so a burst of edits sends one progress event after it, off the edit itself
  let progressTimer = null;
  const progressSoon = () => {
    if (progressTimer) return;
    progressTimer = setTimeout(() => { progressTimer = null; if (!closed) emit('progress', status()); }, 250);
    progressTimer.unref?.();
  };
  function update(rels) {
    if (closed) return;
    if (state.phase !== 'ready') { for (const r of rels ?? []) pending.add(r); return undefined; }
    if (updating) { for (const r of rels ?? vindex.rels()) pending.add(r); return updating; }
    const all = rels ?? vindex.rels();
    const t0 = now();
    const done = () => {
      // a reported move no update has seen by now never happened the way it was reported
      reported.clear();
      const ms = now() - t0;
      if (ms > 100) log('memory graph', `updated ${all.length} notes in ${ms}ms`);
      progressSoon();
    };
    if (all.length <= BATCH) {
      try { applyBatch(all); } catch (err) { log('memory graph update', String(err?.stack ?? err)); }
      done();
      return undefined;
    }
    updating = (async () => {
      const known = store.files();
      const gone = all.filter((r) => known.has(r) && textOf(r) === null);
      const first = new Set([...gone, ...await pairedWith(gone, all.filter((r) => !known.has(r)), known), ...[...reported].flat().filter((r) => all.includes(r))]);
      const rest = all.filter((r) => !first.has(r));
      const batches = [[...first, ...rest.slice(0, Math.max(0, BATCH - first.size))]];
      for (let i = Math.max(0, BATCH - first.size); i < rest.length; i += BATCH) batches.push(rest.slice(i, i + BATCH));
      for (const b of batches) {
        if (closed) return;
        try { applyBatch(b); } catch (err) { log('memory graph update', String(err?.stack ?? err)); }
        await tick();
      }
      done();
    })().finally(() => {
      updating = null;
      if (pending.size && !closed) { const p = [...pending]; pending.clear(); update(p); }
    });
    return updating;
  }

  function status() {
    const st = closed ? { files: 0, nodes: 0, edges: 0 } : store.stats();
    return { phase: closed ? 'closed' : state.phase, done: state.done, total: state.total, ms: state.ms, builtAt: state.builtAt, notes: st.files, nodes: st.nodes, edges: st.edges, byKind: st.byKind };
  }

  return {
    store,
    build,
    update,
    // moves seen before the index reports the paths: [{ from, to }]. The next update moves those notes with their history
    moved: (pairs) => { for (const p of pairs ?? []) if (p?.from && p?.to && p.from !== p.to) reported.set(String(p.from), String(p.to)); },
    status,
    on: (ev, fn) => { listeners[ev].add(fn); return () => listeners[ev].delete(fn); },
    onFileChange: (fn) => { fileHooks.add(fn); return () => fileHooks.delete(fn); },
    textOf,
    rels: () => vindex.rels(),
    ...query,
    close: () => { closed = true; clearTimeout(progressTimer); store.close(); },
  };
}
