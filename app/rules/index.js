// The Memory health review rules and the engine that runs them. Each rule is a plain module with an id, a version, a
// readable label and run(ctx) -> findings. A finding can carry a fix the batch planner runs once a person approves it;
// autoFix marks the fixes Apply memory fixes on its own may run without a review.
//
// ctx: { notes, resolve, tags, now }
//   notes   [{ rel, text, note: { title, props, headings }, mtime, size, inbound, outbound }] from the vault index
//   resolve (target, fromRel) -> rel | null, the index's link resolver
//   tags    [{ rel, value }] the confidential value of every note in the vault, including notes the index leaves out
//   folders { [folder rel]: value } the folders a person marked confidential (kept in Quorum's settings)
//   contradictions { provider, bar } the agent's claims and verdicts and the rule's measured bar (rules/contradictions.js)
import * as orphans from './orphans.js';
import * as duplicates from './duplicates.js';
import * as nearDuplicates from './nearDuplicates.js';
import * as frontmatter from './frontmatter.js';
import * as oversized from './oversized.js';
import * as confidential from './confidential.js';
import * as secrets from './secrets.js';
import * as stale from './stale.js';
import * as contradictions from './contradictions.js';

export const RULES = [stale, duplicates, nearDuplicates, contradictions, frontmatter, confidential, secrets, oversized, orphans];
export const RULE_LABELS = Object.fromEntries(RULES.map((r) => [r.rule.id, r.rule.label]));

// runs every rule over the vault. only: the notes that changed; findings that touch none of them are left out, so the
// caller can merge them into what it already holds (mergeFindings). Answers the findings and each rule's time in ms
export function runRules(ctx, { only = null, rules = RULES } = {}) {
  const findings = [];
  const ms = {};
  const want = only ? new Set(only) : null;
  for (const r of rules) {
    const t0 = performance.now();
    let found;
    try { found = r.run({ now: Date.now(), ...ctx, only }); } catch { found = []; }
    ms[r.rule.id] = Math.round((performance.now() - t0) * 10) / 10;
    for (const f of found) if (!want || f.notes.some((rel) => want.has(rel))) findings.push(f);
  }
  return { findings, ms };
}

// the findings after a run on some notes: the earlier findings that touch none of them stay, the new ones join
export function mergeFindings(prev, next, only) {
  if (!only) return next;
  const touched = new Set(only);
  return [...prev.filter((f) => !f.notes.some((rel) => touched.has(rel))), ...next];
}
