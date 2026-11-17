#!/usr/bin/env node
// The decision layer's performance budget: a child process plays the memory engine's utility process and runs the
// decider over the synthetic pairs (test/fixtures/deciderPairs.js), each text made new per round so no vector comes
// from the cache. The parent plays main and measures its own event loop delay and heap while the child works. Prints
// one JSON line: per-pair latency, the child's RSS, main's lag and heap. No Claude call, no vault content.
//
//   node --expose-gc scripts/decider-bench.mjs [--rounds 4] [--fake]
//
// --fake swaps the bundled models for a stand-in that holds the child's thread for 25 ms per call, so the test of main's
// lag runs where the model files are absent (CI).
import { fork } from 'node:child_process';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i < 0 ? def : args[i + 1]; };
const fake = args.includes('--fake');
const rounds = Number(opt('rounds', 4));
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? null; };

if (args.includes('--child')) {
  const { createDecider } = await import('../decide/index.js');
  const { loadModels } = await import('../decide/models.js');
  const { PAIRS } = await import('../test/fixtures/deciderPairs.js');
  const hold = (ms) => { const end = performance.now() + ms; while (performance.now() < end); };
  const stand = { embed: async (t) => { hold(25); return t.map(() => Float32Array.from({ length: 384 }, () => 1 / Math.sqrt(384))); }, nli: async (p) => { hold(25); return p.map(() => ({ contradiction: 0.5, entailment: 0.1, neutral: 0.4 })); } };
  const rss0 = process.memoryUsage().rss;
  const d = createDecider({ load: fake ? async () => stand : () => loadModels() });
  const at = performance.now();
  await d.warm();
  const loadMs = performance.now() - at;
  const ms = [];
  let peak = process.memoryUsage().rss;
  for (let r = 0; r < rounds; r++) for (const p of PAIRS) {
    const v = (c) => ({ ...c, quote: `${c.quote} (${r})` });
    const t = performance.now();
    const out = await d.relatedPair(v(p.a), v(p.b));
    if (out.tier === 't1') ms.push(performance.now() - t);
    peak = Math.max(peak, process.memoryUsage().rss);
  }
  process.send({ pairs: ms.length, pairMeanMs: ms.reduce((a, x) => a + x, 0) / (ms.length || 1), pairP50Ms: pct(ms, 0.5), pairP95Ms: pct(ms, 0.95), loadMs, engineRssStartMB: rss0 / 1e6, engineRssPeakMB: peak / 1e6, tiers: d.tiers() });
  process.exit(0);
}

globalThis.gc?.();
const heapStart = process.memoryUsage().heapUsed;
const lag = monitorEventLoopDelay({ resolution: 5 });
lag.enable();
const child = fork(new URL(import.meta.url).pathname, ['--child', '--rounds', String(rounds), ...(fake ? ['--fake'] : [])], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
// main keeps doing small work while the child runs, as it does while the engine sweeps
const tick = setInterval(() => { JSON.stringify({ at: Date.now(), list: Array.from({ length: 200 }, (_, i) => i) }); }, 10);
const report = await new Promise((resolve, reject) => { child.on('message', resolve); child.on('exit', (code) => code && reject(new Error(`child exited ${code}`))); });
clearInterval(tick);
lag.disable();
globalThis.gc?.();
const round = (v) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 10) / 10 : v);
console.log(JSON.stringify({ fake, ...report, lagP95: lag.percentile(95) / 1e6, lagMax: lag.max / 1e6, heapStartMB: heapStart / 1e6, heapEndMB: process.memoryUsage().heapUsed / 1e6 }, (k, v) => round(v)));
