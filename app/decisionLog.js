// The decision log of Memory health: one record per decision on a finding, per vault, in Quorum's data folder (never
// in the vault). A record keeps the rule that made the finding and its version, a fingerprint of the finding, the
// evidence, the fix Quorum proposed, the decision, who made it and when. owner and approver are kept for team vaults
// and stay null on a personal vault.
//
// decision is one of:
//   approved  a person approved the proposed fix
//   archived  a person set the finding aside without fixing it
//   undone    a person undid a fix that ran
//   reopened  a person moved it back to review, or Quorum did because its evidence changed after an archive
//   auto      Quorum applied the fix on its own (no rule does this yet)
//
// An archived finding stays out of Needs review while its fingerprint is the same. The fingerprint hashes the rule id,
// the normalized target and the set of linking notes, so a new linking note (new evidence) brings it back.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const DECISIONS = ['approved', 'archived', 'undone', 'reopened', 'auto'];
const CAP = 5000;
const hash = (t) => createHash('sha256').update(t).digest('hex');
export const normTarget = (t) => String(t ?? '').toLowerCase().replace(/\.md$/, '').replace(/\s+/g, ' ').trim();

// a stable id of a finding: the same rule, target and linking notes give the same fingerprint in any order
export function fingerprint(ruleId, target, sources = []) {
  return hash([ruleId, normTarget(target), ...[...new Set(sources.map(String))].sort()].join('\n')).slice(0, 24);
}

export function createDecisionLog(dir) {
  const cache = new Map();
  const file = (vault) => path.join(dir, `${hash(String(vault)).slice(0, 16)}.json`);
  // a log that does not parse is moved aside as <name>.corrupt-<time>.json before the next save, so a new record never
  // writes over the history in it
  const load = (vault) => {
    if (!cache.has(vault)) {
      let list = [];
      let raw = null;
      try { raw = readFileSync(file(vault), 'utf8'); } catch {}
      if (raw != null) {
        try { const j = JSON.parse(raw); if (!Array.isArray(j.records)) throw new Error('no records'); list = j.records; } catch {
          try { renameSync(file(vault), file(vault).replace(/\.json$/, `.corrupt-${Date.now()}.json`)); } catch {}
        }
      }
      cache.set(vault, list);
    }
    return cache.get(vault);
  };
  // written to a temporary file and renamed over the log, so a quit partway never leaves half a log
  const save = (vault) => {
    const list = load(vault);
    if (list.length > CAP) list.splice(0, list.length - CAP);
    const tmp = `${file(vault)}.tmp`;
    try { mkdirSync(dir, { recursive: true }); writeFileSync(tmp, JSON.stringify({ vault, records: list })); renameSync(tmp, file(vault)); } catch {}
  };

  // adds a record; key is the finding's key (the missing link's target, lowercased)
  function record(vault, { ruleId, ruleVersion, key, target, sources = [], evidence = null, proposedFix = null, decision, actor = 'you', owner = null, approver = null, note = null, at = Date.now() }) {
    if (!vault || !DECISIONS.includes(decision)) return null;
    const rec = {
      id: `${at}-${hash(`${key}${Math.random()}`).slice(0, 8)}`, ruleId, ruleVersion, key: String(key ?? normTarget(target)), fingerprint: fingerprint(ruleId, target ?? key, sources),
      evidence, proposedFix, decision, actor, at, owner, approver, ...(note ? { note } : {}),
    };
    load(vault).push(rec);
    save(vault);
    return rec;
  }
  const list = (vault) => [...load(vault)];
  const latest = (vault, key) => { const all = load(vault); for (let i = all.length - 1; i >= 0; i--) if (all[i].key === key) return all[i]; return null; };
  // the archived findings whose evidence changed: their latest record is an archive with another fingerprint
  // current: Map key -> fingerprint of the finding as it reads now
  function changedArchives(vault, current) {
    const out = [];
    for (const [key, fp] of current) { const r = latest(vault, key); if (r?.decision === 'archived' && r.fingerprint !== fp) out.push(key); }
    return out;
  }
  return { record, list, latest, changedArchives, file };
}
