// Near-duplicates: two notes whose bodies share most of their text without being equal. Each body is read without its
// frontmatter, without heading lines that repeat in two or more notes of its folder, and without lines that repeat in
// three or more notes of its folder (the text a template writes). What is left becomes overlapping runs of three words
// (shingles). A MinHash signature of 32 values estimates how many shingles two notes share; notes that agree on both
// values of any one of 16 bands are compared exactly, by Jaccard similarity (shared shingles over all shingles).
//
// A pair is a finding at THRESHOLD or more and below 1 (equal bodies are the duplicates rule's). THRESHOLD comes from a
// measurement: on a synthetic vault of edited copies and unrelated notes, and read-only on a real vault (see
// docs/specs/memory-agent.md). Bodies under MIN_SHINGLES are left out, and so are pairs between two folders that share
// MIRROR_PAIRS or more pairs (a deliberate mirror, such as a staging copy), and pairs of two notes named by their date
// (a daily log or a recurring report writes much the same text each day). A dated meeting note is left out of every
// pair (common.js meetingInstance): the agent's draft of a merge sends one note to the Trash, and two instances of one
// series are two notes.
//
// The fix: "link these notes" adds a Related line to the first note. When the agent drafts fixes (memoryDraft.js) it
// drafts a merge instead. Both are review-only.
import { bodyOf, dirOf, finding, isInstance, quote, skipped } from './common.js';

export const rule = { id: 'note.near-duplicate', version: 2, label: 'Notes that repeat each other' };
export const THRESHOLD = 0.5;
export const MIN_SHINGLES = 40;
const SHINGLE = 3;
const HASHES = 32;
const BANDS = 16;
const ROWS = HASHES / BANDS;
const TEMPLATE_REPEAT = 3;
const HEADING_REPEAT = 2;
const MIRROR_PAIRS = 5;

const fnv = (t) => { let h = 0x811c9dc5; for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; };
// fixed seeds, so the same text always gets the same signature
const SEEDS = Array.from({ length: HASHES }, (_, i) => [(fnv(`a${i}`) | 1) >>> 0, fnv(`b${i}`)]);
const norm = (l) => l.toLowerCase().replace(/\s+/g, ' ').trim();
const HEADING = /^#{1,6}\s/;

// the lines of a body once frontmatter is set aside
export const bodyLines = (text) => bodyOf(text).split('\n').map(norm).filter(Boolean);

// the shingles of a body after the folder's repeated lines are taken out, each as a 32-bit hash of its three words
export function shingles(lines, repeated = new Map()) {
  const kept = lines.filter((l) => { const n = repeated.get(l) ?? 0; return HEADING.test(l) ? n < HEADING_REPEAT : n < TEMPLATE_REPEAT; });
  const words = kept.join(' ').replace(/\[\[([^\]|#]*)[^\]]*\]\]/g, '$1').match(/[\p{L}\p{N}]+/gu) ?? [];
  const h = words.map(fnv);
  const out = new Set();
  for (let i = 0; i + SHINGLE <= h.length; i++) out.add((Math.imul(h[i], 0x9e3779b1) ^ Math.imul(h[i + 1], 0x85ebca77) ^ h[i + 2]) >>> 0);
  return out;
}
export const shingleOf = (text) => [...shingles([norm(text)])][0];

export function signature(set) {
  const sig = new Uint32Array(HASHES).fill(0xffffffff);
  const a = SEEDS.map((x) => x[0]);
  const b = SEEDS.map((x) => x[1]);
  for (const h of set) {
    for (let i = 0; i < HASHES; i++) {
      const v = (Math.imul(a[i], h) + b[i]) >>> 0;
      if (v < sig[i]) sig[i] = v;
    }
  }
  return sig;
}

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  let both = 0;
  for (const s of small) if (big.has(s)) both++;
  return both / (a.size + b.size - both);
}

// each note's lines, kept while its text is the same, so a sweep after a save reads only what changed
const cache = new Map();
const linesFor = (n) => {
  const c = cache.get(n.rel);
  if (c && c.text === n.text) return c.lines;
  const lines = bodyLines(n.text);
  cache.set(n.rel, { text: n.text, lines });
  return lines;
};

// every pair at min similarity or more, with its similarity, before the mirror filter. notes: [{ rel, text }]
export function similarPairs(notes, { min = THRESHOLD } = {}) {
  if (cache.size > notes.length * 2) cache.clear();
  const linesOf = new Map(notes.map((n) => [n.rel, linesFor(n)]));
  const repeats = new Map();
  for (const n of notes) {
    const d = dirOf(n.rel);
    const seen = repeats.get(d) ?? repeats.set(d, new Map()).get(d);
    for (const l of new Set(linesOf.get(n.rel))) seen.set(l, (seen.get(l) ?? 0) + 1);
  }
  // a folder's repeated lines, as one string: a note's shingles stay valid while its text and this string are the same
  const folderKey = new Map();
  for (const [d, seen] of repeats) folderKey.set(d, [...seen].filter(([, c]) => c >= HEADING_REPEAT).map(([l, c]) => `${c >= TEMPLATE_REPEAT ? 't' : 'h'}${l}`).sort().join('\n'));
  const sets = new Map();
  const sigs = new Map();
  for (const n of notes) {
    const fk = folderKey.get(dirOf(n.rel));
    const c = cache.get(n.rel);
    if (!c.set || c.fk !== fk) { c.fk = fk; c.set = shingles(linesOf.get(n.rel), repeats.get(dirOf(n.rel))); c.sig = c.set.size >= MIN_SHINGLES ? signature(c.set) : null; }
    if (c.sig) { sets.set(n.rel, c.set); sigs.set(n.rel, c.sig); }
  }
  const buckets = new Map();
  for (const [rel, sig] of sigs) {
    for (let b = 0; b < BANDS; b++) {
      const k = `${b}:${Array.from(sig.subarray(b * ROWS, (b + 1) * ROWS)).join(',')}`;
      (buckets.get(k) ?? buckets.set(k, []).get(k)).push(rel);
    }
  }
  const seen = new Set();
  const out = [];
  for (const rels of buckets.values()) {
    if (rels.length < 2) continue;
    for (let i = 0; i < rels.length; i++) for (let j = i + 1; j < rels.length; j++) {
      const [a, b] = [rels[i], rels[j]].sort();
      const k = `${a}\n${b}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const sim = jaccard(sets.get(a), sets.get(b));
      if (sim >= min) out.push({ a, b, sim });
    }
  }
  return out.sort((x, y) => y.sim - x.sim || x.a.localeCompare(y.a));
}

// the pairs between two folders that share MIRROR_PAIRS or more pairs: a deliberate mirror
export function dropMirrors(pairs) {
  const fk = (p) => [dirOf(p.a), dirOf(p.b)].sort().join('\n');
  const count = new Map();
  for (const p of pairs) if (dirOf(p.a) !== dirOf(p.b)) count.set(fk(p), (count.get(fk(p)) ?? 0) + 1);
  return pairs.filter((p) => dirOf(p.a) === dirOf(p.b) || (count.get(fk(p)) ?? 0) < MIRROR_PAIRS);
}

const base = (rel) => rel.split('/').pop().replace(/\.md$/i, '');
// the line "link these notes" adds: a wiki link by the note's path, which opens it in any folder
export const relatedLine = (to) => `Related: [[${to.replace(/\.md$/i, '')}]]`;

export function run({ notes }) {
  const live = notes.filter((n) => !skipped(n) && !isInstance(n));
  const pairs = dropMirrors(similarPairs(live).filter((p) => p.sim < 1));
  const byRel = new Map(live.map((n) => [n.rel, n]));
  return pairs.map(({ a, b, sim }) => {
    const ta = byRel.get(a)?.note?.title ?? base(a);
    const tb = byRel.get(b)?.note?.title ?? base(b);
    const linked = [a, b].some((r) => String(byRel.get(r)?.text ?? '').toLowerCase().includes(`[[${base(r === a ? b : a).toLowerCase()}`));
    return finding(rule, {
      key: fnv(`${a}\n${b}`).toString(16), target: `${a}\n${b}`, notes: [a, b],
      title: `${quote(ta)} and ${quote(tb)} repeat each other`,
      problem: `These two notes share ${Math.round(sim * 100)}% of their text. An edit to one leaves the other out of date, and the agent reads the topic twice.`,
      proposal: linked ? 'Merge them into one note. Approve after the agent drafts the merge, or merge them by hand.' : 'Link these notes so each one points at the other copy. A merge needs the agent to draft it.',
      evidence: [`Shared text: ${Math.round(sim * 100)}%`, `Note: ${a}`, `Note: ${b}`],
      meta: [['Similarity', `${Math.round(sim * 100)}%`]],
      fix: linked ? null : { kind: 'link', to: b },
    });
  });
}
