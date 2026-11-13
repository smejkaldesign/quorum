// Colors for the graph without anyone configuring groups: notes that link among themselves form a cluster, and each
// cluster gets one color. Label propagation over the links finds the clusters; hubs (an index that links to everything)
// sit out, since a node adjacent to the whole vault would pull it into one cluster. A cluster's color comes from the
// names of its established notes, so the same part of a vault keeps its color as notes are added around it.
export const PALETTE = ['#5ea9ff', '#ff8a5b', '#7ddc8f', '#f5c84c', '#c79bff', '#ff6f9c', '#4fd1c5', '#a3e635', '#ffb86b', '#8ad0ff', '#f2a2e8', '#9be7a6'];
export const HUB = '#8ec5ff';
const MIN_CLUSTER = 3;
const ROUNDS = 24;

const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

// ids: a stable name per node; links: index pairs; skip(i): true for nodes that take no color (ghosts)
// returns one color per node, or null where the node stays the default
export const clusterColors = (ids, links, skip = () => false) => clusterAssign(ids, links, skip).colors;

// the colors plus which cluster each node landed in: an index into the clusters (largest first), HUB_CLUSTER for a
// hub, -1 for a node with no cluster
export const HUB_CLUSTER = -2;
export function clusterAssign(ids, links, skip = () => false) {
  const n = ids.length;
  const deg = new Array(n).fill(0);
  const adj = Array.from({ length: n }, () => []);
  for (const [a, b] of links) { deg[a]++; deg[b]++; adj[a].push(b); adj[b].push(a); }
  const live = [...deg.keys()].filter((i) => deg[i] > 0 && !skip(i));
  if (!live.length) return { colors: new Array(n).fill(null), cluster: new Array(n).fill(-1) };
  // a hub links to a large share of the graph; the index of a vault does, a project note does not
  const sorted = live.map((i) => deg[i]).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 1;
  const isHub = (i) => deg[i] >= Math.max(30, median * 12) && deg[i] > live.length * 0.08;
  const hub = new Array(n).fill(false);
  for (const i of live) hub[i] = isHub(i);

  const label = [...Array(n).keys()];
  for (let round = 0; round < ROUNDS; round++) {
    let moved = 0;
    for (const i of live) {
      if (hub[i]) continue;
      const votes = new Map();
      for (const j of adj[i]) if (!hub[j] && !skip(j)) votes.set(label[j], (votes.get(label[j]) ?? 0) + 1);
      if (!votes.size) continue;
      let best = label[i], bestN = -1;
      for (const [l, c] of votes) if (c > bestN || (c === bestN && l < best)) { best = l; bestN = c; }
      if (best !== label[i]) { label[i] = best; moved++; }
    }
    if (!moved) break;
  }

  const members = new Map();
  for (const i of live) if (!hub[i]) (members.get(label[i]) ?? members.set(label[i], []).get(label[i])).push(i);
  const clusters = [...members.values()].filter((m) => m.length >= MIN_CLUSTER).sort((a, b) => b.length - a.length);
  const used = new Set();
  const colors = new Array(n).fill(null);
  const cluster = new Array(n).fill(-1);
  for (const [c, m] of clusters.entries()) {
    // the established notes (at or above the cluster's median degree) pick the slot by their smallest name hash, so a
    // new note with a link or two does not change the cluster's color
    const degs = m.map((i) => deg[i]).sort((a, b) => a - b);
    const mid = degs[Math.floor(degs.length / 2)];
    let k = Math.min(...m.filter((i) => deg[i] >= mid).map((i) => hash(ids[i]))) % PALETTE.length;
    if (used.size < PALETTE.length) while (used.has(k)) k = (k + 1) % PALETTE.length;
    used.add(k);
    for (const i of m) { colors[i] = PALETTE[k]; cluster[i] = c; }
  }
  for (const i of live) if (hub[i]) { colors[i] = HUB; cluster[i] = HUB_CLUSTER; }
  return { colors, cluster };
}

const baseName = (rel) => rel.split('/').pop().replace(/\.md$/i, '');

// a name a person can read for each cluster: the folder most of its notes share, or else the name of its most linked
// note. rels: the note path per node; cluster and deg per node as clusterAssign and the links give them. Returns one
// name per node, null where the node has no cluster
export function clusterNames(rels, cluster, deg) {
  const members = new Map();
  cluster.forEach((c, i) => { if (c >= 0) (members.get(c) ?? members.set(c, []).get(c)).push(i); });
  const names = new Map();
  for (const [c, m] of members) {
    const folders = new Map();
    for (const i of m) { const f = rels[i].includes('/') ? rels[i].slice(0, rels[i].lastIndexOf('/')) : ''; folders.set(f, (folders.get(f) ?? 0) + 1); }
    const [folder, count] = [...folders].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
    if (folder && count >= m.length * 0.6) { names.set(c, folder.split('/').pop()); continue; }
    const top = m.reduce((a, b) => (deg[b] > deg[a] || (deg[b] === deg[a] && rels[b] < rels[a]) ? b : a));
    names.set(c, baseName(rels[top]));
  }
  return cluster.map((c) => (c === HUB_CLUSTER ? 'Hubs' : names.get(c) ?? null));
}

// a readable name for an Obsidian color group query: path:"01-daily/x.md" reads x, path:/^Projects\// reads
// Projects; the first of several OR parts names the group
export function groupLabel(query) {
  const first = String(query ?? '').split(/\s+OR\s+/)[0].trim().replace(/^path:/, '').replace(/^"(.*)"$/, '$1').replace(/^\/(.*)\/$/, '$1');
  const parts = first.replace(/\\(.)/g, '$1').replace(/[\^$*+?()[\]{}|]/g, '').replace(/\.md$/i, '').split('/').filter(Boolean);
  return parts.pop() || first || 'Group';
}

