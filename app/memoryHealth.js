// Memory health: the missing links in the vault (vindex.js linkHealth), sorted by the fix Quorum recommends and written
// up as issues a person can act on. Shared by Memory health, the note review, Notifications and the tests.
//
// The fix follows an order, best first, because an agent reading the vault gets the most from a link that opens the
// note it means, then from a note that gathers what the vault says about a topic, and gets nothing from a link to an
// empty note:
//   1. alias: a note goes by that exact name: add the name as its alias
//   2. relink: a note is clearly the one meant (it shares most of the name's words, or shares some and is already
//               linked with the linking notes or sits in their folder): point the link at it
//   3. relink: a weaker match: a note that exists beats a new note that only quotes the links
//   4. create: two or more notes link to it: write it from what they say
//   5. unlink: nothing matches and nothing says enough: keep the words and take the dead link out
// A link whose name is a folder, script, skill, file or a note on another branch (linkElsewhere.js) is left as it is,
// or pointed at the folder's index note. Writing a note and a weaker match are review-only: Approve on a selection of
// several issues skips them, so a person reads each one first (see linkRules.js createPlan for when Quorum may write
// a note at all)
// Decline moves to the next fix in the order; Ignore leaves the link as it is.

import { createPlan } from './linkRules.js';

// the Type filter, one entry per recommended fix
export const CATEGORIES = [
  { id: 'alias', label: 'Likely matches' },
  { id: 'similar', label: 'Closer notes' },
  { id: 'missing', label: 'Notes to write' },
  { id: 'unlink', label: 'Dead links' },
  { id: 'outside', label: 'Outside the vault' },
  { id: 'elsewhere', label: 'Not a note' },
];
export const LEFT_LABEL = 'Dismissed';

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
// what the link names outside this checkout's notes (linkElsewhere.js), unless a note goes by that exact name
const foundOf = (m) => (m.found && !m.candidates?.[0]?.exact ? m.found : null);
// a folder's index note, as the candidate for a link to the folder
const folderCandidate = (f) => ({ rel: f.rel, title: f.rel.split('/').pop().replace(/\.md$/i, ''), name: null, exact: false, score: 1, cover: 1, kindClash: false, shared: [], neighbor: false, sameFolder: false, folder: true });

// the fixes for a missing link, best first (see the order above)
export function optionsOf(m) {
  if (OUTSIDE_RE.test(m.target)) return ['leave'];
  const found = foundOf(m);
  if (found) return found.rel ? ['relink', 'leave'] : ['leave'];
  const c = m.candidates?.[0];
  const out = [];
  if (c?.exact) out.push('alias');
  else if (strong(c)) out.push('relink');
  else if (usable(c)) out.push('relink');
  if (createPlan(m).ok) out.push('create');
  out.push('unlink');
  return out;
}

// which category a missing link falls in: the fix recommended now, after the ones the person declined
export function categoryOf(m) {
  const action = pending(m)[0] ?? 'leave';
  return action === 'leave' && foundOf(m) ? 'elsewhere' : CATEGORY_OF[action];
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
  const found = foundOf(m);
  const category = action === 'leave' && found ? 'elsewhere' : CATEGORY_OF[action];
  const c = found ? (found.rel ? folderCandidate(found) : null) : (m.candidates?.[0] ?? null);
  const plan = createPlan(m);
  const name = quote(m.target);
  const match = c ? quote(c.name ?? c.title) : '';
  const one = (m.links ?? m.count) === 1;
  const Links = one ? 'The link opens' : 'The links open';
  const linkWord = one ? 'link' : 'links';
  const them = one ? 'it' : 'them';
  const top = topFolder(m.sources ?? []);
  // a new note goes where most of its linking notes live (linkRules.js createPlan), so what it quotes stays in the
  // same area of the vault
  const createIn = plan.ok ? plan.folder : '';
  // writing a note and a weak match need a person to read the issue first; a bulk Approve skips them
  const reviewOnly = action === 'create' || (action === 'relink' && !c?.folder && !strong(c));
  const kindWord = found ? { folder: 'a folder', script: 'a script', skill: 'a skill', file: 'a file outside this vault', branch: `a note on the branch ${found.branch}` }[found.kind] ?? 'a file' : '';
  const where = found ? quote(found.where) : '';
  const linking = m.count === 1 ? 'the linking note' : `the ${m.count} linking notes`;
  const why = c ? [
    c.shared?.length ? `shares the words ${list(c.shared.slice(0, 4).map(quote))}` : null,
    c.neighbor ? `is already linked with ${m.count === 1 ? 'the linking note' : 'these notes'}` : null,
    c.sameFolder ? 'sits in the same folder' : null,
    c.folder ? 'is the index note of the folder with that name' : null,
  ].filter(Boolean) : [];

  const title = {
    alias: `${notes(m.count)} to ${name}, which is almost certainly ${match}`,
    relink: `${notes(m.count)} to ${name}, and the closest note is ${match}`,
    create: `${notes(m.count)} to ${name}, a note that does not exist`,
    unlink: `${notes(m.count)} to ${name}, a note that does not exist`,
    leave: found ? `${notes(m.count)} to ${name}, which is ${kindWord}` : `${notes(m.count)} to ${name}, which is outside this vault`,
  }[action];
  const problem = {
    alias: `${Links} nothing, because the note is named ${match}. The agent treats ${name} as a separate topic with no note.`,
    relink: `${Links} nothing. ${match} ${list(why) || 'has a close name'}, so it is most likely the note meant.`,
    create: `${Links} nothing. ${m.count > 1 ? `${m.count} notes refer to ${name}` : `The linking note describes ${name}`}, so it reads as a topic of its own with no note for the agent to read.`,
    unlink: `${Links} nothing. No note has a close name. ${plan.ok ? `${linking[0].toUpperCase()}${linking.slice(1)} ${m.count === 1 ? 'says' : 'say'} too little about ${name} to write one.` : plan.reason} The agent follows ${one ? 'a link' : 'links'} to nothing.`,
    leave: found?.kind === 'branch'
      ? `${Links} nothing on this branch. A note with that name is at ${where} on the branch ${found.branch}, so the link works once that branch merges. A second note here would clash with it.`
      : found ? `${name} is ${kindWord} at ${where}. A note link cannot open it, and a new note with that name would split the topic, so Quorum leaves the link for you to decide.`
        : 'The link points at a file outside this vault. Quorum and the agent only follow links inside the vault.',
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
  // the solution (what Quorum does on Approve) and the value (what it does for the memory and the agent)
  const solution = {
    alias: `Quorum adds ${name} to the aliases of ${match}. No note text changes.`,
    relink: `Quorum rewrites the ${linkWord} in ${linking} to point at ${match}.`,
    create: `Quorum writes a note named ${name}${createIn ? ` in ${createIn}` : ''} that quotes what ${linking} ${m.count === 1 ? 'says' : 'say'} about it, with a link back to each.`,
    unlink: `Quorum removes the ${linkWord} and keeps ${name} as plain text.`,
    leave: 'Nothing changes.',
  }[action];
  const value = {
    alias: `${one ? 'The link opens' : 'Every link opens'} ${match}, and the agent counts ${them} as links to that note.`,
    relink: `The agent can follow ${them} to the note ${one ? 'it most likely means' : 'they most likely mean'}.`,
    create: `The agent reads the topic in one place, and the graph connects ${m.count === 1 ? 'the note' : `the ${m.count} notes`} through it.`,
    unlink: `The agent stops following ${them} to nothing, and the graph drops the empty node.`,
    leave: 'The issue stops showing here.',
  }[action];
  const nextText = {
    alias: `add ${name} as an alias of ${match}`,
    relink: `point the ${linkWord} at ${match}`,
    create: `make a note named ${name} from what ${linking} ${m.count === 1 ? 'says' : 'say'}`,
    unlink: `remove the ${linkWord} and keep the words`,
    leave: 'leave the link as it is',
  };
  const decline = next ? `Quorum suggests the next fix instead: ${nextText[next]}.` : 'The links stay as they are, and the issue moves to Left as is.';
  // what Approve does when the agent does the work, or its fallback after the agent could not (main.js agentNeed)
  const says = m.approve?.says ?? null;
  return {
    key: m.target.toLowerCase(), target: m.target, category, title, fix: says ?? recommend, problem, effect, recommend: says ?? recommend, solution: says ?? solution, value, decline, action, next, candidate: c, sources: m.sources ?? [],
    reviewOnly, found: found ?? null, confidential: plan.ok ? plan.confidential : null,
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

// the facts of an issue, the same list in Memory health, the note's drawer and Notifications
export function issueMeta(issue, { date = (t) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) } = {}) {
  const out = [['Missing note', issue.target], ['First linked from', issue.path], ['Links', String(issue.links)]];
  if (issue.folder) out.push(['Most from', issue.folder.folder || 'The vault root']);
  if (issue.lastAt) out.push(['Changed', date(issue.lastAt)]);
  return out;
}
