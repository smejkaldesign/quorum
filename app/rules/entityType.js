// People and project notes with no type: a note in a people or projects folder, or one the memory graph reads as a
// person or project, whose frontmatter sets no type. Agents and the graph read type first, so the note is read as a
// plain note. Approve sets type to person or project.
import { ENTRY_NAME, baseOf, finding, quote } from './common.js';
import { folderKind, live } from './entities.js';

export const rule = { id: 'note.entity-type', version: 1, label: 'People and project notes with no type' };

export function run({ notes, graph = null }) {
  const out = [];
  const byGraph = new Map();
  if (graph) for (const kind of ['person', 'project']) for (const x of graph.nodes(kind)) if (x.rel) byGraph.set(x.rel, kind);
  for (const n of live(notes)) {
    if (ENTRY_NAME.test(baseOf(n.rel))) continue;
    const props = n.note?.props ?? {};
    if (props.type != null && String(props.type).trim() !== '' && !(Array.isArray(props.type) && !props.type.length)) continue;
    const folder = folderKind(n.rel);
    const kind = folder === 'person' || folder === 'project' ? folder : byGraph.get(n.rel) ?? null;
    if (!kind) continue;
    out.push(finding(rule, {
      key: n.rel, target: n.rel, notes: [n.rel],
      title: `${quote(n.note?.title ?? n.rel)} has no type`,
      problem: `It reads as a ${kind} note, and its frontmatter does not say so. Agents and the memory graph read type first.`,
      proposal: `Set type: ${kind} in its frontmatter.`,
      evidence: [folder ? `It sits in ${n.rel.slice(0, n.rel.lastIndexOf('/'))}` : `The memory graph reads it as a ${kind}`, 'Its frontmatter has no type'],
      facts: [`kind:${kind}`],
      meta: [['Note', n.rel], ['Type', kind]],
      fix: { kind: 'ops', group: 'setkey', ops: [{ op: 'setkey', rel: n.rel, key: 'type', value: kind }] },
    }));
  }
  return out;
}
