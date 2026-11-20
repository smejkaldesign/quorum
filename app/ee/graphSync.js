// Cloud graph sync (docs/specs/memory-graph.md, wave 2; migration 0049). For the knowledge bases a team shares, each Mac
// publishes the memory graph edges it extracted from its own notes in those knowledge bases, and reads teammates' edges
// into its local graph, so entity, graph_query, decisions and search's graph boost see the team's connections.
//
// What leaves the Mac: only edges whose source note the server holds in a knowledge base, whose text on disk is the
// text sync pushed (so the guard that let the note sync passed on that same text), and that the vault index reads. A
// private folder, a confidential note, an opted-out customer or a note sync withholds never publishes; a note that
// becomes one withdraws its edges. An edge end that is another note is published only when that note sits in the same
// knowledge base, so a reader never learns the title or path of a note they cannot open. A model edge goes only when it
// is confident or a person approved it (the server refuses the rest too). A fact a private note superseded stays here.
//
// What comes in: teammates' edges, with their provenance and source line, under the source path team:<path> and a team
// mark in props (knowledge base, note, author, edge key). Entities (people, projects, companies, tags) are shared by id,
// so a teammate's "attended" edge points at the same person node as yours; a teammate's notes, meetings and decisions get
// ids of their own (note:team:<path>). Supersession is sent as edge keys and resolved again after every pull.
//
// Incremental and offline safe: the server keeps one hash per note's edge set (graph_heads); a publish replaces a note's
// set in one transaction (graph_put) only when its hash changed, and a pull reads only the notes whose hash changed.
// Nothing is marked done before the server answered, so a failed run leaves the difference in place and the next run,
// after the next pull, sends it again. A note that leaves its knowledge base or is deleted loses its rows on the server
// (a trigger), drops out of graph_heads, and leaves the local graph at the next pull.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { EDGE_KINDS, NODE_KINDS, NOTE_IDENTITY, PROVENANCE } from '../graph/store.js';
import { ulid } from './sync.js';

// a model edge below this confidence waits for a person's approval in Review (migration 0049 refuses it too)
export const MODEL_PUBLISH_MIN = 0.8;
const PAGE = 1000;
// note ids per links read, and graph_put calls per run; the rest go on the next run
const NOTE_BATCH = 50;
const PUTS_PER_RUN = 100;
const MAX_EDGES = 2000;
// runs closer together than this become one trailing run: every pull asks for one, and a burst of edits pulls often
const MIN_GAP = 15000;
const META = 'team_graph';
const COLUMNS = 'from_note, kind, provenance, src, src_kind, src_name, dst, dst_kind, dst_name, source_line, confidence, valid_from, valid_to, edge_key, superseded_by_key, graph_hash, props, ends';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const iso = (t) => (t == null ? null : new Date(t).toISOString());
const msOf = (s) => { const t = s ? Date.parse(s) : NaN; return Number.isNaN(t) ? null : t; };
const EMPTY_SET = sha256('[]');
// the local source path and node id of what a teammate wrote, apart from this vault's own paths and ids
export const teamRel = (rel) => `team:${rel}`;
export const teamId = (id) => String(id).replace(/^([a-z_]+):/, '$1:team:');
// a vault-relative markdown path, or null
export const safePath = (p) => {
  const rel = String(p ?? '').split('\\').join('/');
  return rel.endsWith('.md') && !rel.startsWith('/') && !rel.split('/').some((s) => s === '' || s === '.' || s === '..') ? rel : null;
};
export const publishable = (e) => e.provenance !== 'model' || e.props?.approved === true || (Number(e.confidence) >= MODEL_PUBLISH_MIN);
const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && !(typeof v === 'object' && !Object.keys(v).length)));

export function createGraphSync({ account, graph = () => null, vault = () => null, isExcluded = () => false, isExcludedText = () => false, log = () => {}, minGap = MIN_GAP, now = Date.now }) {
  let running = null;
  let timer = null;
  let lastAt = 0;
  let last = { published: 0, withdrawn: 0, imported: 0, removed: 0, waiting: 0, error: null, at: null };

  const target = () => {
    const s = account.state();
    const client = account.client();
    const g = graph();
    if (!s.sync || !s.signedIn || !s.workspace || !s.userId || !client || !g?.store || g.status?.().phase !== 'ready') return null;
    return { client, ws: s.workspace.id, me: s.userId, g, store: g.store, vault: vault() };
  };
  // every page of a query; make() builds a fresh builder per page
  async function all(make, what) {
    const rows = [];
    for (let o = 0; ; o += PAGE) {
      const { data, error } = await make().range(o, o + PAGE - 1);
      if (error) throw new Error(`${what}: ${error.message}`);
      rows.push(...(data ?? []));
      if (!data || data.length < PAGE) return rows;
    }
  }

  // the import state lives in the graph's own database, so a graph rebuilt from scratch starts the import over
  const readCache = (store) => { try { const c = JSON.parse(store.meta(META) ?? '{}'); return { ws: c.ws ?? null, notes: c.notes ?? {} }; } catch { return { ws: null, notes: {} }; } };
  const writeCache = (store, c) => store.meta(META, JSON.stringify(c));

  // ---- publish

  // one end of an edge as teammates may see it, or null when it must stay on this Mac
  function end(store, id, kb, eligible) {
    const n = store.node(id);
    const kind = n?.kind ?? String(id).split(':')[0];
    const name = String(n?.name ?? id);
    if (isExcludedText(name) || isExcludedText(String(id))) return null;
    if (n?.rel && isExcluded(n.rel)) return null;
    const same = !!n?.rel && eligible.get(n.rel)?.kb === kb;
    if (NOTE_IDENTITY.has(kind)) return same ? { id, kind, name, rel: n.rel, props: kind === 'note' ? null : n.props } : null;
    // an entity is shared by name; one whose id is a path (two notes of one name) names its folder, so it goes only
    // when its note is in the same knowledge base
    if (n?.rel && !same && String(id).includes('/')) return null;
    return { id, kind, name, rel: same ? n.rel : null, props: null };
  }

  const rowOf = (x, n, extra = {}) => compact({
    kind: x.e.kind, provenance: x.e.provenance, src: x.src.id, src_kind: x.src.kind, src_name: x.src.name, dst: x.dst.id, dst_kind: x.dst.kind, dst_name: x.dst.name,
    source_line: x.e.source_line ?? null, confidence: x.e.confidence ?? null, valid_from: iso(x.e.valid_from), valid_to: iso(x.e.valid_to), edge_key: x.key, note_hash: n.hash,
    props: x.e.props && Object.keys(x.e.props).length ? x.e.props : null,
    ends: compact({ src: compact({ rel: x.src.rel, props: x.src.props }), dst: compact({ rel: x.dst.rel, props: x.dst.props }) }),
    ...extra,
  });

  async function publish(t, heads, counts) {
    const notes = await all(() => t.client.from('notes').select('id, path, kb_id, hash').eq('workspace_id', t.ws).eq('user_id', t.me).not('kb_id', 'is', null).is('deleted_at', null).order('id'), 'knowledge base notes');
    const own = new Map(heads.filter((h) => h.author === t.me).map((h) => [h.note_id, h]));
    // eligible: in a KB, the text sync pushed, read by the graph as it is now. withdraw: in a KB but withheld here now.
    // Everything else waits for a later run (an edit not pushed yet, a graph still catching up, a note on another Mac)
    const eligible = new Map();
    const withdraw = [];
    const waiting = new Set();
    for (const n of notes) {
      const rel = safePath(n.path);
      if (!rel || isExcluded(rel)) { withdraw.push(n.id); continue; }
      let raw = null;
      try { raw = t.vault ? readFileSync(path.join(t.vault, rel), 'utf8') : null; } catch { /* not on this Mac */ }
      if (raw === null) continue;
      if (isExcludedText(raw)) { withdraw.push(n.id); continue; }
      if (sha256(raw) !== n.hash) { waiting.add(rel); continue; }
      const text = t.g.textOf(rel);
      if (text === null) { withdraw.push(n.id); continue; }
      if (t.store.fileHash(rel) !== sha256(text)) { waiting.add(rel); continue; }
      eligible.set(rel, { id: n.id, kb: n.kb_id, hash: n.hash });
    }

    // every edge that may go gets its key first, so supersession can point across notes
    const keyOf = new Map();
    const plan = new Map();
    for (const [rel, n] of eligible) {
      const list = [];
      for (const e of t.store.edgesFromSource(rel)) {
        const pair = e.kind === 'supersedes' && e.props?.by === 'supersession';
        if (!pair && !publishable(e)) continue;
        const src = end(t.store, e.src, n.kb, eligible), dst = end(t.store, e.dst, n.kb, eligible);
        if (!src || !dst) continue;
        if (pair) { list.push({ e, src, dst, pair }); continue; }
        const key = sha256(JSON.stringify([rel, e.src, e.dst, e.kind, e.provenance, e.source_line ?? null, e.confidence ?? null, e.valid_from ?? null, e.props ?? {}]));
        keyOf.set(e.id, key);
        list.push({ e, src, dst, key });
      }
      plan.set(rel, list);
    }
    // a fact replaced by one that stays here (a private note's) is history this Mac keeps to itself. When what replaced
    // it is in a note that waits for its push, the note waits too, so its set does not change twice
    const pending = (id) => waiting.has(t.store.edge(id)?.source_rel);
    for (let again = true; again;) {
      again = false;
      for (const [rel, list] of plan) {
        for (const x of list) {
          if (x.pair) { if (pending(x.e.props.old) || pending(x.e.props.new)) waiting.add(rel); continue; }
          if (!keyOf.has(x.e.id) || x.e.superseded_by == null || keyOf.has(x.e.superseded_by)) continue;
          if (pending(x.e.superseded_by)) { if (!waiting.has(rel)) { waiting.add(rel); again = true; } continue; }
          keyOf.delete(x.e.id);
          again = true;
        }
      }
    }
    counts.waiting += waiting.size;

    let puts = 0;
    const put = async (noteId, graphHash, rows) => {
      const { error } = await t.client.rpc('graph_put', { note_id: noteId, graph_hash: graphHash, edges: rows.map((r) => ({ id: ulid(), ...r })) });
      if (error) throw new Error(`graph put: ${error.message}`);
      puts++;
    };
    for (const [rel, n] of eligible) {
      if (waiting.has(rel)) continue;
      if (puts >= PUTS_PER_RUN) { counts.waiting++; continue; }
      const rows = new Map();
      for (const x of plan.get(rel)) {
        if (x.pair) {
          const oldKey = keyOf.get(x.e.props.old), newKey = keyOf.get(x.e.props.new);
          if (!oldKey || !newKey) continue;
          const key = sha256(JSON.stringify([rel, 'supersedes', x.e.src, x.e.dst, oldKey, newKey]));
          rows.set(key, rowOf({ ...x, key, e: { ...x.e, props: { by: 'supersession', old_key: oldKey, new_key: newKey } } }, n));
        } else if (keyOf.has(x.e.id)) {
          rows.set(x.key, rowOf(x, n, x.e.superseded_by != null ? { superseded_by_key: keyOf.get(x.e.superseded_by) } : {}));
        }
      }
      let list = [...rows.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, r]) => r);
      if (list.length > MAX_EDGES) { log('graph sync', `${rel}: ${list.length} edges, publishing the first ${MAX_EDGES}`); list = list.slice(0, MAX_EDGES); }
      const graphHash = list.length ? sha256(JSON.stringify(list)) : EMPTY_SET;
      const head = own.get(n.id);
      if (head ? head.graph_hash === graphHash : !list.length) continue;
      try { await put(n.id, graphHash, list); counts.published++; } catch (err) { log('graph sync', rel, err.message); counts.failed++; }
    }
    for (const id of withdraw) {
      if (!own.has(id) || puts >= PUTS_PER_RUN) continue;
      try { await put(id, EMPTY_SET, []); counts.withdrawn++; } catch (err) { log('graph sync', 'withdraw', err.message); counts.failed++; }
    }
  }

  // ---- pull

  // a teammate's node in this graph: entities by their own id, a note, meeting or decision under team ids with its
  // team path as its source
  function nodeIn(store, id, kind, name, e) {
    if (typeof id !== 'string' || !NODE_KINDS.includes(kind)) return null;
    const label = String(name ?? id).slice(0, 300);
    if (isExcludedText(label) || isExcludedText(id)) return null;
    if (NOTE_IDENTITY.has(kind)) {
      const rel = safePath(e?.rel);
      if (!rel) return null;
      const tid = teamId(id);
      store.upsertNode({ id: tid, kind, name: label, rel: teamRel(rel), props: e?.props && typeof e.props === 'object' ? e.props : {} });
      store.setAliases(tid, [label]);
      return tid;
    }
    if (!store.node(id)) { store.upsertNode({ id, kind, name: label }); store.setAliases(id, [label]); }
    return id;
  }

  function addRow(store, h, r) {
    if (!EDGE_KINDS.includes(r.kind) || !PROVENANCE.includes(r.provenance) || !publishable(r)) return false;
    const ends = r.ends && typeof r.ends === 'object' ? r.ends : {};
    const src = nodeIn(store, r.src, r.src_kind, r.src_name, ends.src), dst = nodeIn(store, r.dst, r.dst_kind, r.dst_name, ends.dst);
    if (!src || !dst) return false;
    const props = { ...(r.props && typeof r.props === 'object' ? r.props : {}) };
    // a teammate's supersedes edge keeps its pair by key; the store's own pair bookkeeping (by: supersession) is local
    if (props.by === 'supersession') delete props.by;
    props.team = compact({ kb: h.kb_id, note: h.note_id, author: h.author, key: r.edge_key, superseded_by_key: r.superseded_by_key ?? null });
    store.addEdge({ src, dst, kind: r.kind, provenance: r.provenance, source_rel: teamRel(h.path), source_line: Number.isInteger(r.source_line) ? r.source_line : null, confidence: typeof r.confidence === 'number' ? r.confidence : 1, valid_from: msOf(r.valid_from), valid_to: msOf(r.valid_to), props });
    return true;
  }

  // a teammate's note's edges, and with forget its nodes too; an end left with no edges goes with them
  function clearNote(store, rel, forget) {
    const touched = new Set();
    for (const e of store.edgesFromSource(rel)) { touched.add(e.src); touched.add(e.dst); store.removeEdge(e.id); }
    if (forget) for (const x of store.removeFile(rel)) touched.add(x);
    return touched;
  }
  function tidy(store, touched, live) {
    store.prune(touched);
    for (const id of touched) {
      const n = store.node(id);
      if (n?.rel?.startsWith('team:') && !live.has(n.rel) && !store.edgesOf(id, { current: false }).length) store.dropNode(id);
    }
  }

  // supersession by edge key, across every teammate's note: run after each pull, since a re-imported edge has a new id
  function resolve(store) {
    const db = store.db();
    const open = db.prepare("select id, valid_to, json_extract(props, '$.team.superseded_by_key') as k from edges where source_rel like 'team:%' and superseded_by is null and json_extract(props, '$.team.superseded_by_key') is not null").all();
    const byKey = db.prepare("select id from edges where source_rel like 'team:%' and json_extract(props, '$.team.key') = ? limit 1");
    store.tx(() => { for (const r of open) { const by = byKey.get(r.k); if (by) store.supersede(r.id, by.id, r.valid_to ?? now()); } });
  }

  function forgetAll(store, cache) {
    const rels = Object.values(cache.notes).map((c) => c.rel);
    store.tx(() => { const touched = new Set(); for (const rel of rels) for (const x of clearNote(store, rel, true)) touched.add(x); tidy(store, touched, new Set()); });
    return rels.length;
  }

  async function pull(t, heads, counts) {
    const theirs = heads.filter((h) => h.author !== t.me && safePath(h.path));
    let cache = readCache(t.store);
    if (cache.ws !== t.ws) { counts.removed += forgetAll(t.store, cache); cache = { ws: t.ws, notes: {} }; writeCache(t.store, cache); }
    const live = new Map(theirs.map((h) => [h.note_id, h]));
    const liveRels = new Set(theirs.map((h) => teamRel(h.path)));
    const gone = Object.entries(cache.notes).filter(([id]) => !live.has(id));
    if (gone.length) {
      t.store.tx(() => { const touched = new Set(); for (const [, c] of gone) for (const x of clearNote(t.store, c.rel, true)) touched.add(x); tidy(t.store, touched, liveRels); });
      for (const [id] of gone) delete cache.notes[id];
      counts.removed += gone.length;
      writeCache(t.store, cache);
    }
    const changed = theirs.filter((h) => cache.notes[h.note_id]?.hash !== h.graph_hash || cache.notes[h.note_id]?.rel !== teamRel(h.path));
    for (let i = 0; i < changed.length; i += NOTE_BATCH) {
      const batch = changed.slice(i, i + NOTE_BATCH);
      const rows = await all(() => t.client.from('links').select(COLUMNS).eq('workspace_id', t.ws).in('from_note', batch.map((h) => h.note_id)).not('kind', 'is', null).is('deleted_at', null).order('id'), 'team edges');
      const by = new Map();
      for (const r of rows) (by.get(r.from_note) ?? by.set(r.from_note, []).get(r.from_note)).push(r);
      for (const h of batch) {
        const list = by.get(h.note_id) ?? [];
        const prev = cache.notes[h.note_id];
        const rel = teamRel(h.path);
        t.store.tx(() => {
          const touched = new Set();
          if (prev && prev.rel !== rel) for (const x of clearNote(t.store, prev.rel, true)) touched.add(x);
          for (const x of clearNote(t.store, rel, false)) touched.add(x);
          for (const r of list) if (!addRow(t.store, h, r)) counts.skipped++;
          tidy(t.store, touched, liveRels);
        });
        cache.notes[h.note_id] = { hash: list[0]?.graph_hash ?? h.graph_hash, rel };
        counts.imported++;
      }
      // the notes read so far stay recorded when a later batch fails
      writeCache(t.store, cache);
    }
    resolve(t.store);
  }

  async function once() {
    const t = target();
    if (!t) return { skipped: true };
    const counts = { published: 0, withdrawn: 0, imported: 0, removed: 0, waiting: 0, skipped: 0, failed: 0 };
    let error = null;
    try {
      const heads = await all(() => t.client.rpc('graph_heads', { workspace_id: t.ws }).order('note_id'), 'graph heads');
      await pull(t, heads, counts);
      await publish(t, heads, counts);
    } catch (err) { error = err?.message ?? String(err); log('graph sync', error); }
    last = { ...counts, error, at: new Date(now()).toISOString() };
    if (counts.published || counts.withdrawn || counts.imported || counts.removed) log('graph sync', `published ${counts.published}, withdrew ${counts.withdrawn}, read ${counts.imported}, removed ${counts.removed} team notes`);
    return last;
  }

  // one run at a time; a call during a run, or soon after one, becomes a single trailing run
  function run() {
    if (running) return running;
    const wait = lastAt + minGap - now();
    if (wait > 0) {
      if (!timer) { timer = setTimeout(() => { timer = null; run().catch(() => {}); }, wait); timer.unref?.(); }
      return Promise.resolve({ deferred: true });
    }
    lastAt = now();
    running = once().finally(() => { running = null; lastAt = now(); });
    return running;
  }

  // signed out, sync off, or another workspace: the team's edges leave this graph
  function clear() {
    const g = graph();
    if (!g?.store) return 0;
    try {
      const cache = readCache(g.store);
      const n = forgetAll(g.store, cache);
      writeCache(g.store, { ws: null, notes: {} });
      return n;
    } catch (err) { log('graph sync clear', err?.message ?? err); return 0; }
  }

  const stop = () => { clearTimeout(timer); timer = null; };
  return { run, clear, stop, status: () => ({ running: !!running, ...last }) };
}
