// Memory health: the missing links in the vault (vindex.js linkHealth), sorted by the fix Quorum recommends and written
// up as issues a person can act on. Shared by Memory health, the note review, Notifications and the tests.
//
// The fix follows an order, best first, because an agent reading the vault gets the most from a link that opens the
// note it means, then from a note that gathers what the vault says about a topic, and gets nothing from a link to an
// empty note:
//   1. alias: a note goes by that exact name: add the name as its alias
//   2. relink: a note is clearly the one meant (it shares most of the name's words, or shares some and is already
//               linked with the linking notes or sits in their folder): point the link at it
//   3. create: the linking notes say enough about the missing note to start it: write it from what they say
//   4. relink: a weaker match, offered after writing the note
//   5. unlink: nothing matches and nothing says enough: keep the words and take the dead link out
// Decline moves to the next fix in the order; Ignore leaves the link as it is.

// the Type filter, one entry per recommended fix
export const CATEGORIES = [
  { id: 'alias', label: 'Likely matches' },
  { id: 'similar', label: 'Closer notes' },
  { id: 'missing', label: 'Notes to write' },
  { id: 'unlink', label: 'Dead links' },
  { id: 'outside', label: 'Outside the vault' },
];
export const LEFT_LABEL = 'Left as is';

const OUTSIDE_RE = /^(\.\.\/|\/)|(^|\/)\.claude\//;
const CATEGORY_OF = { alias: 'alias', relink: 'similar', create: 'missing', unlink: 'unlink', leave: 'outside' };

// a match strong enough to recommend first
// a match strong enough to recommend first: no clash in the kind of document, the shared words cover most of the link's
// topic, and either they cover all of it or the note already sits near the linking notes (linked with them, or in
// their folder). A weaker match without a clash is offered later; a clash is never offered
const strong = (c) => !!c && !c.exact && !c.kindClash && (c.shared?.length ?? 0) >= 2 && (c.cover ?? 0) >= 1 && (c.neighbor || c.sameFolder || (c.shared?.length ?? 0) >= 3);
const usable = (c) => !!c && !c.exact && !c.kindClash && (c.shared?.length ?? 0) >= 2 && (c.cover ?? 0) >= 0.5;
// the words the linking notes say around the link, apart from the link's own name
export function contextWords(m) {
  const own = new Set(String(m.target).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  let n = 0;
  for (const c of m.contexts ?? []) n += (String(c.text).toLowerCase().match(/[a-z][a-z'’]{2,}/g) ?? []).filter((w) => !own.has(w)).length;
  return n;
}
// enough to start a note: more than one note refers to it, or the linking lines describe it in a sentence or more
const hasContext = (m) => m.count >= 2 || contextWords(m) >= 12;

// the fixes for a missing link, best first (see the order above)
export function optionsOf(m) {
  if (OUTSIDE_RE.test(m.target)) return ['leave'];
  const c = m.candidates?.[0];
  const out = [];
  if (c?.exact) out.push('alias');
  else if (strong(c)) out.push('relink');
  if (hasContext(m)) out.push('create');
  if (usable(c) && !strong(c)) out.push('relink');
  out.push('unlink');
  return out;
}

// which category a missing link falls in: the fix recommended now, after the ones the person declined
export function categoryOf(m) {
  return CATEGORY_OF[pending(m)[0] ?? 'leave'];
}
const pending = (m) => { const no = new Set(m.declined ?? []); return optionsOf(m).filter((o) => !no.has(o)); };

// the folder most of the links come from, and how many of the linking notes are in it
export function topFolder(sources) {
  const n = new Map();
  for (const s of sources) { const d = s.includes('/') ? s.slice(0, s.lastIndexOf('/')) : ''; n.set(d, (n.get(d) ?? 0) + 1); }
  let best = null;
  for (const [folder, count] of n) if (!best || count > best.count || (count === best.count && folder < best.folder)) best = { folder, count };
  return best;
}

const notes = (n) => (n === 1 ? 'One note links' : `${n} notes link`);
const list = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0] ?? '');
const quote = (t) => `“${t}”`;

// one missing link as an issue: the title, the problem it causes, what fixing it does, what Approve does (the
// recommended fix) and what Decline does (the next fix, or leaving it)
export function issueOf(m) {
  const options = pending(m);
  const action = options[0] ?? 'leave';
  const next = options[1] ?? null;
  const category = CATEGORY_OF[action];
  const c = m.candidates?.[0] ?? null;
  const name = quote(m.target);
  const match = c ? quote(c.name ?? c.title) : '';
  const one = (m.links ?? m.count) === 1;
  const Links = one ? 'The link opens' : 'The links open';
  const linkWord = one ? 'link' : 'links';
  const them = one ? 'it' : 'them';
  const top = topFolder(m.sources ?? []);
  const createIn = top?.folder ?? '';
  const linking = m.count === 1 ? 'the linking note' : `the ${m.count} linking notes`;
  const why = c ? [
    c.shared?.length ? `shares the words ${list(c.shared.slice(0, 4).map(quote))}` : null,
    c.neighbor ? `is already linked with ${m.count === 1 ? 'the linking note' : 'these notes'}` : null,
    c.sameFolder ? 'sits in the same folder' : null,
  ].filter(Boolean) : [];

  const title = {
    alias: `${notes(m.count)} to ${name}, which is almost certainly ${match}`,
    relink: `${notes(m.count)} to ${name}, and the closest note is ${match}`,
    create: `${notes(m.count)} to ${name}, a note that does not exist`,
    unlink: `${notes(m.count)} to ${name}, a note that does not exist`,
    leave: `${notes(m.count)} to ${name}, which is outside this vault`,
  }[action];
  const problem = {
    alias: `${Links} nothing, because the note is named ${match}. The agent treats ${name} as a separate topic with no note.`,
    relink: `${Links} nothing. ${match} ${list(why) || 'has a close name'}, so it is most likely the note meant.`,
    create: `${Links} nothing. ${m.count > 1 ? `${m.count} notes refer to ${name}` : `The linking note describes ${name}`}, so it reads as a topic of its own with no note for the agent to read.`,
    unlink: `${Links} nothing. No note has a close name, and ${linking} ${m.count === 1 ? 'says' : 'say'} too little about ${name} to write one, so the agent follows ${one ? 'a link' : 'links'} to nothing.`,
    leave: 'The link points at a file outside this vault. Quorum and the agent only follow links inside the vault.',
  }[action];
  const effect = {
    alias: `${one ? 'The link opens' : 'Every link opens'} ${match}, and the agent counts ${them} as links to that note. No note text changes.`,
    relink: `${Links} ${match}, and the agent can follow ${them} to the note ${one ? 'it most likely means' : 'they most likely mean'}.`,
    create: `A note named ${name} holds what ${linking} ${m.count === 1 ? 'says' : 'say'} about it, with a link back to each. The agent reads the topic in one place, and the graph connects ${m.count === 1 ? 'the note' : `the ${m.count} notes`} through it.`,
    unlink: `The words stay in the text and the dead ${linkWord} ${one ? 'goes' : 'go'}. The agent stops following ${them}, and the graph drops the empty node.`,
    leave: 'Nothing in your memory changes. The issue stops showing here.',
  }[action];
  const recommend = {
    alias: `Add ${name} as an alias of ${match}.`,
    relink: `Point the ${linkWord} at ${match}.`,
    create: `Make a note named ${name}${createIn ? ` in ${createIn}` : ''} from what ${linking} ${m.count === 1 ? 'says' : 'say'} about it.`,
    unlink: `Remove the ${linkWord} and keep ${name} as plain text.`,
    leave: 'Leave the link as it is.',
  }[action];
  const nextText = {
    alias: `add ${name} as an alias of ${match}`,
    relink: `point the ${linkWord} at ${match}`,
    create: `make a note named ${name} from what ${linking} ${m.count === 1 ? 'says' : 'say'}`,
    unlink: `remove the ${linkWord} and keep the words`,
  };
  const decline = next ? `Quorum suggests the next fix instead: ${nextText[next]}.` : 'The links stay as they are, and the issue moves to Left as is.';
  return {
    key: m.target.toLowerCase(), target: m.target, category, title, fix: recommend, problem, effect, recommend, decline, action, next, candidate: c, sources: m.sources ?? [],
    contexts: m.contexts ?? [], createIn, path: m.sources?.[0] ?? '', links: m.links ?? m.count, notes: m.count, folder: top, lastAt: m.lastAt ?? null,
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
