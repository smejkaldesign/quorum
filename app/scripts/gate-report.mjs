#!/usr/bin/env node
// Prints what the quality gate of Needs review (qualityGate.js) showed and held, READ-ONLY from Quorum's data folder:
// the latest gate run per vault, shown against held per kind of fix with its expected precision, and the precision the
// person's own decisions measure for each kind since (approved over approved, archived and undone). It never writes.
//
//   node scripts/gate-report.mjs [--data <app data dir>] [--runs <n>]
//
// The data folder defaults to Quorum's on this Mac. --runs prints the shown and held counts of the last n runs too.
// The output names kinds of fixes and counts only, never notes.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const dataDir = path.resolve(flag('--data') ?? path.join(os.homedir(), 'Library', 'Application Support', 'Quorum'));
const history = Number(flag('--runs') ?? 0);
const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { readGateLog, tallies, priorOf, SHOW_AT, MIN_DECISIONS } = await import(pathToFileURL(path.join(appDir, 'qualityGate.js')).href);

const log = readGateLog(path.join(dataDir, 'memory-gate-log.jsonl'));
if (!log.length) { console.log(`No gate runs logged in ${dataDir}. Quorum logs one each time it checks Needs review.`); process.exit(0); }

// every decision of every vault: the log names a vault by its hash, and so does the decision log's file name
const decisions = [];
const dir = path.join(dataDir, 'finding-decisions');
if (existsSync(dir)) for (const f of readdirSync(dir).filter((x) => /^[0-9a-f]{16}\.json$/.test(x))) { try { decisions.push(...(JSON.parse(readFileSync(path.join(dir, f), 'utf8')).records ?? [])); } catch {} }
const measured = tallies(decisions);

const byVault = new Map();
for (const run of log) byVault.set(run.vault, [...(byVault.get(run.vault) ?? []), run]);
const pct = (x) => (x == null ? 'n/a' : `${Math.round(x * 1000) / 10}%`);
for (const [vault, runs] of byVault) {
  const last = runs[runs.length - 1];
  console.log(`vault ${vault}: ${runs.length} gate runs, the last on ${new Date(last.at).toISOString()}, ${last.passes} passes`);
  console.log(`  shown ${last.counts.show}, check these first ${last.counts.check}, not shown ${last.counts.quiet}`);
  const kinds = {};
  for (const i of last.items) {
    const e = (kinds[i.kind] ??= { show: 0, check: 0, quiet: 0, expected: i.expected, reasons: {} });
    e[i.bucket]++;
    for (const r of i.reasons ?? []) e.reasons[r] = (e.reasons[r] ?? 0) + 1;
  }
  console.log('  kind: shown / check first / not shown; expected precision; measured from decisions');
  for (const [k, e] of Object.entries(kinds).sort()) {
    const t = measured[k];
    const n = t ? t.approved + t.archived + t.undone : 0;
    const rate = n ? t.approved / n : null;
    const flagOut = n >= MIN_DECISIONS && rate < SHOW_AT ? ', demoted' : '';
    const why = Object.entries(e.reasons).map(([r, c]) => `${r} ${c}`).join(', ');
    console.log(`  ${k}: ${e.show} / ${e.check} / ${e.quiet}; expected ${pct(e.expected)} (prior ${pct(priorOf(k).p)}); measured ${pct(rate)} over ${n} decisions${flagOut}${why ? `; held for ${why}` : ''}`);
  }
  if (history > 0) {
    console.log(`  last ${Math.min(history, runs.length)} runs (shown / check first / not shown):`);
    for (const r of runs.slice(-history)) console.log(`    ${new Date(r.at).toISOString()}  ${r.counts.show} / ${r.counts.check} / ${r.counts.quiet}`);
  }
}
