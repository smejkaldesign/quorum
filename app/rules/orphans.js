// Orphan notes: a note no other note links to, so the agent only finds it by search. Entry points are left out: index,
// README, CLAUDE and log notes, dated notes (daily notes and session logs are reached by date), notes in inbox,
// daily, journal, template and archive folders, notes another note names in its frontmatter, and generated reports. A folder
// where most notes have no inbound link is a log-style folder by design, so its notes are left out too.
import { DATED, ENTRY_NAME, baseOf, dirOf, finding, plural, quote, skipped } from './common.js';

export const rule = { id: 'note.orphan', version: 1, label: 'Notes nothing links to' };
// inbox, daily, journal and template folders are entry points; archive folders hold notes set aside on purpose
const ENTRY_FOLDERS = /(^|\/)([^/]*inbox[^/]*|daily|journal|templates?|_templates?|[^/]*archived?[^/]*)(\/|$)/i;
// a folder whose notes are mostly unlinked holds logs, archives or copies; its orphans are expected
const LOG_FOLDER_SHARE = 0.5;
const MIN_FOLDER = 3;

export function run({ notes, resolve }) {
  // notes named in another note's frontmatter (related:, parent:, see:) count as linked
  const fromFrontmatter = new Set();
  for (const n of notes) for (const v of Object.values(n.note?.props ?? {})) {
    for (const s of Array.isArray(v) ? v : [v]) for (const m of String(s).matchAll(/\[\[([^\]|#]+)/g)) { const to = resolve(m[1].trim(), n.rel); if (to && to !== n.rel) fromFrontmatter.add(to); }
  }
  const unlinked = (n) => n.inbound === 0 && !fromFrontmatter.has(n.rel);
  const folders = new Map();
  for (const n of notes) { const d = dirOf(n.rel); const f = folders.get(d) ?? folders.set(d, { all: 0, orphans: 0 }).get(d); f.all++; if (unlinked(n)) f.orphans++; }
  const out = [];
  for (const n of notes) {
    if (!unlinked(n) || skipped(n)) continue;
    const name = baseOf(n.rel);
    if (ENTRY_NAME.test(name) || DATED.test(name) || ENTRY_FOLDERS.test(n.rel)) continue;
    const f = folders.get(dirOf(n.rel));
    if (f.all < MIN_FOLDER || f.orphans / f.all >= LOG_FOLDER_SHARE) continue;
    // a note that links out is still reachable from its own links; one with no links either way is isolated
    if (n.outbound > 0) continue;
    const linkedShare = Math.round(((f.all - f.orphans) / f.all) * 100);
    out.push(finding(rule, {
      key: n.rel, target: n.rel, notes: [n.rel],
      title: `${quote(n.note?.title ?? name)} has no links in or out`,
      problem: 'No note links to it and it links to none, so the agent only reaches it by search and the graph shows it alone.',
      proposal: 'Link it from a note on the same topic, or archive it if nobody uses it.',
      evidence: [`0 notes link to it, and it links to 0 notes`, `${linkedShare}% of the ${plural(f.all, 'note')} in ${dirOf(n.rel) || 'the vault root'} have a link in`],
      meta: [['Note', n.rel], ['Folder', dirOf(n.rel) || 'The vault root']],
    }));
  }
  return out;
}
