// The local decision layer (decide/): every tier fails open, T1 drops only pairs it marks equivalent, the 5% audit sample is
// deterministic and its verdicts land in a local log, and tiers() reports each tier's state. Fake models stand in for
// the bundled ones; the last block runs the real models when scripts/fetch-models.mjs has put them on disk.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AUDIT_RATE, audited, createPairGate } from '../decide/gate.js';
import { MAX_FAILURES, createDecider } from '../decide/index.js';
import { loadModels, missingFile } from '../decide/models.js';
import { noteRule, pairRule } from '../decide/rules.js';
import { FINDING, NOTES, PAIRS } from './fixtures/deciderPairs.js';

const c = (quote, value, polarity = 'positive') => ({ rel: 'x.md', quote, subject: 'atlas', attribute: 'database', value, polarity });
// fake models answering fixed scores: cos is the cosine both vectors give, nli the probabilities both directions give
const fake = ({ cos = 0.5, nli = { contradiction: 0.01, entailment: 0.01, neutral: 0.98 } } = {}) => {
  const a = Float32Array.from([1, 0]);
  const b = Float32Array.from([cos, Math.sqrt(1 - cos * cos)]);
  let n = 0;
  return { embed: vi.fn(async (texts) => texts.map(() => (n++ % 2 ? b : a))), nli: vi.fn(async (pairs) => pairs.map(() => nli)) };
};
// scores T1 reads as the same fact: entailment both ways, no contradiction, high similarity
const SAME = { cos: 0.97, nli: { contradiction: 0.001, entailment: 0.99, neutral: 0.009 } };
const pairA = c('Atlas stores uploads in a bucket.', 'bucket');
const pairB = c('Atlas standups are on Tuesday.', 'tuesday');
const tier = (d, id) => d.tiers().find((t) => t.id === id);

describe('decider tiers fail open', () => {
  it('passes every pair on when the models cannot load, and reports T1 missing', async () => {
    const d = createDecider({ load: async () => { throw new Error('model file missing: nli/config.json'); } });
    const r = await d.relatedPair(pairA, pairB);
    expect(r).toMatchObject({ drop: false, equivalent: false, tier: 't0' });
    expect(tier(d, 't1')).toMatchObject({ state: 'missing', error: 'model file missing: nli/config.json' });
    expect(await d.warm()).toBe(false);
  });

  it('loads the models once for many pairs, even when the load fails', async () => {
    const load = vi.fn(async () => { throw new Error('no runtime'); });
    const d = createDecider({ load });
    await Promise.all([d.relatedPair(pairA, pairB), d.relatedPair(pairB, pairA)]);
    await d.relatedPair(pairA, pairB);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('passes a pair on when the models run past the time limit', async () => {
    const d = createDecider({ load: async () => ({ embed: () => new Promise(() => {}), nli: () => new Promise(() => {}) }), timeoutMs: 20 });
    const r = await d.relatedPair(pairA, pairB);
    expect(r).toMatchObject({ drop: false, tier: 't0', reason: 't1 failed' });
    expect(tier(d, 't1').failures).toBe(1);
  });

  it('turns T1 off after repeated errors and stops calling it', async () => {
    const m = { embed: vi.fn(async () => { throw new Error('bad tensor'); }), nli: vi.fn(async () => { throw new Error('bad tensor'); }) };
    const d = createDecider({ load: async () => m });
    for (let i = 0; i < MAX_FAILURES + 2; i++) expect((await d.relatedPair(pairA, pairB)).drop).toBe(false);
    expect(tier(d, 't1')).toMatchObject({ state: 'off', failures: MAX_FAILURES });
    expect(m.embed).toHaveBeenCalledTimes(MAX_FAILURES);
  });

  it('reads a note when the rules cannot judge it', () => {
    const d = createDecider({ load: async () => fake() });
    expect(d.worthReading(null)).toMatchObject({ read: false, tier: 't0' });
    expect(d.worthReading({ rel: 'x.md', get text() { throw new Error('gone'); } })).toEqual({ read: true, reason: null, tier: 'none' });
  });
});

describe('decider decisions', () => {
  it('marks an equivalent pair and drops it, and answers no label', async () => {
    const same = await createDecider({ load: async () => fake(SAME) }).relatedPair(pairA, pairB);
    expect(same).toMatchObject({ drop: true, equivalent: true, tier: 't1' });
    expect(same).not.toHaveProperty('label');
  });

  it('keeps unrelated pairs, contradictions, refinements and entailment the similarity does not back', async () => {
    const keep = async (o, nli) => { const m = fake(o); if (nli) m.nli = async () => nli; return createDecider({ load: async () => m }).relatedPair(pairA, pairB); };
    // low contradiction and low similarity: refinements score like this too, so it is never dropped
    expect(await keep({ cos: 0.5 })).toMatchObject({ drop: false, tier: 't1' });
    expect((await keep({ cos: 0.97, nli: { contradiction: 0.4, entailment: 0.5, neutral: 0.1 } })).drop).toBe(false);
    // one direction entails, the other is neutral: a refinement Quorum shows
    expect((await keep({ cos: 0.97 }, [{ contradiction: 0.001, entailment: 0.99, neutral: 0.009 }, { contradiction: 0.001, entailment: 0.01, neutral: 0.989 }])).drop).toBe(false);
    // entailment both ways that the embedding model does not agree with
    expect((await keep({ ...SAME, cos: 0.6 })).drop).toBe(false);
  });

  it('lets T0 keep a changed figure or a flipped polarity without asking the models', async () => {
    const m = fake({ cos: 0.1 });
    const d = createDecider({ load: async () => m });
    expect(await d.relatedPair(c('Launch is March 3.', 'March 3'), c('Launch is April 10.', 'April 10'))).toMatchObject({ drop: false, tier: 't0', reason: 'figures differ' });
    expect(await d.relatedPair(c('Free plan has folders.', 'folders'), c('Free plan has no folders.', 'folders', 'negative'))).toMatchObject({ drop: false, tier: 't0', reason: 'polarity' });
    expect(m.embed).not.toHaveBeenCalled();
    expect(pairRule(c('', 'Postgres'), c('', 'postgres.'))).toMatchObject({ equivalent: true });
  });

  it('embeds each text once', async () => {
    const m = fake({ cos: 0.9 });
    const d = createDecider({ load: async () => m });
    await d.relatedPair(pairA, pairB);
    await d.relatedPair(pairB, pairA);
    expect(m.embed.mock.calls.flatMap((x) => x[0])).toHaveLength(2);
  });

  it('answers the fixture notes', () => {
    for (const n of NOTES) expect(noteRule(n).read, n.rel).toBe(n.truth);
  });

  it('reports both tiers', async () => {
    const d = createDecider({ load: async () => fake(SAME) });
    expect(d.tiers().map((t) => [t.id, t.state])).toEqual([['t0', 'ready'], ['t1', 'idle']]);
    await d.warm();
    expect(tier(d, 't1')).toMatchObject({ state: 'ready', calls: 0, drops: 0, failures: 0 });
    await d.relatedPair(pairA, pairB);
    expect(tier(d, 't1')).toMatchObject({ calls: 1, drops: 1 });
  });
});

describe('the 5% audit of dropped pairs', () => {
  it('samples about 5% of keys, the same keys every time', () => {
    const keys = Array.from({ length: 20000 }, (_, i) => `pair-${i}`);
    const picked = keys.filter((k) => audited(k));
    expect(picked.length / keys.length).toBeGreaterThan(AUDIT_RATE - 0.01);
    expect(picked.length / keys.length).toBeLessThan(AUDIT_RATE + 0.01);
    expect(keys.filter((k) => audited(k))).toEqual(picked);
  });

  it('sends a sampled drop to Claude and logs its verdict, and holds back the rest', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'decider-'));
    const file = path.join(dir, 'decider-audit.jsonl');
    const gate = createPairGate({ decider: createDecider({ load: async () => fake(SAME) }), file, now: () => 1000 });
    const inKey = Array.from({ length: 500 }, (_, i) => `k${i}`).find((k) => audited(k));
    const outKey = Array.from({ length: 500 }, (_, i) => `k${i}`).find((k) => !audited(k));
    expect(await gate.check({ key: outKey, a: pairA, b: pairB })).toMatchObject({ send: false, audit: false, drop: true });
    expect(await gate.check({ key: inKey, a: pairA, b: pairB })).toMatchObject({ send: true, audit: true, drop: true });
    expect(gate.record(outKey, 'contradiction')).toBe(false);
    expect(gate.record(inKey, 'contradiction')).toBe(true);
    expect(gate.record(inKey, 'contradiction')).toBe(false);
    const rows = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows).toEqual([{ at: 1000, key: inKey, tier: 't1', equivalent: true, score: 0.001, label: 'contradiction', miss: true }]);
    expect(gate.stats()).toEqual({ audited: 1, misses: 1, missRate: 1 });
  });

  it('sends every kept pair, and every pair when the decider throws', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'decider-'));
    const keepGate = createPairGate({ decider: createDecider({ load: async () => fake({ cos: 0.5 }) }), file: path.join(dir, 'a.jsonl') });
    expect(await keepGate.check({ key: 'k', a: pairA, b: pairB })).toMatchObject({ send: true, audit: false, drop: false });
    const broken = createPairGate({ decider: { relatedPair: async () => { throw new Error('boom'); } }, file: path.join(dir, 'b.jsonl') });
    expect(await broken.check({ key: 'k', a: pairA, b: pairB })).toMatchObject({ send: true, drop: false, tier: 'none' });
    expect(broken.stats()).toEqual({ audited: 0, misses: 0, missRate: null });
  });
});

describe('main stays responsive while the decider runs in another process', () => {
  it('keeps main event loop delay low while a child scores pairs', () => {
    const r = JSON.parse(execFileSync(process.execPath, ['--expose-gc', path.join(import.meta.dirname, '../scripts/decider-bench.mjs'), '--fake', '--rounds', '1'], { encoding: 'utf8', timeout: 60000 }));
    expect(r.pairs).toBeGreaterThan(30);
    expect(r.lagP95).toBeLessThan(100);
    expect(r.heapEndMB - r.heapStartMB).toBeLessThan(10);
  }, 70000);
});

describe.skipIf(missingFile() !== null)('the bundled models', () => {
  it('never drops a fixture pair whose truth makes a finding, and drops some closable ones', async () => {
    const models = await loadModels();
    const d = createDecider({ load: async () => models });
    const rows = [];
    for (const p of PAIRS) rows.push({ truth: p.truth, ...(await d.relatedPair(p.a, p.b)) });
    expect(rows.filter((r) => r.drop && FINDING.has(r.truth))).toEqual([]);
    expect(rows.filter((r) => r.drop).length).toBeGreaterThan(5);
    expect(rows.filter((r) => r.drop && r.truth !== 'same')).toEqual([]);
  }, 60000);
});
