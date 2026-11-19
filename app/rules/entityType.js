// People and project notes with no type: a note the memory graph reads as a person or project (another note names it
// as one, or it is its folder's hub note; rules/entities.js entityKinds) whose frontmatter sets no type. Agents read
// type first, and the note stays a person or project only while those links last. A note in a people or projects
// folder that nothing names as one is a plain note (a spec, a PRD, a list) and gets no item.
// One item per folder and kind, listing its notes; Approve sets the type on the notes the person keeps ticked.
import { baseOf, dirOf, finding, plural, quote } from './common.js';
import { entityKinds, live } from './entities.js';

export const rule = { id: 'note.entity-type', version: 2, label: 'People and project notes with no type' };
const WORD = { person: ['person note', 'person notes'], project: ['project note', 'project notes'] };
const untyped = (props) => props.type == null || String(props.type).trim() === '' || (Array.isArray(props.type) && !props.type.length);

export function run(ctx) {
  const read = entityKinds(ctx);
  const groups = new Map();
  for (const n of live(ctx.notes)) {
    const kind = read(n);
    if ((kind !== 'person' && kind !== 'project') || !untyped(n.note?.props ?? {})) continue;
    const k = `${kind}\n${dirOf(n.rel)}`;
    (groups.get(k) ?? groups.set(k, { kind, dir: dirOf(n.rel), list: [] }).get(k)).list.push(n);
  }
  const out = [];
  for (const { kind, dir, list } of groups.values()) {
    list.sort((a, b) => a.rel.localeCompare(b.rel));
    const why = (n) => { const w = read.why(n); return w === 'hub' ? 'the hub note of its folder' : w === 'graph' ? 'named as one by other notes' : w ?? 'named as one'; };
    const [one, many] = WORD[kind];
    const where = dir || 'the vault root';
    out.push(finding(rule, {
      key: `${kind}:${dir}`, target: `${kind}\n${dir}`, notes: list.map((n) => n.rel),
      title: list.length === 1 ? `${quote(list[0].note?.title ?? baseOf(list[0].rel))} reads as a ${one} and has no type` : `${plural(list.length, one, many)} in ${quote(where)} have no type`,
      problem: `The memory graph reads ${list.length === 1 ? 'it' : 'them'} as ${list.length === 1 ? `a ${kind}` : kind === 'person' ? 'people' : 'projects'} from ${list.length === 1 ? 'its' : 'their'} links or ${list.length === 1 ? 'its' : 'their'} folder, and ${list.length === 1 ? 'its' : 'their'} frontmatter does not say so. Agents read type first.`,
      proposal: `Set type: ${kind} in the frontmatter of ${list.length === 1 ? 'the note' : 'each note you keep ticked'}.`,
      evidence: list.slice(0, 20).map((n) => `${n.rel}: ${why(n)}`).concat(list.length > 20 ? [`And ${plural(list.length - 20, 'more note')}`] : []),
      facts: [`kind:${kind}`, `notes:${list.length}`],
      meta: [['Folder', where], ['Type', kind]],
      fix: { kind: 'ops', group: 'setkey', pick: list.length > 1, ops: list.map((n) => ({ op: 'setkey', rel: n.rel, key: 'type', value: kind })) },
    }));
  }
  return out;
}
