// Memory health: the missing links in the vault (vindex.js linkHealth), sorted into categories and written up as
// issues a person can act on. Each issue has a plain one-line title, the suggested fix, the numbers for the card
// footer, and the action Accept recommendation takes. Shared by the panel (MemoryHealth.tsx) and the tests.

export const CATEGORIES = [
  { id: 'missing', label: 'Missing notes' },
  { id: 'alias', label: 'Likely matches' },
  { id: 'similar', label: 'Similar names' },
  { id: 'outside', label: 'Outside the vault' },
];
export const LEFT_LABEL = 'Left as is';

const OUTSIDE_RE = /^(\.\.\/|\/)|(^|\/)\.claude\//;

// which category a missing link falls in: it points outside the vault, a note almost certainly goes by that name, a
// note has a similar name, or nothing matches
export function categoryOf(m) {
  if (OUTSIDE_RE.test(m.target)) return 'outside';
  const c = m.candidates?.[0];
  if (c?.exact) return 'alias';
  if (c) return 'similar';
  return 'missing';
}

// the folder most of the links come from, and how many of the linking notes are in it
export function topFolder(sources) {
  const n = new Map();
  for (const s of sources) { const d = s.includes('/') ? s.slice(0, s.lastIndexOf('/')) : ''; n.set(d, (n.get(d) ?? 0) + 1); }
  let best = null;
  for (const [folder, count] of n) if (!best || count > best.count || (count === best.count && folder < best.folder)) best = { folder, count };
  return best;
}

const notes = (n) => (n === 1 ? 'One note links' : `${n} notes link`);

// one missing link as an issue card
export function issueOf(m) {
  const category = categoryOf(m);
  const c = m.candidates?.[0] ?? null;
  const name = `“${m.target}”`;
  const match = c ? `“${c.name ?? c.title}”` : '';
  const title = {
    missing: `${notes(m.count)} to ${name}, a note that does not exist`,
    alias: `${notes(m.count)} to ${name}, which is almost certainly ${match}`,
    similar: `${notes(m.count)} to ${name}, and no note has that name`,
    outside: `${notes(m.count)} to ${name}, which is outside this vault`,
  }[category];
  const fix = {
    missing: `Write a note named ${name}, so the links have a note to open.`,
    alias: `Add ${name} as an alias of ${match}. Every link then opens that note, and no note text changes.`,
    similar: `Change the links to point at ${match}, the note with the closest name.`,
    outside: 'Leave the link as it is. Quorum only follows links to notes inside this vault.',
  }[category];
  const action = { missing: 'create', alias: 'alias', similar: 'relink', outside: 'leave' }[category];
  // the longer write-up Memory health and Notifications show: the problem the issue causes, what fixing it does for
  // the memory, and the recommended action Approve takes
  const linkWord = (m.links ?? m.count) === 1 ? 'link' : 'links';
  const noteWord = m.count === 1 ? 'note' : `${m.count} notes`;
  const problem = {
    missing: `The ${linkWord} open nothing. The agent can not follow them, so it can not bring together what ${m.count === 1 ? 'this note says' : 'these notes say'} about ${name}.`,
    alias: `The ${linkWord} open nothing, because the note is named ${match}. The agent treats ${name} as a separate topic with no note.`,
    similar: `The ${linkWord} open nothing. The closest note is ${match}, which may be the note they mean.`,
    outside: `The link points at a file outside this vault. Quorum and the agent only follow links inside the vault.`,
  }[category];
  const effect = {
    missing: `Every link opens the new note, and the graph connects the ${noteWord} through it.`,
    alias: `Every link opens ${match}, and the agent counts them as links to that note. No note text changes.`,
    similar: `The links open ${match}, and the agent sees the ${noteWord} as related to it.`,
    outside: 'Nothing in your memory changes. The issue stops showing here.',
  }[category];
  const recommend = {
    missing: `Make an empty note named ${name}. You can add to it later.`,
    alias: `Add ${name} as an alias of ${match}.`,
    similar: `Point the links in the ${noteWord} at ${match}. Use View first to check it is the right note.`,
    outside: 'Leave the link as it is.',
  }[category];
  const top = topFolder(m.sources ?? []);
  return {
    key: m.target.toLowerCase(), target: m.target, category, title, fix, problem, effect, recommend, action, candidate: c, sources: m.sources ?? [],
    path: m.sources?.[0] ?? '', links: m.links ?? m.count, notes: m.count, folder: top, lastAt: m.lastAt ?? null,
  };
}

// the categories with their counts, in a fixed order and without the empty ones; links left as is are counted
// apart, at the end
export function categoryCounts(items, left = new Set()) {
  const n = new Map();
  let kept = 0;
  for (const m of items) {
    if (left.has(m.target.toLowerCase())) { kept++; continue; }
    const c = categoryOf(m);
    n.set(c, (n.get(c) ?? 0) + 1);
  }
  const out = CATEGORIES.filter((c) => n.get(c.id)).map((c) => ({ id: c.id, label: c.label, count: n.get(c.id) }));
  if (kept) out.push({ id: 'left', label: LEFT_LABEL, count: kept });
  return out;
}

// the subtitle line: each category and its count
export const countsLine = (counts) => counts.map((c) => `${c.label} ${c.count}`).join(' · ');

// the footer facts of a card, in order: links, the folder most of them come from, the last change
export function footerFacts(issue, { date = (t) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) } = {}) {
  const out = [`${issue.links} ${issue.links === 1 ? 'link' : 'links'}`];
  if (issue.folder && issue.notes > 1) out.push(`${issue.folder.count} of ${issue.notes} from ${issue.folder.folder || 'the vault root'}`);
  else if (issue.folder) out.push(`From ${issue.folder.folder || 'the vault root'}`);
  if (issue.lastAt) out.push(`Changed ${date(issue.lastAt)}`);
  return out;
}

// the missing links in one open note, as review items in line order, joined to their issue. Links left as is and
// links with no issue are left out
export function fileIssues(lines, items, left = new Set()) {
  const by = new Map(items.map((m) => [m.target.toLowerCase(), m]));
  return lines
    .filter((l) => by.has(l.target.toLowerCase()) && !left.has(l.target.toLowerCase()))
    .sort((a, b) => a.line - b.line)
    .map((l) => ({ line: l.line, issue: issueOf(by.get(l.target.toLowerCase())) }));
}

// the marks the Memory tree shows for open issues: each note with the number of open issues it links to, and each
// folder with the number of open issues that have a linking note anywhere inside it (an issue counts once per folder)
export function healthMarks(items, left = new Set()) {
  const files = {};
  const folders = {};
  for (const m of items) {
    if (left.has(m.target.toLowerCase())) continue;
    const inside = new Set();
    for (const s of new Set(m.sources ?? [])) {
      files[s] = (files[s] ?? 0) + 1;
      const parts = s.split('/');
      for (let k = 1; k < parts.length; k++) inside.add(parts.slice(0, k).join('/'));
    }
    for (const f of inside) folders[f] = (folders[f] ?? 0) + 1;
  }
  return { files, folders };
}

// the sorts Memory health offers, the same pattern as Notifications
export const HEALTH_SORTS = [['links', 'Most links'], ['recent', 'Recent'], ['az', 'A to Z']];
const BY = {
  links: (a, b) => b.links - a.links || a.target.localeCompare(b.target),
  recent: (a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0) || b.links - a.links,
  az: (a, b) => a.target.localeCompare(b.target, undefined, { sensitivity: 'base' }),
};
// one tab of Memory health as issues: open or left as is, narrowed to categories and to the issues whose words match
export function healthList(items, { tab = 'open', categories = [], q = '', sort = 'links', left = new Set() } = {}) {
  const cats = new Set(categories);
  const words = String(q ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  return items
    .filter((m) => left.has(m.target.toLowerCase()) === (tab === 'left'))
    .map(issueOf)
    .filter((i) => !cats.size || cats.has(i.category))
    .filter((i) => { const hay = `${i.target} ${i.title} ${i.sources.join(' ')} ${i.candidate?.name ?? i.candidate?.title ?? ''}`.toLowerCase(); return words.every((w) => hay.includes(w)); })
    .sort(BY[sort] ?? BY.links);
}
