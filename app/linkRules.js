// The rules Memory health applies to missing links before it offers a fix. Plain functions with no Node or Electron
// imports, so the window, main and the tests all use the same rules.

// Rule id and version of the missing-link detector, kept with each decision so a later version can tell which rule
// made a finding. Raise the version when the fix a finding gets can change
export const LINK_RULE = 'link.missing';
export const LINK_RULE_VERSION = 2;

const yes = (v) => v === true || /^(true|yes|1)$/i.test(String(v ?? '').trim());

// Generated notes: reports and logs a script or an agent writes. A link in one of them restates a link found in another
// note (a drift report lists the dead links it found as links), so it is never a source of a missing link, Quorum never
// edits one to fix a link, and it never becomes the note a link points at. Each rule names what it matches and why, so
// a person can read the list and a test can check each one
export const GENERATED_RULES = [
  { id: 'log-file', why: 'It is the vault change log', path: /(^|\/)(log|changelog)\.md$/i },
  { id: 'report-file', why: 'Its name marks it as a report', path: /(^|\/)[^/]*[-_]report(?:[-_]\d{4}-\d{2}-\d{2})?\.md$/i },
  { id: 'report-folder', why: 'It sits in a reports folder', path: /(^|\/)(reports|generated)\// },
  { id: 'generated-frontmatter', why: 'Its frontmatter marks it as generated', props: (p) => yes(p.generated) || !!p.generated_by || /^(report|log|generated)$/i.test(String(p.type ?? '')) },
];

// the rule a note matches, or null for a note a person wrote
export function generatedRule(rel, props = {}) {
  for (const r of GENERATED_RULES) {
    if (r.path && r.path.test(String(rel))) return r;
    if (r.props && r.props(props ?? {})) return r;
  }
  return null;
}
export const isGenerated = (rel, props) => generatedRule(rel, props) !== null;

// A note's title: its frontmatter title or its first heading, cut at a line break saved as the two characters \n and
// at 120 characters, so a note saved as one long line never turns its whole body into a title
export const TITLE_MAX = 120;
export function cleanTitle(text) {
  let t = String(text ?? '').split(/\\n|\n/)[0].trim();
  if (t.length > TITLE_MAX) { const cut = t.slice(0, TITLE_MAX); t = (cut.includes(' ') ? cut.slice(0, cut.lastIndexOf(' ')) : cut).trim(); }
  return t;
}

// Where Quorum may write a note for a missing link. Session logs and eval runs are written by agents and read in date
// order; a topic note there is lost. Each entry is tested against the folder path at any depth, so a vault that holds
// its notes one folder down (MyBrain/memory/sessions) is covered too
export const NO_CREATE_FOLDERS = [/(^|\/)sessions?(\/|$)/i, /(^|\/)evals?(\/|$)/i, /(^|\/)logs?(\/|$)/i];
const createAllowed = (folder) => !NO_CREATE_FOLDERS.some((re) => re.test(folder));
const dirOf = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
const falsy = (v) => v == null || v === false || /^(false|no|)$/i.test(String(v).trim());

// Link names that are common words or placeholders: a note about links writes [[link]] or [[filename-without-extension]]
// to show the syntax, and prose in brackets reads as [[wiki links]]. Quorum never writes a note for one
export const GENERIC_TARGETS = new Set(['link', 'links', 'wiki link', 'wiki links', 'wikilink', 'wikilinks', 'backlink', 'backlinks', 'filename', 'file name', 'file', 'files', 'filename-without-extension', 'name', 'note', 'notes', 'note name', 'note-name', 'page', 'pages', 'page name', 'title', 'todo', 'todos', 'tbd', 'example', 'examples', 'target', 'this', 'that', 'here', 'something', 'foo', 'bar', 'baz', 'test', 'placeholder', 'name-goes-here', 'your note', 'my note', 'path', 'slug']);
// placeholder shapes: <name>, {name}, ..., xxx, name-here, your-note, some-note
const PLACEHOLDER_RE = /^[<{].*[>}]$|\.\.\.|…|^x{2,}$|(^|[-_ ])(here|placeholder|example|without[-_ ]extension)$|^(your|some|another|my)[-_ ]/i;
export function genericTarget(target) {
  const name = String(target ?? '').split('/').pop().replace(/\.md$/i, '').trim().toLowerCase();
  return !name || GENERIC_TARGETS.has(name) || GENERIC_TARGETS.has(name.replace(/[-_]+/g, ' ')) || PLACEHOLDER_RE.test(name);
}

// A line that reports on links: a drift report or a lint log lists dead links as [[name]] next to words like
// "dead-wikilink" or "no matching vault file", or next to a file path in a code span. Those [[...]] are examples or
// findings about other notes, so they are never a source of a missing link
export const LINK_REPORT_LINE = /dead[- ]?(wiki)?[- ]?links?|broken[- ]?(wiki)?[- ]?links?|unresolved[- ]?(wiki)?[- ]?links?|missing[- ]?(wiki)?[- ]?links?|no matching (vault )?(file|note)|(link|links|wikilinks?) (to|with) no (target|note|file)|does not resolve|doesn['’]t resolve|link[- ]?(drift|lint|audit|check)/i;
// a code span next to a link that shows a file path or link syntax: `notes/a.md`, `[[name]]`
const CODE_PATH_RE = /`[^`]*(\.md\b|\[\[|\]\]|\/)[^`]*`/;
export const reportLine = (line) => LINK_REPORT_LINE.test(String(line ?? '')) || CODE_PATH_RE.test(String(line ?? ''));
// A whole note that reports on links: its title or a heading names dead or broken links or link drift, or two or more
// of its lines read as link report lines. Every link in it is left out
const REPORT_HEADING_RE = /(dead|broken|missing|unresolved|orphan(ed)?)[- ]?(wiki)?[- ]?links?|link (drift|health|lint|audit|report)|drift report|vault (drift|lint|audit)/i;
export function linkReport(text, title = '') {
  if (REPORT_HEADING_RE.test(String(title ?? ''))) return true;
  let hits = 0;
  for (const line of String(text ?? '').split('\n')) {
    if (/^#{1,6}\s/.test(line) && REPORT_HEADING_RE.test(line)) return true;
    if (LINK_REPORT_LINE.test(line) && ++hits >= 2) return true;
  }
  return false;
}

// Whether Quorum can offer to write the missing note, and where. It needs at least two linking notes (generated
// reports are already left out of the sources), goes in the folder most of them sit in (a sub-folder over the vault
// root on a tie, never a session, log or eval folder at any depth), needs a name that is not a common word or a
// placeholder (genericTarget), and carries a confidential mark forward when any
// linking note has one.
// Answers { ok: true, folder, confidential } or { ok: false, reason } with a plain reason a person can read
export function createPlan(m) {
  if (genericTarget(m.target)) return { ok: false, reason: `“${m.target}” is a common word or a placeholder, so it does not name a topic of its own.` };
  const sources = m.sources ?? [];
  if (sources.length < 2) return { ok: false, reason: 'Only one note links to it, which is too little to write a note from.' };
  const n = new Map();
  for (const s of sources) { const d = dirOf(s); if (createAllowed(d)) n.set(d, (n.get(d) ?? 0) + 1); }
  const better = (a, b) => a.count - b.count || Number(a.folder !== '') - Number(b.folder !== '') || (b.folder < a.folder ? -1 : b.folder > a.folder ? 1 : 0);
  let best = null;
  for (const [folder, count] of n) if (!best || better({ folder, count }, best) > 0) best = { folder, count };
  if (!best) return { ok: false, reason: 'The linking notes sit in session logs or eval runs, where Quorum does not write notes.' };
  const marks = (m.confidential ?? []).filter((v) => !falsy(v));
  return { ok: true, folder: best.folder, confidential: marks.length ? String(marks[0]) : null };
}

// the note Quorum writes for a missing link: what each linking note says about it, with a link back to that note, and
// the confidential mark of its sources (createPlan) so it stays as private as what it quotes
export function contextNote(issue) {
  const name = issue.target.split('/').pop();
  const own = new Set(name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const says = (t) => (t.toLowerCase().match(/[a-z][a-z'’]{2,}/g) ?? []).filter((w) => !own.has(w)).length >= 3;
  const said = (issue.contexts ?? []).map((c) => `- [[${c.rel.replace(/\.md$/i, '')}]]: ${says(c.text) ? c.text : (c.title ?? c.rel)}`);
  const head = issue.confidential ? ['---', `confidential: ${issue.confidential}`, '---', ''] : [];
  return [...head, `# ${name}`, '', `Quorum made this note because ${issue.notes === 1 ? 'one note links' : `${issue.notes} notes link`} to “${name}” and no note had that name. What ${issue.notes === 1 ? 'that note says' : 'those notes say'} about it:`, '', ...said, ''].join('\n');
}
