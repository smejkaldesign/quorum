// The memory graph for one vault: a full build when the vault connects (batched, yielding between batches), then
// incremental updates from vindex's watcher by content hash, moves included. The text comes from vindex, so opted-out
// lines are already withheld and excluded or denied notes never arrive.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { DEFAULT_CONVENTIONS, ENTITY_FOLDERS, edgeKey, entityId, entityIds, extractNote, folderKind, noteKind, slugKey } from './extract.js';
import { createQuery } from './query.js';
import { NOTE_IDENTITY, openStore } from './store.js';
import { subjectOf, supersessions } from './temporal.js';

const BATCH = 100;
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
  // a note the opt-out list names in its path stays out, the same as its withheld lines
  const textOf = (rel) => { if (isExcluded(rel)) return null; const t = vindex.text?.(rel); return typeof t === 'string' ? t : null; };

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
    const ex = extractNote({ rel, text, note: vindex.note?.(rel) ?? null, resolve: (t, from) => vindex.resolve(t, from), conventions, isExcluded, linkedAs, kindOf, shared });
    for (const r of ex.refs) recheck.add(r);
    const backed = new Set(ex.nodes.filter((n) => n.rel).map((n) => n.id));
    const touched = new Set();
    for (const p of store.nodesByRel(rel)) {
      if (backed.has(p.id)) continue;
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
    const old = new Map();
    // an edge another writer added (props.by: the keeper, the contradiction checker) is not the note's to retract
    for (const e of store.edgesBySource(rel)) if (e.superseded_by == null && !e.props?.by) old.set(edgeKey(e), e);
    const added = [];
    for (const e of ex.edges) {
      const k = edgeKey(e);
      const cur = old.get(k);
      if (cur) { old.delete(k); if (cur.source_line !== e.source_line || cur.valid_from !== e.valid_from) store.updateEdge(cur.id, e); continue; }
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
          if (older && newer && older.src !== newer.src) store.addEdge({ src: newer.src, dst: older.src, kind: 'supersedes', provenance: 'rule', source_rel: newer.source_rel, source_line: newer.source_line, valid_from: newer.valid_from });
        }
      }
    }
    for (const e of old.values()) {
      if (store.edge(e.id)?.superseded_by != null) continue;
      touched.add(e.src); touched.add(e.dst);
      store.removeEdge(e.id);
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
  function apply(rels, { all = false } = {}) {
    const known = store.files();
    const flipped = countSlugs();
    const texts = new Map();
    const gone = [];
    const pairs = [...reported].filter(([from, to]) => rels.includes(from) || rels.includes(to) || (known.has(from) && textOf(from) === null));
    rels = [...new Set([...rels, ...pairs.flat()])];
    for (const rel of rels) {
      const t = textOf(rel);
      if (t === null) { if (known.has(rel)) gone.push(rel); } else texts.set(rel, t);
    }
    const hashes = new Map([...texts].map(([rel, t]) => [rel, sha(t)]));
    const moves = [];
    const taken = new Set();
    for (const [from, to] of pairs) {
      reported.delete(from);
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
        store.moveFile(from, to, idFor);
        hook({ type: 'move', from, to, hash: h });
        // a reported move can change the text too (its own links rewritten): search hears the new text
        if (h !== before) hook({ type: 'upsert', rel: to, text: texts.get(to), hash: h });
        for (const r of linkersOf(to)) deps.add(r);
        // the path is part of what the note is (its folder, its kind): read again, same history
        reindex(to, texts.get(to), h);
      }
      for (const rel of gone) {
        if (moved.has(rel)) continue;
        for (const r of linkersOf(rel)) deps.add(r);
        backers(store.removeFile(rel) ?? []);
        hook({ type: 'remove', rel });
      }
      for (const [rel, t] of texts) {
        if (moves.some((m) => m[1] === rel)) continue;
        const h = hashes.get(rel);
        const prev = known.get(rel);
        if (prev === h) continue;
        if (!prev && !all) for (const r of linkersOf(rel)) deps.add(r);
        reindex(rel, t, h);
        hook({ type: 'upsert', rel, text: t, hash: h });
      }
      for (const rel of deps) {
        if (texts.has(rel) && known.get(rel) !== hashes.get(rel)) continue;
        const t = textOf(rel);
        if (t !== null) reindex(rel, t, sha(t));
      }
      // notes whose id changed with a shared slug, and the notes that link them
      if (flipped.length) {
        const again = new Set(flipped);
        for (const r of flipped) for (const l of linkersOf(r)) again.add(l);
        for (const r of again) { if (texts.has(r) && known.get(r) !== hashes.get(r)) continue; const t = textOf(r); if (t !== null) reindex(r, t, sha(t)); }
      }
      // a folder note that became an entity or stopped being one is read again, and so are the notes that link it,
      // whose mentions of it change too
      for (let round = 0; round < 3 && recheck.size; round++) {
        const now = [...recheck].filter((r) => textOf(r) !== null && stale(r));
        recheck.clear();
        const again = new Set(now);
        for (const r of now) for (const l of linkersOf(r)) again.add(l);
        for (const r of again) { const t = textOf(r); if (t !== null) reindex(r, t, sha(t)); }
      }
      recheck.clear();
    });
  }

  function build() {
    if (building) return building;
    building = (async () => {
      const t0 = now();
      state.phase = 'building';
      const rels = vindex.rels();
      const live = new Set(rels);
      const stale = [...store.files().keys()].filter((r) => !live.has(r));
      state.total = rels.length;
      state.done = 0;
      emit('progress', status());
      // moves and removals need the whole picture, so the gone paths go with the first batch
      for (let i = 0; i < rels.length || (i === 0 && stale.length); i += BATCH) {
        if (closed) return;
        const batch = rels.slice(i, i + BATCH);
        try { apply(i === 0 ? [...stale, ...batch] : batch, { all: true }); } catch (err) { log('memory graph build', String(err?.stack ?? err)); }
        state.done = Math.min(rels.length, i + BATCH);
        emit('progress', status());
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

  // the watcher's changed paths; while the first build runs they wait for it
  function update(rels) {
    if (closed) return;
    if (state.phase !== 'ready') { for (const r of rels ?? []) pending.add(r); return; }
    const t0 = now();
    try { apply(rels ?? vindex.rels()); } catch (err) { log('memory graph update', String(err?.stack ?? err)); }
    // a reported move no update has seen by now never happened the way it was reported
    reported.clear();
    const ms = now() - t0;
    if (ms > 100) log('memory graph', `updated ${rels?.length ?? 'all'} notes in ${ms}ms`);
    emit('progress', status());
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
    close: () => { closed = true; store.close(); },
  };
}
