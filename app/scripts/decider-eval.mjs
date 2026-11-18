// Runs the decision layer (decide/) with the bundled models over the synthetic fixtures (test/fixtures/deciderPairs.js)
// and prints what a threshold change needs: the precision of drops (a dropped pair whose truth makes a finding is an
// error), the drop rate, the latency per pair and per note, and the process memory. No Claude call, no vault content.
// Fetch the models first: node scripts/fetch-models.mjs
// Exits 1 when drop precision falls under MIN_PRECISION, so a threshold change that drops findings fails.
// usage: node scripts/decider-eval.mjs [--json] [--sweep]
import { performance } from 'node:perf_hooks';
import { createDecider, THRESHOLDS } from '../decide/index.js';
import { loadModels } from '../decide/models.js';
import { FINDING, NOTES, PAIRS } from '../test/fixtures/deciderPairs.js';

const asJson = process.argv.includes('--json');
export const MIN_PRECISION = 0.99;
const mb = (n) => Math.round(n / 1e6);
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const rss0 = process.memoryUsage().rss;

const t0 = performance.now();
const models = await loadModels();
const loadMs = performance.now() - t0;
const rssLoaded = process.memoryUsage().rss;

// one decider per threshold set, sharing the loaded models
const run = async (thresholds) => {
  const d = createDecider({ load: async () => models, thresholds });
  await d.warm();
  const rows = [];
  for (const p of PAIRS) {
    const at = performance.now();
    const r = await d.relatedPair(p.a, p.b);
    rows.push({ truth: p.truth, ...r, ms: performance.now() - at });
  }
  return { d, rows };
};

const score = (rows) => {
  const drops = rows.filter((r) => r.drop);
  const wrong = drops.filter((r) => FINDING.has(r.truth));
  const closable = rows.filter((r) => !FINDING.has(r.truth));
  return { pairs: rows.length, drops: drops.length, wrongDrops: wrong.length, dropPrecision: drops.length ? (drops.length - wrong.length) / drops.length : null, dropRate: drops.length / rows.length, closableDropped: closable.length ? drops.length - wrong.length : 0, closable: closable.length };
};

if (process.argv.includes('--sweep')) {
  for (const equivEntailment of [0.8, 0.9, 0.95, 0.98]) for (const equivCosine of [0, 0.8, 0.85, 0.9]) {
    const { rows } = await run({ ...THRESHOLDS, equivEntailment, equivCosine });
    const s = score(rows);
    console.log(JSON.stringify({ equivEntailment, equivCosine, drops: s.drops, wrong: s.wrongDrops, precision: s.dropPrecision }));
  }
  process.exit(0);
}

// a cold pass fills the embedding cache, so time a second decider for the per-pair figure a sweep sees on new pairs
await run(THRESHOLDS);
const { d, rows } = await run(THRESHOLDS);
const noteMs = [];
let noteRight = 0;
for (const n of NOTES) { const at = performance.now(); const r = d.worthReading(n); noteMs.push(performance.now() - at); if (r.read === n.truth) noteRight++; }
const t1Rows = rows.filter((r) => r.tier === 't1');
const s = score(rows);
const byTruth = Object.fromEntries([...new Set(PAIRS.map((p) => p.truth))].map((t) => { const r = rows.filter((x) => x.truth === t); return [t, { pairs: r.length, dropped: r.filter((x) => x.drop).length, equivalent: r.filter((x) => x.equivalent).length, t0Kept: r.filter((x) => x.tier === 't0' && !x.drop).length }]; }));
const report = {
  thresholds: THRESHOLDS, ...s, byTruth,
  latencyMs: { pairMean: rows.reduce((a, r) => a + r.ms, 0) / rows.length, t1PairP50: pct(t1Rows.map((r) => r.ms), 0.5), t1PairP95: pct(t1Rows.map((r) => r.ms), 0.95), noteMean: noteMs.reduce((a, x) => a + x, 0) / noteMs.length, loadMs },
  notes: { count: NOTES.length, right: noteRight },
  rssMB: { start: mb(rss0), loaded: mb(rssLoaded), end: mb(process.memoryUsage().rss) },
  tiers: d.tiers(),
};
const failed = s.dropPrecision !== null && s.dropPrecision < MIN_PRECISION;
if (asJson) { console.log(JSON.stringify(report)); process.exit(failed ? 1 : 0); }
console.log(`pairs ${s.pairs}, dropped ${s.drops} (${(s.dropRate * 100).toFixed(0)}%), wrong drops ${s.wrongDrops}, drop precision ${s.dropPrecision === null ? 'n/a' : (s.dropPrecision * 100).toFixed(1) + '%'}`);
console.log(`closable pairs dropped: ${s.closableDropped} of ${s.closable}`);
for (const [i, r] of rows.entries()) if (r.drop && FINDING.has(r.truth)) console.log(`  wrong drop: ${r.truth} "${PAIRS[i].a.quote}" / "${PAIRS[i].b.quote}"`);
for (const [t, v] of Object.entries(byTruth)) console.log(`  ${t.padEnd(16)} ${v.dropped}/${v.pairs} dropped (${v.equivalent} as equivalent), ${v.t0Kept} kept by T0`);
console.log(`latency: pair mean ${report.latencyMs.pairMean.toFixed(1)} ms, T1 pair p50 ${report.latencyMs.t1PairP50.toFixed(1)} ms, p95 ${report.latencyMs.t1PairP95.toFixed(1)} ms, note ${report.latencyMs.noteMean.toFixed(3)} ms, model load ${loadMs.toFixed(0)} ms`);
console.log(`notes: ${noteRight}/${NOTES.length} right`);
console.log(`rss: ${report.rssMB.start} MB at start, ${report.rssMB.loaded} MB with models, ${report.rssMB.end} MB at end`);
if (failed) { console.error(`drop precision under ${MIN_PRECISION * 100}%`); process.exit(1); }
