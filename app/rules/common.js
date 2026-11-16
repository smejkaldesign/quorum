// Shared helpers for the Memory health review rules (rules/*.js). Plain functions, no Node or Electron imports.
import { isGenerated } from '../linkRules.js';

export const dirOf = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
export const baseOf = (rel) => rel.split('/').pop().replace(/\.md$/i, '');
// every folder above a note, nearest first: a/b/c.md -> ['a/b', 'a']
export const ancestors = (rel) => { const out = []; let d = dirOf(rel); while (d) { out.push(d); d = dirOf(d); } return out; };
export const DAY = 86400000;
export const DATE_RE = /(\d{4})-(\d{2})-(\d{2})/;
export const dateIn = (s) => { const m = String(s ?? '').match(DATE_RE); if (!m) return null; const t = Date.UTC(+m[1], +m[2] - 1, +m[3]); return Number.isFinite(t) ? t : null; };
// a value that switches a tag off: confidential: false, none, no
export const OFF_RE = /^(false|no|none|off|public|)$/i;
export const isOff = (v) => v == null || v === false || (Array.isArray(v) ? !v.length : OFF_RE.test(String(v).trim()));
export const skipped = (n) => isGenerated(n.rel, n.note?.props ?? {});
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const quote = (t) => `“${t}”`;
// a note that opens a folder or the vault (index, README, CLAUDE): it lists other notes and follows no folder schema
export const ENTRY_NAME = /^(index|_index|readme|_readme|claude|agents|log|changelog|home|start|moc)$/i;
// a note named by its date: a daily note or a session log, reached by date and written as a log
export const DATED = /\d{4}-\d{2}-\d{2}/;

// the frontmatter block as raw lines, without the --- fences, or null when the note has none
export function frontmatterLines(text) {
  const t = String(text ?? '');
  if (!t.startsWith('---\n') && !t.startsWith('---\r\n')) return null;
  const close = t.indexOf('\n---', 3);
  return close < 0 ? null : t.slice(4, close).split('\n');
}
// the body after the frontmatter
export function bodyOf(text) {
  const t = String(text ?? '');
  if (!t.startsWith('---\n') && !t.startsWith('---\r\n')) return t;
  const close = t.indexOf('\n---', 3);
  if (close < 0) return t;
  const after = t.indexOf('\n', close + 1);
  return after < 0 ? '' : t.slice(after + 1);
}
// the value at a fraction of a sorted list (0.99 for p99)
export function percentile(values, p) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
}

// one finding of a rule. key is unique for the finding; target and facts make its fingerprint with the notes, so a
// change in the facts (new evidence) makes a new fingerprint. evidence holds plain lines for the drawer; it never
// holds a secret or a note's text beyond a title
export function finding(rule, { key, target, notes, title, problem, proposal, evidence = [], facts = [], meta = [] }) {
  return { ruleId: rule.id, ruleVersion: rule.version, rule: rule.label, key: `${rule.id}:${key}`, target, notes, rel: notes[0], title, problem, proposal, evidence, facts, meta, autoFix: false };
}
