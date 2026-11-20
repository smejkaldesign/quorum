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
// a template: a note in a templates folder, or one whose frontmatter still holds template syntax ({{date}}, <% %>).
// Its status and dates are placeholders, so no rule reads it as a note
const TEMPLATE_FOLDER = /(^|\/)_?templates?\//i;
const TEMPLATE_SYNTAX = /\{\{[^}]*\}\}|<%[\s\S]*?%>/;
export const isTemplate = (rel, props = {}) => TEMPLATE_FOLDER.test(rel) || Object.values(props).some((v) => (Array.isArray(v) ? v : [v]).some((x) => TEMPLATE_SYNTAX.test(String(x ?? ''))));
// generated reports and templates: no rule reads them
export const skipped = (n) => isGenerated(n.rel, n.note?.props ?? {}) || isTemplate(n.rel, n.note?.props ?? {});
export const MAX_RULE_TEXT = 1000000;

// A note longer than MAX_RULE_TEXT reaches the rules as its head (memoryEngine.js).
// the text the rules read for a note: the whole text, or its head cut at a line end. Main cuts it before it sends the
// note, so the copy that reaches the engine holds no reference to the whole text
export function ruleText(text) {
  const t = String(text ?? '');
  if (t.length <= MAX_RULE_TEXT) return t;
  const cut = t.lastIndexOf('\n', MAX_RULE_TEXT);
  return cut > 0 ? t.slice(0, cut) : t.slice(0, MAX_RULE_TEXT);
}

// a short hash of a note's text as the rules read it, with its full length: FNV-1a over the text
export function noteHash(text, chars = String(text ?? '').length) {
  const t = String(text ?? '');
  let h = 0x811c9dc5;
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${h.toString(16).padStart(8, '0')}:${chars}`;
}
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const quote = (t) => `“${t}”`;
// a note that opens a folder or the vault (index, README, CLAUDE): it lists other notes and follows no folder schema
export const ENTRY_NAME = /^(index|_index|readme|_readme|claude|agents|log|changelog|home|start|moc)$/i;
// a note named by its date: a daily note or a session log, reached by date and written as a log
export const DATED = /\d{4}-\d{2}-\d{2}/;
// One dated instance of a recurring note: a note named by its date (or undated-, as a notetaker files a meeting with no
// date), or a meeting note (a meetings, meeting notes, 1:1s, one-on-ones or standups folder; type meeting,
// meeting-note, meeting_notes, 1:1 or standup; or attendees in its frontmatter). Two instances of one series (the
// same monthly all-hands on two dates, two 1:1s with the same person) are separate notes: no rule proposes merging one
// into another or sending it to the Trash, and the merge steps refuse to (memorySetup.js runSetupOp, reviewItems.js
// findingItem, memoryDraft.js). The duplicate rules leave them out, byte-identical copies too: a copy of one meeting is
// for a person to sort out, and Quorum offers no fix that could remove a meeting note
const MEETING_DIR = /(^|\/)(\d+[-_ ]*)?(meetings?|meeting[-_ ]?notes?|1[-_:]?(on[-_ ]?)?1s?|one[-_ ]?on[-_ ]?ones?|standups?)(\/|$)/i;
const MEETING_TYPE = /^(meetings?|meeting[-_ ]?notes?|1[-_:]?(on[-_ ]?)?1|one[-_ ]?on[-_ ]?one|standup)$/i;
export function meetingInstance(rel, props = {}) {
  if (DATED.test(baseOf(rel)) || /^undated-/i.test(baseOf(rel)) || MEETING_DIR.test(dirOf(rel))) return true;
  const type = String(Array.isArray(props?.type) ? props.type[0] : props?.type ?? '').trim();
  if (MEETING_TYPE.test(type)) return true;
  return ['attendees', 'participants'].some((k) => (Array.isArray(props?.[k]) ? props[k].length : String(props?.[k] ?? '').trim()));
}
export const isInstance = (n) => !!n && meetingInstance(n.rel, n.note?.props ?? {});

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
// fix: what the finding's Approve does, for a rule that offers one ({ kind: 'tag' | 'move' | 'move-tag', value, to });
// autoFix: Apply memory fixes on its own may run the fix without a review
export function finding(rule, { key, target, notes, title, problem, proposal, evidence = [], facts = [], meta = [], fix = null, autoFix = false }) {
  return { ruleId: rule.id, ruleVersion: rule.version, rule: rule.label, key: `${rule.id}:${key}`, target, notes, rel: notes[0], title, problem, proposal, evidence, facts, meta, ...(fix ? { fix } : {}), autoFix: !!(fix && autoFix) };
}
