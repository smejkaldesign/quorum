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
  const top = topFolder(m.sources ?? []);
  return {
    key: m.target.toLowerCase(), target: m.target, category, title, fix, action, candidate: c,
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
