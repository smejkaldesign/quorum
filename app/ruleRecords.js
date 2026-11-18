// What the decision log (decisionLog.js) says about each rule: its record for Settings > Memory, and the ignore rules
// Quorum proposes when a person keeps archiving the same kind of finding. Plain Node with no Electron.
//
// An ignore proposal comes from 3 or more archives of one rule's findings that share a pattern:
//   folder  every note of the finding sits in one folder
//   key     the finding is about one frontmatter key (missing, wrong type or written twice)
//   target  the same link target or note
// Accepting one stores an ignore rule in Quorum's settings (never in the vault); the rule's findings that match it stop
// showing. The person lists and removes ignore rules in Settings > Memory.
import { createHash } from 'node:crypto';
import { normTarget } from './decisionLog.js';

export const IGNORE_AFTER = 3;
export const FIELDS = ['folder', 'key', 'target'];
const KEY_FACT = /^(missing|type|twice):(.+)$/;
const dirOf = (rel) => (String(rel).includes('/') ? String(rel).slice(0, String(rel).lastIndexOf('/')) : '');
const inFolder = (rel, folder) => dirOf(rel) === folder || String(rel).startsWith(`${folder}/`);
const hash = (t) => createHash('sha256').update(t).digest('hex').slice(0, 16);

// each rule's decisions: { [ruleId]: { approved, archived, undone, auto, reopened, last } }
export function ruleRecords(records) {
  const out = {};
  for (const r of records ?? []) {
    if (!r?.ruleId) continue;
    const e = (out[r.ruleId] ??= { approved: 0, archived: 0, undone: 0, auto: 0, reopened: 0, last: 0 });
    if (r.decision in e) e[r.decision]++;
    e.last = Math.max(e.last, r.at ?? 0);
  }
  return out;
}

// the notes a record is about: a finding's notes, or a link's linking notes
const notesOf = (r) => (Array.isArray(r.evidence?.notes) ? r.evidence.notes : Array.isArray(r.evidence?.sources) ? r.evidence.sources : []);
// the frontmatter keys a record is about, from a frontmatter finding's facts
const keysOf = (facts) => [...new Set((facts ?? []).map((f) => String(f).match(KEY_FACT)?.[2]).filter(Boolean))];

// the patterns a record shares with others: { field, value }
export function patternsOf(r) {
  const out = [];
  const notes = notesOf(r);
  const folders = [...new Set(notes.map(dirOf))];
  if (notes.length && folders.length === 1 && folders[0]) out.push({ field: 'folder', value: folders[0] });
  const keys = keysOf(r.evidence?.facts);
  if (keys.length === 1) out.push({ field: 'key', value: keys[0] });
  // a pair target (two notes on two lines) is no shared text
  const raw = String(r.target ?? r.key ?? '');
  if (raw && !raw.includes('\n')) out.push({ field: 'target', value: normTarget(raw) });
  return out;
}

export const ignoreId = (ruleId, field, value) => hash(`${ruleId}\n${field}\n${value}`);

// the ignore rules to propose: each rule and pattern archived IGNORE_AFTER or more times, once per finding and evidence,
// leaving out the ones already stored or turned down. records: the decision log; labels: rule id -> readable label
export function ignoreProposals(records, { ignores = [], dismissed = [], labels = {} } = {}) {
  const have = new Set([...ignores.map((g) => g.id), ...dismissed]);
  const seen = new Set();
  const groups = new Map();
  for (const r of records ?? []) {
    if (r?.decision !== 'archived' || !r.ruleId || r.ruleId === 'fix.recheck') continue;
    const once = `${r.ruleId}\n${r.key}\n${r.fingerprint}`;
    if (seen.has(once)) continue;
    seen.add(once);
    for (const p of patternsOf(r)) {
      const id = ignoreId(r.ruleId, p.field, p.value);
      const g = groups.get(id) ?? groups.set(id, { id, ruleId: r.ruleId, field: p.field, value: p.value, count: 0, keys: new Set() }).get(id);
      g.count++;
      g.keys.add(r.key);
    }
  }
  return [...groups.values()]
    .filter((g) => g.count >= IGNORE_AFTER && !have.has(g.id))
    // a target archived again and again is one finding; a folder or key needs findings on more than one note
    .filter((g) => g.field === 'target' || g.keys.size >= 2)
    .map((g) => ({ id: g.id, ruleId: g.ruleId, field: g.field, value: g.value, count: g.count, findings: g.keys.size, title: ignoreTitle(g, labels) }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
}

// "Stop flagging X in folder Y", in the words of the rule
export function ignoreTitle(g, labels = {}) {
  const what = labels[g.ruleId] ?? g.ruleId;
  if (g.field === 'folder') return `Stop flagging ${lower(what)} in the folder ${g.value}`;
  if (g.field === 'key') return `Stop flagging ${lower(what)} for the frontmatter key ${g.value}`;
  return `Stop flagging ${lower(what)} for “${g.value}”`;
}
const lower = (t) => String(t).charAt(0).toLowerCase() + String(t).slice(1);

// whether an ignore rule covers a finding ({ ruleId, notes, facts, target }) or a link issue ({ target, sources })
export function ignored(ignores, ruleId, { notes = [], facts = [], target = null } = {}) {
  for (const g of ignores ?? []) {
    if (g.ruleId !== ruleId) continue;
    if (g.field === 'folder' && notes.length && notes.every((rel) => inFolder(rel, g.value))) return g;
    if (g.field === 'key') { const keys = keysOf(facts); if (keys.length && keys.every((k) => k === g.value)) return g; }
    if (g.field === 'target' && normTarget(target) === g.value) return g;
  }
  return null;
}
