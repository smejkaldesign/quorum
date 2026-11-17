#!/usr/bin/env node
// Runs contradiction detection READ-ONLY against a vault with no model call: stage 1 (index), the structured claims of
// stage 2 (frontmatter and "key: value" lines), stage 3 (pairing) and the symbolic rules of stage 4. Prints counts only,
// never note names or text. It never writes: the index is built in memory.
//
//   node scripts/contradiction-eval.mjs <vault> [--labels labels.json]
//
// A labels file is a JSON array of { category, files, negative }. Items with category "contradiction" are scored: a
// positive label is found when a pair still open after the symbolic rules touches all its files; a negative label is a
// false alarm when such a pair touches all its files. Keep the labels and the output out of the repo.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const labelsArg = flag('--labels');
const [vaultArg] = args;
if (!vaultArg) { console.error('usage: node scripts/contradiction-eval.mjs <vault> [--labels labels.json]'); process.exit(2); }
const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (f) => import(pathToFileURL(path.join(appDir, f)).href);
const { createVaultIndex } = await load('vindex.js');
const { analyze, run } = await load('rules/contradictions.js');
const { packBatches, BATCH_CHARS } = await load('contradictionAgent.js');
const { DAILY_CAP } = await load('memoryDraft.js');

const vaultDir = path.resolve(vaultArg);
const idx = createVaultIndex({ vault: vaultDir, isExcludedPath: () => false, isExcludedText: () => false, redact: (t) => t, onChange: () => {} });
idx.sync();
const ctx = { notes: idx.snapshot(), resolve: (t, from) => idx.resolve(t, from), tags: [], folders: {} };
const t0 = performance.now();
const a = analyze(ctx);
const ms = Math.round(performance.now() - t0);
const t1 = performance.now();
run(ctx);
const warm = Math.round(performance.now() - t1);
const findings = run(ctx);
const count = (list, key) => list.reduce((m, x) => { const k = key(x); m[k] = (m[k] ?? 0) + 1; return m; }, {});
const open = a.results.filter((r) => !r.res.closed && !r.res.pending);

// the claim calls read each note's excerpt (contradictionClaims.js excerptOf)
const { excerptOf } = await load('contradictionClaims.js');
const toRead = a.toRead.map((x) => ({ ...x, chars: excerptOf(x).length })).filter((x) => x.chars);
const batches = packBatches(toRead);
const chars = toRead.reduce((n, x) => n + x.chars, 0);
console.log(`notes ${a.notes}; stage 1 sends ${a.worth} to claim extraction, plus ${a.linked} that link to one of them`);
console.log(`first pass: ${batches.length} claim calls of up to ${BATCH_CHARS} characters (about ${Math.round(chars / 4 / 1000)}k input tokens in all), ${Math.ceil(batches.length / DAILY_CAP)} days at ${DAILY_CAP} calls a day before judge calls`);
console.log(`structured claims ${a.claims.length}`, count(a.claims, (c) => c.extractor));
console.log(`attribute groups ${a.groups}, candidate pairs ${a.pairs.length}`, count(a.pairs, (p) => p.match));
console.log('resolved', count(a.results, (r) => r.res.rule ?? r.res.pending));
console.log(`open pairs ${open.length}, findings ${findings.length}`, count(findings, (f) => f.facts[0]), `with a fix ${findings.filter((f) => f.fix).length}, in the auto slice ${findings.filter((f) => f.facts.includes('auto-slice')).length}`);
console.log(`first run ${ms} ms, cached run ${warm} ms`);

if (labelsArg) {
  const labels = JSON.parse(readFileSync(path.resolve(labelsArg), 'utf8')).filter((l) => l.category === 'contradiction');
  const touches = (files) => (r) => files.every((f) => r.res.older.rel === f || r.res.newer.rel === f);
  const anyPair = (files) => (p) => files.every((f) => p.a.rel === f || p.b.rel === f);
  const pos = labels.filter((l) => !l.negative);
  const neg = labels.filter((l) => l.negative);
  const found = pos.filter((l) => open.some(touches(l.files))).length;
  const paired = pos.filter((l) => a.pairs.some(anyPair(l.files))).length;
  const alarms = neg.filter((l) => open.some(touches(l.files))).length;
  console.log(`labels: ${pos.length} contradictions, ${neg.length} negatives`);
  console.log(`contradictions paired ${paired}/${pos.length}, open after the rules ${found}/${pos.length}; negatives flagged ${alarms}/${neg.length}`);
}
