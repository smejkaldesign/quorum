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
export function clusterColors(ids, links, skip = () => false) {
  const n = ids.length;
  const deg = new Array(n).fill(0);
  const adj = Array.from({ length: n }, () => []);
  for (const [a, b] of links) { deg[a]++; deg[b]++; adj[a].push(b); adj[b].push(a); }
  const live = [...deg.keys()].filter((i) => deg[i] > 0 && !skip(i));
  if (!live.length) return new Array(n).fill(null);
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
  for (const m of clusters) {
    // the established notes (at or above the cluster's median degree) pick the slot by their smallest name hash, so a
    // new note with a link or two does not change the cluster's color
    const degs = m.map((i) => deg[i]).sort((a, b) => a - b);
    const mid = degs[Math.floor(degs.length / 2)];
    let k = Math.min(...m.filter((i) => deg[i] >= mid).map((i) => hash(ids[i]))) % PALETTE.length;
    if (used.size < PALETTE.length) while (used.has(k)) k = (k + 1) % PALETTE.length;
    used.add(k);
    for (const i of m) colors[i] = PALETTE[k];
  }
  for (const i of live) if (hub[i]) colors[i] = HUB;
  return colors;
}
