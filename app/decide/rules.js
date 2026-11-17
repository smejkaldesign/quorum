// T0 of the decision layer: rules in code that always run. They need no model, and they answer two questions: is a note
// worth sending to the claim reader at all, and does a claim pair carry a signal (a changed number, a changed date, a
// flipped polarity) that no local model may overrule. A T0 keep sends the pair to Claude whatever T1 scores.
import { normValue } from '../contradictionPairs.js';

// a template note under this many words outside its placeholders has nothing of its own to read
export const MIN_WORDS = 8;

const FRONT = /^---\n([\s\S]*?)\n---(\n|$)/;
const body = (text) => String(text ?? '').replace(FRONT, '');
// properties that name or file the note; every other property with a value can hold a claim (decision:, due:, owner:)
const NAMING = new Set(['tags', 'tag', 'aliases', 'alias', 'cssclasses', 'cssclass']);
const claimProps = (text) => (String(text ?? '').match(FRONT)?.[1] ?? '').split('\n').some((l) => { const m = l.match(/^([\w -]+):\s*(.*)$/); return !!m && !NAMING.has(m[1].trim().toLowerCase()) && !/^(\[\s*\]|""|''|null|~)?$/.test(m[2].trim()); });
const words = (s) => s.replace(/\[\[[^\]]*\]\]|\[[^\]]*\]\([^)]*\)|https?:\/\/\S+|[#*_`>|-]+/g, ' ').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));

// a figure, a date or a decision word: a note with one is always read, however short. A short note is often the one
// that records a decision ("Decided: launch on April 10.")
const SIGNAL = /\d|\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?|mon(day)?|tue(s(day)?)?|wed(nesday)?|thu(rs(day)?)?|fri(day)?|sat(urday)?|sun(day)?|today|tomorrow|yesterday|decid\w*|agree\w*|approv\w*|chose|chosen|choose|will|must|shall|ship\w*|launch\w*|cancel\w*|deadline|due|owns?|owner)\b/i;

// { read, reason }. read false only for a note the rules are sure holds no claim: empty, a template, or a list of
// links, with no figure, date or decision word in what is left
export function noteRule(note) {
  if (claimProps(note?.text)) return { read: true, reason: null };
  const b = body(note?.text);
  if (!b.trim()) return { read: false, reason: 'empty' };
  if (SIGNAL.test(b.replace(/\{\{[^}]+\}\}|<%[\s\S]*?%>|\[\[[^\]]*\]\]|\[[^\]]*\]\([^)]*\)|https?:\/\/\S+/g, ' '))) return { read: true, reason: null };
  if (/\{\{[^}]+\}\}|<%[\s\S]*?%>/.test(b) && words(b.replace(/\{\{[^}]+\}\}|<%[\s\S]*?%>/g, ' ')).length < MIN_WORDS * 2) return { read: false, reason: 'template' };
  const lines = b.split('\n').map((l) => l.trim()).filter(Boolean);
  const linkOnly = lines.filter((l) => /^([-*+]|\d+\.)?\s*(\[\[[^\]]+\]\]|\[[^\]]*\]\([^)]*\)|https?:\/\/\S+)\s*$/.test(l)).length;
  if (lines.length >= 3 && linkOnly / lines.length >= 0.8) return { read: false, reason: 'links' };
  return { read: true, reason: null };
}

// whole month and weekday names and their abbreviations, each mapped to one key: "Sept" -> "sep", "Tuesday" -> "tue"
const NAMES = [['jan', 'jan|january'], ['feb', 'feb|february'], ['mar', 'mar|march'], ['apr', 'apr|april'], ['may', 'may'], ['jun', 'jun|june'], ['jul', 'jul|july'], ['aug', 'aug|august'], ['sep', 'sep|sept|september'], ['oct', 'oct|october'], ['nov', 'nov|november'], ['dec', 'dec|december'],
  ['mon', 'mon|monday'], ['tue', 'tue|tues|tuesday'], ['wed', 'wed|wednesday'], ['thu', 'thu|thur|thurs|thursday'], ['fri', 'fri|friday'], ['sat', 'sat|saturday'], ['sun', 'sun|sunday']];
const KEY = new Map(NAMES.flatMap(([k, forms]) => forms.split('|').map((f) => [f, k])));
const NAME = `(${[...KEY.keys()].sort((x, y) => y.length - x.length).join('|')})`;
// the numbers and dates a text names, normalized: "$1,200" -> "1200", "March 3" -> "mar 3", "Q3" -> "q3", "3/14" stays
export function figures(v) {
  let s = normValue(v);
  const out = new Set();
  s = s.replace(new RegExp(`\\b${NAME}\\.?\\s+(\\d{1,2})\\b`, 'g'), (_, n, d) => { out.add(`${KEY.get(n)} ${Number(d)}`); return ' '; });
  s = s.replace(/\bq([1-4])\b/g, (_, q) => { out.add(`q${q}`); return ' '; });
  s = s.replace(/\b\d{4}-\d{2}-\d{2}\b|\b\d+\/\d+(\/\d+)?\b/g, (m) => { out.add(m); return ' '; });
  for (const m of s.matchAll(/\d+(?:[.,]\d+)*/g)) out.add(m[0].replace(/,/g, ''));
  for (const m of s.matchAll(new RegExp(`\\b${NAME}\\b`, 'g'))) out.add(KEY.get(m[1]));
  return out;
}

const NEGATION = /\b(not|no|never|none|nobody|nothing|neither|nor|without|cannot)\b|n't\b/i;
const differ = (x, y) => [...x].some((f) => !y.has(f)) || [...y].some((f) => !x.has(f));

// { keep, equivalent, reason } for a pair. keep: a sign of a real change T1 may not overrule, read from the values and
// from the quotes, since a claim's value can leave out the figure or the negation its sentence holds ("Postgres" for
// "Atlas runs Postgres 16"). equivalent: the same value, polarity, figures and negation (pairClaims already skips
// same-value pairs, so this only catches callers that do not)
export function pairRule(a, b) {
  const flipped = (a?.polarity ?? 'positive') !== (b?.polarity ?? 'positive');
  if (flipped) return { keep: true, equivalent: false, reason: 'polarity' };
  if (differ(figures(a?.value), figures(b?.value)) || differ(figures(a?.quote), figures(b?.quote))) return { keep: true, equivalent: false, reason: 'figures differ' };
  if (NEGATION.test(String(a?.quote ?? '')) !== NEGATION.test(String(b?.quote ?? ''))) return { keep: true, equivalent: false, reason: 'negation' };
  const va = normValue(a?.value);
  if (va && va === normValue(b?.value)) return { keep: false, equivalent: true, reason: 'same value' };
  return { keep: false, equivalent: false, reason: null };
}
