// People, projects, meetings and decisions as the review rules see them: the folder conventions, the type a note's
// frontmatter gives, the names a note goes by, the names notes mention in their frontmatter, and the memory graph's view
// when it is built (graph/store.js). Plain functions, no Node or Electron imports.
import { baseOf, dirOf, isOff, skipped } from './common.js';

export const KINDS = ['person', 'project', 'meeting', 'decision'];
// a folder named for a kind, at any depth, with an optional numeric prefix (02-people, 08-meetings)
export const FOLDER_RE = {
  person: /(^|\/)(\d+[-_ ]?)?(people|persons|contacts|team|crm)(\/|$)/i,
  project: /(^|\/)(\d+[-_ ]?)?projects?(\/|$)/i,
  meeting: /(^|\/)(\d+[-_ ]?)?meetings?(\/|$)/i,
  decision: /(^|\/)(\d+[-_ ]?)?decisions?(\/|$)/i,
};
// the frontmatter keys that name people and projects
export const PEOPLE_KEYS = ['people', 'attendees', 'participants'];
export const PROJECT_KEYS = ['project', 'projects'];
const one = (v) => (Array.isArray(v) ? v[0] : v);
const list = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);

// the kind a note's frontmatter type gives, or null
export const typeOf = (n) => { const t = String(one(n.note?.props?.type) ?? '').trim().toLowerCase(); return KINDS.includes(t) ? t : null; };
// the kind a note's folder gives, or null
export const folderKind = (rel) => KINDS.find((k) => FOLDER_RE[k].test(dirOf(rel))) ?? null;
// the kind of a note: its type, else its folder
export const kindOf = (n) => typeOf(n) ?? folderKind(n.rel);

// a name as written in frontmatter or a body: the link brackets, a display part, "(recorder)" and spacing taken off
export function cleanName(v) {
  let s = String(v ?? '').trim();
  const link = s.match(/^\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]$/);
  if (link) s = (link[2] ?? link[1]).trim();
  s = s.replace(/\s*\((recorder|host|organizer|me)\)\s*$/i, '').replace(/\s+/g, ' ').trim();
  return s;
}
// whether a cleaned value reads as a name: letters, not an email, a path or a date, at most six words
export function isName(s) {
  if (!s || s.length < 3 || s.length > 80) return false;
  if (/@|\/|\\|^\d{4}-\d{2}-\d{2}|https?:/i.test(s)) return false;
  if (!/\p{L}/u.test(s)) return false;
  return s.split(' ').length <= 6;
}
// a name for comparing: lowercase, accents and punctuation off, one space between words
export const normName = (s) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[-_.]+/g, ' ').replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim();

// whether the note's frontmatter field holds this name as a wikilink already
export const linkedIn = (v, name) => list(v).some((x) => /^\[\[/.test(String(x).trim()) && normName(cleanName(x)) === normName(name));

// the names a note mentions in its frontmatter, each with its kind: [{ name, kind, key, linked }]
export function frontmatterNames(n) {
  const props = n.note?.props ?? {};
  const out = [];
  for (const [keys, kind] of [[PEOPLE_KEYS, 'person'], [PROJECT_KEYS, 'project']]) {
    for (const key of keys) for (const raw of list(props[key])) {
      const name = cleanName(raw);
      if (isName(name)) out.push({ name, kind, key, linked: /^\s*\[\[/.test(String(raw)) });
    }
  }
  return out;
}

// the names a note goes by: its file name, its title and its aliases
export const namesOf = (n) => [...new Set([baseOf(n.rel), n.note?.title, ...(n.note?.aliases ?? [])].filter(Boolean).map(String))];

// a note marked confidential by its own frontmatter or the tag scan; rules that copy names between notes skip it
export function confidentialSet(ctx) {
  const tagged = new Set((ctx.tags ?? []).filter((t) => !isOff(t.value)).map((t) => t.rel));
  const folders = ctx.folders ?? {};
  return (n) => tagged.has(n.rel) || !isOff(n.note?.props?.confidential) || Object.entries(folders).some(([d, v]) => !isOff(v) && (n.rel === d || n.rel.startsWith(`${d}/`)));
}

// the notes the entity rules read: generated reports and templates left out
export const live = (notes) => notes.filter((n) => !skipped(n));

// the top-level folder for a kind, when the vault has one: the shortest folder path a note of that kind sits in
export function kindFolder(notes, kind) {
  let best = null;
  for (const n of notes) {
    const d = dirOf(n.rel);
    if (!d || !FOLDER_RE[kind].test(d)) continue;
    const parts = d.split('/');
    const i = parts.findIndex((p) => FOLDER_RE[kind].test(`${p}/`));
    const top = parts.slice(0, i + 1).join('/');
    if (!best || top.length < best.length) best = top;
  }
  return best;
}

// The graph as the rules read it, from the store (graph/store.js) or its read-only view in the memory engine
// (graphView.js); null while the graph is not built, and the rules fall back to the notes alone. A note stands for
// note:<rel> and, when it is a person, project, meeting or decision, for that node too (nodesByRel). Shape:
//   nodes(kind)          [{ id, kind, name, rel, aliases, mentions: [rel] }]: mentions are the notes with a current
//                        mentions or attended edge on the node
//   aliasesOf(rel)       the aliases of the note's nodes
//   inbound(rel)         the other notes with a current edge into one of the note's nodes, other than folder and tag
//   edgesFrom(rel)       every edge read from the note's lines, current and superseded, for the instruction file check
//   linked(a, b, kinds)  whether a current edge of one of kinds joins the two notes
const STRUCTURAL = new Set(['in_folder', 'tagged', 'about']);
export function ruleGraph(store) {
  if (!store) return null;
  const safe = (f, fallback) => { try { return f(); } catch { return fallback; } };
  const ids = new Map();
  const idsOf = (rel) => {
    if (!ids.has(rel)) ids.set(rel, [...new Set([`note:${rel}`, ...safe(() => store.nodesByRel(rel), []).map((x) => x.id)])]);
    return ids.get(rel);
  };
  const uniq = (xs) => [...new Set(xs)];
  // one view per sweep, so each note's reads are kept for the sweep
  const memo = (f) => { const m = new Map(); return (rel) => (m.has(rel) ? m.get(rel) : m.set(rel, f(rel)).get(rel)); };
  return {
    nodes: (kind) => safe(() => store.nodes({ kind }), []).map((x) => ({
      id: x.id, kind: x.kind, name: x.name, rel: x.rel ?? null,
      aliases: safe(() => store.aliasesOf(x.id), []),
      mentions: uniq(safe(() => store.edgesOf(x.id, { dir: 'both', kinds: ['mentions', 'attended'], current: true }), []).map((e) => e.source_rel).filter(Boolean)),
    })),
    aliasesOf: memo((rel) => uniq(idsOf(rel).flatMap((id) => safe(() => store.aliasesOf(id), [])))),
    inbound: memo((rel) => uniq(idsOf(rel).flatMap((id) => safe(() => store.edgesOf(id, { dir: 'in', current: true }), [])).filter((e) => !STRUCTURAL.has(e.kind)).map((e) => e.source_rel).filter((r) => r && r !== rel))),
    edgesFrom: (rel) => safe(() => store.edgesBySource(rel), []),
    linked: (a, b, kinds) => {
      const bs = new Set(idsOf(b));
      return idsOf(a).some((id) => safe(() => store.edgesOf(id, { dir: 'both', kinds, current: true }), []).some((e) => bs.has(e.src === id ? e.dst : e.src)));
    },
  };
}
