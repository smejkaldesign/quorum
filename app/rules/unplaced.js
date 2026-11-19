// Notes the folder conventions cannot place: a note whose type says person, project, meeting or decision and that sits
// outside the vault's folder for that kind, and a note at the vault root with no type whose links mostly go into one
// folder. The agent and the keeper look for each kind in its folder. Approve moves the note there; the links to it
// follow. A root note that works as a hub stays where it is: a map of content (MOC_LINKS or more notes linked, or mostly
// a list of links), a note other root notes link to, or one named for the folder it points into (Projects.md). A confidential note stays too:
// moving it out of its folder would drop the folder's confidential mark.
import { DATED, ENTRY_NAME, baseOf, bodyOf, dirOf, finding, plural, quote } from './common.js';
import { FOLDER_RE, confidentialSet, kindFolder, live, normName, typeOf } from './entities.js';

export const rule = { id: 'note.unplaced', version: 2, label: 'Notes outside the folder for their kind' };
// a root note moves only when this share of its links, and at least MIN_LINKS of them, go into one folder
export const LINK_SHARE = 0.6;
export const MIN_LINKS = 3;
export const MOC_LINKS = 10;
const bare = (s) => normName(String(s).replace(/^\d+[-_ ]*/, ''));
// a note that is mostly a list of links (a roadmap or an index under another name): half or more of its text lines
// are list items with a link
const listOfLinks = (text) => {
  const lines = bodyOf(text).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const items = lines.filter((l) => /^([-*+]|\d+\.)\s+.*\[\[/.test(l)).length;
  return items >= MIN_LINKS && items / lines.length >= 0.5;
};

export function run(ctx) {
  const { notes, resolve } = ctx;
  const secret = confidentialSet(ctx);
  const all = live(notes).filter((n) => !secret(n));
  // the root notes another root note links to
  const linkedFromRoot = new Set();
  for (const n of all) if (!dirOf(n.rel)) for (const l of n.note?.links ?? []) { const to = resolve(l.target, n.rel); if (to && to !== n.rel && !dirOf(to)) linkedFromRoot.add(to); }
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
    if (dirOf(n.rel) || DATED.test(name) || linkedFromRoot.has(n.rel)) continue;
    const counts = new Map();
    const targets = new Set();
    let total = 0;
    for (const l of n.note?.links ?? []) {
      const to = resolve(l.target, n.rel);
      if (!to || to === n.rel || !dirOf(to)) continue;
      total++;
      targets.add(to);
      const top = to.split('/')[0];
      counts.set(top, (counts.get(top) ?? 0) + 1);
    }
    const [top, hits] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [];
    if (!top || hits < MIN_LINKS || hits / total < LINK_SHARE) continue;
    if (targets.size >= MOC_LINKS || bare(name) === bare(top) || listOfLinks(n.text)) continue;
    push(n, `${top}/${n.rel}`, `It sits at the vault root with no type, and most of its links go into ${top}, so it most likely belongs there.`, [`${plural(hits, 'link')} of ${total} go into ${top}`, 'Its frontmatter has no type']);
  }
  return out;
}
