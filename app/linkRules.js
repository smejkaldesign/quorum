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
// order; a topic note there is lost. Each entry is tested against the folder path
export const NO_CREATE_FOLDERS = [/^memory\/sessions(\/|$)/i, /^memory\/eval(\/|$)/i];
const createAllowed = (folder) => !NO_CREATE_FOLDERS.some((re) => re.test(folder));
const dirOf = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
const falsy = (v) => v == null || v === false || /^(false|no|)$/i.test(String(v).trim());

// Whether Quorum can offer to write the missing note, and where. It needs at least two linking notes (generated
// reports are already left out of the sources), goes in the folder most of them sit in (a sub-folder over the vault
// root on a tie, never a session log folder or an eval folder), and carries a confidential mark forward when any
// linking note has one.
// Answers { ok: true, folder, confidential } or { ok: false, reason } with a plain reason a person can read
export function createPlan(m) {
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
