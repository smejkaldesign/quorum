// The quality gate of Needs review. Before a review item (reviewItems.js) shows in Needs review, it passes these checks:
//   stability    the item came out of two or more passes (a re-scan after the index settled, its notes read again) with
//                the same fix and the same note hashes. A drafted fix also needs a second, independent draft that agrees
//                on the fix, with every quote of both checked against its note (memoryDraft.js confirm)
//   fixability   an item whose only Approve is Keep as is and that tells the person nothing they can act on is not shown
//   precision    each kind of fix has a prior precision measured on Quorum's own eval (PRIORS) and a posterior from this
//                vault's decision log: approved against archived and undone. An item whose expected precision is under
//                SHOW_AT still shows in Needs review, and a bulk plan lists it under Check these first, unticked
//   live guard   a kind whose approve rate over its last WINDOW decisions by a person falls under SHOW_AT, with
//                MIN_DECISIONS or more decisions in that window, is demoted: its items list under Check these first, and
//                Apply memory fixes on its own skips it. The demotion lifts once the window is back at SHOW_AT or above
// Only an item whose Approve could keep it as it is and that tells the person nothing stays out of Needs review
// (bucket quiet). Every other item shows: bucket show starts ticked in a bulk plan, bucket check starts unticked. An
// item that needs the agent (a missing note to write, a weak relink or alias) gets its fix from the agent when a person
// approves it (main.js agentResolve)
// Plain Node with no Electron, so main, the tests and the read-only scripts (scripts/gate-eval.mjs,
// scripts/gate-report.mjs) use the same gate.
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const GATE_VERSION = 1;
export const SHOW_AT = 0.9;
export const MIN_DECISIONS = 10;
// the live guard reads each kind's last WINDOW decisions by a person (approved, archived, undone)
export const WINDOW = 50;
export const BUCKETS = ['show', 'check', 'quiet'];

// Prior precision per kind of fix: p is the share of right suggestions measured on Quorum's eval, n how many decisions
// that prior is worth. Source: the labeled eval of 2026-11-16 (61 labeled items and 50 labeled past fix runs on the
// founder's vault, kept outside this repo; scripts/memory-eval.mjs and scripts/fix-recheck-eval.mjs). Small samples are
// rounded down from 100%. Unmeasured kinds sit at the bar with little weight, so one dismissal moves them out
export const PRIORS = {
  // 3 of 3 labeled aliases right after the stub check, and 3 of 3 past aliases not onto a stub labeled correct
  'link:alias': { p: 0.95, n: 6, source: 'labels 3/3, past runs 3/3' },
  // 3 of 3 labeled relinks with an exact or strong name match right (a match under WEAK_SCORE counts as weak); past relinks
  // 3 correct and 2 debatable
  'link:relink': { p: 0.92, n: 8, source: 'labels 3/3 strong, past runs 3 correct 2 debatable' },
  // 5 of 5 labeled unlink and self-link items right, 1 past unlink correct
  'link:unlink': { p: 0.95, n: 6, source: 'labels 5/5, past runs 1/1' },
  // review-only relinks and aliases: 2 of 6 labeled items wanted the note Quorum picked
  'link:relink-weak': { p: 0.4, n: 6, source: 'labels 2/6' },
  'link:alias-weak': { p: 0.4, n: 6, source: 'labels 2/6, as relink-weak' },
  // none of 29 past "write a missing note" fixes was right
  'link:create': { p: 0, n: 29, source: 'past runs 0/29' },
  // the review rules: precision on their labeled hits
  'finding:note.stale': { p: 1, n: 2, source: 'labels 2/2' },
  'finding:note.orphan': { p: 1, n: 1, source: 'labels 1/1' },
  'finding:note.frontmatter': { p: 1, n: 3, source: 'labels 3/3' },
  'finding:note.confidential-folder': { p: 1, n: 2, source: 'labels 2/2' },
  'finding:note.near-duplicate': { p: 1, n: 1, source: 'labels 1/1' },
  // equal bodies by construction
  'finding:note.duplicate': { p: 1, n: 1, source: 'exact match' },
  'finding:note.secret': { p: 0.9, n: 1, source: 'unmeasured' },
  'finding:note.oversized': { p: 0.9, n: 1, source: 'unmeasured' },
  // flagged past fixes Quorum can undo exactly: 22 of 22 flagged notes it wrote were labeled wrong or debatable, and the
  // undo only removes a note that holds nothing but what the fix wrote
  'pastfix:undo': { p: 0.95, n: 22, source: 'past runs 22/22 wrong or debatable' },
  // flagged past fixes Quorum cannot undo exactly: 5 relinks labeled wrong, 2 aliases onto a stub labeled debatable
  'pastfix:keep': { p: 0.9, n: 7, source: 'past runs 5 wrong, 2 debatable' },
  // fixes an agent drafted, including retroactive improvements: unmeasured, and only shown after two drafts agree
  'draft:create': { p: 0.9, n: 2, source: 'unmeasured' },
  'draft:point': { p: 0.9, n: 2, source: 'unmeasured' },
  'draft:merge': { p: 0.9, n: 2, source: 'unmeasured' },
  'draft:retro': { p: 0.9, n: 2, source: 'unmeasured' },
  // two notes that disagree (rules/contradictions.js): unmeasured on a real vault, so its items start under Check these
  // first until this vault's decisions lift it. An item with no fix shows too; Approve keeps both notes
  'finding:note.contradiction': { p: 0.7, n: 2, source: 'unmeasured' },
};
const DEFAULT_PRIOR = { p: SHOW_AT, n: 1, source: 'unmeasured' };
export const priorOf = (kind) => PRIORS[kind] ?? DEFAULT_PRIOR;

// a relink or alias whose name match is neither exact nor strong
export const WEAK_SCORE = 0.5;
// review rules whose keep-only finding still tells the person something they can act on themselves
export const INFO_RULES = new Set(['note.secret', 'note.duplicate', 'note.confidential-folder', 'note.contradiction', 'note.hygiene']);

const ruleOf = (kind) => String(kind).split(':')[0];
// the kind of fix an item proposes: the key of PRIORS and of the live guard
export function kindOf(item) {
  if (!item) return 'unknown';
  if (item.draft) return `draft:${item.retro ? 'retro' : item.draft.kind === 'contradiction' ? 'merge' : item.draft.kind}`;
  if (item.kind === 'link') {
    const op = item.ops?.[0]?.op ?? 'leave';
    if (op === 'create') return 'link:create';
    if (op === 'relink' || op === 'alias') return `link:${op}${weakLink(item) ? '-weak' : ''}`;
    return `link:${op}`;
  }
  if (item.kind === 'pastfix') return item.keep || item.retro ? 'pastfix:keep' : 'pastfix:undo';
  if (item.kind === 'finding') return `finding:${item.ruleId}`;
  return `${item.kind}:other`;
}
export const weakLink = (item) => !!item.reviewOnly || (!!item.match && !item.match.exact && Number(item.match.score ?? 0) < WEAK_SCORE);

// the kind of fix a decision record was about. Records written with the gate carry it; older ones are read back from
// their rule and proposed fix
export function kindOfRecord(r) {
  if (r?.proposedFix?.gateKind) return r.proposedFix.gateKind;
  if (r?.ruleId === 'link.missing') {
    const a = r.proposedFix?.action;
    if (!a) return null;
    if (a === 'relink' || a === 'alias') return `link:${a}${r.proposedFix.reviewOnly || r.proposedFix.weak ? '-weak' : ''}`;
    return `link:${a}`;
  }
  if (r?.ruleId === 'fix.recheck') return r.proposedFix?.kind === 'keep' ? 'pastfix:keep' : 'pastfix:undo';
  if (r?.ruleId) return `finding:${r.ruleId}`;
  return null;
}

// each kind's decisions from a decision log: approved (a person or Apply on its own), archived and undone. recent holds
// the kind's last WINDOW decisions by a person, oldest first by time, for the live guard
export function tallies(records) {
  const out = {};
  const seq = {};
  (records ?? []).forEach((r, i) => {
    const k = kindOfRecord(r);
    if (!k) return;
    const e = (out[k] ??= { approved: 0, auto: 0, archived: 0, undone: 0, recent: null });
    if (r.decision in e) e[r.decision]++;
    if (r.decision === 'approved' || r.decision === 'archived' || r.decision === 'undone') (seq[k] ??= []).push({ at: Number(r.at) || 0, i, decision: r.decision });
  });
  for (const [k, e] of Object.entries(out)) {
    const last = (seq[k] ?? []).sort((a, b) => a.at - b.at || a.i - b.i).slice(-WINDOW);
    e.recent = { approved: 0, archived: 0, undone: 0 };
    for (const d of last) e.recent[d.decision]++;
  }
  return out;
}

// the expected precision of a kind: its prior, as p * n right answers out of n, plus this vault's decisions
export function expected(kind, t = null) {
  const { p, n } = priorOf(kind);
  const good = (t?.approved ?? 0) + (t?.auto ?? 0);
  const bad = (t?.archived ?? 0) + (t?.undone ?? 0);
  if (!good && !bad) return p;
  return Math.round(((p * n + good) / (n + good + bad)) * 1e6) / 1e6;
}

// the live guard: a kind whose last WINDOW decisions by a person hold MIN_DECISIONS or more, with an approve rate under
// SHOW_AT. Before that the eval prior decides (expected). A tally without recent counts all its decisions
export function demoted(t) {
  if (!t) return null;
  const w = t.recent ?? t;
  const total = w.approved + w.archived + w.undone;
  if (total < MIN_DECISIONS || w.approved / total >= SHOW_AT) return null;
  return { approved: w.approved, total };
}
export const demotedLine = (d) => `Demoted: ${d.approved} of the last ${d.total} approved`;
// every demoted kind of a log, by kind
export function demotions(records) {
  const out = {};
  for (const [k, t] of Object.entries(tallies(records))) { const d = demoted(t); if (d) out[k] = d; }
  return out;
}
// the demotion of a rule for Settings > Memory: its kinds' decisions added up, when any of its kinds is demoted
export function ruleDemotion(ruleId, records) {
  const ds = Object.entries(demotions(records)).filter(([k]) => ruleIdOfKind(k) === ruleId).map(([, d]) => d);
  if (!ds.length) return null;
  return ds.reduce((a, d) => ({ approved: a.approved + d.approved, total: a.total + d.total }), { approved: 0, total: 0 });
}
export function ruleIdOfKind(kind) {
  const [head, rest] = [ruleOf(kind), String(kind).slice(ruleOf(kind).length + 1)];
  if (head === 'link') return 'link.missing';
  if (head === 'pastfix') return 'fix.recheck';
  if (head === 'finding') return rest;
  if (head === 'draft') return rest === 'retro' ? 'fix.recheck' : rest === 'merge' ? 'note.near-duplicate' : 'link.missing';
  return null;
}

// what an item would change, as text that is the same across passes when the fix is the same
export function signature(item) {
  const ops = (item.ops ?? []).map((o) => {
    const { lines, links, expect, before, text, ...rest } = o;
    return { ...rest, ...(before != null ? { before: hash(before) } : {}), ...(text != null ? { text: hash(text) } : {}) };
  });
  return JSON.stringify({ ops, hold: item.hold ?? null, hashes: item.hashes ?? null });
}
const hash = (t) => createHash('sha256').update(String(t)).digest('hex').slice(0, 16);

// item id -> how many passes it came out of with the fix of the first pass. passes: arrays of items
export function stability(passes) {
  const out = new Map();
  const [first, ...rest] = passes;
  for (const i of first ?? []) {
    const sig = signature(i);
    const same = rest.every((p) => p.some((x) => x.id === i.id && signature(x) === sig));
    out.set(i.id, { passes: passes.length, stable: same });
  }
  return out;
}

// whether Approve can only keep the item as it is
export const keepOnly = (item) => !item.ops?.length || item.ops.every((o) => o.op === 'keep');
// whether a keep-only item still tells the person something they can act on
export function infoValue(item) {
  if (item.kind === 'finding') return INFO_RULES.has(item.ruleId);
  if (item.kind === 'pastfix') return !!item.retro;
  return false;
}

// The gate of one item. ctx: { stable: { stable } | null, tally: the kind's decisions, isStub(rel) }. Answers
// { bucket, why, kind, expected, reasons }; why is the one line a bulk plan shows under Check these first
export function gateItem(item, { stable = null, tally = null, isStub = () => false } = {}) {
  const kind = kindOf(item);
  const exp = expected(kind, tally);
  const reasons = [];
  const out = (bucket, why) => ({ bucket, why, kind, expected: Math.round(exp * 1000) / 1000, reasons });
  if (keepOnly(item) && !infoValue(item)) { reasons.push('keep-only'); return out('quiet', item.hold ?? 'Approve could only keep it as it is, and it shows nothing you need to act on.'); }
  if (stable && !stable.stable) { reasons.push('unstable'); return out('check', 'Its fix changed between Quorum\'s checks, so read it before it runs.'); }
  if (item.hold) { reasons.push('held'); return out('check', item.hold); }
  const o = item.ops?.[0];
  if (o && (o.op === 'alias' || o.op === 'relink') && isStub(o.op === 'alias' ? o.rel : o.to)) { reasons.push('onto-stub'); return out('check', 'It points the link at a note Quorum wrote from links alone.'); }
  if (item.draft) {
    if (item.draft.confirmed === false) { reasons.push('drafts-disagree'); return out('check', 'Two drafts of this fix disagree, so read it before it runs.'); }
    if (item.draft.confirmed !== true) { reasons.push('draft-unconfirmed'); return out('check', 'A second draft has not checked this fix yet, so read it before it runs.'); }
  }
  const d = demoted(tally);
  if (d) { reasons.push('demoted'); return out('check', `${demotedLine(d)}, so read fixes like this before they run.`); }
  if (exp >= SHOW_AT) return out('show', null);
  reasons.push('low-precision');
  return out('check', `Fixes like this were right about ${Math.round(exp * 100)}% of the time, so read it before it runs.`);
}

// The gate over the review items. passes: the items from each pass, the first pass is the one shown; records: the
// vault's decision log. Answers { verdicts: Map id -> verdict, counts: { show, check, quiet } }
export function runGate(passes, records = [], { isStub = () => false } = {}) {
  const stab = stability(passes);
  const t = tallies(records);
  const verdicts = new Map();
  const counts = { show: 0, check: 0, quiet: 0 };
  for (const item of passes[0] ?? []) {
    const v = gateItem(item, { stable: stab.get(item.id), tally: t[kindOf(item)] ?? null, isStub });
    verdicts.set(item.id, v);
    counts[v.bucket]++;
  }
  return { verdicts, counts };
}

// shown vs held per kind, with each kind's expected precision: for the gate log and scripts/gate-report.mjs
export function summarize(verdicts) {
  const out = {};
  for (const v of verdicts.values()) {
    const e = (out[v.kind] ??= { show: 0, check: 0, quiet: 0, expected: v.expected, reasons: {} });
    e[v.bucket]++;
    for (const r of v.reasons) e.reasons[r] = (e.reasons[r] ?? 0) + 1;
  }
  return out;
}

// The gate log: one JSON line per gate run in Quorum's data folder, so precision can be measured against the decisions
// that follow. Each line holds the vault's hash, the passes, the counts and each item's id, kind, bucket and reasons.
// The file is cut to its newer half past MAX_LOG bytes
const MAX_LOG = 4 * 1024 * 1024;
export function logGate(file, vault, { verdicts, counts }, { passes = 2, at = Date.now() } = {}) {
  const items = [...verdicts].map(([id, v]) => ({ id, kind: v.kind, bucket: v.bucket, expected: v.expected, reasons: v.reasons }));
  const line = JSON.stringify({ v: GATE_VERSION, at, vault: hash(vault), passes, counts, items });
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${line}\n`);
    if (statSync(file).size > MAX_LOG) {
      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
      writeFileSync(file, `${lines.slice(Math.floor(lines.length / 2)).join('\n')}\n`);
    }
  } catch {}
}
export function readGateLog(file) {
  try { return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
}
