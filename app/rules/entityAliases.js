// One person or project under two names: two notes of the same kind whose names match once case, accents and
// punctuation are set aside, or where one name is the other's first name and last initial ("Ana R." and "Ana Ruiz"),
// and a name the notes mention that matches a person or project note this way. From the graph's nodes and aliases when
// it is built, else from the notes and their frontmatter. Approve merges two notes into the one more notes link to
// (the other's name becomes an alias, its links point at the kept note, and it goes to the Trash), or adds the
// mentioned name as an alias of the note. A dated meeting note is never merged (common.js meetingInstance): two
// instances of one series under one title are two notes.
import { ENTRY_NAME, baseOf, dirOf, finding, isInstance, quote } from './common.js';
import { cleanName, confidentialSet, entityKinds, folderKind, frontmatterNames, isName, live, namesOf, normName } from './entities.js';

export const rule = { id: 'note.entity-alias', version: 3, label: 'People and projects under two names' };

// whether two names are one: equal once normalized, or, for people, first name plus last initial against a first and
// last name made of letters ("Ana R." and "Ana Ruiz"; "Project A" and "Project A26" stay apart)
export function sameEntity(a, b, { initials = true } = {}) {
  const x = normName(a);
  const y = normName(b);
  if (!x || !y) return false;
  if (x === y) return String(a).trim() !== String(b).trim();
  const initial = (s, l) => {
    const sw = s.split(' ');
    const lw = l.split(' ');
    return sw.length === 2 && lw.length === 2 && sw[0] === lw[0] && /^\p{L}$/u.test(sw[1]) && /^\p{L}{2,}$/u.test(lw[1]) && lw[1].startsWith(sw[1]);
  };
  return initials && (initial(x, y) || initial(y, x));
}

// the person or project notes a mentioned name could be, by any of their names (rules/missingEntity.js shares it)
export const matchesOf = (entities, name, kind, { kindOf, names }) => entities.filter((n) => kindOf(n) === kind && names(n).some((x) => sameEntity(x, name, { initials: kind === 'person' }) || normName(x) === normName(name)));

export function run(ctx) {
  const { notes, graph = null } = ctx;
  const all = live(notes);
  const secret = confidentialSet(ctx);
  const read = entityKinds(ctx);
  // a note the graph reads as a person or project, or one in that kind's folder that nothing links as one yet
  const kindOf = (n) => read(n) ?? (['person', 'project'].includes(folderKind(n.rel)) ? folderKind(n.rel) : null);
  // a folder's index and a file name every project folder uses (overview, notes) name no person or project
  const entities = all.filter((n) => kindOf(n) && !secret(n) && !ENTRY_NAME.test(baseOf(n.rel)));
  const inbound = (n) => (graph ? graph.inbound(n.rel).length : n.inbound ?? 0);
  const nameCache = new Map();
  const names = (n) => nameCache.get(n.rel) ?? nameCache.set(n.rel, [...new Set([...namesOf(n), ...(graph ? graph.aliasesOf(n.rel) : [])])]).get(n.rel);
  const out = [];
  const seen = new Set();
  // two notes of one kind under two names
  // only notes that share a kind and a first word can match
  const buckets = new Map();
  for (const n of entities) for (const first of new Set(names(n).map((x) => normName(x).split(' ')[0]).filter(Boolean))) {
    const k = `${kindOf(n)}\n${first}`;
    (buckets.get(k) ?? buckets.set(k, []).get(k)).push(n);
  }
  const pairs = [];
  const sameFile = (a, b) => baseOf(a.rel).toLowerCase() === baseOf(b.rel).toLowerCase() && dirOf(a.rel) !== dirOf(b.rel);
  for (const group of buckets.values()) for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
    const [a, b] = [group[i], group[j]];
    // the same file name in two folders is a path link's job (projects/alpha/overview.md, projects/beta/overview.md)
    if (sameFile(a, b)) continue;
    // two dated instances of one series are two notes, and a merge would send one to the Trash
    if (isInstance(a) || isInstance(b)) continue;
    // two folder notes nothing names as a person or project are two notes (a spec and its copy are the duplicate rule's)
    if (!read(a) && !read(b)) continue;
    const pair = names(a).flatMap((x) => names(b).map((y) => [x, y])).find(([x, y]) => sameEntity(x, y, { initials: kindOf(a) === 'person' }) || normName(x) === normName(y));
    if (pair) pairs.push([a, b, pair]);
  }
  // a note that matches two others ("Ana R." against "Ana Ruiz" and "Ana Rios") is left for a person
  const degree = new Map();
  const uniq = new Map();
  for (const [a, b, pair] of pairs) { const k = [a.rel, b.rel].sort().join('\n'); if (!uniq.has(k)) uniq.set(k, [a, b, pair]); }
  for (const [a, b] of uniq.values()) for (const n of [a, b]) degree.set(n.rel, (degree.get(n.rel) ?? 0) + 1);
  for (const [a, b, pair] of uniq.values()) {
    if (degree.get(a.rel) > 1 || degree.get(b.rel) > 1) continue;
    const [keep, drop] = inbound(a) > inbound(b) || (inbound(a) === inbound(b) && a.text.length >= b.text.length) ? [a, b] : [b, a];
    const k = [keep.rel, drop.rel].sort().join('\n');
    if (seen.has(k)) continue;
    seen.add(k);
    const dropName = drop.note?.title ?? drop.rel;
    out.push(finding(rule, {
      key: `merge:${k}`, target: k, notes: [keep.rel, drop.rel],
      title: `${quote(keep.note?.title ?? keep.rel)} and ${quote(dropName)} look like one ${kindOf(keep)}`,
      problem: `Two notes hold what Quorum reads as one ${kindOf(keep)}, so facts about it split between them and the agent reads half of them.`,
      proposal: `Merge ${quote(drop.rel)} into ${quote(keep.rel)}: its text goes under a heading, ${quote(dropName)} becomes an alias, its links point at the kept note, and it goes to the Trash.`,
      evidence: [`Names: ${quote(pair[0])} and ${quote(pair[1])}`, `${keep.rel}: ${inbound(keep)} notes link to it`, `${drop.rel}: ${inbound(drop)} notes link to it`],
      meta: [['Keep', keep.rel], ['Merge in', drop.rel]],
      fix: { kind: 'ops', group: 'merge-entity', ops: [{ op: 'merge', rel: keep.rel, drop: drop.rel, alias: dropName }] },
    }));
  }
  // a mentioned name that is another name for a note
  const mentioned = new Map();
  if (graph) {
    for (const kind of ['person', 'project']) for (const x of graph.nodes(kind)) if (!x.rel && isName(cleanName(x.name))) for (const r of x.mentions) (mentioned.get(x.name) ?? mentioned.set(x.name, { kind, rels: new Set() }).get(x.name)).rels.add(r);
  } else {
    for (const n of all) if (!secret(n)) for (const m of frontmatterNames(n)) (mentioned.get(m.name) ?? mentioned.set(m.name, { kind: m.kind, rels: new Set() }).get(m.name)).rels.add(n.rel);
  }
  // a mention can name a note in a people or projects folder that nothing links as one yet: the alias is what links it
  const taken = new Set(entities.flatMap((n) => names(n).map(normName)));
  for (const [name, { kind, rels }] of mentioned) {
    if (taken.has(normName(name))) continue;
    const hits = matchesOf(entities, name, kind, { kindOf, names });
    // a name that could be either of two notes is left for a person
    if (hits.length !== 1) continue;
    const n = hits[0];
    out.push(finding(rule, {
      key: `alias:${n.rel}:${normName(name)}`, target: `${n.rel}\n${normName(name)}`, notes: [n.rel, ...[...rels].sort()],
      title: `${quote(name)} looks like another name for ${quote(n.note?.title ?? n.rel)}`,
      problem: `${rels.size === 1 ? 'A note names' : `${rels.size} notes name`} ${quote(name)}, which matches no note, and ${quote(n.rel)} goes by a name that matches it.`,
      proposal: `Add ${quote(name)} as an alias of ${quote(n.rel)}, so links and mentions under that name reach it.`,
      evidence: [`Mentioned in ${[...rels].sort().slice(0, 3).join(', ')}`, `Names of the note: ${names(n).slice(0, 4).join(', ')}`],
      meta: [['Note', n.rel], ['Alias', name]],
      fix: { kind: 'ops', group: 'alias', ops: [{ op: 'alias', rel: n.rel, alias: name }] },
    }));
  }
  return out;
}
