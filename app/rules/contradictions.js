// Contradictions: two notes that make claims about the same subject and attribute that cannot both hold. The rule
// runs the pipeline of the contradiction research design:
//   1 index (contradictionIndex.js), no model, cached by note hash
//   2 claims (contradictionClaims.js): frontmatter and "key: value" lines with no model, and the agent's claims when
//     Let the agent draft fixes is on (contradictionAgent.js, through ctx.contradictions.provider)
//   3 pairs (contradictionPairs.js): subject aliases, acronyms, string similarity, attribute clusters
//   4 resolve (contradictionResolve.js): symbolic rules first, the judge only for pairs of agent claims
//   5 fix: an added superseded marker or "as of DATE" on the older line, never a deletion
// A pair the rules close (an explicit marker, a scope split, the same fact in other words) is no finding. A finding
// applies on its own only when every auto-approve criterion holds; everything else waits in review, and the batch
// planner lists it under Check these first.
//
// ctx.contradictions: { provider, bar } from main; without it the rule reads structured claims only
import { ancestors, finding, isOff, quote, skipped } from './common.js';
import { hashText, indexNote, pruneIndexCache } from '../contradictionIndex.js';
import { structuredClaims } from '../contradictionClaims.js';
import { normValue, pairClaims, resolveSubject, subjectIndex } from '../contradictionPairs.js';
import { PERSON_FOLDER, autoCriteria, inSlice, resolvePair } from '../contradictionResolve.js';

export const rule = { id: 'note.contradiction', version: 1, label: 'Notes that disagree' };
const MAX_CASCADE = 5;

const structured = new Map();
const claimsOf = (n) => {
  const h = indexNote(n).hash;
  const hit = structured.get(n.rel);
  if (hit?.h === h) return hit.claims;
  const claims = structuredClaims(n);
  structured.set(n.rel, { h, claims });
  return claims;
};
const one = (v) => (Array.isArray(v) ? v[0] : v);

// the subject index and each resolved link, kept while the names of the vault's notes stay the same: subjectIndex and
// the engine's link resolver read only the paths, titles, aliases and name fields of the notes
let names = { sig: null };
function subjectsFor(all, live, resolve) {
  const sig = hashText(all.map((n) => `${n.rel}\u0000${skipped(n) ? 1 : 0}\u0000${n.note?.title ?? ''}\u0000${(n.note?.aliases ?? []).join('\u0001')}\u0000${n.note?.props?.name ?? ''}`).join('\n'));
  if (names.sig !== sig) names = { sig, memo: new Map(), links: new Map(), sx: subjectIndex(live.map((n) => ({ rel: n.rel, title: n.note?.title, aliases: n.note?.aliases }))) };
  const { links } = names;
  const res = (target, from) => { const k = `${from}\u0000${target}`; if (links.has(k)) return links.get(k); const r = resolve(target, from); links.set(k, r); return r; };
  return { sx: names.sx, res, of: (c) => resolveSubject(c, names.sx, res, names.memo)?.id ?? null };
}
// the subjects a save sweep pairs again: every subject a claim of a changed note names, and every subject of a claim
// on the same line as a claim of those subjects, so each older line keeps all of its pairs (run below groups by it)
function subjectsTouched(claims, of, touched) {
  const bySubject = new Map();
  const byLine = new Map();
  const ids = claims.map((c) => {
    const id = of(c);
    if (id == null) return null;
    (bySubject.get(id) ?? bySubject.set(id, []).get(id)).push(c);
    const k = `${c.rel}\n${c.lineEnd ?? c.line}`;
    (byLine.get(k) ?? byLine.set(k, new Set()).get(k)).add(id);
    return id;
  });
  const out = new Set();
  const queue = [];
  const add = (id) => { if (id != null && !out.has(id)) { out.add(id); queue.push(id); } };
  claims.forEach((c, i) => { if (touched.has(c.rel)) add(ids[i]); });
  while (queue.length) for (const c of bySubject.get(queue.pop()) ?? []) for (const id of byLine.get(`${c.rel}\n${c.lineEnd ?? c.line}`)) add(id);
  return { set: out, ids };
}

// the whole pipeline over the vault, for the rule and the read-only eval script. Answers every claim, every pair and
// its resolution. only: the notes a save sweep checks; the answer then holds the pairs of the subjects those notes touch
// (subjectsTouched), which are every pair a finding on those notes can come from, and toRead is null
export function analyze(ctx, { only = null } = {}) {
  const provider = ctx.contradictions?.provider ?? null;
  const live = (ctx.notes ?? []).filter((n) => !skipped(n));
  const byRel = new Map(live.map((n) => [n.rel, n]));
  // a renamed or deleted note leaves both caches (ctx.notes is the whole vault on every sweep)
  pruneIndexCache(new Set(byRel.keys()));
  for (const rel of structured.keys()) if (!byRel.has(rel)) structured.delete(rel);
  const index = new Map(live.map((n) => [n.rel, indexNote(n)]));
  const resolve = ctx.resolve ?? (() => null);
  const touched = only ? new Set(only) : null;
  const { sx, res, of } = subjectsFor(ctx.notes ?? [], live, resolve);
  // stage 1 sends a note on when it has a decision phrase, a body date, a status or a marker; a note without one goes
  // too when it links to a note that goes, since it may speak of the same subject
  const read = new Set([...index.values()].filter((x) => x.worth).map((x) => x.rel));
  const linked = touched && !provider ? new Set() : new Set(live.filter((n) => !read.has(n.rel) && index.get(n.rel).readable && (n.note?.links ?? []).some((l) => read.has(res(l.target, n.rel)))).map((n) => n.rel));
  // a save sweep pairs again only the subjects its notes touch; a provider without retain gets the whole pass
  const inc = touched && (!provider || typeof provider.retain === 'function');
  provider?.begin(inc ? { keepPairs: true } : undefined);
  const claims = live.flatMap((n) => [...claimsOf(n), ...(provider ? provider.claimsOf(n, { worth: read.has(n.rel) || linked.has(n.rel) }) : [])]);
  const scope = inc ? subjectsTouched(claims, of, touched) : null;
  if (scope && provider) provider.retain((p) => !scope.set.has(p.subject) && !touched.has(p.a.rel) && !touched.has(p.b.rel));
  const pairable = scope ? claims.filter((c, i) => scope.set.has(scope.ids[i])) : claims;
  const { pairs, groups } = pairClaims(pairable, sx, res);
  const ix = (rel) => index.get(rel) ?? null;
  const lines = new Map();
  const lineOf = (rel, n) => {
    if (!lines.has(rel)) { const t = byRel.get(rel)?.text; lines.set(rel, t == null ? null : t.split('\n')); }
    const l = lines.get(rel);
    return l == null ? null : (l[n - 1] ?? null)?.replace(/\r$/, '') ?? null;
  };
  const results = pairs.map((p) => {
    let r = resolvePair(p, { ix, lineOf });
    if (r.pending && provider) {
      const label = provider.judgeOf(p, [byRel.get(p.a.rel), byRel.get(p.b.rel)].map((n) => ({ rel: n.rel, text: n.text })));
      if (label) r = resolvePair(p, { ix, lineOf, judge: label });
    }
    return { p, res: r };
  });
  // the agent's stored claims and verdicts are pruned only after a sweep of the whole vault
  if (!inc) provider?.end([...byRel.keys()], pairs.map((p) => p.key));
  const toRead = inc ? null : live.filter((n) => read.has(n.rel) || linked.has(n.rel)).map((n) => ({ rel: n.rel, text: n.text, note: n.note, rank: index.get(n.rel).priority + (read.has(n.rel) ? 0 : 20) }));
  return { notes: live.length, worth: read.size, linked: linked.size, toRead, claims, pairs, groups, results, byRel };
}

export function run(ctx) {
  const only = ctx.only ?? null;
  const { results, byRel } = analyze(ctx, { only });
  const touched = only ? new Set(only) : null;
  const tagged = new Set((ctx.tags ?? []).filter((t) => !isOff(t.value)).map((t) => t.rel));
  const folders = ctx.folders ?? {};
  const confidential = (rel) => tagged.has(rel) || ancestors(rel).some((d) => folders[d] && !isOff(folders[d])) || !isOff(byRel.get(rel)?.note?.props?.confidential);
  const person = (id) => PERSON_FOLDER.test(id) || String(one(byRel.get(id)?.note?.props?.type) ?? '').toLowerCase() === 'person';
  const textOf = (rel) => byRel.get(rel)?.text ?? null;
  const open = results.filter((r) => !r.res.closed && !r.res.pending);
  // one item per older line: the newest claim against it wins, the others list with it as the same point
  const byOlder = new Map();
  for (const r of open) {
    const k = `${r.res.older.rel}\n${r.res.older.lineEnd}`;
    const cur = byOlder.get(k);
    if (!cur || String(r.res.newer.date ?? '') > String(cur[0].res.newer.date ?? '')) byOlder.set(k, [r, ...(cur ?? [])]);
    else cur.push(r);
  }
  const title = (rel) => byRel.get(rel)?.note?.title ?? rel.split('/').pop().replace(/\.md$/i, '');
  const out = [];
  for (const [first, ...rest] of byOlder.values()) {
    const { p, res } = first;
    // a save sweep keeps only the findings on the notes it checks (rules/index.js), so the others are not built
    if (touched && !touched.has(res.older.rel) && !touched.has(res.newer.rel)) continue;
    const { older, newer } = res;
    const criteria = autoCriteria(p, res, { textOf, confidential, person, bar: ctx.contradictions?.bar });
    const slice = inSlice(criteria);
    const auto = criteria.every((c) => c.ok);
    const side = (c) => `${c.rel} line ${c.line}${c.date ? ` (${c.date})` : ''}: ${quote(c.quote)}`;
    const cascade = rest.slice(0, MAX_CASCADE).map((r) => `Also on this point: ${r.res.newer.rel === older.rel ? r.res.older.rel : r.res.newer.rel}`);
    const fix = res.fix ?? null;
    const what = older.attribute;
    const problem = {
      R2: `${quote(title(newer.rel))} records a newer decision on ${what}. The older line still reads as current.`,
      R3: `The two lines give different values for ${what} at different dates. The older line does not say it held only until then.`,
    }[res.rule] ?? res.ask ?? 'These lines disagree.';
    const proposal = fix?.kind === 'annotate'
      ? `Add ${quote(fix.add.trim())} at the end of line ${fix.line} of ${older.rel}. Nothing is deleted.`
      : fix?.kind === 'link' ? `Link ${older.rel} to ${newer.rel}.` : 'Read both lines and decide which one holds. Quorum changes neither note.';
    out.push(finding(rule, {
      key: hashText(p.key), target: `${older.rel}\n${newer.rel}`, notes: [older.rel, newer.rel],
      title: `${quote(title(older.rel))} and ${quote(title(newer.rel))} disagree on ${what}`,
      problem, proposal,
      evidence: [`Older: ${side(older)}`, `Newer: ${side(newer)}`, `Rule: ${res.rule}`, ...cascade],
      facts: [`rule:${res.rule}`, `value:${normValue(older.value)}`, `value:${normValue(newer.value)}`, ...(slice ? ['auto-slice'] : [])],
      meta: [['Rule', res.rule], ['Match', p.match], ['Claims', [...new Set([older.extractor, newer.extractor])].join(', ')]],
      fix, autoFix: auto,
    }));
  }
  return out;
}
