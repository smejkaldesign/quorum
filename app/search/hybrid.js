// Hybrid search over the chunks (search/index.js). Three ranked lists, merged with reciprocal rank fusion:
//   fts    BM25 from FTS5 over heading and text
//   vec    cosine between the query's vector and every chunk vector (brute force; fine to a few hundred thousand)
//   graph  notes near the query: nodes the query names (graph.find) and nodes of the top fts and vec hits, expanded
//          one or two hops over current edges (graph.edgesOf)
// The fused score is then scaled by recency (newer notes a little higher) and supersession (a note whose facts were
// replaced ranks lower). The graph is optional; without it the graph list is empty. Results are trimmed to a token
// budget, strongest first, with a summary of what was left out.
import { tokensOf } from './chunk.js';

// graph: the boost from the top hits' neighbors when the query names no node. The eval found no gain from it and a loss
// on paraphrased questions, so it is off; graphNamed applies when the query names a node the graph knows
export const WEIGHTS = Object.freeze({ fts: 1, vec: 1, graph: 0, graphNamed: 3, rrfK: 60, recency: 0.15, halfLifeDays: 120, superseded: 0.6, kindHint: 2, perNote: 3, pool: 100 });
// a word in the query that names a kind of note; chunks of that kind rank higher (meetings with Ada, Heron decisions)
const KIND_WORDS = { meeting: 'meeting', meetings: 'meeting', decision: 'decision', decisions: 'decision', project: 'project', projects: 'project', person: 'person' };
// edge kinds by how strongly they tie two notes for search
const EDGE_WEIGHT = { links_to: 1, embeds: 1, attended: 0.9, works_on: 0.9, member_of: 0.7, decided_in: 1, decision_about: 1, about: 0.8, mentions: 0.6, supersedes: 0.8, tagged: 0.2, in_folder: 0 };
const ITEM_OVERHEAD = 12;
const DAY = 86400000;

// the note behind a node id: note:<rel>, meeting:<rel> and decision:<rel>#<hash> carry it; entity nodes do not
const relOf = (id) => { const m = typeof id === 'string' ? id.match(/^(?:note|meeting|decision):(.+?\.md)(?:#.*)?$/i) : null; return m ? m[1] : null; };
const words = (q) => (String(q).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 32);
// an FTS5 query that ranks any of the words, each quoted so no word reads as syntax
export const ftsQuery = (q) => [...new Set(words(q))].map((w) => `"${w}"`).join(' OR ');

export function createHybridSearch({ db, embedder = null, graph = () => null, version = () => 0, weights = WEIGHTS, now = () => Date.now() }) {
  const q = {
    fts: db.prepare('SELECT rowid AS id, bm25(chunks_fts, 2.0, 1.0) AS s FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY s LIMIT ?'),
    chunk: db.prepare('SELECT c.id AS id, c.rel AS rel, c.heading AS heading, c.start_line AS start_line, c.end_line AS end_line, c.text AS text, c.tokens AS tokens, f.kind AS kind, f.date AS date FROM chunks c JOIN search_files f ON f.rel = c.rel WHERE c.id = ?'),
    firstOf: db.prepare('SELECT id FROM chunks WHERE rel = ? ORDER BY start_line LIMIT 1'),
    vecs: db.prepare('SELECT chunk, vec FROM vectors WHERE model = ?'),
    total: db.prepare('SELECT COUNT(*) AS n FROM chunks'),
  };
  // every vector of the model in one matrix, read again after the index wrote vectors
  let mat = null;
  function matrix() {
    if (!embedder) return null;
    const v = version();
    if (mat?.v === v) return mat;
    const rows = q.vecs.all(embedder.id);
    const dim = embedder.dim;
    const ids = new Array(rows.length);
    const data = new Float32Array(rows.length * dim);
    rows.forEach((r, i) => { ids[i] = r.chunk; const b = r.vec; data.set(new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)).subarray(0, dim), i * dim); });
    // the share of chunks with a vector: while the queue still runs, the vector list ranks only some of them
    const total = q.total.get().n;
    mat = { v, ids, data, dim, coverage: total ? Math.min(1, rows.length / total) : 0 };
    return mat;
  }

  const chunkCache = new Map();
  const getChunk = (id) => { if (!chunkCache.has(id)) chunkCache.set(id, q.chunk.get(id) ?? null); return chunkCache.get(id); };

  function ftsList(text, pool) {
    const m = ftsQuery(text);
    if (!m) return [];
    try { return q.fts.all(m, pool).map((r) => r.id); } catch { return []; }
  }

  async function vecList(text, pool) {
    const m = matrix();
    if (!m || !m.ids.length) return [];
    const [qv] = await embedder.embed([`${embedder.query ?? ''}${text}`]);
    const { data, dim, ids } = m;
    const scores = new Float32Array(ids.length);
    for (let i = 0; i < ids.length; i++) { let s = 0; const o = i * dim; for (let j = 0; j < dim; j++) s += data[o + j] * qv[j]; scores[i] = s; }
    const order = Array.from(ids.keys()).sort((a, b) => scores[b] - scores[a]).slice(0, pool);
    return order.map((i) => ids[i]);
  }

  // rel -> score from the graph: seeds are nodes the query names (weight 1) and the notes of the top hits (0.5);
  // a seed backed by a note counts itself at its weight, its neighbors count by edge kind, and a neighbor that is no note (a person,
  // a project) passes half its weight on to the notes around it
  function graphScores(g, text, hitRels) {
    const score = new Map();
    // each seed adds its strongest tie to a note once, so two notes linked both ways do not count double
    let mine = new Map();
    const add = (rel, s) => { if (rel && s > (mine.get(rel) ?? 0)) mine.set(rel, s); };
    const flush = () => { for (const [rel, s] of mine) score.set(rel, (score.get(rel) ?? 0) + s); mine = new Map(); };
    const seeds = new Map();
    // the query words inside a name the graph knows, which are no kind hint (the "project" in Project Heron)
    const inName = new Set();
    const w = words(text);
    for (let n = Math.min(3, w.length); n >= 1; n--) {
      for (let i = 0; i + n <= w.length; i++) {
        let found;
        try { found = g.find(w.slice(i, i + n).join(' ')) ?? []; } catch { found = []; }
        // an ambiguous short name seeds nothing
        // a folder or a tag shares its name with ordinary words (meetings, decisions), so it names nothing here
        if (Array.isArray(found)) found = found.filter((nd) => nd.kind !== 'folder' && nd.kind !== 'tag');
        if (!Array.isArray(found) || !found.length || found.length > 3) continue;
        for (let j = i; j < i + n; j++) inName.add(j);
        for (const nd of found) if (!seeds.has(nd.id)) seeds.set(nd.id, { w: 1 / found.length, rel: nd.rel ?? relOf(nd.id) });
      }
    }
    const named = seeds.size > 0;
    for (const rel of hitRels) if (!seeds.has(`note:${rel}`)) seeds.set(`note:${rel}`, { w: 0.5, rel });
    const around = (id) => { try { return g.edgesOf(id, { dir: 'both', current: true }) ?? []; } catch { return []; } };
    const other = (e, id) => (e.src === id ? e.dst : e.src);
    for (const [id, s] of seeds) {
      add(s.rel, s.w);
      for (const e of around(id)) {
        const ew = EDGE_WEIGHT[e.kind] ?? 0.3;
        if (!ew) continue;
        const nb = other(e, id);
        const r = relOf(nb);
        if (r) { add(r, s.w * ew); continue; }
        for (const e2 of around(nb).slice(0, 200)) {
          const ew2 = EDGE_WEIGHT[e2.kind] ?? 0.3;
          const r2 = relOf(other(e2, nb));
          if (ew2 && r2 && r2 !== s.rel) add(r2, s.w * ew * ew2 * 0.5);
        }
      }
      flush();
    }
    return { score, named, nameWords: new Set([...inName].map((j) => w[j])) };
  }

  // a note whose facts a newer one replaced: another note supersedes it, or every decision made in it (decided_in)
  // has had what it decided (decision_about) superseded
  function superseded(g, rel) {
    if (!g) return false;
    try {
      const ids = [`note:${rel}`, `meeting:${rel}`];
      if (ids.some((id) => (g.edgesOf(id, { dir: 'in', kinds: ['supersedes'] }) ?? []).length)) return true;
      const made = ids.flatMap((id) => (g.edgesOf(id, { dir: 'in', kinds: ['decided_in'] }) ?? []).map((e) => e.src));
      const facts = made.flatMap((d) => g.edgesOf(d, { dir: 'out', kinds: ['decision_about'], current: false }) ?? []);
      return facts.length > 0 && facts.every((e) => e.superseded_by != null);
    } catch { return false; }
  }

  // signals: which lists run ('fts', 'vec', 'graph'), for the eval; folders, kinds, since: filters on the note
  async function search({ q: text = '', budget = 1500, k = 20, folders = null, kinds = null, since = null, signals = ['fts', 'vec', 'graph'] } = {}) {
    chunkCache.clear();
    const qs = String(text).trim();
    const empty = { results: [], truncated: { shown: 0, total: 0, budgetNeeded: 0 } };
    if (!qs) return empty;
    const w = weights;
    const sinceT = since ? Date.parse(since) : NaN;
    const ok = (c) => c
      && (!folders?.length || folders.some((f) => c.rel === f || c.rel.startsWith(`${String(f).replace(/\/+$/, '')}/`)))
      && (!kinds?.length || kinds.includes(c.kind))
      && (Number.isNaN(sinceT) || c.date >= sinceT);
    const keep = (ids) => ids.filter((id) => ok(getChunk(id)));
    const on = new Set(signals);
    const fts = on.has('fts') ? keep(ftsList(qs, w.pool)) : [];
    const vec = on.has('vec') ? keep(await vecList(qs, w.pool)) : [];
    const fused = new Map();
    const parts = new Map();
    const put = (id, key, rank, weight) => {
      fused.set(id, (fused.get(id) ?? 0) + weight / (w.rrfK + rank));
      const p = parts.get(id) ?? parts.set(id, {}).get(id);
      p[key] = rank + 1;
    };
    fts.forEach((id, i) => put(id, 'fts', i, w.fts));
    // a chunk with no vector yet would lose to every chunk that has one, so the list counts as much as it covers
    const cover = vec.length ? matrix()?.coverage ?? 1 : 0;
    vec.forEach((id, i) => put(id, 'vec', i, w.vec * cover));
    const g = on.has('graph') ? graph() : null;
    let nameWords = new Set();
    let namedNode = false;
    if (g) {
      // the best chunk each note already has in the lists, or its first chunk
      const best = new Map();
      for (const id of [...fts, ...vec]) { const r = getChunk(id).rel; if (!best.has(r)) best.set(r, id); }
      const hitRels = [...best.keys()].slice(0, 5);
      const gr = graphScores(g, qs, hitRels);
      const { score, named } = gr;
      nameWords = gr.nameWords;
      namedNode = named;
      const gs = [...score].sort((a, b) => b[1] - a[1]).slice(0, w.pool);
      // a query that names a node leans on the graph; one that names none gets a light boost from the hits' neighbors
      const gw = named ? w.graphNamed : w.graph;
      let rank = 0;
      if (!gw) gs.length = 0;
      for (const [rel] of gs) {
        const id = best.get(rel) ?? q.firstOf.get(rel)?.id;
        if (id == null || !ok(getChunk(id))) continue;
        put(id, 'graph', rank++, gw);
      }
    }
    const t = now();
    // a kind word counts only beside a name the graph knows (meetings with Ada): without one, the "project" in a
    // project name the graph missed would lift every project note
    const hinted = namedNode ? new Set(words(qs).filter((x) => !nameWords.has(x)).map((x) => KIND_WORDS[x]).filter(Boolean)) : new Set();
    const scored = [...fused].map(([id, s]) => {
      const c = getChunk(id);
      const hint = hinted.has(c.kind) ? w.kindHint : 1;
      const age = Math.max(0, (t - (c.date || 0)) / DAY);
      const recency = 1 + w.recency * Math.pow(0.5, age / w.halfLifeDays);
      const sup = superseded(g, c.rel);
      return { c, score: s * recency * hint * (sup ? w.superseded : 1), parts: { ...parts.get(id), recency: Math.round(recency * 1000) / 1000, superseded: sup, ...(hint !== 1 ? { kindHint: true } : {}) } };
    }).sort((a, b) => b.score - a.score);
    const perNote = new Map();
    const top = [];
    for (const x of scored) {
      const n = perNote.get(x.c.rel) ?? 0;
      if (n >= w.perNote) continue;
      perNote.set(x.c.rel, n + 1);
      top.push(x);
      if (top.length >= k) break;
    }
    const cost = (x) => (x.c.tokens || tokensOf(x.c.text)) + ITEM_OVERHEAD;
    const results = [];
    let used = 0;
    for (const x of top) {
      if (used + cost(x) > budget && results.length) break;
      // a first result larger than the whole budget comes back cut to it
      const room = Math.max(0, budget - ITEM_OVERHEAD) * 4;
      const text = cost(x) > budget ? x.c.text.slice(0, room) : x.c.text;
      used += Math.min(cost(x), budget);
      results.push({ rel: x.c.rel, heading: x.c.heading, start_line: x.c.start_line, end_line: x.c.end_line, text, kind: x.c.kind, score: Math.round(x.score * 1e5) / 1e5, parts: x.parts, ...(text.length < x.c.text.length ? { cut: true } : {}) });
    }
    const budgetNeeded = top.reduce((s, x) => s + cost(x), 0);
    return { results, truncated: { shown: results.length, total: top.length, budgetNeeded } };
  }

  return { search };
}
