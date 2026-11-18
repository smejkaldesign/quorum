// Contradiction detection, stage 2: claims. A claim says one thing about one subject: subject, attribute, value,
// polarity, modality, date, scope, authority, and the verbatim quote with its line range.
//   structured  no model: frontmatter keys (the note is the subject) and "key: value" body lines, with a leading wiki
//               link as the subject ("- [[Atlas]] status: paused")
//   model       the person's own Claude Code sign-in with no tools reads one note and lists its claims as strict JSON.
//               Every quote is checked against the note's lines, character for character; a claim whose quote does
//               not match is dropped, and so is a date the quoted lines do not hold
// Plain Node, no Electron, so the tests run a fake model.
import { AUTHORITY, datesIn, frontmatterEnd, indexNote, modalityOf } from './contradictionIndex.js';
import { CLAIM_ANSWER } from './memoryModels.js';

export const MODALITY = ['decided', 'proposed', 'considering', 'rejected', 'stated'];
export const MAX_CLAIMS = 30;
// the claims the model lists per note
export const MODEL_CLAIMS = 20;
const MAX_FIELD = 160;
// frontmatter keys that describe the note itself and never state a fact about its subject
const META_KEYS = new Set(['title', 'aliases', 'alias', 'tags', 'tag', 'created', 'updated', 'modified', 'date', 'decided', 'type', 'confidential', 'last_verified', 'source', 'sources', 'related', 'id', 'cssclass', 'cssclasses', 'publish', 'permalink', 'summary', 'description', 'author', 'authors', 'url', 'links', 'category', 'categories', 'kind', 'template', 'superseded_by', 'supersededby', 'replaced_by', 'attendees', 'participants']);
const KV_RE = /^\s*(?:[-*+]\s+)?(?:\[\[([^\]|#\n]+)(?:[|#][^\]\n]*)?\]\]\s+)?(?:\*\*|__)?([A-Za-z][A-Za-z0-9 /&'-]{0,40}?)(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*(\S.{0,200})$/;
const clip = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_FIELD);

const base = (n, ix) => ({ rel: n.rel, hash: ix.hash, authority: ix.authority, scope: null, polarity: '+' });
function dated(claim, ix, lineText) {
  const inText = datesIn(lineText)[0];
  if (inText) return { ...claim, date: inText, dateSource: 'text' };
  return { ...claim, date: ix.date, dateSource: ix.dateSource };
}

// the claims a note makes with no model. n: { rel, text, note }
export function structuredClaims(n) {
  const ix = indexNote(n);
  const lines = String(n.text ?? '').split('\n');
  const out = [];
  const decisionNote = ix.authority === AUTHORITY.decision;
  for (let i = 1; i < ix.fmEnd - 1; i++) {
    const m = lines[i].match(/^([\w-]+):\s*(\S.*)$/);
    if (!m || META_KEYS.has(m[1].toLowerCase())) continue;
    const value = clip(m[2].replace(/^["']|["']$/g, ''));
    if (!value || value === '[]') continue;
    out.push(dated({ ...base(n, ix), id: `${n.rel}#fm:${m[1]}`, line: i + 1, lineEnd: i + 1, quote: lines[i].replace(/\r$/, ''), subject: null, self: true, attribute: m[1].replace(/[_-]+/g, ' '), value, modality: decisionNote ? 'decided' : 'stated', extractor: 'frontmatter', inFrontmatter: true }, ix, lines[i]));
  }
  let fenced = false;
  for (let i = ix.fmEnd; i < lines.length; i++) {
    const l = lines[i].replace(/\r$/, '');
    if (/^\s*(```|~~~)/.test(l)) { fenced = !fenced; continue; }
    if (fenced || /^\s*#/.test(l) || /^\s*\|/.test(l)) continue;
    const m = l.match(KV_RE);
    if (!m) continue;
    const key = m[2].trim();
    if (key.split(/\s+/).length > 4 || /^(https?|mailto|note|notes|todo|q|a|example|e\.g|i\.e|related|see|source|sources|link|links)$/i.test(key)) continue;
    const value = clip(m[3].replace(/\*\*|__/g, ''));
    if (!value || /^https?:\/\//i.test(value)) continue;
    const modality = decisionNote && modalityOf(l) === 'stated' ? 'decided' : modalityOf(l);
    out.push(dated({ ...base(n, ix), id: `${n.rel}#L${i + 1}`, line: i + 1, lineEnd: i + 1, quote: l, subject: m[1] ? m[1].trim() : null, subjectLink: !!m[1], self: !m[1], attribute: key, value, modality, extractor: 'regex', inFrontmatter: false }, ix, l));
  }
  return out;
}

// The lines of a note the model reads for its claims. A note up to WHOLE_NOTE characters goes whole, since a dated note
// can state its facts on lines with no marker: on 100 notes, Haiku on excerpts found 40% of the claims Sonnet found on
// whole long notes. A longer note goes as the lines stage 1 found (decision
// phrases, body dates, superseded markers), the frontmatter keys that state a fact, the "key: value" lines, and the
// title heading, each with EXCERPT_CONTEXT lines on either side; with none of those, its lines with a link, and with no
// link, its first LEAD_LINES body lines. Line numbers stay those of the note, so every quote is checked against the
// note itself (quoteMatches). Lines past MAX_LINE characters are cut, and the excerpt stops at MAX_EXCERPT characters
export const EXCERPT_CONTEXT = 1;
export const WHOLE_NOTE = 12000;
export const MAX_EXCERPT = 6000;
const LEAD_LINES = 15;
const MAX_LINE = 600;
const LINK_RE = /\[\[[^\]\n]+\]\]|\]\([^)\n]+\.md\b/;
export function excerptLines(n) {
  const ix = indexNote(n);
  const lines = String(n.text ?? '').split('\n');
  const filled = (from) => { const out = []; for (let i = from; i < lines.length; i++) if (lines[i].trim()) out.push(i + 1); return out; };
  if (String(n.text ?? '').length <= WHOLE_NOTE) return filled(0);
  const want = new Set();
  for (let i = 1; i < ix.fmEnd - 1; i++) { const m = lines[i].match(/^([\w-]+):\s*\S/); if (m && !META_KEYS.has(m[1].toLowerCase())) want.add(i + 1); }
  for (const d of [...ix.decisions, ...ix.supersededLines, ...ix.dates]) want.add(d.line);
  for (let i = ix.fmEnd; i < lines.length; i++) if (KV_RE.test(lines[i].replace(/\r$/, ''))) want.add(i + 1);
  const body = [...want].some((l) => l > ix.fmEnd);
  if (!body) for (let i = ix.fmEnd; i < lines.length; i++) if (LINK_RE.test(lines[i])) want.add(i + 1);
  if (![...want].some((l) => l > ix.fmEnd)) for (const l of filled(ix.fmEnd).slice(0, LEAD_LINES)) want.add(l);
  const title = lines.findIndex((l, i) => i >= ix.fmEnd && /^#\s/.test(l));
  if (title >= 0) want.add(title + 1);
  const out = new Set();
  for (const l of want) for (let k = l - EXCERPT_CONTEXT; k <= l + EXCERPT_CONTEXT; k++) if (k >= 1 && k <= lines.length && lines[k - 1].trim()) out.add(k);
  return [...out].sort((x, y) => x - y);
}
// the excerpt as the model reads it: "<line number>: <text>", with "..." where lines are left out. Empty when the
// note has nothing to read
export function excerptOf(n) {
  const lines = String(n.text ?? '').split('\n');
  const out = [];
  let used = 0;
  let prev = 0;
  // a whole note is cut at WHOLE_NOTE characters by its own size; an excerpt stops at MAX_EXCERPT
  const cap = String(n.text ?? '').length <= WHOLE_NOTE ? Infinity : MAX_EXCERPT;
  for (const l of excerptLines(n)) {
    const row = `${l}: ${lines[l - 1].replace(/\r$/, '').slice(0, MAX_LINE)}`;
    if (used + row.length > cap) break;
    // "..." marks left-out lines with text; a blank line left out needs no mark
    if (prev && lines.slice(prev, l - 1).some((x) => x.trim())) out.push('...');
    out.push(row);
    used += row.length + 1;
    prev = l;
  }
  return out.join('\n');
}

// the instructions are the same on every call, so they sit in the system prompt and every call starts with the same text
// The instructions sit in the system prompt, so every call starts with the same text. Two forms of answer
// (memoryModels.js CLAIM_ANSWER): one JSON object of claims, or one line per claim so no field name repeats
const NOTES_SHOWN = 'Each note shows its lines with their line numbers in the note. A long note shows some of its lines; "..." stands for lines left out.';
export const SYSTEM_JSON = [
  'You list the factual claims notes from a notes vault make. You read only the notes given; you have no tools and change nothing.',
  NOTES_SHOWN,
  'List the claims each note makes about the state of things: decisions, choices of tools or vendors, prices, plans, owners, statuses, counts, dates and deadlines.',
  'Skip opinions, questions, open tasks and claims about the note itself.',
  'subject: the thing the claim is about, as the note names it (the wiki link target when the line links it). attribute: what about it, in two or three words. value: what the note says, short, in the quote\'s own words.',
  'polarity: "-" when the line says the value does not hold, else "+". modality: decided, proposed, considering, rejected or stated.',
  'date: the YYYY-MM-DD date the quoted lines give for this claim, or null. scope: the project, environment, team or person the claim is limited to, or null.',
  `At most ${MAX_CLAIMS} claims per note. path is the path of the note the quote comes from, and line numbers are the numbers shown.`,
  'Every claim rests on a quote: the exact text of one to four consecutive numbered lines, or an exact part of them. Copy quotes character for character; do not fix spelling or spacing.',
  'Answer with one JSON object and nothing else: { "claims": [{ "path": "<note path>", "subject": "", "attribute": "", "value": "", "polarity": "+" | "-", "modality": "", "date": null, "scope": null, "quote": "<exact text>", "line": <first line number>, "line_end": <last line number> }] }',
].join('\n');
export const SYSTEM_COMPACT = [
  'You list the factual claims notes from a notes vault make. You read only the notes given; you have no tools and change nothing.',
  NOTES_SHOWN,
  'List the claims each note makes about the state of things: decisions, choices of tools or vendors, prices, plans, owners, statuses, counts, dates and deadlines.',
  `Skip opinions, questions, open tasks and claims about the note itself. At most ${MODEL_CLAIMS} claims per note.`,
  'Answer with lines and nothing else. Start the claims of each note with a line "@ <note path>". Then one line per claim, nine fields split by " | ":',
  '<line> or <first line>-<last line> | subject | attribute | value | polarity | modality | date | scope | quote',
  'subject: the thing the claim is about, as the note names it (the wiki link target when the line links it). attribute: what about it, in two or three words. value: what the note says, short, in the line\'s own words.',
  'polarity: - when the line says the value does not hold, else +. modality: d decided, p proposed, c considering, r rejected, s stated.',
  'date: the YYYY-MM-DD date the lines give for this claim, or -. scope: the project, environment, team or person the claim is limited to, or -.',
  'quote: an exact part of the cited lines that holds the value, at least 8 characters, copied character for character with no quotation marks around it. The cited lines are at most four consecutive lines.',
  'A note with no such claim gets no lines; when no note has one, answer with the single word none. Never write " | " inside a field.',
].join('\n');
export const SYSTEM = CLAIM_ANSWER === 'compact' ? SYSTEM_COMPACT : SYSTEM_JSON;
const MODALITY_CODE = { d: 'decided', p: 'proposed', c: 'considering', r: 'rejected', s: 'stated' };
// the compact answer as claim objects, the shape checkClaims reads: { path, line, line_end, subject, attribute, value,
// polarity, modality, date, scope, quote }. A line that does not parse is left out
export function parseCompact(text) {
  const claims = [];
  let rel = null;
  for (const raw of String(text ?? '').split('\n')) {
    const l = raw.trim();
    if (!l) continue;
    if (l.startsWith('@ ')) { rel = l.slice(2).trim(); continue; }
    const f = l.split(' | ').map((x) => x.trim());
    if (f.length < 9) continue;
    const m = f[0].match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) continue;
    const dash = (v) => (v === '-' || v === '' ? null : v);
    // a quote the model wrapped in quotation marks or backticks is read without them
    const quote = f.slice(8).join(' | ').replace(/^(["'`\u201c])(.*)(["'`\u201d])$/s, '$2');
    claims.push({ path: rel, line: Number(m[1]), line_end: Number(m[2] ?? m[1]), subject: f[1], attribute: f[2], value: f[3], polarity: f[4] === '-' ? '-' : '+', modality: MODALITY_CODE[f[5]?.toLowerCase()] ?? f[5], date: dash(f[6]), scope: dash(f[7]), quote });
  }
  return { claims };
}
// a reply as claims: the compact lines, or a JSON object with claims (an older answer, and the tests)
// "none" when no note has a claim; an empty reply is no answer
const claimsOf = (reply) => { const j = parseJson(reply); if (Array.isArray(j?.claims)) return j; const t = String(reply ?? '').trim(); if (/^none\.?$/i.test(t)) return { claims: [] }; const c = parseCompact(t); return c.claims.length || t.includes('@ ') ? c : null; };

// the prompt that asks for the claims of several notes. answer: 'json' or 'compact', the setting by default
export function claimPrompt(notes, { answer = CLAIM_ANSWER } = {}) {
  const list = Array.isArray(notes) ? notes : [notes];
  const title = (n) => String(n.note?.title ?? n.rel).replace(/"/g, "'");
  return { system: answer === 'compact' ? SYSTEM_COMPACT : SYSTEM_JSON, prompt: list.map((n) => `<note path="${n.rel}" title="${title(n)}">\n${excerptOf(n)}\n</note>`).join('\n\n') };
}

// the first JSON object in a reply, or null
export function parseJson(text) {
  const t = String(text ?? '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { const j = JSON.parse(t.slice(start, end + 1)); return j && typeof j === 'object' ? j : null; } catch { return null; }
}

// a quote is good when it sits inside the lines it names, character for character
export function quoteMatches(text, line, lineEnd, quote) {
  const lines = String(text ?? '').split('\n').map((l) => l.replace(/\r$/, ''));
  const a = Number(line);
  const b = Number(lineEnd ?? line);
  const q = typeof quote === 'string' ? quote.trim() : '';
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < a || b > lines.length || b - a > 3 || q.length < 8) return false;
  return lines.slice(a - 1, b).join('\n').includes(q);
}

// a value the quoted lines back: every number in it and at least half of its other words appear in them. A value the
// lines do not hold is the model's own (or text in another note told it to say so), so the claim is dropped
export function valueInSpan(value, span) {
  const t = String(span ?? '').toLowerCase();
  const words = String(value ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const nums = words.filter((w) => /\d/.test(w));
  const rest = words.filter((w) => !/\d/.test(w) && w.length >= 3);
  if (!nums.length && !rest.length) return false;
  return nums.every((w) => t.includes(w)) && rest.filter((w) => t.includes(w)).length * 2 >= rest.length;
}

// a model reply as claims: each claim with a quote that matches its lines and every field it needs; the rest dropped.
// Answers { claims, dropped }
// a reply for several notes checked note by note: each claim goes to the note its path names, and its quote is checked
// against that note only. Answers { byRel: Map(rel -> { claims, dropped }), stray } or { why } when there is no answer
export function checkClaimsBatch(notes, reply, model = 'claude') {
  const j = claimsOf(reply);
  if (!Array.isArray(j?.claims)) return { why: 'The agent did not answer with claims' };
  const one = notes.length === 1;
  const byRel = new Map();
  for (const n of notes) byRel.set(n.rel, checkClaims(n, j.claims.filter((c) => c?.path === n.rel || (one && c?.path == null)), model));
  const stray = j.claims.filter((c) => !notes.some((n) => c?.path === n.rel) && !(one && c?.path == null)).length;
  return { byRel, stray };
}

export function checkClaims(n, reply, model = 'claude') {
  const ix = indexNote(n);
  const j = Array.isArray(reply) ? { claims: reply } : claimsOf(reply);
  const list = Array.isArray(j?.claims) ? j.claims.slice(0, MAX_CLAIMS) : null;
  if (!list) return { claims: [], dropped: 0, why: 'The agent did not answer with claims' };
  const lines = String(n.text ?? '').split('\n');
  const fmEnd = frontmatterEnd(lines);
  const out = [];
  let dropped = 0;
  for (const c of list) {
    const line = Number(c?.line);
    const lineEnd = c?.line_end == null ? line : Number(c.line_end);
    const subject = clip(c?.subject);
    const attribute = clip(c?.attribute);
    const value = clip(c?.value);
    if (!subject || !attribute || !value || !quoteMatches(n.text, line, lineEnd, c?.quote)) { dropped++; continue; }
    const span = lines.slice(line - 1, lineEnd).join('\n');
    if (!valueInSpan(value, span)) { dropped++; continue; }
    // a date counts only when the quoted lines hold it; otherwise the note's own date stands in
    const said = typeof c.date === 'string' && datesIn(c.date)[0] && span.includes(datesIn(c.date)[0]) ? datesIn(c.date)[0] : null;
    const modality = MODALITY.includes(c.modality) ? c.modality : modalityOf(span);
    out.push({
      id: `${n.rel}#m${line}-${out.length}`, rel: n.rel, hash: ix.hash, line, lineEnd, quote: String(c.quote).trim(),
      subject, subjectLink: /\[\[/.test(span) && span.toLowerCase().includes(`[[${subject.toLowerCase()}`), self: false, attribute, value,
      polarity: c.polarity === '-' ? '-' : '+', modality: modality === 'considering' ? 'proposed' : modality,
      date: said ?? ix.date, dateSource: said ? 'text' : ix.dateSource, scope: c.scope ? clip(c.scope) : null,
      authority: ix.authority, extractor: `model:${model}`, inFrontmatter: line <= fmEnd,
    });
  }
  return { claims: out, dropped };
}

// stored claims checked again against the note as it reads now: a claim whose quote moved or changed is dropped
export const stillTrue = (claims, text) => (claims ?? []).filter((c) => quoteMatches(text, c.line, c.lineEnd, c.quote));
