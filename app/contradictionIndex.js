// Contradiction detection, stage 1: an index of each note with no model. It reads the frontmatter, the lines that
// carry decision phrases, the dates, the status field, superseded markers and wiki links, and gives the note an
// authority rank and a date. Results are cached by the hash of the note's text, so only changed notes are read again
// and only notes with something to compare go on to claim extraction (contradictionClaims.js).
//
// Authority ranks follow the research design: 1 decision record, 2 project or reference note, 3 meeting note,
// 4 session log, 5 inbox note. Lower is stronger.
// Plain Node, no Electron.
import { createHash } from 'node:crypto';

export const hashText = (t) => createHash('sha256').update(String(t ?? '')).digest('hex').slice(0, 24);

export const AUTHORITY = { decision: 1, project: 2, meeting: 3, session: 4, inbox: 5 };
const ISO = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
// language that records a decision, a proposal or a rejection. A rejection is checked first: "decided against"
export const REJECTED_RE = /\b(decided against|ruled out|rejected|we will not|we won't|dropped the idea|no longer (?:plan|planning))\b/i;
export const DECIDED_RE = /\b(we decided|decided to|decided that|decided on|decision:|final decision|finali[sz]ed|agreed (?:to|that|on)|we will go with|going with|we chose|chose to|signed off|approved)\b/i;
export const PROPOSED_RE = /\b(propos(?:e|ed|al)|consider(?:ing|ed)?|might|maybe|option|could|draft|idea:|thinking about|explor(?:e|ing))\b/i;
// a line that says it is out of date or names what replaced it
export const SUPERSEDED_RE = /\b(superseded(?: by)?|replaced by|no longer (?:true|valid|current|applies)|deprecated|obsolete|outdated)\b/i;
// a line in a newer note that names the note it replaces: "This replaces [[pricing-v1]]"
export const REPLACES_RE = /\b(replaces|supersedes|overrides)\b/i;
const SUPERSEDED_STATUS = /^(superseded|replaced|deprecated|obsolete|retired)$/i;

const one = (v) => (Array.isArray(v) ? v[0] : v);
const validDate = (y, m, d) => { const t = Date.UTC(+y, +m - 1, +d); const x = new Date(t); return Number.isFinite(t) && x.getUTCMonth() === +m - 1 && x.getUTCDate() === +d ? `${y}-${m}-${d}` : null; };
// the ISO dates written in a piece of text
export function datesIn(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(ISO)) { const d = validDate(m[1], m[2], m[3]); if (d) out.push(d); }
  return out;
}

// how much a note's claims weigh, from its frontmatter type and its folder
export function authorityOf(rel, props = {}) {
  const type = String(one(props.type) ?? '').toLowerCase();
  const r = `/${String(rel).toLowerCase()}`;
  if (type === 'decision' || type === 'adr' || /\/(decisions?|adrs?)\//.test(r)) return AUTHORITY.decision;
  if (/\/(\d+-)?inbox\//.test(r) || type === 'inbox') return AUTHORITY.inbox;
  if (/\/(sessions?|logs?|journal|daily)\//.test(r) || type === 'session' || type === 'log') return AUTHORITY.session;
  if (/\/(\d+-)?meetings?\//.test(r) || type === 'meeting' || props.attendees != null) return AUTHORITY.meeting;
  return AUTHORITY.project;
}

// the date a note speaks for: its frontmatter (decided, date, created), else a date in its file name. File modified
// time is never used, since an edit for a typo changes it
export function noteDate(rel, props = {}) {
  for (const k of ['decided', 'date', 'created']) {
    const d = datesIn(one(props[k]))[0];
    if (d) return { date: d, source: 'frontmatter' };
  }
  const named = datesIn(String(rel).split('/').pop())[0];
  return named ? { date: named, source: 'name' } : { date: null, source: null };
}

// what a line records: decided, rejected, proposed, or a plain statement
export function modalityOf(line) {
  const t = String(line ?? '');
  if (REJECTED_RE.test(t)) return 'rejected';
  if (DECIDED_RE.test(t)) return 'decided';
  if (PROPOSED_RE.test(t)) return 'proposed';
  return 'stated';
}

// the frontmatter's line count, fences included, so body line numbers can be told apart from frontmatter ones
export function frontmatterEnd(lines) {
  if (lines[0]?.replace(/\r$/, '') !== '---') return 0;
  for (let i = 1; i < lines.length; i++) if (/^---\s*$/.test(lines[i])) return i + 1;
  return 0;
}

const cache = new Map();
// the stage 1 index of one note. n: { rel, text, note } as the vault index gives it (note from linkparse.js parseNote)
export function indexNote(n) {
  const text = String(n.text ?? '');
  const hash = hashText(text);
  const hit = cache.get(n.rel);
  if (hit?.hash === hash) return hit;
  const props = n.note?.props ?? {};
  const lines = text.split('\n');
  const fmEnd = frontmatterEnd(lines);
  const decisions = [];
  const superseded = [];
  const dates = [];
  const replaces = new Set();
  for (let i = fmEnd; i < lines.length; i++) {
    const l = lines[i];
    if (REPLACES_RE.test(l)) for (const m of l.matchAll(/\[\[([^\]|#\n]+)/g)) replaces.add(m[1].trim().toLowerCase());
    if (DECIDED_RE.test(l) || REJECTED_RE.test(l)) decisions.push({ line: i + 1, text: l });
    if (SUPERSEDED_RE.test(l)) superseded.push({ line: i + 1, text: l });
    for (const d of datesIn(l)) dates.push({ line: i + 1, date: d });
  }
  const status = one(props.status) != null ? String(one(props.status)) : null;
  const supersededBy = [props.superseded_by, props.supersededBy, props.replaced_by].flatMap((v) => (Array.isArray(v) ? v : v ? [v] : [])).map((v) => String(v).replace(/^\[\[|\]\]$/g, '').split('|')[0]);
  const { date, source } = noteDate(n.rel, props);
  const out = {
    rel: n.rel, hash, title: n.note?.title ?? String(n.rel).split('/').pop().replace(/\.md$/i, ''), aliases: n.note?.aliases ?? [],
    keys: Object.keys(props), status, superseded: (status != null && SUPERSEDED_STATUS.test(status)) || supersededBy.length > 0, supersededBy,
    decisions, supersededLines: superseded, replaces: [...replaces], dates, links: [...new Set((n.note?.links ?? []).map((l) => l.target))],
    date, dateSource: source, authority: authorityOf(n.rel, props), fmEnd,
  };
  // a note goes on to claim extraction when it has a decision phrase, a date (frontmatter, file name or body), a status
  // field, a superseded marker, or is a decision record (the rule also sends a note that links to one of those). It needs a sentence to
  // read. priority (below) puts decision records, notes with decision phrases and dated notes first
  const body = lines.slice(fmEnd).filter((l) => l.trim() && !/^\s*#/.test(l)).join(' ');
  out.readable = body.replace(/\s+/g, ' ').trim().length >= 12;
  out.worth = out.readable && (out.decisions.length > 0 || out.date != null || out.dates.length > 0 || out.status != null || out.superseded || out.supersededLines.length > 0 || out.authority === AUTHORITY.decision);
  out.priority = (out.authority === AUTHORITY.decision ? 0 : 10) + (out.decisions.length ? 0 : 5) + (out.date || out.dates.length ? 0 : 3) + out.authority;
  cache.set(n.rel, out);
  return out;
}
export const clearIndexCache = () => cache.clear();
