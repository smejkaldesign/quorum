// plugins: the upkeep jobs the keeper does in a vault (index, daily, links, facts). Each job is owned by Quorum (the
// keeper writes it) or by the vault (the keeper writes nothing for that job). A job is Quorum's unless a saved choice
// gives it to the vault. Also here: how a file marked as generated is recognized, and how a daily folder names its notes

// a file whose first lines carry a generated notice is rewritten by a tool, so anything appended to it gets lost. The
// notice has to stand as its own line: a comment (<!-- --> or %% %%) that says so, a frontmatter key, or a line that
// starts with the notice. Prose such as "Do not edit .env directly" is not a notice
const NOTICE_RE = /^(?:this (?:file|note|page) (?:is|was) )?(?:auto-?generated\b|generated (?:by|from) \S+|do not hand-?edit\b|do not edit (?:this (?:file|note|page)|by hand)\b)/i;
const COMMENT_NOTICE_RE = /^generated\.?$|^generated\s*:\s*(?!(?:false|no|0|off)\b)\S|auto-?generated\b|generated (?:by|from) \S+|do not (?:hand-?)?edit\b/i;
const FRONTMATTER_RE = /^(?:auto[-_]?generated|generated(?:[-_]by)?)\s*:\s*(?!(?:false|no|0|off)\b)\S/i;
export function isNotice(line) {
  const t = String(line).trim();
  const comment = t.match(/^(?:<!--|%%)\s*(.*?)\s*(?:-->|%%)?$/);
  if (comment) return COMMENT_NOTICE_RE.test(comment[1]);
  if (FRONTMATTER_RE.test(t)) return true;
  return NOTICE_RE.test(t.replace(/^(?:[#>*_-]+\s*|\/\/\s*)+/, '').replace(/^[*_]+/, ''));
}
export const isGenerated = (text) => String(text ?? '').split('\n').slice(0, 10).some(isNotice);

// the dated notes in a daily folder decide its naming: the most common text after the date wins, so a folder of
// 2026-11-10-brief.md files keeps that name. An empty or undated folder gets the plain <date>.md
export const DAILY_DEFAULT = '{date}.md';
export function dailyPattern(names) {
  const counts = new Map();
  for (const n of names) {
    const m = n.match(/^\d{4}-\d{2}-\d{2}(.*)\.md$/);
    if (m) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  if (!counts.size) return { template: DAILY_DEFAULT, dated: 0 };
  const [suffix, n] = [...counts].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0];
  return { template: `{date}${suffix}.md`, dated: [...counts.values()].reduce((a, b) => a + b, 0), matching: n };
}
export const dailyName = (template, date) => template.replace('{date}', date);

export const PLUGINS = [
  { id: 'index', title: 'Index lines', does: 'One line per meeting in index.md' },
  { id: 'daily', title: 'Daily lines', does: 'A line in the daily note for each meeting day' },
  { id: 'links', title: 'People and project links', does: 'A line under Meetings in each people and project note a meeting concerns' },
  { id: 'facts', title: 'Learned facts', does: 'Up to three facts per meeting, written with your model source' },
];

// the rows the keeper checks. saved is settings.plugins: { [id]: { owner } }. A saved owner wins. With none, a folder
// Quorum built gives the job to Quorum, and a folder the person connected keeps it with the person's own setup
export function resolvePlugins(saved = {}, { built = true } = {}) {
  const ownerOf = (id) => { const o = saved?.[id]?.owner; return o === 'vault' || o === 'quorum' ? o : built ? 'quorum' : 'vault'; };
  return PLUGINS.map((p) => ({ id: p.id, title: p.title, does: p.does, owner: ownerOf(p.id) }));
}

// a pick for one job, saved over the earlier one
export function choose(saved, id, owner) {
  if (!PLUGINS.some((p) => p.id === id) || (owner !== 'quorum' && owner !== 'vault')) return saved ?? {};
  return { ...(saved ?? {}), [id]: { owner } };
}

export const owns = (rows, id) => rows.find((r) => r.id === id)?.owner === 'quorum';
