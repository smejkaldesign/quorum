#!/usr/bin/env node
// Re-checks past Memory health fix runs READ-ONLY against a vault (fixRecheck.js) and, given labels, prints how often
// the flags agree with them. It never writes: the index is built in memory, undo records and saved versions are read
// from the data folder, and git is only read.
//
//   node scripts/fix-recheck-eval.mjs <vault> <fix-runs.json> [--labels labels.json] [--data <app data dir>] [--verbose]
//
// A labels file is a JSON array of { index, label } with label correct, debatable or wrong; index is the run's place in
// fix-runs.json. --verbose prints each run's index, label, reason ids and undo kind, never note names or text. Keep the
// labels and the output out of the repo.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const verbose = args.includes('--verbose');
if (verbose) args.splice(args.indexOf('--verbose'), 1);
const labelsArg = flag('--labels');
const [vaultArg, runsArg] = args;
const dataDir = path.resolve(flag('--data') ?? path.dirname(path.resolve(runsArg ?? '.')));
if (!vaultArg || !runsArg) { console.error('usage: node scripts/fix-recheck-eval.mjs <vault> <fix-runs.json> [--labels f] [--data dir] [--verbose]'); process.exit(2); }
const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (f) => import(pathToFileURL(path.join(appDir, f)).href);
const { createVaultIndex } = await load('vindex.js');
const { createElsewhere } = await load('linkElsewhere.js');
const { recheckAll, undoPlan, fixVersions } = await load('fixRecheck.js');

const vaultDir = path.resolve(vaultArg);
const runs = JSON.parse(readFileSync(path.resolve(runsArg), 'utf8')).filter((r) => r.vault === undefined || path.resolve(r.vault) === vaultDir);
const idx = createVaultIndex({ vault: vaultDir, isExcludedPath: () => false, isExcludedText: () => false, redact: (t) => t, onChange: () => {} });
idx.sync();
const read = (rel) => { try { return readFileSync(path.join(vaultDir, rel), 'utf8'); } catch { return null; } };
const vault = { rels: () => idx.rels(), note: (rel) => idx.note(rel), backlinks: (rel) => idx.backlinks(rel), resolve: (t, from) => idx.resolve(t, from), read };
const finder = createElsewhere({ vault: vaultDir });
const mtime = (rel) => { try { return statSync(path.join(vaultDir, rel)).mtimeMs; } catch { return null; } };
const undoFile = (id) => path.join(dataDir, 'fix-undo', `${String(id).replace(/[^a-z0-9_-]/gi, '_').slice(0, 200)}.json`);
const undoFiles = (id) => { try { return JSON.parse(readFileSync(undoFile(id), 'utf8')).files ?? null; } catch { return null; } };
const vhome = path.join(dataDir, 'memory-versions', createHash('sha1').update(vaultDir).digest('hex').slice(0, 16));
let vfiles = {};
try { vfiles = JSON.parse(readFileSync(path.join(vhome, 'index.json'), 'utf8')).files ?? {}; } catch {}
const readVersion = (_rel, id) => { try { return readFileSync(path.join(vhome, 'v', `${id}.md`), 'utf8'); } catch { return null; } };
try { readdirSync(dataDir); } catch { console.error('no data folder at', dataDir); }

const { results } = recheckAll(runs, { vault, find: (n) => finder.find(n) });
const labels = labelsArg ? new Map(JSON.parse(readFileSync(path.resolve(labelsArg), 'utf8')).map((l) => [l.index, l.label])) : new Map();
const table = {};
const reasons = {};
const undoKinds = {};
runs.forEach((run, i) => {
  const res = results[run.id];
  if (!res) return;
  const label = labels.get(i) ?? 'unlabeled';
  const key = `${label}:${res.flagged ? 'flagged' : 'clear'}`;
  table[key] = (table[key] ?? 0) + 1;
  for (const r of res.reasons) reasons[r.id] = (reasons[r.id] ?? 0) + 1;
  let plan = null;
  if (res.flagged) {
    plan = undoPlan(run, { vault, undoFiles: undoFiles(run.id), versions: fixVersions(vfiles, run), readVersion, mtime });
    const k = `${plan.kind}:${plan.ok ? 'ok' : 'refused'}`;
    undoKinds[k] = (undoKinds[k] ?? 0) + 1;
  }
  if (verbose) console.log(i, label, res.action, res.flagged ? res.reasons.map((r) => r.id).join(',') : '-', plan ? `${plan.kind}:${plan.ok ? 'ok' : 'refused'}` : '');
});
const n = (k) => table[k] ?? 0;
console.log('runs', Object.values(table).reduce((a, b) => a + b, 0));
console.log('by label and flag', table);
if (labels.size) {
  const wrong = n('wrong:flagged') + n('wrong:clear');
  const correct = n('correct:flagged') + n('correct:clear');
  const deb = n('debatable:flagged') + n('debatable:clear');
  console.log(`wrong flagged: ${n('wrong:flagged')} of ${wrong}`);
  console.log(`correct left clear: ${n('correct:clear')} of ${correct}`);
  console.log(`debatable flagged: ${n('debatable:flagged')} of ${deb}`);
  console.log(`agreement (wrong flagged + correct clear): ${n('wrong:flagged') + n('correct:clear')} of ${wrong + correct}`);
}
console.log('reasons', reasons);
console.log('undo', undoKinds);
