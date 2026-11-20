// Communities and hubs over the memory graph, with no model. Pure but for readGraph: the input is plain nodes and edges,
// so the worker (communityWorker.js) and the tests run it the same way. Louvain modularity with a connectivity split after each level
// (each community is one connected piece, the guarantee Leiden adds), weighted by edge kind and provenance. Nodes are
// visited in id order and ties go to the lower index, so one graph always gives the same communities.

// how much an edge kind and a provenance tie two nodes together. Tags and folders join thousands of notes and say little
// about topic: they name communities (nameCommunity) and never shape them
export const KIND_W = { decision_about: 1, decided_in: 0.9, attended: 0.9, works_on: 0.9, member_of: 0.9, about: 0.9, contradicts: 0.8, supersedes: 0.7, embeds: 0.7, mentions: 0.6, links_to: 0.6 };
export const PROV_W = { person: 1, explicit: 1, rule: 0.8, model: 0.6 };
export const LABEL_KINDS = new Set(['tag', 'folder']);
// kinds that make a good name for a topic, best first
const NAMING = ['project', 'topic', 'company', 'person', 'note', 'meeting', 'decision'];
const MAX_LEVELS = 20;
const MAX_PASSES = 50;

// the nodes and current edges detection reads, from a memory database connection (node:sqlite)
export const readGraph = (db) => ({
  nodes: db.prepare('select id, kind, name, rel from nodes').all(),
  edges: db.prepare('select src, dst, kind, provenance, confidence from edges where superseded_by is null').all(),
});

export const edgeWeight = (e) => (KIND_W[e.kind] ?? 0) * (PROV_W[e.provenance] ?? 0.5) * (e.confidence ?? 1);

// one level of local moving over a weighted graph in CSR form; answers each node's community index
function localMoving(n, adjStart, adjTo, adjW, k, m2) {
  const comm = new Int32Array(n);
  const tot = new Float64Array(n);
  for (let i = 0; i < n; i++) { comm[i] = i; tot[i] = k[i]; }
  const wTo = new Float64Array(n);
  const touched = new Int32Array(n);
  let moved = true;
  let anyMove = false;
  for (let pass = 0; moved && pass < MAX_PASSES; pass++) {
    moved = false;
    for (let i = 0; i < n; i++) {
      const ci = comm[i];
      let nt = 0;
      for (let p = adjStart[i]; p < adjStart[i + 1]; p++) {
        const c = comm[adjTo[p]];
        if (wTo[c] === 0) touched[nt++] = c;
        wTo[c] += adjW[p];
      }
      tot[ci] -= k[i];
      // the gain of joining c, less the constant part: w(i, c) - tot(c) k(i) / 2m
      let best = ci;
      let bestGain = wTo[ci] - (tot[ci] * k[i]) / m2;
      for (let t = 0; t < nt; t++) {
        const c = touched[t];
        const gain = wTo[c] - (tot[c] * k[i]) / m2;
        if (gain > bestGain + 1e-12 || (Math.abs(gain - bestGain) <= 1e-12 && c < best)) { best = c; bestGain = gain; }
      }
      tot[best] += k[i];
      if (best !== ci) { comm[i] = best; moved = true; anyMove = true; }
      for (let t = 0; t < nt; t++) wTo[touched[t]] = 0;
    }
  }
  return { comm, anyMove };
}

// a community that is two pieces with no edge between them becomes two communities
function splitDisconnected(n, adjStart, adjTo, comm) {
  const out = new Int32Array(n).fill(-1);
  let next = 0;
  const stack = [];
  for (let s = 0; s < n; s++) {
    if (out[s] !== -1) continue;
    const id = next++;
    out[s] = id;
    stack.push(s);
    while (stack.length) {
      const v = stack.pop();
      for (let p = adjStart[v]; p < adjStart[v + 1]; p++) {
        const u = adjTo[p];
        if (out[u] === -1 && comm[u] === comm[s]) { out[u] = id; stack.push(u); }
      }
    }
  }
  return { comm: out, count: next };
}

// pairs [a, b, w] with a, b in 0..n-1 to CSR adjacency (both directions); a self loop counts only in the degree
function csr(n, pairs) {
  const deg = new Int32Array(n + 1);
  for (const [a, b] of pairs) { if (a === b) continue; deg[a + 1]++; deg[b + 1]++; }
  for (let i = 0; i < n; i++) deg[i + 1] += deg[i];
  const adjTo = new Int32Array(deg[n]);
  const adjW = new Float64Array(deg[n]);
  const fill = deg.slice(0, n);
  const k = new Float64Array(n);
  for (const [a, b, w] of pairs) {
    if (a === b) { k[a] += 2 * w; continue; }
    adjTo[fill[a]] = b; adjW[fill[a]++] = w;
    adjTo[fill[b]] = a; adjW[fill[b]++] = w;
    k[a] += w; k[b] += w;
  }
  return { adjStart: deg, adjTo, adjW, k };
}

// Louvain over n nodes and weighted pairs; answers the community index of each node and the modularity
export function louvain(n, pairs) {
  let membership = new Int32Array(n);
  for (let i = 0; i < n; i++) membership[i] = i;
  const total = pairs.reduce((s, p) => s + p[2], 0);
  if (!n || !(total > 0)) return { membership, count: n, modularity: 0 };
  const m2 = 2 * total;
  let cur = { n, pairs };
  for (let level = 0; level < MAX_LEVELS; level++) {
    const g = csr(cur.n, cur.pairs);
    const lm = localMoving(cur.n, g.adjStart, g.adjTo, g.adjW, g.k, m2);
    const split = splitDisconnected(cur.n, g.adjStart, g.adjTo, lm.comm);
    // renumber by first appearance, so the order of nodes decides the order of communities
    const remap = new Int32Array(split.count).fill(-1);
    let count = 0;
    for (let i = 0; i < cur.n; i++) if (remap[split.comm[i]] === -1) remap[split.comm[i]] = count++;
    const levelComm = new Int32Array(cur.n);
    for (let i = 0; i < cur.n; i++) levelComm[i] = remap[split.comm[i]];
    for (let i = 0; i < n; i++) membership[i] = levelComm[membership[i]];
    if (!lm.anyMove || count === cur.n) break;
    // the next level: one node per community, the weights between them summed, the weight inside as a self loop
    const agg = new Map();
    for (const [a, b, w] of cur.pairs) {
      let x = levelComm[a], y = levelComm[b];
      if (x > y) [x, y] = [y, x];
      const key = x * count + y;
      agg.set(key, (agg.get(key) ?? 0) + w);
    }
    cur = { n: count, pairs: [...agg].sort((p, q) => p[0] - q[0]).map(([key, w]) => [Math.floor(key / count), key % count, w]) };
  }
  return { membership, count: Math.max(0, ...membership) + 1, modularity: modularity(n, pairs, membership, m2) };
}

export function modularity(n, pairs, membership, m2 = 2 * pairs.reduce((s, p) => s + p[2], 0)) {
  if (!(m2 > 0)) return 0;
  const inW = new Map();
  const tot = new Map();
  for (const [a, b, w] of pairs) {
    tot.set(membership[a], (tot.get(membership[a]) ?? 0) + w);
    tot.set(membership[b], (tot.get(membership[b]) ?? 0) + w);
    if (membership[a] === membership[b]) inW.set(membership[a], (inW.get(membership[a]) ?? 0) + w);
  }
  let q = 0;
  for (const [c, t] of tot) q += (2 * (inW.get(c) ?? 0)) / m2 - (t / m2) ** 2;
  return Math.round(q * 1e4) / 1e4;
}

const round = (x) => Math.round(x * 1000) / 1000;

// the graph's communities and hubs. nodes: [{ id, kind, name, rel }]; edges: current edges [{ src, dst, kind,
// provenance, confidence }]. Tag and folder edges label communities (tags and folders shared by their members). Answers
// communities biggest first, each { id, size, weight, members: [{ id, rank, degree }], hub, tags, folder }, and hubs:
// every node with its distinct neighbors (degree) and edge count, most connected first
export function detectCommunities({ nodes, edges }) {
  const byId = new Map(nodes.map((x) => [x.id, x]));
  const ids = nodes.filter((x) => !LABEL_KINDS.has(x.kind)).map((x) => x.id).sort();
  const index = new Map(ids.map((id, i) => [id, i]));
  const pairW = new Map();
  const labels = new Map();
  const neighbors = new Map();
  const edgeCount = new Map();
  const near = (a, b) => { (neighbors.get(a) ?? neighbors.set(a, new Set()).get(a)).add(b); edgeCount.set(a, (edgeCount.get(a) ?? 0) + 1); };
  for (const e of edges) {
    if (e.src === e.dst) continue;
    near(e.src, e.dst); near(e.dst, e.src);
    const a = index.get(e.src), b = index.get(e.dst);
    if (a == null || b == null) {
      // a tag or folder on a member: kept to name its community
      const label = byId.get(e.dst);
      if (a != null && label && LABEL_KINDS.has(label.kind)) (labels.get(e.src) ?? labels.set(e.src, []).get(e.src)).push(label);
      continue;
    }
    const w = edgeWeight(e);
    if (!(w > 0)) continue;
    const key = a < b ? a * ids.length + b : b * ids.length + a;
    pairW.set(key, (pairW.get(key) ?? 0) + w);
  }
  const pairs = [...pairW].sort((p, q) => p[0] - q[0]).map(([key, w]) => [Math.floor(key / ids.length), key % ids.length, w]);
  const { membership, modularity: q } = louvain(ids.length, pairs);

  // weight inside each member's community, for its rank
  const inner = new Float64Array(ids.length);
  const linked = new Uint8Array(ids.length);
  for (const [a, b, w] of pairs) {
    linked[a] = 1; linked[b] = 1;
    if (membership[a] === membership[b]) { inner[a] += w; inner[b] += w; }
  }
  const groups = new Map();
  for (let i = 0; i < ids.length; i++) {
    if (!linked[i]) continue;
    (groups.get(membership[i]) ?? groups.set(membership[i], []).get(membership[i])).push(i);
  }
  const communities = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => inner[b] - inner[a] || (ids[a] < ids[b] ? -1 : 1));
    const top = inner[list[0]] || 1;
    const members = list.map((i) => ({ id: ids[i], rank: round(inner[i] / top), degree: neighbors.get(ids[i])?.size ?? 0 }));
    const weight = round(list.reduce((s, i) => s + inner[i], 0) / 2);
    communities.push({ id: `c:${members[0].id}`, size: members.length, weight, members, hub: members[0].id, ...labelsOf(members, labels) });
  }
  communities.sort((a, b) => b.size - a.size || b.weight - a.weight || (a.id < b.id ? -1 : 1));
  const hubs = [...neighbors.keys()].filter((id) => byId.has(id) && !LABEL_KINDS.has(byId.get(id).kind))
    .map((id) => ({ id, degree: neighbors.get(id).size, edges: edgeCount.get(id) ?? 0 }))
    .sort((a, b) => b.degree - a.degree || b.edges - a.edges || (a.id < b.id ? -1 : 1));
  return { communities, hubs, modularity: q, nodes: ids.length, pairs: pairs.length };
}

// the tags at least 40% of a community's members carry (best two), and the folder half of them sit in
function labelsOf(members, labels) {
  const tags = new Map();
  const folders = new Map();
  for (const m of members) {
    for (const l of new Map((labels.get(m.id) ?? []).map((x) => [x.id, x])).values()) {
      const into = l.kind === 'tag' ? tags : folders;
      const cur = into.get(l.id) ?? { name: l.name, n: 0 };
      cur.n++;
      into.set(l.id, cur);
    }
  }
  const best = (m, share) => [...m.values()].filter((x) => x.n >= Math.max(2, members.length * share)).sort((a, b) => b.n - a.n || (a.name < b.name ? -1 : 1));
  return { tags: best(tags, 0.4).slice(0, 2).map((x) => x.name), folder: best(folders, 0.5)[0]?.name ?? null };
}

// a short name with no model: the strongest member of the best naming kind, with a shared tag when the hub is only a
// note. nodeOf(id) gives { kind, name }
export function nameCommunity(c, nodeOf) {
  const top = c.members.slice(0, 10).map((m) => ({ ...m, node: nodeOf(m.id) })).filter((m) => m.node);
  const pick = NAMING.map((k) => top.find((m) => m.node.kind === k)).find(Boolean) ?? top[0];
  const hubName = String(pick?.node?.name ?? c.hub).replace(/\.md$/i, '');
  const strong = pick && ['project', 'topic', 'company'].includes(pick.node.kind);
  if (!strong && c.tags?.length) return `${c.tags[0].replace(/^#/, '')}: ${hubName}`;
  if (!strong && c.folder && c.folder !== hubName) return `${c.folder}: ${hubName}`;
  return hubName;
}
