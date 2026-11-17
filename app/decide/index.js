// The memory agent's local decision layer: questions answered on the Mac before an item goes to Claude.
//   worthReading(note)    { read, reason, tier }: false only when T0 is sure the note holds no claim
//   relatedPair(a, b)     { drop, equivalent, score, tier, reason }: drop true takes the pair out of the judge queue;
//                         today every drop is a pair marked equivalent
//   tiers()               the state of every tier, for status and logs
// T0 (rules.js) always runs. T1 (models.js) is the two bundled models. Every tier fails open: when a tier is missing,
// errors or runs past its time limit, the item goes on to Claude unchanged. T1 may only drop a pair it marks
// equivalent; it never answers a label, so no finding Quorum shows comes from a local model.
import { cosine, loadModels } from './models.js';
import { noteRule, pairRule } from './rules.js';

// set from scripts/decider-eval.mjs on the synthetic fixtures for a drop precision of at least 99%. T1 drops only a pair
// it reads as the same fact: entailment in both directions, no contradiction, and a high similarity, two models agreeing.
// It does not drop pairs as unrelated: refinements whose detail is worded apart score like unrelated pairs on both
// models (low contradiction, low similarity, no entailment), so any cut that drops unrelated pairs also drops findings
export const THRESHOLDS = Object.freeze({ equivEntailment: 0.95, equivContradiction: 0.02, equivCosine: 0.85 });
export const TIMEOUT_MS = 5000;
// T1 stops after this many failures in a row, so a broken runtime costs a few timeouts and then nothing
export const MAX_FAILURES = 3;
const CACHE = 5000;

const textOf = (c) => String(c?.quote || [c?.subject, c?.attribute, c?.value].filter(Boolean).join(' ')).trim();
const within = (p, ms) => new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms); p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); }); });

export function createDecider({ load = loadModels, thresholds = THRESHOLDS, timeoutMs = TIMEOUT_MS, log = () => {}, now = Date.now } = {}) {
  const t1 = { state: 'idle', error: null, loadMs: null, calls: 0, drops: 0, failures: 0, streak: 0 };
  let models = null;
  let loading = null;
  const vectors = new Map();

  const ensure = () => {
    if (models || t1.state === 'missing' || t1.state === 'off') return Promise.resolve(models);
    loading ??= (async () => {
      t1.state = 'loading';
      const at = now();
      try {
        models = await within(Promise.resolve().then(() => load()), timeoutMs * 6);
        t1.state = 'ready'; t1.loadMs = now() - at;
        log('decider', 't1 ready', t1.loadMs);
      } catch (e) {
        t1.state = 'missing'; t1.error = String(e?.message ?? e);
        log('decider', 't1 missing', t1.error);
      }
      return models;
    })();
    return loading;
  };

  const embed = async (texts) => {
    const want = [...new Set(texts.filter((t) => !vectors.has(t)))];
    if (want.length) {
      const got = await models.embed(want);
      want.forEach((t, i) => { if (vectors.size >= CACHE) vectors.delete(vectors.keys().next().value); vectors.set(t, got[i]); });
    }
    return texts.map((t) => vectors.get(t));
  };

  const pass = (tier, reason) => ({ drop: false, equivalent: false, score: null, tier, reason });

  return {
    worthReading(note) {
      try { const r = noteRule(note); return { ...r, tier: 't0' }; } catch (e) { log('decider', 't0 note failed', String(e?.message ?? e)); return { read: true, reason: null, tier: 'none' }; }
    },

    async relatedPair(a, b) {
      let rule;
      try { rule = pairRule(a, b); } catch (e) { log('decider', 't0 pair failed', String(e?.message ?? e)); rule = { keep: false, equivalent: false }; }
      if (rule.equivalent) return { drop: true, equivalent: true, score: 1, tier: 't0', reason: rule.reason };
      if (rule.keep) return pass('t0', rule.reason);
      const ta = textOf(a);
      const tb = textOf(b);
      if (!ta || !tb) return pass('t0', 'no text');
      try {
        if (!(await ensure())) return pass('t0', 't1 missing');
        if (t1.state !== 'ready') return pass('t0', `t1 ${t1.state}`);
        t1.calls++;
        const [[va, vb], [ab, ba]] = await within(Promise.all([embed([ta, tb]), models.nli([[ta, tb], [tb, ta]])]), timeoutMs);
        t1.streak = 0;
        const sim = cosine(va, vb);
        const contra = Math.max(ab.contradiction, ba.contradiction);
        const entail = Math.min(ab.entailment, ba.entailment);
        const oneWay = Math.max(ab.entailment, ba.entailment);
        const th = thresholds;
        if (entail >= th.equivEntailment && contra <= th.equivContradiction && sim >= th.equivCosine) { t1.drops++; return { drop: true, equivalent: true, score: contra, tier: 't1', reason: 'entailment both ways', sim, entail, oneWay }; }
        return { drop: false, equivalent: false, score: contra, tier: 't1', reason: null, sim, entail, oneWay };
      } catch (e) {
        t1.failures++; t1.streak++; t1.error = String(e?.message ?? e);
        if (t1.streak >= MAX_FAILURES) { t1.state = 'off'; models = null; }
        log('decider', 't1 failed', t1.error, t1.state);
        return pass('t0', 't1 failed');
      }
    },

    // loads T1 now instead of on the first pair
    warm: () => ensure().then((m) => !!m),

    tiers: () => [
      { id: 't0', name: 'Rules', state: 'ready' },
      { id: 't1', name: 'Bundled models', state: t1.state, error: t1.error, loadMs: t1.loadMs, calls: t1.calls, drops: t1.drops, failures: t1.failures },
    ],
  };
}
