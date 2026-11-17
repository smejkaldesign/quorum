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
import { normValue, pairClaims, subjectIndex } from '../contradictionPairs.js';
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

// the whole pipeline over the vault, for the rule and the read-only eval script. Answers every claim, every pair and
// its resolution
export function analyze(ctx) {
  const provider = ctx.contradictions?.provider ?? null;
  const live = (ctx.notes ?? []).filter((n) => !skipped(n));
  const byRel = new Map(live.map((n) => [n.rel, n]));
  // a renamed or deleted note leaves both caches (ctx.notes is the whole vault on every sweep)
  pruneIndexCache(new Set(byRel.keys()));
  for (const rel of structured.keys()) if (!byRel.has(rel)) structured.delete(rel);
  provider?.begin();
  const index = new Map(live.map((n) => [n.rel, indexNote(n)]));
  const resolve = ctx.resolve ?? (() => null);
  // stage 1 sends a note on when it has a decision phrase, a body date, a status or a marker; a note without one goes
  // too when it links to a note that goes, since it may speak of the same subject
  const read = new Set([...index.values()].filter((x) => x.worth).map((x) => x.rel));
  const linked = new Set(live.filter((n) => !read.has(n.rel) && index.get(n.rel).readable && (n.note?.links ?? []).some((l) => read.has(resolve(l.target, n.rel)))).map((n) => n.rel));
  const claims = live.flatMap((n) => [...claimsOf(n), ...(provider ? provider.claimsOf(n, { worth: read.has(n.rel) || linked.has(n.rel) }) : [])]);
  const sx = subjectIndex(live.map((n) => ({ rel: n.rel, title: n.note?.title, aliases: n.note?.aliases })));
  const { pairs, groups } = pairClaims(claims, sx, resolve);
  const ix = (rel) => index.get(rel) ?? null;
  const lineOf = (rel, n) => { const t = byRel.get(rel)?.text; return t == null ? null : (t.split('\n')[n - 1] ?? null)?.replace(/\r$/, '') ?? null; };
  const results = pairs.map((p) => {
    let res = resolvePair(p, { ix, lineOf });
    if (res.pending && provider) {
      const label = provider.judgeOf(p, [byRel.get(p.a.rel), byRel.get(p.b.rel)].map((n) => ({ rel: n.rel, text: n.text })));
      if (label) res = resolvePair(p, { ix, lineOf, judge: label });
    }
    return { p, res };
  });
  provider?.end([...byRel.keys()], pairs.map((p) => p.key));
  return { notes: live.length, worth: read.size, linked: linked.size, toRead: live.filter((n) => read.has(n.rel) || linked.has(n.rel)).map((n) => ({ rel: n.rel, text: n.text, note: n.note, rank: index.get(n.rel).priority + (read.has(n.rel) ? 0 : 20) })), claims, pairs, groups, results, byRel };
}

export function run(ctx) {
  const { results, byRel } = analyze(ctx);
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
