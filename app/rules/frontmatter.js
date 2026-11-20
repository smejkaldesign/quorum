// Frontmatter schema per folder, learned from the folder's own notes: a key that 80% or more of a folder's notes carry
// is expected there, and its type is the one 80% or more of them use. A note missing an expected key, or holding a
// value of another type, is flagged; so is a key written twice in one note (the second silently replaces the first).
// A missing key counts only when Quorum can tell its value from the note (fillable): an empty key adds nothing and
// churns the vault's history, so a key Quorum could only add empty is never proposed.
// Folders with fewer than five notes teach nothing. The confidential key has its own rule (confidential.js).
import { ENTRY_NAME, baseOf, dirOf, finding, frontmatterLines, plural, quote, skipped } from './common.js';

export const rule = { id: 'note.frontmatter', version: 2, label: 'Frontmatter that does not fit its folder' };
const MIN_FOLDER = 5;
const EXPECTED = 0.8;
const OWN_RULE = new Set(['confidential']);
const typeOf = (v) => {
  if (Array.isArray(v)) return v.length ? 'list' : 'empty';
  const s = String(v).trim();
  if (!s) return 'empty';
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return 'date';
  if (/^(true|false|yes|no)$/i.test(s)) return 'yes or no';
  if (/^-?\d+(\.\d+)?$/.test(s)) return 'number';
  return 'text';
};
// a single text value where a list is usual reads the same to the agent
// the value Quorum can give a missing key from the note itself, or null: its title, or the date its file is named by
// (reviewApprove.js approveFinding writes it)
export function fillable(key, rel, title) {
  if (key === 'title') return title ? JSON.stringify(title) : null;
  if (key === 'date' || key === 'created') return baseOf(rel).match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
  return null;
}
const fits = (want, got) => want === got || got === 'empty' || (want === 'list' && got === 'text') || (want === 'text' && got === 'list');

export function run({ notes }) {
  const live = notes.filter((n) => !skipped(n));
  const byFolder = new Map();
  for (const n of live) (byFolder.get(dirOf(n.rel)) ?? byFolder.set(dirOf(n.rel), []).get(dirOf(n.rel))).push(n);
  const schemas = new Map();
  for (const [d, list] of byFolder) {
    if (list.length < MIN_FOLDER) continue;
    const keys = new Map();
    for (const n of list) for (const [k, v] of Object.entries(n.note?.props ?? {})) {
      if (OWN_RULE.has(k)) continue;
      const e = keys.get(k) ?? keys.set(k, { n: 0, types: new Map() }).get(k);
      e.n++;
      const t = typeOf(v);
      if (t !== 'empty') e.types.set(t, (e.types.get(t) ?? 0) + 1);
    }
    const expected = [];
    for (const [k, e] of keys) {
      if (e.n / list.length < EXPECTED) continue;
      const typed = [...e.types.values()].reduce((a, b) => a + b, 0);
      const [type, count] = [...e.types].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
      expected.push({ key: k, share: e.n / list.length, type: typed && count / typed >= EXPECTED ? type : null });
    }
    if (expected.length) schemas.set(d, { size: list.length, expected });
  }
  const out = [];
  for (const n of live) {
    const props = n.note?.props ?? {};
    const lines = frontmatterLines(n.text) ?? [];
    const counts = new Map();
    for (const l of lines) { const m = l.match(/^([\w-]+):/); if (m) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1); }
    const twice = [...counts].filter(([, c]) => c > 1).map(([k]) => k);
    // an index or README note opens its folder and follows no folder schema; its repeated keys still count
    const s = ENTRY_NAME.test(baseOf(n.rel)) ? null : schemas.get(dirOf(n.rel));
    const missing = s ? s.expected.filter((e) => !(e.key in props) && fillable(e.key, n.rel, n.note?.title)) : [];
    const wrong = s ? s.expected.filter((e) => e.type && e.key in props && !fits(e.type, typeOf(props[e.key]))) : [];
    if (!twice.length && !missing.length && !wrong.length) continue;
    const folder = dirOf(n.rel) || 'the vault root';
    const evidence = [
      ...missing.map((e) => `Missing ${quote(e.key)}, which ${Math.round(e.share * 100)}% of the ${s.size} notes in ${folder} have`),
      ...wrong.map((e) => `${quote(e.key)} is ${typeOf(props[e.key])}; the notes in ${folder} use ${e.type}`),
      ...twice.map((k) => `${quote(k)} is written ${counts.get(k)} times; only the last one counts`),
    ];
    const parts = [missing.length ? `add ${missing.map((e) => quote(e.key)).join(', ')}` : null, wrong.length ? `fix the type of ${wrong.map((e) => quote(e.key)).join(', ')}` : null, twice.length ? `merge the repeated ${twice.map(quote).join(', ')}` : null].filter(Boolean);
    out.push(finding(rule, {
      key: n.rel, target: n.rel, notes: [n.rel],
      title: `${quote(n.note?.title ?? n.rel)} has ${plural(missing.length + wrong.length + twice.length, 'frontmatter problem')}`,
      problem: 'Its frontmatter differs from the other notes in its folder, so searches and agents that read those keys skip it or read the wrong value.',
      proposal: `${parts.join(', ').replace(/^./, (c) => c.toUpperCase())}.`,
      evidence, facts: [...missing.map((e) => `missing:${e.key}`), ...wrong.map((e) => `type:${e.key}`), ...twice.map((k) => `twice:${k}`)],
      meta: [['Note', n.rel], ['Folder', folder]],
    }));
  }
  return out;
}
