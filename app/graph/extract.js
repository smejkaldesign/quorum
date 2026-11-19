// What one note says, as graph nodes and edges, with no model: its links, frontmatter, tags, folder, meeting attendees,
// decision lines and the keeper's link lines. Pure: the caller passes the text (already redacted) and vindex's resolver.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseNote } from '../linkparse.js';
import { slug } from '../starter.js';
import { norm } from './store.js';

export const ENTITY_KINDS = new Set(['person', 'project', 'company', 'topic']);
// folder names (any level, numeric prefix ignored, deepest wins) that say what a note is about
export const DEFAULT_CONVENTIONS = {
  folders: {
    person: ['people', 'person', 'contacts'],
    project: ['projects', 'project'],
    company: ['companies', 'company', 'clients', 'organizations'],
    meeting: ['meetings', 'meeting'],
    decision: ['decisions', 'decision'],
    topic: ['topics', 'topic'],
  },
};
const TYPES = {
  person: 'person', people: 'person', contact: 'person', project: 'project', company: 'company', organization: 'company', org: 'company', client: 'company',
  meeting: 'meeting', 'meeting-note': 'meeting', meeting_note: 'meeting', decision: 'decision', topic: 'topic',
};
// a folder's own index is about the folder, so it is never a person or a project
const INDEX_NOTE = /^(readme|index|_index|home|moc)$/i;

const sha8 = (t) => createHash('sha256').update(t).digest('hex').slice(0, 8);
const list = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]).map(String);
// "Ana, [[Ben Ode|Ben]] and Cy" as names; commas inside a link stay in it
function names(values) {
  const out = [];
  for (const v of [].concat(values).flatMap(list)) {
    for (const part of v.split(/,(?![^[]*\]\])|;|\s+and\s+(?![^[]*\]\])/)) {
      const t = part.replace(/\s*\((?:recorder|host|organizer)\)\s*$/i, '').trim();
      if (t) out.push(t);
    }
  }
  return out;
}
const linkOf = (s) => s.match(/^!?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]$/);
const plain = (t) => t.replace(/!?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_, a, b) => b ?? a.split('/').pop()).replace(/[*_`]+/g, '').replace(/\s+/g, ' ').trim();

export function noteDateOf(rel, props) {
  for (const d of [props.date, props.meeting_date, props.created, props.created_at, path.basename(rel).match(/^(\d{4}-\d{2}-\d{2})/)?.[1]]) {
    const s = Array.isArray(d) ? d[0] : d;
    const t = s ? Date.parse(String(s).slice(0, 25)) : NaN;
    if (!Number.isNaN(t)) return t;
  }
  return null;
}

export function folderKind(rel, conventions = DEFAULT_CONVENTIONS) {
  const segs = rel.split('/').slice(0, -1).map((s) => s.replace(/^\d+[-_ ]*/, '').toLowerCase());
  for (let i = segs.length - 1; i >= 0; i--) {
    for (const [kind, words] of Object.entries(conventions.folders)) if (words.includes(segs[i])) return kind;
  }
  return null;
}

// the folder kinds whose notes are entities only when something says so: a project folder also holds specs, PRDs and
// research, a people folder holds lists and templates
export const ENTITY_FOLDERS = new Set(['person', 'project', 'company']);
const seg = (s) => s.replace(/^\d+[-_ ]*/, '').toLowerCase().replace(/[-_\s]+/g, ' ').trim();
// the hub note of an entity's own folder, named like the folder: projects/Atlas/Atlas.md
export function isHub(rel, conventions = DEFAULT_CONVENTIONS) {
  const parts = rel.split('/');
  if (parts.length < 3) return false;
  const parent = seg(parts[parts.length - 2]);
  if (seg(path.basename(rel, '.md')) !== parent) return false;
  return !Object.values(conventions.folders).some((words) => words.includes(parent));
}

// the kind a note is, and whether its frontmatter said so (explicit) or a convention (rule). A note in a people,
// projects or companies folder is that entity only when its type says so, when it is that folder's hub note, or when
// linked says other notes link it as one (a meeting's attendees, a project field, works_on: graph/index.js linkedAs).
// Every other note in those folders is a note
export function noteKind(rel, props, conventions = DEFAULT_CONVENTIONS, linked = null) {
  const type = TYPES[String(Array.isArray(props.type) ? props.type[0] : props.type ?? '').toLowerCase().trim()];
  if (type) return { kind: type, provenance: 'explicit' };
  if (INDEX_NOTE.test(path.basename(rel, '.md'))) return { kind: 'note', provenance: null };
  const kind = folderKind(rel, conventions);
  if (!kind) return { kind: 'note', provenance: null };
  if (ENTITY_FOLDERS.has(kind) && linked !== kind && !isHub(rel, conventions)) return { kind: 'note', provenance: null };
  return { kind, provenance: 'rule' };
}

// the node id a note stands for: an entity by its file name, a meeting or decision by its path. shared(kind, rel): the
// note's entry from entityIds when another note of its kind has the same file name slug, else null
export function entityId(kind, rel, shared = null) {
  if (ENTITY_KINDS.has(kind)) return shared?.(kind, rel)?.id ?? `${kind}:${slug(path.basename(rel, '.md'))}`;
  if (kind === 'meeting' || kind === 'decision') return `${kind}:${rel}`;
  return `note:${rel}`;
}

const DECISION_LINE = /^\s*(?:[-*+]\s+)?(?:\[[xX]\]\s+)?(?:decision|decided)\s*(?:\([^)]*\))?\s*[:\-–]\s*(.+)$/i;
const DECISION_HEAD = /^(?:key\s+)?decisions?(?:\s+made)?$/i;
const ATTENDEE_LINE = /^\s*(?:[-*+]\s+)?(?:attendees|participants|present|people)\s*:\s*(.+)$/i;
const ATTENDEE_HEAD = /^(?:attendees|participants|present)$/i;
const KEEPER_HEAD = /^meetings$/i;
const ITEM = /^\s*(?:[-*+]|\d+\.)\s+(?:\[([ xX])\]\s+)?(.+)$/;
// "Database: Postgres" names what the decision is about, so a later decision with the same key replaces it
const KEY = /^([^:[\]]{2,40}):\s+\S/;

// the entity kind a note could be from its path and type alone, with the slug its id takes: the key two notes share
// when their ids would collide (graph/index.js counts them). null for a note that can be no entity
export function slugKey(rel, props = {}, conventions = DEFAULT_CONVENTIONS) {
  if (INDEX_NOTE.test(path.basename(rel, '.md'))) return null;
  const type = TYPES[String(Array.isArray(props.type) ? props.type[0] : props.type ?? '').toLowerCase().trim()];
  const kind = ENTITY_KINDS.has(type) ? type : type ? null : folderKind(rel, conventions);
  return ENTITY_KINDS.has(kind) ? `${kind}:${slug(path.basename(rel, '.md'))}` : null;
}

// the folder an entity note stands for: its own folder when it is that folder's hub (projects/Orca/Orca.md), else the
// folder its name would give beside it (projects/Orca.md stands for projects/Orca), as normalized segments
const ownFolder = (rel) => {
  const dirs = rel.split('/').slice(0, -1).map(seg);
  const name = seg(path.basename(rel, '.md'));
  return dirs.at(-1) === name ? dirs : [...dirs, name];
};
const within = (a, b) => a.length <= b.length && a.every((x, i) => x === b[i]);

// Ids for notes that share a slug key (slugKey). Two of them are one entity when one's folder holds the other: a hub
// and the note beside its folder (projects/Orca.md and projects/Orca/Orca.md), or a hub and a note inside its folder.
// Each group of related notes is one entity: its typed note backs it, else the deepest, and the others are notes about
// it. Groups in unrelated folders (alpha/Orca, beta/Orca) each go by the path of their backing note. A path id holds a
// /, which a slug never does. entries: [{ rel, props }] with one key. Answers Map rel -> { id, backs }
export function entityIds(entries) {
  const out = new Map();
  if (entries.length < 2) return out;
  const groups = [];
  for (const e of entries) {
    const f = ownFolder(e.rel);
    const hits = groups.filter((g) => g.some((x) => within(ownFolder(x.rel), f) || within(f, ownFolder(x.rel))));
    const merged = [e, ...hits.flat()];
    for (const h of hits) groups.splice(groups.indexOf(h), 1);
    groups.push(merged);
  }
  const typed = (e) => !!TYPES[String(Array.isArray(e.props?.type) ? e.props.type[0] : e.props?.type ?? '').toLowerCase().trim()];
  for (const g of groups) {
    const [backer] = [...g].sort((a, b) => Number(typed(b)) - Number(typed(a)) || b.rel.split('/').length - a.rel.split('/').length || a.rel.localeCompare(b.rel));
    const key = slugKey(backer.rel, backer.props);
    const id = groups.length > 1 ? `${key.slice(0, key.indexOf(':'))}:${backer.rel.replace(/\.md$/i, '')}` : key;
    for (const e of g) out.set(e.rel, { id, backs: e === backer });
  }
  return out;
}

// linkedAs(rel): the entity kind other notes link the note as, or null. kindOf(rel): the kind another note is, for its
// links and references; without the graph, its folder convention with no frontmatter. refs: the notes in an entity
// folder this note names as an entity, whose own kind can change with it (graph/index.js)
export function extractNote({ rel, text, note = null, resolve = () => null, conventions = DEFAULT_CONVENTIONS, isExcluded = () => false, linkedAs = () => null, kindOf = (to) => noteKind(to, {}, conventions).kind, shared = null }) {
  const n = note ?? parseNote(rel, text);
  const props = n.props ?? {};
  const date = noteDateOf(rel, props);
  const read = noteKind(rel, props, conventions, linkedAs(rel));
  const kindProv = read.provenance;
  // a note another note of the same entity backs (entityIds) is a note about that entity
  const about = ENTITY_KINDS.has(read.kind) && shared?.(read.kind, rel)?.backs === false ? entityId(read.kind, rel, shared) : null;
  const kind = about ? 'note' : read.kind;
  const refs = new Set();
  const noteId = `note:${rel}`;
  const self = kind === 'note' ? noteId : entityId(kind, rel, shared);
  const nodes = new Map();
  const edges = new Map();
  const addNode = (node) => { if (!nodes.has(node.id) || node.rel) nodes.set(node.id, { props: {}, aliases: [], ...node }); };
  const addEdge = (e) => {
    if (!e.src || !e.dst || e.src === e.dst) return;
    const key = edgeKey(e);
    if (!edges.has(key)) edges.set(key, { confidence: 1, source_line: null, valid_from: null, props: null, ...e });
  };

  const folder = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
  addNode({ id: noteId, kind: 'note', name: n.title, rel, props: { title: n.title, ...(props.type ? { type: String(props.type) } : {}), ...(date ? { date } : {}), ...(props.status ? { status: String(props.status) } : {}), kind } });
  if (kind !== 'note') {
    addNode({ id: self, kind, name: n.title, rel, props: { ...(props.status ? { status: String(props.status) } : {}), ...(date ? { date } : {}) }, aliases: [n.title, path.basename(rel, '.md'), ...n.aliases, ...(typeof props.name === 'string' ? [props.name] : [])] });
    addEdge({ src: noteId, dst: self, kind: 'about', provenance: kindProv, valid_from: date });
  }
  if (about) {
    addNode({ id: about, kind: read.kind, name: n.title, aliases: [n.title, path.basename(rel, '.md'), ...n.aliases] });
    addEdge({ src: noteId, dst: about, kind: 'about', provenance: 'rule', valid_from: date });
  }
  if (folder) {
    addNode({ id: `folder:${folder}`, kind: 'folder', name: folder.split('/').pop() });
    addEdge({ src: noteId, dst: `folder:${folder}`, kind: 'in_folder', provenance: 'rule' });
  }
  for (const t of n.tags) {
    addNode({ id: `tag:${t}`, kind: 'tag', name: t });
    addEdge({ src: noteId, dst: `tag:${t}`, kind: 'tagged', provenance: 'explicit' });
  }

  // a name or a link to a person, project or company: the entity it stands for, made from the note it resolves to when
  // there is one, so every way of writing the name lands on the same node
  const ref = (value, want) => {
    const m = linkOf(value.trim());
    const target = (m ? m[1] : value).trim();
    const shown = (m ? m[2] ?? m[1].split('/').pop() : value).trim();
    if (target.length < 2 || isExcluded(target) || isExcluded(shown)) return null;
    const to = resolve(target, rel);
    if (to === rel) return null;
    const k = to ? folderKind(to, conventions) : null;
    const k2 = to ? kindOf(to) : null;
    const ek = ENTITY_KINDS.has(k2) ? k2 : ENTITY_KINDS.has(k) ? k : want;
    if (to && ENTITY_FOLDERS.has(k)) refs.add(to);
    const id = to ? entityId(ek, to, shared) : `${ek}:${slug(target)}`;
    addNode({ id, kind: ek, name: to ? shown || path.basename(to, '.md') : shown, aliases: [shown, target] });
    return id;
  };
  // a link from this note to another, as the node it stands for (a meeting or decision note by its folder)
  const linkTarget = (to) => {
    const k = kindOf(to);
    return k === 'note' ? `note:${to}` : entityId(k, to, shared);
  };

  // links and embeds; a link to a person, project or company note is also a mention of it
  for (const l of n.links) {
    const to = resolve(l.target, rel);
    if (!to || to === rel) continue;
    addEdge({ src: noteId, dst: `note:${to}`, kind: l.embed ? 'embeds' : 'links_to', provenance: 'explicit', source_line: l.line });
    const k = kindOf(to);
    if (ENTITY_KINDS.has(k) && !isExcluded(path.basename(to, '.md'))) addEdge({ src: noteId, dst: entityId(k, to, shared), kind: 'mentions', provenance: 'rule', source_line: l.line, valid_from: date });
  }

  // frontmatter fields, read by what the note is
  const people = names([props.people, props.attendees, props.participants]);
  const projects = names([props.project, props.projects]);
  const companies = names([props.company, props.organization, props.client]);
  const team = names([props.team, props.members, props.owner, props.owners]);
  const role = typeof props.role === 'string' && props.role.trim() ? props.role.trim() : null;
  for (const p of people) {
    const id = ref(p, 'person');
    if (!id) continue;
    if (kind === 'meeting') addEdge({ src: id, dst: self, kind: 'attended', provenance: 'explicit', valid_from: date });
    else if (kind === 'company') addEdge({ src: id, dst: self, kind: 'member_of', provenance: 'explicit', valid_from: date });
    else if (kind === 'project') addEdge({ src: id, dst: self, kind: 'works_on', provenance: 'explicit', valid_from: date });
    else addEdge({ src: noteId, dst: id, kind: 'mentions', provenance: 'explicit', valid_from: date });
  }
  for (const p of team) {
    const id = ref(p, 'person');
    if (id && kind === 'project') addEdge({ src: id, dst: self, kind: 'works_on', provenance: 'explicit', valid_from: date });
  }
  for (const p of projects) {
    const id = ref(p, 'project');
    if (!id) continue;
    if (kind === 'person') addEdge({ src: self, dst: id, kind: 'works_on', provenance: 'explicit', valid_from: date, props: role ? { role } : null });
    else addEdge({ src: kind === 'meeting' ? self : noteId, dst: id, kind: 'about', provenance: 'explicit', valid_from: date });
  }
  for (const c of companies) {
    const id = ref(c, 'company');
    if (!id) continue;
    if (kind === 'person' || kind === 'project') addEdge({ src: self, dst: id, kind: 'member_of', provenance: 'explicit', valid_from: date });
    else if (kind === 'meeting') addEdge({ src: self, dst: id, kind: 'about', provenance: 'explicit', valid_from: date });
    else addEdge({ src: noteId, dst: id, kind: 'mentions', provenance: 'explicit', valid_from: date });
  }

  // the body, line by line: attendee lines in meetings, decision lines and sections, the keeper's meeting lines
  const lines = text.split('\n');
  const start = text.slice(0, n.bodyStart ?? 0).split('\n').length - 1;
  let section = null;
  let sectionLevel = 0;
  let fenced = false;
  const decisionOf = (raw, line) => {
    const clean = plain(raw);
    if (clean.length < 3 || isExcluded(clean)) return;
    const id = `decision:${rel}#${sha8(norm(clean))}`;
    const key = clean.match(KEY)?.[1];
    addNode({ id, kind: 'decision', name: clean.slice(0, 200), rel, props: { text: clean.slice(0, 1000), line, ...(date ? { date } : {}), ...(key ? { key: norm(key) } : {}) } });
    addEdge({ src: id, dst: kind === 'meeting' ? self : noteId, kind: 'decided_in', provenance: 'explicit', source_line: line, valid_from: date });
    // what it decides: the links on its line, else the note's projects, else the entity the note is
    let about = [];
    for (const m of raw.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g)) {
      const to = resolve(m[1].trim(), rel);
      if (to && to !== rel) about.push(linkTarget(to));
    }
    if (!about.length) about = projects.map((p) => ref(p, 'project')).filter(Boolean);
    if (!about.length && ENTITY_KINDS.has(kind)) about = [self];
    for (const dst of about) addEdge({ src: id, dst, kind: 'decision_about', provenance: 'explicit', source_line: line, valid_from: date, props: key ? { key: norm(key) } : null });
  };
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const h = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (h) {
      const level = h[1].length;
      const name = plain(h[2]);
      if (DECISION_HEAD.test(name)) { section = 'decisions'; sectionLevel = level; }
      else if (ATTENDEE_HEAD.test(name)) { section = 'attendees'; sectionLevel = level; }
      else if (KEEPER_HEAD.test(name)) { section = 'meetings'; sectionLevel = level; }
      else if (section && level <= sectionLevel) section = null;
      continue;
    }
    const flat = line.replace(/\*\*|__/g, '');
    const d = flat.match(DECISION_LINE);
    if (d) { decisionOf(d[1], i); continue; }
    if (kind === 'meeting') {
      const a = flat.match(ATTENDEE_LINE);
      if (a) {
        for (const p of names(a[1])) { const id = ref(p, 'person'); if (id) addEdge({ src: id, dst: self, kind: 'attended', provenance: 'rule', source_line: i, valid_from: date }); }
        continue;
      }
    }
    const item = flat.match(ITEM);
    if (!item || !section) continue;
    if (section === 'decisions' && item[1] !== ' ') decisionOf(item[2], i);
    else if (section === 'attendees' && kind === 'meeting') {
      for (const p of names(item[2])) { const id = ref(p, 'person'); if (id) addEdge({ src: id, dst: self, kind: 'attended', provenance: 'rule', source_line: i, valid_from: date }); }
    } else if (section === 'meetings' && ENTITY_KINDS.has(kind)) {
      // the keeper's line in a person or project note: "- 2026-03-04 [[2026-03-04 Standup]] Standup"
      const m = line.match(/^\s*[-*+]\s+(\d{4}-\d{2}-\d{2})?\s*\[\[([^\]|#]+)/);
      const to = m ? resolve(m[2].trim(), rel) : null;
      if (!to || to === rel) continue;
      const at = m[1] ? Date.parse(m[1]) : null;
      const meeting = linkTarget(to);
      if (kind === 'person') addEdge({ src: self, dst: meeting, kind: 'attended', provenance: 'rule', source_line: i, valid_from: at });
      else addEdge({ src: meeting, dst: self, kind: 'about', provenance: 'rule', source_line: i, valid_from: at });
    }
  }

  return { kind, self, date, refs: [...refs], nodes: [...nodes.values()], edges: [...edges.values()] };
}

// two edges are the same fact when they join the same nodes the same way from the same kind of source; a role or a
// decision key makes it a different fact
export const edgeKey = (e) => `${e.src}|${e.dst}|${e.kind}|${e.provenance}|${e.props?.role ?? ''}|${e.props?.key ?? ''}`;
