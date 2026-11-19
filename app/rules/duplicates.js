// Exact duplicates: two notes with the same body once frontmatter, template lines and spacing are set aside. Template
// lines are lines that repeat in three or more notes of the same folder (headings and prompts a template writes).
// Bodies under 200 characters after that are left out: recurring near-empty notes are separate notes. Two folders that
// share five or more duplicate pairs are a deliberate mirror, and so is a folder where half or more of the notes copy a
// note elsewhere (a staging or seed copy); their pairs are left out.
// Approve merges the copies into the one more notes link to: each other copy's name becomes an alias of it, the links
// to the copy point at it, and the copy goes to the Trash. With the memory graph built, two notes that go by the same
// name are listed too, when that name is an alias one of them sets in its frontmatter and their bodies share enough
// words: a link by that name reaches only one. Two notes that only share a title (two "Weekly sync" meetings, two
// "Notes") are separate notes. Notes whose confidentiality differs never merge: the merge would copy a confidential
// body into a note that is not.
import { DATED, baseOf, bodyOf, dirOf, finding, plural, quote, skipped } from './common.js';
import { confidentialSet, entityKinds, kindOf, namesOf, normName } from './entities.js';

export const rule = { id: 'note.duplicate', version: 2, label: 'Duplicate notes' };
const MIN_BODY = 200;
const TEMPLATE_REPEAT = 3;
const MIRROR_PAIRS = 5;
// the share of words two bodies must share (Jaccard over their word sets) before one name makes them one note
export const ALIAS_OVERLAP = 0.3;
const wordsOf = (t) => new Set(bodyOf(t).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
export function overlap(a, b) {
  const x = wordsOf(a);
  const y = wordsOf(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}
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

export function run(ctx) {
  const { notes, graph = null } = ctx;
  const secret = confidentialSet(ctx);
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
    // copies on both sides of a confidential line are left for a person
    if (new Set([...keep].map((r) => secret(live.find((n) => n.rel === r)))).size > 1) continue;
    const list = [...keep].sort();
    const title = notes.find((n) => n.rel === list[0])?.note?.title ?? list[0];
    const kept = keeperOf(list, notes, graph);
    out.push(finding(rule, {
      key: h, target: h, notes: list,
      title: `${plural(list.length, 'note')} hold the same text as ${quote(title)}`,
      problem: 'The same text sits in more than one note. An edit to one leaves the other out of date, and the agent reads the topic twice.',
      proposal: `Keep ${quote(kept)}, point the links to the other ${list.length === 2 ? 'copy' : 'copies'} at it, and move ${list.length === 2 ? 'that copy' : 'them'} to the Trash.`,
      evidence: list.map((r) => `Same text: ${r}`),
      meta: [['Notes', String(list.length)], ['Keep', kept]],
      fix: mergeFix(kept, list, notes),
    }));
  }
  if (graph) out.push(...aliasDuplicates(live, graph, secret, entityKinds(ctx)));
  return out;
}

// the copy to keep: the one more notes link to, then the shorter path
function keeperOf(rels, notes, graph) {
  const inbound = (r) => (graph ? graph.inbound(r).length : notes.find((n) => n.rel === r)?.inbound ?? 0);
  return [...rels].sort((a, b) => inbound(b) - inbound(a) || a.length - b.length || a.localeCompare(b))[0];
}
const mergeFix = (kept, rels, notes) => ({ kind: 'ops', group: 'merge-copies', ops: rels.filter((r) => r !== kept).map((drop) => ({ op: 'merge', rel: kept, drop, alias: notes.find((n) => n.rel === drop)?.note?.title ?? baseOf(drop) })) });

// two notes under one name, from the graph's aliases. Dated notes, meetings and decisions recur under one title by
// design and are left out
function aliasDuplicates(live, graph, secret, entity) {
  const owners = new Map();
  const pool = live.filter((n) => !DATED.test(baseOf(n.rel)) && kindOf(n) !== 'meeting' && kindOf(n) !== 'decision');
  for (const n of pool) for (const name of new Set([...namesOf(n), ...graph.aliasesOf(n.rel)].map(normName).filter((x) => x.length >= 3))) (owners.get(name) ?? owners.set(name, new Set()).get(name)).add(n.rel);
  const explicit = (n, name) => (n.note?.aliases ?? []).some((a) => normName(a) === name);
  const out = [];
  const seen = new Set();
  for (const [name, set] of owners) {
    if (set.size !== 2) continue;
    const list = [...set].sort();
    const k = list.join('\n');
    if (seen.has(k)) continue;
    seen.add(k);
    const [a, b] = list.map((r) => pool.find((n) => n.rel === r));
    // the same file name in two folders is a path link's job, not a duplicate
    if (baseOf(a.rel).toLowerCase() === baseOf(b.rel).toLowerCase()) continue;
    // one of them says it goes by that name, and the two bodies are about the same thing
    if (!explicit(a, name) && !explicit(b, name)) continue;
    if (overlap(a.text, b.text) < ALIAS_OVERLAP) continue;
    if (secret(a) !== secret(b)) continue;
    // two people or two projects under one name are the entity alias rule's (rules/entityAliases.js)
    if (entity(a) && entity(a) === entity(b) && ['person', 'project'].includes(entity(a))) continue;
    const kept = keeperOf(list, live, graph);
    out.push(finding(rule, {
      key: `alias:${k}`, target: k, notes: list,
      title: `${quote(a.note?.title ?? a.rel)} and ${quote(b.note?.title ?? b.rel)} go by one name`,
      problem: `Both notes answer to ${quote(name)}, so a link or a search by that name reaches only one of them, and facts split between the two.`,
      proposal: `Merge them into ${quote(kept)}: the other's text goes under a heading, its name becomes an alias, and it goes to the Trash.`,
      evidence: [`Shared name: ${quote(name)}`, ...list.map((r) => `Note: ${r}`), `The bodies share ${Math.round(overlap(a.text, b.text) * 100)}% of their words`],
      facts: [`name:${name}`],
      meta: [['Keep', kept]],
      fix: mergeFix(kept, list, live),
    }));
  }
  return out;
}
