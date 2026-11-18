// The narrow hook between the decision layer and the contradiction judge. check(pair) asks the decider and answers
// whether the pair still goes to Claude. A deterministic 5% of the pairs the decider drops go to Claude anyway as an
// audit; record(key, label) writes the judge's verdict for an audited pair to a local log, and stats() reads the log
// back, so the recall the drops cost can be measured. The log holds pair keys (hashes), tiers, scores and labels, never
// note text.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const AUDIT_RATE = 0.05;
// judge labels that make a finding: a dropped pair the judge gives one of these is recall the drop cost
export const FINDING_LABELS = new Set(['contradiction', 'refinement', 'different_times']);

// the same pair is always in or out of the sample, whatever order the sweep meets it in
export const audited = (key, rate = AUDIT_RATE) => parseInt(createHash('sha256').update(`audit\u0000${key}`).digest('hex').slice(0, 8), 16) / 0x100000000 < rate;

export function createPairGate({ decider, file, rate = AUDIT_RATE, now = Date.now, log = () => {} }) {
  const open = new Map();
  return {
    // { send, audit, drop, equivalent, score, tier }. Never throws: an error sends the pair on
    async check(p) {
      let d;
      try { d = await decider.relatedPair(p.a, p.b); } catch (e) { log('decider gate', 'check failed', String(e?.message ?? e)); return { send: true, audit: false, drop: false, equivalent: false, score: null, tier: 'none' }; }
      if (!d?.drop) return { ...d, send: true, audit: false };
      const audit = audited(p.key, rate);
      if (audit) open.set(p.key, d);
      return { ...d, send: audit, audit };
    },
    // the judge's label for a pair check() sent as an audit. Answers whether it was one
    record(key, label) {
      const d = open.get(key);
      if (!d) return false;
      open.delete(key);
      try {
        mkdirSync(path.dirname(file), { recursive: true });
        appendFileSync(file, `${JSON.stringify({ at: now(), key, tier: d.tier, equivalent: d.equivalent, score: d.score, label, miss: FINDING_LABELS.has(label) })}\n`);
      } catch (e) { log('decider gate', 'audit log failed', String(e?.message ?? e)); }
      return true;
    },
    // { audited, misses, missRate } over the log
    stats() {
      if (!existsSync(file)) return { audited: 0, misses: 0, missRate: null };
      const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
      const misses = rows.filter((r) => r.miss).length;
      return { audited: rows.length, misses, missRate: rows.length ? misses / rows.length : null };
    },
  };
}
