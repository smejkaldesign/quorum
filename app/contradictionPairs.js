// Contradiction detection, stage 3: normalization and pairing, no model. Subjects map to notes through note titles,
// frontmatter aliases, file names and wiki link targets, then through acronyms, then through string similarity.
// Attributes join clusters through a short synonym table and string similarity. Two claims in different notes pair
// when their subject and attribute cluster match and their value or polarity differs.
//
// Each pair records how its match was made: exact (same key or a wiki link), alias (a note title, alias or file name),
// acronym or fuzzy. Only exact and alias matches can ever apply on their own (contradictionResolve.js).
import { hashText } from './contradictionIndex.js';

export const SUBJECT_SIMILARITY = 0.86;
export const ATTRIBUTE_SIMILARITY = 0.8;
export const MAX_PAIRS_PER_GROUP = 40;
const STOP = new Set(['the', 'a', 'an', 'of', 'for', 'to', 'our', 'its', 'their']);
const RANK = { exact: 0, alias: 1, acronym: 2, fuzzy: 3 };
export const weaker = (...hows) => hows.reduce((w, h) => (RANK[h] > RANK[w] ? h : w), 'exact');

const singular = (w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
// a name as a comparable key: lower case, no markup or punctuation, no small words, singular
export function normKey(s) {
  const t = String(s ?? '').toLowerCase().replace(/\[\[|\]\]/g, '').replace(/\.md$/, '').split('/').pop().replace(/[|#].*$/, '');
  return t.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter((w) => w && !STOP.has(w)).map(singular).join(' ');
}
// the first letters of a name of two or more words: "Quorum Cloud Edition" -> "qce"
export const acronymOf = (key) => { const w = String(key).split(' ').filter(Boolean); return w.length >= 2 ? w.map((x) => x[0]).join('') : null; };

// Dice similarity of two strings over letter pairs, 0 to 1
export function similarity(a, b) {
  const x = String(a);
  const y = String(b);
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const grams = (s) => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) ?? 0) + 1); } return m; };
  const gx = grams(x);
  const gy = grams(y);
  let both = 0;
  for (const [g, n] of gx) both += Math.min(n, gy.get(g) ?? 0);
  return (2 * both) / (x.length - 1 + y.length - 1);
}

// the names every note answers to. notes: [{ rel, title, aliases }]
export function subjectIndex(notes) {
  const byKey = new Map();
  const byAcronym = new Map();
  const byWord = new Map();
  const add = (k, rel) => {
    if (!k || byKey.has(k)) return;
    byKey.set(k, rel);
    const a = acronymOf(k);
    if (a && a.length >= 2 && !byAcronym.has(a)) byAcronym.set(a, rel);
    const w = k.split(' ')[0];
    (byWord.get(w) ?? byWord.set(w, []).get(w)).push(k);
  };
  for (const n of notes) {
    add(normKey(n.rel), n.rel);
    add(normKey(n.title), n.rel);
    for (const a of n.aliases ?? []) add(normKey(a), n.rel);
  }
  return { byKey, byAcronym, byWord };
}

// the subject of a claim as a note or a text key, and how the match was made. resolve(target, fromRel) is the vault's
// link resolver
export function resolveSubject(claim, sx, resolve = () => null, memo = new Map()) {
  if (claim.self) return { id: claim.rel, how: 'exact' };
  if (claim.subjectLink) { const r = resolve(claim.subject, claim.rel); if (r) return { id: r, how: 'exact' }; }
  const k = normKey(claim.subject);
  if (!k) return null;
  if (memo.has(k)) return memo.get(k);
  let out = null;
  if (sx.byKey.has(k)) out = { id: sx.byKey.get(k), how: 'alias' };
  else if (!k.includes(' ') && sx.byAcronym.has(k)) out = { id: sx.byAcronym.get(k), how: 'acronym' };
  else if (acronymOf(k) && sx.byKey.has(acronymOf(k))) out = { id: sx.byKey.get(acronymOf(k)), how: 'acronym' };
  else if (k.length >= 5) {
    let best = null;
    for (const cand of sx.byWord.get(k.split(' ')[0]) ?? []) {
      const s = similarity(k, cand);
      if (s >= SUBJECT_SIMILARITY && (!best || s > best.s)) best = { s, key: cand };
    }
    if (best) out = { id: sx.byKey.get(best.key), how: 'fuzzy' };
  }
  out ??= { id: `text:${k}`, how: 'exact' };
  memo.set(k, out);
  return out;
}

// attribute names that mean the same thing
const SYNONYMS = {
  price: ['price', 'pricing', 'cost', 'fee', 'monthly price', 'seat price', 'per seat price', 'subscription price', 'plan price', 'list price'],
  owner: ['owner', 'owned by', 'lead', 'dri', 'responsible', 'maintainer', 'assignee', 'ownership'],
  status: ['status', 'state', 'stage'],
  deadline: ['deadline', 'due', 'due date', 'target date'],
  launch: ['launch', 'launch date', 'release', 'release date', 'ship date', 'ship', 'ships', 'go live'],
  database: ['database', 'db', 'datastore', 'data store', 'storage engine'],
  hosting: ['host', 'hosting', 'hosted on', 'cloud provider', 'deploy target', 'deployment target', 'region'],
  'team size': ['team size', 'headcount', 'engineer count', 'number of engineer', 'engineer', 'size'],
  plan: ['plan', 'tier', 'plans', 'tiers', 'plan count'],
};
const SYN = new Map(Object.entries(SYNONYMS).flatMap(([c, list]) => list.map((w) => [normKey(w), c])));
// the cluster of an attribute and how it was matched
export const attributeKey = (a) => { const k = normKey(a); return SYN.has(k) ? { id: SYN.get(k), how: SYN.get(k) === k ? 'exact' : 'alias' } : { id: k, how: 'exact' }; };

const numbers = (s) => [...String(s).matchAll(/\d+(?:[.,]\d+)?/g)].map((m) => m[0].replace(',', '.')).sort().join(' ');
const tokens = (s) => new Set(normKey(s).split(' ').filter(Boolean));
export const normValue = (v) => String(v ?? '').toLowerCase().replace(/\*\*|__|`|\[\[|\]\]/g, '').replace(/[.;,]+$/, '').replace(/\s+/g, ' ').trim();
// two values that say the same thing: equal once normalized, or close in wording with the same numbers
export function sameValue(a, b) {
  const x = normValue(a);
  const y = normValue(b);
  if (x === y) return true;
  const nx = numbers(x);
  const ny = numbers(y);
  if (nx !== ny && (nx || ny)) return false;
  if (similarity(x, y) >= 0.8) return true;
  const tx = tokens(x);
  const ty = tokens(y);
  const both = [...tx].filter((t) => ty.has(t)).length;
  return tx.size + ty.size > 0 && both / (tx.size + ty.size - both) >= 0.75;
}
// one value holds every word of the other: often a refinement ("Q3" and "Q3, late September")
export function contains(a, b) {
  const tx = tokens(a);
  const ty = tokens(b);
  const sub = (p, q) => p.size > 0 && [...p].every((t) => q.has(t));
  return sub(tx, ty) || sub(ty, tx);
}

export const pairKey = (a, b) => hashText([`${a.rel}\n${a.quote}`, `${b.rel}\n${b.quote}`].sort().join('\n\u0000'));

// the candidate pairs among claims. Answers { pairs, groups } where each pair is { key, a, b, subject, attribute,
// match, refinement }
export function pairClaims(claims, sx, resolve = () => null) {
  const memo = new Map();
  // by subject first: a subject only one note speaks of cannot hold a pair, so its attributes are never compared
  const bySubject = new Map();
  for (const c of claims) {
    const s = resolveSubject(c, sx, resolve, memo);
    if (!s) continue;
    const e = bySubject.get(s.id) ?? bySubject.set(s.id, { rels: new Set(), list: [] }).get(s.id);
    e.rels.add(c.rel);
    e.list.push({ c, s });
  }
  const atMemo = new Map();
  const attr = (a) => atMemo.get(a) ?? atMemo.set(a, attributeKey(a)).get(a);
  const groups = new Map();
  for (const [sid, { rels, list }] of bySubject) {
    if (rels.size < 2) continue;
    const local = new Map();
    for (const x of list) { const at = attr(x.c.attribute); (local.get(at.id) ?? local.set(at.id, []).get(at.id)).push({ ...x, at }); }
    // attribute names close in spelling within one subject join the larger cluster
    const keys = [...local.keys()].sort((p, q) => local.get(q).length - local.get(p).length);
    for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
      const [ka, kb] = [keys[i], keys[j]];
      if (!local.has(ka) || !local.has(kb)) continue;
      if (similarity(ka, kb) >= ATTRIBUTE_SIMILARITY) {
        local.set(ka, [...local.get(ka), ...local.get(kb).map((x) => ({ ...x, at: { id: x.at.id, how: 'fuzzy' } }))]);
        local.delete(kb);
      }
    }
    for (const [aid, l] of local) groups.set(`${sid}\u0000${aid}`, l);
  }
  const pairs = [];
  for (const [k, list] of groups) {
    if (new Set(list.map((x) => x.c.rel)).size < 2) continue;
    const found = [];
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const x = list[i];
      const y = list[j];
      if (x.c.rel === y.c.rel) continue;
      const same = sameValue(x.c.value, y.c.value);
      if (same && x.c.polarity === y.c.polarity) continue;
      found.push({
        key: pairKey(x.c, y.c), a: x.c, b: y.c, subject: x.s.id, attribute: k.split('\u0000')[1],
        match: weaker(x.s.how, y.s.how, x.at.how, y.at.how), refinement: !same && contains(x.c.value, y.c.value), flip: same,
      });
    }
    // dated pairs first: they are the ones the rules can settle
    found.sort((p, q) => (!!(q.a.date && q.b.date) - !!(p.a.date && p.b.date)) || p.key.localeCompare(q.key));
    pairs.push(...found.slice(0, MAX_PAIRS_PER_GROUP));
  }
  return { pairs, groups: groups.size };
}
