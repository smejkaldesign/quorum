// The review rules for changes Quorum's agents make to vault notes: the line diff that counts and marks a change, the
// dot a file and its folders show in the Memory tree, the group of updates an open file's banner is about, and the
// caps on what is kept. Pure functions with the clock passed in, shared by the main process (memoryVersions.js) and the
// Memory tab (KnowledgeView.tsx, MemoryUpdates.tsx).

export const DAY = 86400000;
export const MAX_VERSIONS = 50;
export const MAX_AGE_DAYS = 365;
export const DOT_DAYS = 30;
const MAX_CELLS = 4000000;

// the steps from one list to another: ' ' keeps x[i] as y[j], '-' drops x[i], '+' adds y[j]. Items the two share at the
// start and the end are matched first; a middle too large to compare drops every item of x, then adds every item of y
export function seqOps(x, y, max = MAX_CELLS) {
  let s = 0;
  while (s < x.length && s < y.length && x[s] === y[s]) s++;
  let e = 0;
  while (e < x.length - s && e < y.length - s && x[x.length - 1 - e] === y[y.length - 1 - e]) e++;
  const n = x.length - s - e, m = y.length - s - e, w = m + 1;
  const out = [];
  for (let k = 0; k < s; k++) out.push({ op: ' ', i: k, j: k });
  if (!n || !m || n * m > max) {
    for (let i = 0; i < n; i++) out.push({ op: '-', i: s + i, j: s });
    for (let j = 0; j < m; j++) out.push({ op: '+', i: s + n, j: s + j });
  } else {
    // longest common subsequence table, read from the end
    const t = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) t[i * w + j] = x[s + i] === y[s + j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
    }
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && x[s + i] === y[s + j]) { out.push({ op: ' ', i: s + i++, j: s + j++ }); continue; }
      if (j < m && (i >= n || t[i * w + j + 1] >= t[(i + 1) * w + j])) out.push({ op: '+', i: s + i, j: s + j++ });
      else out.push({ op: '-', i: s + i++, j: s + j });
    }
  }
  for (let k = 0; k < e; k++) out.push({ op: ' ', i: x.length - e + k, j: y.length - e + k });
  return out;
}

// a line diff of a and b: the indexes of the lines of b that are new or changed, and the number of changed blocks
// (runs of added or removed lines between unchanged ones). a null a is a file that did not exist, so every line of b
// is new
export function lineDiff(a, b) {
  const changed = [];
  let blocks = 0, inBlock = false;
  for (const o of seqOps(a == null ? [] : String(a).split('\n'), b == null ? [] : String(b).split('\n'))) {
    if (o.op === ' ') { inBlock = false; continue; }
    if (!inBlock) { blocks++; inBlock = true; }
    if (o.op === '+') changed.push(o.j);
  }
  return { changed, blocks };
}

// when an approved update counts as approved: the time it was accepted, or made when it was approved on its own
const approvedTime = (u) => u.approvedAt ?? u.at;
// an approved update the person has not opened the file since, inside the dot window
const freshApproved = (rec, u, now, days) => u.approved && approvedTime(u) > (rec.openedAt ?? 0) && now - approvedTime(u) < days * DAY;

// the dot of one file: green while any update waits for approval, blue for an approved update not opened yet and newer
// than the dot window, else none. Green stays until the updates are accepted, whatever their age
export function fileDot(rec, { now, days = DOT_DAYS }) {
  const ups = rec?.updates ?? [];
  if (ups.some((u) => !u.approved)) return 'green';
  return ups.some((u) => freshApproved(rec, u, now, days)) ? 'blue' : null;
}

// the dot of each folder from the dots of the files under it; green wins over blue
export function folderDots(files) {
  const out = {};
  for (const [rel, dot] of Object.entries(files)) {
    if (!dot) continue;
    const parts = rel.split('/');
    for (let k = 1; k < parts.length; k++) {
      const f = parts.slice(0, k).join('/');
      if (out[f] !== 'green') out[f] = dot;
    }
  }
  return out;
}

// the updates an open file's banner is about: the ones waiting for approval when the dot is green, the approved ones
// not opened yet when it is blue. ids are updates the open page already shows; they stay in the group after opening the
// file cleared its dot. Every update since the oldest of them belongs to the group, since the page shows the text from
// before that one next to the text now. first is the oldest, whose saved text is the Before view
export function reviewGroup(rec, { now, days = DOT_DAYS, ids = [] }) {
  const shown = new Set(ids);
  const dot = fileDot(rec, { now, days });
  const fresh = (u) => (dot === 'green' ? !u.approved : dot === 'blue' && freshApproved(rec, u, now, days));
  const all = [...(rec?.updates ?? [])].sort((a, b) => a.at - b.at);
  const from = all.findIndex((u) => fresh(u) || shown.has(u.id));
  if (from < 0) return null;
  const ups = all.slice(from);
  return { dot: dot ?? 'blue', ids: ups.map((u) => u.id), count: ups.length, at: ups[ups.length - 1].at, first: ups[0], changes: ups.reduce((n, u) => n + (u.changes ?? 0), 0) };
}

// what a list of dated entries keeps: the newest max, none older than maxAgeDays. Entries keep their order
export function prune(list, { now, max = MAX_VERSIONS, maxAgeDays = MAX_AGE_DAYS }) {
  const young = list.filter((v) => now - v.at < maxAgeDays * DAY);
  const keep = young.slice(Math.max(0, young.length - max));
  const kept = new Set(keep);
  return { keep, drop: list.filter((v) => !kept.has(v)) };
}

// the part of a note the Memory tab shows: no frontmatter, and no first heading when the body starts with it
export function noteBody(text) {
  const body = String(text ?? '').replace(/^---\n[\s\S]*?\n---\n/, '').trim();
  const h1 = body.match(/^#\s+(.+)$/m);
  return h1 && body.startsWith(h1[0]) ? body.slice(h1[0].length).trim() : body;
}
