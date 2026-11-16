// Exact duplicates: two notes with the same body once frontmatter, template lines and spacing are set aside. Template
// lines are lines that repeat in three or more notes of the same folder (headings and prompts a template writes).
// Bodies under 200 characters after that are left out: recurring near-empty notes are separate notes. Two folders that
// share five or more duplicate pairs are a deliberate mirror, and so is a folder where half or more of the notes copy a
// note elsewhere (a staging or seed copy); their pairs are left out.
import { bodyOf, dirOf, finding, plural, quote, skipped } from './common.js';

export const rule = { id: 'note.duplicate', version: 1, label: 'Duplicate notes' };
const MIN_BODY = 200;
const TEMPLATE_REPEAT = 3;
const MIRROR_PAIRS = 5;
const norm = (l) => l.toLowerCase().replace(/\s+/g, ' ').trim();
// a short stable hash, enough to group equal bodies (FNV-1a over the text)
const hash = (t) => { let h = 0x811c9dc5; for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16).padStart(8, '0') + t.length.toString(16); };

// each note's normalized lines, kept while its text is the same, so a sweep after a save reads only what changed
const cache = new Map();
const linesFor = (n) => {
  const c = cache.get(n.rel);
  if (c && c.text === n.text) return c.lines;
  const lines = bodyOf(n.text).split('\n').map(norm).filter(Boolean);
  cache.set(n.rel, { text: n.text, lines });
  return lines;
};

export function run({ notes }) {
  const live = notes.filter((n) => !skipped(n));
  if (cache.size > live.length * 2) cache.clear();
  const linesOf = new Map(live.map((n) => [n.rel, linesFor(n)]));
  const repeats = new Map();
  for (const n of live) {
    const d = dirOf(n.rel);
    const seen = repeats.get(d) ?? repeats.set(d, new Map()).get(d);
    for (const l of new Set(linesOf.get(n.rel))) seen.set(l, (seen.get(l) ?? 0) + 1);
  }
  const groups = new Map();
  for (const n of live) {
    const rep = repeats.get(dirOf(n.rel));
    const body = linesOf.get(n.rel).filter((l) => (rep.get(l) ?? 0) < TEMPLATE_REPEAT).join('\n');
    if (body.length < MIN_BODY) continue;
    const h = hash(body);
    (groups.get(h) ?? groups.set(h, []).get(h)).push(n.rel);
  }
  const multi = [...groups].filter(([, rels]) => rels.length > 1);
  const pairKey = (a, b) => [dirOf(a), dirOf(b)].sort().join('\n');
  const pairCount = new Map();
  for (const [, rels] of multi) {
    const seen = new Set();
    for (let i = 0; i < rels.length; i++) for (let j = i + 1; j < rels.length; j++) { const k = pairKey(rels[i], rels[j]); if (!seen.has(k)) { seen.add(k); pairCount.set(k, (pairCount.get(k) ?? 0) + 1); } }
  }
  // a folder where half or more of the notes copy a note elsewhere is a copy of another folder
  const copies = new Map();
  for (const [, rels] of multi) for (const r of rels) if (rels.some((o) => dirOf(o) !== dirOf(r))) copies.set(dirOf(r), (copies.get(dirOf(r)) ?? 0) + 1);
  const sizes = new Map();
  for (const n of live) sizes.set(dirOf(n.rel), (sizes.get(dirOf(n.rel)) ?? 0) + 1);
  const mirror = (d) => (sizes.get(d) ?? 0) >= 3 && (copies.get(d) ?? 0) / sizes.get(d) >= 0.5;
  const out = [];
  for (const [h, rels] of multi) {
    const keep = new Set();
    for (let i = 0; i < rels.length; i++) for (let j = i + 1; j < rels.length; j++) {
      const k = pairKey(rels[i], rels[j]);
      if (dirOf(rels[i]) !== dirOf(rels[j]) && ((pairCount.get(k) ?? 0) >= MIRROR_PAIRS || mirror(dirOf(rels[i])) || mirror(dirOf(rels[j])))) continue;
      keep.add(rels[i]); keep.add(rels[j]);
    }
    if (keep.size < 2) continue;
    const list = [...keep].sort();
    const title = notes.find((n) => n.rel === list[0])?.note?.title ?? list[0];
    out.push(finding(rule, {
      key: h, target: h, notes: list,
      title: `${plural(list.length, 'note')} hold the same text as ${quote(title)}`,
      problem: 'The same text sits in more than one note. An edit to one leaves the other out of date, and the agent reads the topic twice.',
      proposal: 'Keep one copy, point links at it, and delete the others.',
      evidence: list.map((r) => `Same text: ${r}`),
      meta: [['Notes', String(list.length)]],
    }));
  }
  return out;
}
