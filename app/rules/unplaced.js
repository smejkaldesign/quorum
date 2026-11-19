// Notes the folder conventions cannot place: a note whose type says person, project, meeting or decision and that sits
// outside the vault's folder for that kind, and a note at the vault root with no type whose links mostly go into one
// folder. The agent and the keeper look for each kind in its folder. Approve moves the note there; the links to it
// follow.
import { DATED, ENTRY_NAME, baseOf, dirOf, finding, plural, quote } from './common.js';
import { FOLDER_RE, kindFolder, live, typeOf } from './entities.js';

export const rule = { id: 'note.unplaced', version: 1, label: 'Notes outside the folder for their kind' };
// a root note moves only when this share of its links, and at least MIN_LINKS of them, go into one folder
export const LINK_SHARE = 0.6;
export const MIN_LINKS = 3;

export function run({ notes, resolve }) {
  const all = live(notes);
  const rels = new Set(notes.map((n) => n.rel));
  const folders = Object.fromEntries(['person', 'project', 'meeting', 'decision'].map((k) => [k, kindFolder(all, k)]));
  const out = [];
  const push = (n, to, why, evidence) => {
    if (rels.has(to)) return;
    out.push(finding(rule, {
      key: n.rel, target: n.rel, notes: [n.rel],
      title: `${quote(n.note?.title ?? n.rel)} sits outside ${quote(dirOf(to))}`,
      problem: why,
      proposal: `Move it to ${quote(dirOf(to))}. The links to it follow.`,
      evidence,
      meta: [['Note', n.rel], ['Move to', to]],
      fix: { kind: 'ops', group: 'move', ops: [{ op: 'move', rel: n.rel, to }] },
    }));
  };
  for (const n of all) {
    const name = baseOf(n.rel);
    if (ENTRY_NAME.test(name)) continue;
    const kind = typeOf(n);
    if (kind) {
      const home = folders[kind];
      if (!home || FOLDER_RE[kind].test(dirOf(n.rel))) continue;
      push(n, `${home}/${n.rel.split('/').pop()}`, `Its type is ${kind}, and the vault keeps ${kind} notes in ${home}. The agent and the keeper look for them there.`, [`type: ${kind}`, `Now in ${dirOf(n.rel) || 'the vault root'}`]);
      continue;
    }
    if (dirOf(n.rel) || DATED.test(name)) continue;
    const counts = new Map();
    let total = 0;
    for (const l of n.note?.links ?? []) {
      const to = resolve(l.target, n.rel);
      if (!to || to === n.rel || !dirOf(to)) continue;
      total++;
      const top = to.split('/')[0];
      counts.set(top, (counts.get(top) ?? 0) + 1);
    }
    const [top, hits] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [];
    if (!top || hits < MIN_LINKS || hits / total < LINK_SHARE) continue;
    push(n, `${top}/${n.rel}`, `It sits at the vault root with no type, and most of its links go into ${top}, so it most likely belongs there.`, [`${plural(hits, 'link')} of ${total} go into ${top}`, 'Its frontmatter has no type']);
  }
  return out;
}
