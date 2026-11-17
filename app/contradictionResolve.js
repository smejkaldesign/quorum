// Contradiction detection, stage 4: resolve each candidate pair. Symbolic rules run first; only pairs they cannot
// settle and that rest on model claims go to the judge prompt. Stage 5 lives here too: the fix only adds text (a
// superseded marker after the older claim, or an "as of DATE" qualifier) and deletes nothing.
//
//   R1 explicit marker     one side already says it is superseded or replaced by the other: closed, no edit
//   R2 dated decision      both dated, the newer side is a decision of equal or higher authority: superseded marker
//   R3 dated state         both dated plain statements, or the judge says each was true at its own date: "as of DATE"
//   R4 scope split         scopes differ: closed, no fix
//   R5 refinement          the newer side adds detail and conflicts with nothing: suggest a link (review)
//   R6 authority inversion the newer side has lower authority or is only proposed: ask a person
//   R7 undated             either side lacks a date from its text or frontmatter, or both carry the same date: ask
//   R8 cascade             other notes on the same point are listed with the item, never fixed on their own
import { verifyQuotes } from './memoryDraft.js';
import { AUTHORITY, SUPERSEDED_RE, modalityOf } from './contradictionIndex.js';
import { parseJson, quoteMatches } from './contradictionClaims.js';
import { normKey } from './contradictionPairs.js';

export const RULE_IDS = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8'];
export const LABELS = ['contradiction', 'refinement', 'different_times', 'different_scope', 'same'];
// the auto-apply bar from the research design: 98% fix precision over 150 or more decisions, with a 95% Wilson lower
// bound above 95%, and fewer than 2 undos in the last 50 automatic applications
export const BAR = { n: 150, precision: 0.98, wilson: 0.95, undoWindow: 50, undos: 2 };
const baseOf = (rel) => String(rel).split('/').pop().replace(/\.md$/i, '');
const linkName = (rel) => String(rel).replace(/\.md$/i, '');
const fromModel = (c) => String(c.extractor ?? '').startsWith('model');
const TEXT_DATE = new Set(['text', 'frontmatter']);

// one side already says the other replaced it. ix(rel): the stage 1 index of a note
function marked(x, y, ix) {
  const xi = ix(x.rel);
  const yi = ix(y.rel);
  if (SUPERSEDED_RE.test(x.quote)) return true;
  if (xi?.superseded && (!xi.supersededBy.length || xi.supersededBy.some((t) => normKey(t) === normKey(y.rel)))) return true;
  if (yi?.replaces?.some((t) => normKey(t) === normKey(x.rel))) return true;
  return !!xi?.supersededLines?.some((l) => l.text.toLowerCase().includes(`[[${baseOf(y.rel).toLowerCase()}`));
}

// the fix for the older claim: text added at the end of its last line. lineOf(rel, n) answers line n as it reads now.
// A claim in frontmatter gets no fix, since text after a value would change the value
export function annotateFix(older, newer, kind, lineOf) {
  if (older.inFrontmatter) return null;
  const text = lineOf(older.rel, older.lineEnd);
  if (text == null || !text.trim() || /\(as of \d{4}-\d{2}-\d{2}\)|superseded by/i.test(text)) return null;
  const add = kind === 'superseded' ? ` (superseded by [[${linkName(newer.rel)}]] on ${newer.date})` : ` (as of ${older.date})`;
  return { kind: 'annotate', line: older.lineEnd, text, add };
}

// the line an annotate fix writes, or an error when the line changed since Quorum planned it. The text goes before the
// line's trailing spaces (a Markdown line break) and every line keeps its own line ending, so nothing else changes
const parts = (raw) => { const cr = raw.endsWith('\r') ? '\r' : ''; const body = raw.slice(0, raw.length - cr.length); const trail = body.match(/[ \t]*$/)[0]; return { core: body.slice(0, body.length - trail.length), trail, cr }; };
export function annotateLine(text, { line, text: expect, add }) {
  const lines = String(text).split('\n');
  if (!Number.isInteger(line) || line < 1 || line > lines.length || lines[line - 1].replace(/\r$/, '') !== expect) throw new Error('The line changed after Quorum planned this fix, so Quorum did not write');
  const { core, trail, cr } = parts(lines[line - 1]);
  lines[line - 1] = `${core}${add}${trail}${cr}`;
  return lines.join('\n');
}
// the line as it read before the fix: the added text taken off again
export const unannotateLine = (text, { line, add }) => {
  const lines = String(text).split('\n');
  if (lines[line - 1] == null) return String(text);
  const { core, trail, cr } = parts(lines[line - 1]);
  if (core.endsWith(add)) lines[line - 1] = `${core.slice(0, -add.length)}${trail}${cr}`;
  return lines.join('\n');
};

// a pair resolved. judge: the judge's label for this pair, or null when it has not judged it. Answers
// { rule, label, older, newer, closed?, pending?, ask?, fix? }
export function resolvePair(p, { ix, judge = null, lineOf = () => null }) {
  const { a, b } = p;
  if (marked(a, b, ix) || marked(b, a, ix)) return { rule: 'R1', label: 'resolved', closed: true, older: a, newer: b };
  if (a.scope && b.scope && normKey(a.scope) !== normKey(b.scope)) return { rule: 'R4', label: 'different_scope', closed: true, older: a, newer: b };
  let label = 'contradiction';
  if (fromModel(a) || fromModel(b)) {
    if (!judge) return { pending: 'judge', older: a, newer: b };
    label = judge;
  } else if (p.refinement) label = 'refinement';
  if (label === 'same') return { rule: 'R1', label, closed: true, older: a, newer: b };
  if (label === 'different_scope') return { rule: 'R4', label, closed: true, older: a, newer: b };
  const known = a.date && b.date && a.date !== b.date;
  const [older, newer] = known && a.date > b.date ? [b, a] : [a, b];
  if (label === 'refinement') {
    const linked = (ix(older.rel)?.links ?? []).some((t) => normKey(t) === normKey(newer.rel)) || (ix(newer.rel)?.links ?? []).some((t) => normKey(t) === normKey(older.rel));
    return { rule: 'R5', label, older, newer, ask: 'The newer note adds detail to the older one. Linking them keeps the detail in reach.', fix: linked ? null : { kind: 'link', to: newer.rel } };
  }
  if (!a.date || !b.date) return { rule: 'R7', label, older, newer, ask: 'One side has no date in its text or frontmatter, so Quorum cannot tell which is current.' };
  if (a.date === b.date) return { rule: 'R7', label, older, newer, ask: 'Both claims carry the same date, so Quorum cannot tell which is current.' };
  if (label === 'different_times') return { rule: 'R3', label: 'different_times', older, newer, fix: annotateFix(older, newer, 'asof', lineOf) };
  if (newer.authority > older.authority) return { rule: 'R6', label, older, newer, ask: 'The newer claim comes from a note with less authority. The decision may have changed without a record, or the newer note may be wrong.' };
  if (newer.modality === 'proposed') return { rule: 'R6', label, older, newer, ask: 'The newer claim is only a proposal.' };
  if (newer.modality === 'decided' || newer.authority === AUTHORITY.decision) return { rule: 'R2', label, older, newer, fix: annotateFix(older, newer, 'superseded', lineOf) };
  if (older.modality === 'decided') return { rule: 'R6', label, older, newer, ask: 'A newer plain statement disagrees with an older decision.' };
  return { rule: 'R3', label, older, newer, fix: annotateFix(older, newer, 'asof', lineOf) };
}

// subjects Quorum never changes on its own: people, money owed, legal and health topics
const SENSITIVE_RE = /\b(salar(?:y|ies)|wages?|pay|paid|payments?|owe[sd]?|debts?|loans?|invoices?|prices?|pricing|costs?|fees?|budgets?|revenue|refunds?|legal|lawyers?|attorneys?|contracts?|lawsuits?|litigation|nda|court|health|medical|diagnos\w*|medications?|therapy|doctors?|patients?|hipaa|phi|illness|symptoms?)\b/i;
export const sensitive = (p) => SENSITIVE_RE.test(`${p.a.subject ?? ''} ${p.attribute} ${p.a.value} ${p.b.value}`) || /[$€£¥]/.test(`${p.a.value} ${p.b.value}`);
export const PERSON_FOLDER = /(^|\/)(people|persons?|contacts?|team|crm)\//i;

// every auto-approve criterion from the research design, each with whether it holds. ctx: { textOf(rel),
// confidential(rel), person(subjectId), bar }
export function autoCriteria(p, res, ctx) {
  const { older, newer } = res;
  const verbatim = [older, newer].every((c) => { const t = ctx.textOf(c.rel); return t != null && quoteMatches(t, c.line, c.lineEnd, c.quote); });
  const scopes = (older.scope ?? '') === (newer.scope ?? '') || (!older.scope && !newer.scope);
  // a decision the text shows: a decision record, or a decision phrase on the quoted lines. The model's own modality
  // label is not enough, since text in a note can ask the model for it
  const spanOf = (c) => String(ctx.textOf(c.rel) ?? '').split('\n').slice(c.line - 1, c.lineEnd).join('\n');
  const decided = newer.authority === AUTHORITY.decision || (newer.modality === 'decided' && modalityOf(spanOf(newer)) === 'decided');
  return [
    { id: 'verbatim', ok: verbatim },
    { id: 'match', ok: p.match === 'exact' || p.match === 'alias' },
    { id: 'dated', ok: TEXT_DATE.has(older.dateSource) && TEXT_DATE.has(newer.dateSource) },
    { id: 'decision', ok: decided && newer.authority <= older.authority },
    { id: 'scope', ok: scopes },
    { id: 'rule', ok: res.rule === 'R1' || res.rule === 'R2' || res.rule === 'R3' },
    { id: 'add-only', ok: res.fix?.kind === 'annotate' },
    { id: 'reversible', ok: res.fix?.kind === 'annotate' && !!res.fix.add },
    { id: 'not-sensitive', ok: !ctx.confidential(older.rel) && !ctx.confidential(newer.rel) && !ctx.person(p.subject) && !sensitive(p) },
    { id: 'bar', ok: !!ctx.bar?.ok },
  ];
}
// criteria 1 to 9: the pair is in the slice whose decisions count toward the bar
export const inSlice = (criteria) => criteria.filter((c) => c.id !== 'bar').every((c) => c.ok);

// the 95% Wilson lower bound of k successes in n
export function wilson(k, n, z = 1.96) {
  if (!n) return 0;
  const ph = k / n;
  return (ph + (z * z) / (2 * n) - z * Math.sqrt((ph * (1 - ph) + (z * z) / (4 * n)) / n)) / (1 + (z * z) / n);
}

// the rule's measured precision from the decision log, over findings in the auto slice: the latest decision per
// finding counts, approved or applied on its own is right, archived or undone is wrong
export function ruleBar(records, ruleId = 'note.contradiction') {
  const latest = new Map();
  for (const r of records ?? []) {
    if (r?.ruleId !== ruleId || !(r.evidence?.facts ?? []).includes('auto-slice')) continue;
    if (r.decision === 'reopened') continue;
    latest.set(r.key, r);
  }
  let good = 0;
  let bad = 0;
  for (const r of latest.values()) { if (r.decision === 'approved' || r.decision === 'auto') good++; else if (r.decision === 'archived' || r.decision === 'undone') bad++; }
  const n = good + bad;
  const recent = [...latest.values()].filter((r) => r.decision === 'auto' || r.decision === 'undone').sort((x, y) => (x.at ?? 0) - (y.at ?? 0)).slice(-BAR.undoWindow);
  const undos = recent.filter((r) => r.decision === 'undone').length;
  const precision = n ? good / n : 0;
  const lower = wilson(good, n);
  return { n, good, bad, precision, wilson: lower, undos, ok: n >= BAR.n && precision >= BAR.precision && lower > BAR.wilson && undos < BAR.undos };
}

const CONTEXT = 3;
const around = (text, c) => {
  const lines = String(text).split('\n');
  const from = Math.max(1, c.line - CONTEXT);
  const to = Math.min(lines.length, c.lineEnd + CONTEXT);
  return lines.slice(from - 1, to).map((l, i) => `${from + i}: ${l}`).join('\n');
};
// the instructions are the same on every call, so they sit in the system prompt and every call starts with the same text
export const JUDGE_SYSTEM = [
  'You judge whether two claims from a notes vault disagree. You read only the excerpts given below; you have no tools and change nothing.',
  'Both claims are about the same subject and attribute. Pick one label:',
  'contradiction: both cannot hold at the same time for the same scope.',
  'refinement: one adds detail to the other and they do not conflict.',
  'different_times: each was true at its own date, and the newer one updates the older one.',
  'different_scope: they speak of different projects, environments, teams or people.',
  'same: they say the same thing in different words.',
  'Quote at least one line from each excerpt that supports the label. Quotes are the exact text of one numbered line, or an exact part of it, with the note path and line number. Copy them character for character.',
  'Answer with one JSON object and nothing else: { "label": "<label>", "quotes": [{ "path": "<note path>", "line": <line number>, "text": "<exact text>" }], "reason": "<one sentence>" }',
].join('\n');
// the same instructions for several pairs in one call, each pair under its id
export const JUDGE_BATCH_SYSTEM = [
  ...JUDGE_SYSTEM.split('\n').slice(0, -1).map((l) => l.replace('two claims from a notes vault disagree', 'the two claims of each pair below disagree').replace('Both claims are about', 'The two claims of a pair are about')),
  'Judge each pair on its own excerpts. Answer with one JSON object and nothing else, one verdict per pair: { "verdicts": [{ "pair": "<pair id>", "label": "<label>", "quotes": [{ "path": "<note path>", "line": <line number>, "text": "<exact text>" }], "reason": "<one sentence>" }] }',
].join('\n');
// several pairs to one call: JUDGE_BATCH pairs at most, and JUDGE_CHARS characters of prompt
export const JUDGE_BATCH = 8;
export const JUDGE_CHARS = 16000;

// the judge prompt for a pair: the two claims and CONTEXT lines on either side of each quote, never the whole notes.
// notes: [{ rel, text }] for the two notes
export function judgePrompt(p, notes) {
  const textOf = (rel) => notes.find((n) => n.rel === rel)?.text ?? '';
  const side = (c) => `<excerpt path="${c.rel}" date="${c.date ?? 'unknown'}">\n${around(textOf(c.rel), c)}\n</excerpt>`;
  const ask = [
    `Claim A in ${p.a.rel} (line ${p.a.line}): "${p.a.quote}"`,
    `Claim B in ${p.b.rel} (line ${p.b.line}): "${p.b.quote}"`,
  ];
  return { system: JUDGE_SYSTEM, prompt: `${ask.join('\n')}\n\n${side(p.a)}\n\n${side(p.b)}` };
}

// the prompt for several pairs: each pair's two claims and their excerpts, under an id. items: [{ id, p, notes }]
export function judgeBatchPrompt(items) {
  const blocks = items.map(({ id, p, notes }) => `<pair id="${id}">\n${judgePrompt(p, notes).prompt}\n</pair>`);
  return { system: JUDGE_BATCH_SYSTEM, prompt: blocks.join('\n\n') };
}
// a reply for several pairs, checked pair by pair as checkJudge does. Answers { byId: Map(id -> { label, quotes,
// reason } or { why }) } or { why } when the reply holds no verdicts. A pair with no verdict, or one that fails its check,
// gets a why; the others keep theirs
export function checkJudgeBatch(items, reply) {
  const j = parseJson(reply);
  if (!Array.isArray(j?.verdicts)) return { why: 'The judge did not answer with verdicts' };
  const byId = new Map();
  for (const { id, p, notes } of items) {
    const v = j.verdicts.find((x) => String(x?.pair) === String(id));
    byId.set(id, v ? checkVerdict(p, notes, v) : { why: 'The judge gave no verdict for this pair' });
  }
  return { byId };
}

// the judge's reply checked: a known label and a matching quote from each side. Answers { label, quotes } or { why }
export function checkJudge(p, notes, reply) {
  return checkVerdict(p, notes, parseJson(reply));
}
function checkVerdict(p, notes, j) {
  if (!j || !LABELS.includes(j.label)) return { why: 'The judge did not answer with a label' };
  const quotes = verifyQuotes(j.quotes, notes);
  if (!quotes.length || quotes.some((q) => !q.ok)) return { why: 'A quote from the judge does not match its note' };
  if (!quotes.some((q) => q.path === p.a.rel) || !quotes.some((q) => q.path === p.b.rel)) return { why: 'The judge did not quote both notes' };
  return { label: j.label, quotes, reason: typeof j.reason === 'string' ? j.reason.slice(0, 300) : '' };
}
