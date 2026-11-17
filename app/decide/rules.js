// T0 of the decision layer: rules in code that always run. They need no model, and they answer two questions: is a note
// worth sending to the claim reader at all, and does a claim pair carry a signal (a changed number, a changed date, a
// flipped polarity) that no local model may overrule. A T0 keep sends the pair to Claude whatever T1 scores.
import { normValue } from '../contradictionPairs.js';

// a note under this many words after its frontmatter, links and markup has no claim worth a model call
export const MIN_WORDS = 8;

const body = (text) => String(text ?? '').replace(/^---\n[\s\S]*?\n---\n?/, '');
const words = (s) => s.replace(/\[\[[^\]]*\]\]|\[[^\]]*\]\([^)]*\)|https?:\/\/\S+|[#*_`>|-]+/g, ' ').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));

// { read, reason }. read false only for a note the rules are sure holds no claim: empty, a few words, a template, or a
// list of links
export function noteRule(note) {
  const b = body(note?.text);
  if (!b.trim()) return { read: false, reason: 'empty' };
  if (/\{\{[^}]+\}\}|<%[\s\S]*?%>/.test(b) && words(b.replace(/\{\{[^}]+\}\}|<%[\s\S]*?%>/g, ' ')).length < MIN_WORDS * 2) return { read: false, reason: 'template' };
  const lines = b.split('\n').map((l) => l.trim()).filter(Boolean);
  const linkOnly = lines.filter((l) => /^([-*+]|\d+\.)?\s*(\[\[[^\]]+\]\]|\[[^\]]*\]\([^)]*\)|https?:\/\/\S+)\s*$/.test(l)).length;
  if (lines.length >= 3 && linkOnly / lines.length >= 0.8) return { read: false, reason: 'links' };
  if (words(b).length < MIN_WORDS) return { read: false, reason: 'short' };
  return { read: true, reason: null };
}

const MONTHS = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';
// the numbers and dates a value names, normalized: "$1,200" -> "1200", "March 3" -> "mar 3"
export function figures(v) {
  const s = normValue(v);
  const out = new Set();
  for (const m of s.matchAll(new RegExp(`\\b(${MONTHS})[a-z]*\\.?\\s+(\\d{1,2})\\b`, 'g'))) out.add(`${m[1]} ${Number(m[2])}`);
  for (const m of s.matchAll(/\d{4}-\d{2}-\d{2}|\d+(?:[.,]\d+)*/g)) out.add(m[0].includes('-') ? m[0] : m[0].replace(/,/g, ''));
  for (const m of s.matchAll(new RegExp(`\\b(${MONTHS})[a-z]*\\b`, 'g'))) out.add(m[1]);
  return out;
}

// { keep, equivalent, reason } for a pair. keep: a sign of a real change T1 may not overrule; equivalent: the same value
// and the same polarity once normalized (pairClaims already skips those, so this only catches callers that do not)
export function pairRule(a, b) {
  const va = normValue(a?.value);
  const vb = normValue(b?.value);
  const flipped = (a?.polarity ?? 'positive') !== (b?.polarity ?? 'positive');
  if (va && va === vb && !flipped) return { keep: false, equivalent: true, reason: 'same value' };
  if (flipped) return { keep: true, equivalent: false, reason: 'polarity' };
  const fa = figures(a?.value);
  const fb = figures(b?.value);
  if ([...fa].some((x) => !fb.has(x)) || [...fb].some((x) => !fa.has(x))) return { keep: true, equivalent: false, reason: 'figures differ' };
  return { keep: false, equivalent: false, reason: null };
}
