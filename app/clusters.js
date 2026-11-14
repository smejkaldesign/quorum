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
const own = (renamed, key) => (renamed && Object.hasOwn(renamed, key) && typeof renamed[key] === 'string' && renamed[key] ? renamed[key] : null);

// a folder name as a person would say it: a numeric ordering prefix and the separators go, so 00-inbox reads Inbox,
// 01-daily reads Daily and auto-memory reads Auto memory. Digits that belong to the name stay: 3d-printing reads
// 3d printing, 2fa and 1password stay, and 2026-11 keeps its dash
export function folderLabel(folder) {
  const seg = String(folder ?? '').split('/').filter(Boolean).pop() ?? '';
  const words = seg.replace(/^\d+[-_]+(?=[^\d\s_-])/, '').replace(/(?<!\d)[-_]+|[-_]+(?!\d)/g, ' ').replace(/\s+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : seg;
}

// the folders that hold more than half of the whole vault (a wrapper such as MyBrain/ around everything): too broad to
// name a cluster. allRels: every note path in the vault. Returns a test on a folder path
export function wrapperFolders(allRels) {
  const counts = new Map();
  for (const rel of allRels) {
    let i = rel.indexOf('/');
    while (i > 0) { const f = rel.slice(0, i); counts.set(f, (counts.get(f) ?? 0) + 1); i = rel.indexOf('/', i + 1); }
  }
  return (folder) => (counts.get(folder) ?? 0) > allRels.length / 2;
}

// the deepest folder that holds at least `share` of the notes, counting notes in its subfolders, or '' when none does
// or the best one is a wrapper. Notes spread over 04-projects/a and 04-projects/b share 04-projects
export function sharedFolder(rels, share = 0.6, wrapper = () => false) {
  const counts = new Map();
  for (const rel of rels) {
    let i = rel.indexOf('/');
    while (i > 0) { const f = rel.slice(0, i); counts.set(f, (counts.get(f) ?? 0) + 1); i = rel.indexOf('/', i + 1); }
  }
  const depth = (f) => f.split('/').length;
  const fits = [...counts].filter(([, n]) => n >= rels.length * share);
  fits.sort((a, b) => depth(b[0]) - depth(a[0]) || b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const best = fits[0]?.[0] ?? '';
  return best && !wrapper(best) ? best : '';
}

// a name a person can read for each cluster: the folder most of its notes share, in plain words, or else the name of
// its most linked note. rels: every note path, one per node; cluster and deg per node as clusterAssign and the links
// give them; names: the display name per note; renamed: the person's own names by key, which win over the generated
// ones. Two clusters that would read the same, generated or renamed, add their most linked note. One entry per node,
// null where the node has no cluster: { key, name, folder }.
// key is what a rename is kept against: folder:<path> for a cluster named by its folder, so it holds across launches
// and re-indexes. A cluster with no shared folder is keyed by its most linked note, note:<path>, which moves if another
// note becomes the most linked one; a rename kept against it is then dropped. folder is the path the name stands for,
// '' when the name comes from a note
export function clusterLabels(rels, cluster, deg, names = rels.map(baseName), renamed = {}) {
  const wrapper = wrapperFolders(rels);
  const members = new Map();
  cluster.forEach((c, i) => { if (c >= 0) (members.get(c) ?? members.set(c, []).get(c)).push(i); });
  const label = new Map();
  for (const [c, m] of members) {
    const folder = sharedFolder(m.map((i) => rels[i]), 0.6, wrapper);
    const t = m.reduce((a, b) => (deg[b] > deg[a] || (deg[b] === deg[a] && rels[b] < rels[a]) ? b : a));
    const key = folder ? `folder:${folder}` : `note:${rels[t]}`;
    label.set(c, { key, name: own(renamed, key) ?? (folder ? folderLabel(folder) : names[t]), folder, top: names[t] });
  }
  const seen = new Map();
  for (const l of label.values()) seen.set(l.name, (seen.get(l.name) ?? 0) + 1);
  const out = new Map();
  for (const [c, l] of label) out.set(c, { key: l.key, name: seen.get(l.name) > 1 && l.name !== l.top ? `${l.name} · ${l.top}` : l.name, folder: l.folder });
  const hubs = { key: 'hubs', name: own(renamed, 'hubs') ?? 'Hubs', folder: '' };
  return cluster.map((c) => (c === HUB_CLUSTER ? hubs : out.get(c) ?? null));
}

// the names alone, one per node
export const clusterNames = (rels, cluster, deg, names, renamed) => clusterLabels(rels, cluster, deg, names, renamed).map((l) => l?.name ?? null);

// an Obsidian color group named the same way: by the folder its notes share, else by the path its query starts with.
// Only a folder name is put in plain words; a note name or a regex the query holds is shown as written.
// members: the paths of the notes the group colors; wrapper: as wrapperFolders gives it
export function groupInfo(query, members, wrapper = () => false, renamed = {}) {
  const key = `group:${query}`;
  const folder = sharedFolder(members, 0.6, wrapper);
  const named = groupPath(query);
  const name = folder ? folderLabel(folder) : named.folder ? folderLabel(named.label) || named.label : named.label;
  return { key, name: own(renamed, key) ?? name, folder };
}

// a readable name for an Obsidian color group query: the last folder or note of the literal path it starts with.
// path:"01-daily/x.md" reads x, path:/^Projects\// reads Projects; a pattern with no literal start reads as written.
// The first of several OR parts names the group
export const groupLabel = (query) => groupPath(query).label;

// the same, plus whether the name is a folder (as opposed to a note, a cut-off name or a raw pattern)
function groupPath(query) {
  const first = String(query ?? '').split(/\s+OR\s+/)[0].trim();
  const exact = first.match(/^path:"(.*)"$/);
  const regex = first.match(/^path:\/(.*)\/$/);
  let literal = exact ? exact[1] : first.replace(/^path:/, '');
  if (regex) {
    // the pattern up to its first special character, with escaped slashes read as slashes
    const body = regex[1].replace(/^\^/, '');
    let out = '';
    for (let i = 0; i < body.length; i++) {
      if (body[i] === '\\' && body[i + 1] === '/') { out += '/'; i++; continue; }
      if ('\\.*+?()[]{}|^$'.includes(body[i])) break;
      out += body[i];
    }
    // a pattern cut off inside a name keeps the folders before it; with no folder before it, the start of the name
    const cut = out.length < body.length && !out.endsWith('/');
    const segs = out.split('/').filter(Boolean);
    if (cut && segs.length > 1) segs.pop();
    if (!segs.length) return { label: regex[1].replace(/\\\//g, '/'), folder: false };
    return { label: segs[segs.length - 1], folder: !(cut && segs.length === 1 && !out.includes('/')) };
  }
  const segs = literal.split('/').filter(Boolean);
  const last = segs.pop();
  if (!last) return { label: first || 'Group', folder: false };
  return { label: last.replace(/\.md$/i, ''), folder: !/\.md$/i.test(last) };
}
