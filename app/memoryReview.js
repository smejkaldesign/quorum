// The review rules for changes Quorum's agents make to vault notes: the line diff that counts and marks a change, the
// dot a file and its folders show in the Memory tree, the group of updates an open file's banner is about, and the
// caps on what is kept. Pure functions with the clock passed in, shared by the main process (memoryVersions.js) and the
// Memory tab (KnowledgeView.tsx, MemoryUpdates.tsx).

export const DAY = 86400000;
export const MAX_VERSIONS = 50;
export const MAX_AGE_DAYS = 365;
export const DOT_DAYS = 30;
const MAX_CELLS = 4000000;

// a line diff of a and b: the indexes of the lines of b that are new or changed, and the number of changed blocks
// (runs of added or removed lines between unchanged ones). a null a is a file that did not exist, so every line of b
// is new. Lines the two share at the start and the end are matched first; a middle too large to compare line by line
// counts as one block with every line in it changed
export function lineDiff(a, b) {
  const x = a == null ? [] : String(a).split('\n');
  const y = b == null ? [] : String(b).split('\n');
  let s = 0;
  while (s < x.length && s < y.length && x[s] === y[s]) s++;
  let e = 0;
  while (e < x.length - s && e < y.length - s && x[x.length - 1 - e] === y[y.length - 1 - e]) e++;
  const xm = x.slice(s, x.length - e);
  const ym = y.slice(s, y.length - e);
  const changed = [];
  if (!xm.length && !ym.length) return { changed, blocks: 0 };
  if (!xm.length || !ym.length || xm.length * ym.length > MAX_CELLS) {
    for (let j = 0; j < ym.length; j++) changed.push(s + j);
    return { changed, blocks: 1 };
  }
  // longest common subsequence table, read from the end
  const n = xm.length, m = ym.length, w = m + 1;
  const t = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) t[i * w + j] = xm[i] === ym[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
  }
  let i = 0, j = 0, blocks = 0, inBlock = false;
  while (i < n || j < m) {
    if (i < n && j < m && xm[i] === ym[j]) { i++; j++; inBlock = false; continue; }
    if (!inBlock) { blocks++; inBlock = true; }
    if (j < m && (i >= n || t[i * w + j + 1] >= t[(i + 1) * w + j])) { changed.push(s + j); j++; } else i++;
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
// not opened yet when it is blue. first is the oldest of them, whose saved text is the Before view
export function reviewGroup(rec, { now, days = DOT_DAYS }) {
  const dot = fileDot(rec, { now, days });
  if (!dot) return null;
  const ups = (rec.updates ?? []).filter((u) => (dot === 'green' ? !u.approved : freshApproved(rec, u, now, days))).sort((a, b) => a.at - b.at);
  return { dot, count: ups.length, at: ups[ups.length - 1].at, first: ups[0], changes: ups.reduce((n, u) => n + (u.changes ?? 0), 0) };
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

// the changed lines of a note grouped into the items the banner's arrows step through: runs of lines next to each
// other, or with only blank lines between them
export function changeBlocks(lines, text = null) {
  const blank = text == null ? () => false : (() => { const all = String(text).split('\n'); return (i) => !all[i]?.trim(); })();
  const out = [];
  for (const l of [...lines].sort((a, b) => a - b)) {
    const cur = out[out.length - 1];
    const last = cur?.[cur.length - 1];
    let joined = cur && l === last + 1;
    if (cur && !joined && l > last) { joined = true; for (let i = last + 1; i < l; i++) if (!blank(i)) { joined = false; break; } }
    if (joined) cur.push(l); else out.push([l]);
  }
  return out;
}
