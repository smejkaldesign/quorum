// Missing people and projects: a name several notes mention with no note of its own, so the agent has nowhere to read
// who the person is or what the project is about. From the memory graph when it is built (a person or project node with
// no note behind it), else from the people, attendees, participants, project and projects fields of the notes'
// frontmatter. A name only confidential notes mention is left out: its note would carry the name out of them.
// Approve writes the note from the vault's template for its kind, or a short default, with the notes that mention it
// listed, and links the first mention in each of those notes to it.
import { baseOf, finding, plural, quote } from './common.js';
import { confidentialSet, frontmatterNames, kindFolder, kindOf, live, namesOf, normName } from './entities.js';

export const rule = { id: 'note.missing-entity', version: 1, label: 'People and projects with no note' };
export const MIN_MENTIONS = 3;
// the notes a fix links the name from, at most
export const MAX_LINKED = 20;
const TEMPLATE_NAME = { person: /^(person|people|contact)( note)?( template)?$/i, project: /^(project|projects)( note)?( template)?$/i };
const TEMPLATE_DIR = /(^|\/)_?templates?\//i;
const slugify = (s) => normName(s).replace(/ /g, '-');
// a folder whose notes are named as slugs (ana-ruiz.md): the keeper matches people notes by slug
const sluggy = (notes, dir) => { const inDir = notes.filter((n) => n.rel.startsWith(`${dir}/`)); return inDir.length >= 2 && inDir.every((n) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(baseOf(n.rel))); };
const today = (now) => new Date(now).toISOString().slice(0, 10);

// the text of the new note: the vault's template for the kind with {{title}} and {{date}} filled in, else a short
// default; type and aliases set in its frontmatter, and the notes that mention it listed
export function entityText({ name, kind, file, sources, template = null, now = Date.now() }) {
  const day = today(now);
  const alias = file !== name ? `aliases: [${JSON.stringify(name)}]\n` : '';
  const listed = sources.map((r) => `- [[${r.replace(/\.md$/i, '')}]]`).join('\n');
  if (template) {
    let t = template.replace(/\{\{\s*title\s*\}\}/gi, name).replace(/\{\{\s*date(:[^}]*)?\s*\}\}/gi, day).replace(/<%[\s\S]*?%>/g, '');
    if (!/^type:/m.test(t.split('\n---')[0] ?? '')) t = t.startsWith('---\n') ? t.replace(/^---\n/, `---\ntype: ${kind}\n${alias}`) : `---\ntype: ${kind}\n${alias}---\n${t}`;
    return `${t.replace(/\s*$/, '')}\n\n## Mentioned in\n\n${listed}\n`;
  }
  return `---\ntype: ${kind}\n${alias}created: ${day}\n---\n# ${name}\n\n## Mentioned in\n\n${listed}\n`;
}

export function run(ctx) {
  const { notes, resolve, graph = null, now = Date.now(), owner = '' } = ctx;
  const all = live(notes);
  const secret = confidentialSet(ctx);
  const byRel = new Map(notes.map((n) => [n.rel, n]));
  // every name a note goes by, so a mention that matches a note under another spelling is no gap
  const known = new Set(all.flatMap((n) => namesOf(n).map(normName)));
  const found = new Map();
  const add = (name, kind, rel) => {
    const k = `${kind}\n${normName(name)}`;
    const e = found.get(k) ?? found.set(k, { name, kind, rels: new Set() }).get(k);
    e.rels.add(rel);
  };
  if (graph) {
    for (const kind of ['person', 'project']) for (const x of graph.nodes(kind)) {
      if (x.rel) continue;
      for (const rel of x.mentions) add(x.name, kind, rel);
    }
  } else {
    for (const n of all) for (const m of frontmatterNames(n)) add(m.name, m.kind, n.rel);
  }
  const out = [];
  for (const { name, kind, rels } of found.values()) {
    const open = [...rels].filter((r) => byRel.has(r) && !secret(byRel.get(r))).sort();
    if (open.length < MIN_MENTIONS) continue;
    // the person the vault belongs to is in every meeting and needs no note from this rule
    if (known.has(normName(name)) || resolve(name, open[0]) || (owner && normName(owner) === normName(name))) continue;
    const dir = kindFolder(all, kind);
    const file = dir && sluggy(all, dir) ? slugify(name) : name.replace(/[\\/:*?"<>|#^[\]]/g, '').replace(/[.\s]+$/, '').trim();
    const rel = `${dir ? `${dir}/` : ''}${file}.md`;
    if (byRel.has(rel)) continue;
    const template = all.length ? notes.find((n) => TEMPLATE_DIR.test(n.rel) && TEMPLATE_NAME[kind].test(baseOf(n.rel)))?.text ?? null : null;
    const linked = open.slice(0, MAX_LINKED);
    const target = rel.replace(/\.md$/i, '').split('/').pop();
    const ops = [
      { op: 'create', rel, text: entityText({ name, kind, file, sources: open, template, now }), sources: [] },
      ...linked.map((r) => ({ op: 'mention', rel: r, name, to: rel, target, edge: kind === 'person' && kindOf(byRel.get(r)) === 'meeting' ? 'attended' : 'mentions', entity: kind })),
    ];
    out.push(finding(rule, {
      key: `${kind}:${normName(name)}`, target: rel, notes: open,
      title: `${quote(name)} is mentioned in ${plural(open.length, 'note')} and has no note`,
      problem: `The agent finds ${quote(name)} in ${plural(open.length, 'note')} with no ${kind} note to say who or what it is.`,
      proposal: `Write ${quote(rel)}${template ? ' from your template' : ''} and link ${linked.length === open.length ? 'each mention' : `the first ${linked.length} mentions`} to it.`,
      evidence: [...open.slice(0, 5).map((r) => `Mentioned in ${r}`), ...(open.length > 5 ? [`And ${plural(open.length - 5, 'more note')}`] : []), graph ? 'Found in the memory graph' : 'Found in frontmatter fields'],
      facts: [`mentions:${open.length}`],
      meta: [['Kind', kind], ['New note', rel]],
      fix: { kind: 'ops', group: 'entity', ops },
    }));
  }
  return out;
}
