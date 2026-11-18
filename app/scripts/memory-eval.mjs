#!/usr/bin/env node
// Local eval of the Memory health link-fix proposer, the review rules and near-duplicates. Reads a vault and a labels file, runs the proposer READ-ONLY and
// prints how often its fix matches the labeled fix for the broken-link categories. It never writes to the vault or
// anywhere else: it builds the index in memory and reads git refs.
//
//   node scripts/memory-eval.mjs <vault> <labels.json> [--app <app dir>] [--quiet]
//
// --app runs the proposer of another checkout (for a before/after comparison against an older branch). A labels file
// is a JSON array of { id, category, evidence, correct_action }; the link target is the first [[link]] in evidence.
// A fix counts as correct when it matches the labeled fix, or when the label says to leave, unlink or ask first and
// Quorum withholds the fix (no issue, Leave, or a review-only fix). Keep the labels and the output out of the repo.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const quiet = args.includes('--quiet');
if (quiet) args.splice(args.indexOf('--quiet'), 1);
const appDir = path.resolve(flag('--app') ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const [vaultArg, labelsArg] = args;
if (!vaultArg || !labelsArg) { console.error('usage: node scripts/memory-eval.mjs <vault> <labels.json> [--app <dir>] [--quiet]'); process.exit(2); }
const vault = path.resolve(vaultArg);
const labels = JSON.parse(readFileSync(path.resolve(labelsArg), 'utf8'));
const load = (f) => import(pathToFileURL(path.join(appDir, f)).href);

const { createVaultIndex } = await load('vindex.js');
const { issueOf } = await load('memoryHealth.js');
const elsewhereMod = existsSync(path.join(appDir, 'linkElsewhere.js')) ? await load('linkElsewhere.js') : null;

const idx = createVaultIndex({ vault, isExcludedPath: () => false, isExcludedText: () => false, redact: (t) => t, onChange: () => {} });
idx.sync();

// the note names on disk, as main.js diskNoteNames() reads them
const disk = new Set();
const walk = (dir, depth) => {
  if (depth > 12) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    if (e.isDirectory()) walk(path.join(dir, e.name), depth + 1);
    else if (/\.md$/i.test(e.name)) {
      const base = e.name.replace(/\.md$/i, '').toLowerCase();
      disk.add(base);
      disk.add(path.relative(vault, path.join(dir, base)).split(path.sep).join('/').toLowerCase());
    }
  }
};
walk(vault, 0);
const onDisk = (t) => { const k = String(t).toLowerCase().replace(/\.md$/, ''); return disk.has(k) || disk.has(k.split('/').pop()); };

let items = idx.linkHealth().filter((m) => !onDisk(m.target));
if (elsewhereMod) {
  const finder = elsewhereMod.createElsewhere({ vault });
  items = elsewhereMod.withFound(items, finder, idx.rels());
}
const issues = items.map(issueOf);

// every target some note links to without a note, before any filter: a label whose target is not here is not broken now
const broken = new Set();
for (const rel of idx.rels()) for (const l of idx.missingIn(rel)) broken.add(l.target.toLowerCase());

const stem = (x) => String(x ?? '').toLowerCase().replace(/\.md$/, '').replace(/\/$/, '').split('/').pop();
const targetOf = (label) => {
  const wiki = String(label.evidence ?? '').match(/\[\[([^\]|#]+)/);
  if (wiki) return wiki[1].trim();
  const file = String(label.evidence ?? '').match(/([\w./-]+)\.md\b/);
  return file ? file[1] : null;
};
const findIssue = (t) => issues.find((i) => i.key === t.toLowerCase()) ?? issues.find((i) => stem(i.key) === stem(t));
const isBroken = (t) => broken.has(t.toLowerCase()) || [...broken].some((b) => stem(b) === stem(t));

function judge(label, t, issue) {
  const want = String(label.correct_action ?? '').toLowerCase().trim();
  const withheld = !issue || issue.action === 'leave' || issue.reviewOnly === true;
  const cand = issue?.candidate ?? null;
  const to = want.match(/\bto\s+([\w./-]+)/)?.[1] ?? null;
  const pointsAt = (x) => !!cand && (stem(cand.rel) === stem(x) || String(cand.name ?? '').toLowerCase() === stem(x));
  if (want.startsWith('depends')) return withheld;
  if (want.startsWith('link the folder')) return withheld || (issue?.action === 'relink' && !!cand && cand.rel.toLowerCase().includes(`${stem(t)}/`));
  if (want.startsWith('relink')) return ['relink', 'alias'].includes(issue?.action) && (!to || pointsAt(to));
  if (want.startsWith('add alias')) { const x = want.match(/\bto\s+([\w./-]+)\s*$/)?.[1]; return issue?.action === 'alias' && (!x || pointsAt(x)); }
  if (want.startsWith('leave') || want.startsWith('unlink')) return withheld || issue?.action === 'unlink';
  return false;
}

const rows = [];
for (const label of labels.filter((l) => String(l.category).startsWith('broken-link'))) {
  const t = targetOf(label);
  if (!t) { rows.push({ id: label.id, category: label.category, state: 'no target' }); continue; }
  const issue = findIssue(t);
  if (!issue && !isBroken(t)) { rows.push({ id: label.id, category: label.category, state: 'not broken now' }); continue; }
  const ok = judge(label, t, issue);
  rows.push({ id: label.id, category: label.category, state: ok ? 'correct' : 'wrong', action: issue ? `${issue.action}${issue.reviewOnly ? ' (review only)' : ''}${issue.candidate ? ` -> ${stem(issue.candidate.rel)}` : ''}` : 'no issue' });
}

const scored = rows.filter((r) => r.state === 'correct' || r.state === 'wrong');
const correct = scored.filter((r) => r.state === 'correct').length;
if (!quiet) for (const r of rows) console.log(`${r.id}\t${r.category}\t${r.state}\t${r.action ?? ''}`);
const byCat = {};
for (const r of scored) { const c = (byCat[r.category] ??= { correct: 0, total: 0 }); c.total++; if (r.state === 'correct') c.correct++; }
console.log(`\nproposer: ${appDir}`);
console.log(`open link issues: ${issues.length} (${Object.entries(issues.reduce((a, i) => ({ ...a, [i.action]: (a[i.action] ?? 0) + 1 }), {})).map(([k, v]) => `${k} ${v}`).join(', ')})`);
for (const [c, v] of Object.entries(byCat)) console.log(`${c}: ${v.correct}/${v.total}`);
console.log(`link-fix accuracy: ${correct}/${scored.length} = ${scored.length ? Math.round((correct / scored.length) * 100) : 0}% (${rows.length - scored.length} labels not scored)`);

// The review rules (rules/index.js), when the checkout has them: each labeled item of these categories is a hit when a
// finding of the mapped rules names one of its files (a path ending in / names a folder). A hit on a negative label is a
// false positive. Precision counts the labeled hits only; the finding totals show how many items Needs review would get
if (existsSync(path.join(appDir, 'rules', 'index.js'))) {
  const { runRules, RULE_LABELS } = await load('rules/index.js');
  const t0 = Date.now();
  const { findings, ms } = runRules({ notes: idx.snapshot(), resolve: (t, from) => idx.resolve(t, from) });
  const took = Date.now() - t0;
  const CAT_RULES = {
    duplicate: ['note.duplicate'], stale: ['note.stale'], orphan: ['note.orphan'],
    frontmatter: ['note.frontmatter', 'note.confidential-folder'], confidential: ['note.confidential-folder', 'note.secret'],
  };
  const names = (f, file) => f.notes.some((rel) => (file.endsWith('/') ? rel.startsWith(file) : rel === file));
  const score = {};
  const lines = [];
  for (const label of labels) {
    const want = CAT_RULES[label.category];
    if (!want) continue;
    const hit = findings.some((f) => want.includes(f.ruleId) && (label.files ?? []).some((file) => names(f, file)));
    const s = (score[label.category] ??= { tp: 0, fp: 0, fn: 0, tn: 0 });
    const k = label.negative ? (hit ? 'fp' : 'tn') : hit ? 'tp' : 'fn';
    s[k]++;
    lines.push(`${label.id}\t${label.category}\t${label.negative ? 'negative' : 'positive'}\t${k.toUpperCase()}`);
  }
  if (!quiet) console.log(`\n${lines.join('\n')}`);
  console.log('\nreview rules (labeled items):');
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : 'n/a');
  for (const [c, s] of Object.entries(score)) console.log(`${c}: precision ${pct(s.tp, s.tp + s.fp)} (${s.tp} TP, ${s.fp} FP), recall ${pct(s.tp, s.tp + s.fn)} (${s.fn} missed), negatives left alone ${s.tn}/${s.tn + s.fp}`);
  const all = Object.values(score).reduce((a, s) => ({ tp: a.tp + s.tp, fp: a.fp + s.fp, fn: a.fn + s.fn }), { tp: 0, fp: 0, fn: 0 });
  console.log(`all review categories: precision ${pct(all.tp, all.tp + all.fp)}, recall ${pct(all.tp, all.tp + all.fn)}`);
  const per = {};
  for (const f of findings) per[f.ruleId] = (per[f.ruleId] ?? 0) + 1;
  console.log(`findings in the vault: ${findings.length} (${Object.entries(per).map(([id, n]) => `${RULE_LABELS[id] ?? id} ${n}`).join(', ')})`);
  console.log(`rules took ${took} ms (${Object.entries(ms).map(([id, t]) => `${id} ${t}`).join(', ')})`);

  // Near-duplicates (rules/nearDuplicates.js), when the checkout has the rule: a duplicate or contradiction label with
  // two or more files is a hit when one near-duplicate finding names two of them. Numbers only
  const near = findings.filter((f) => f.ruleId === 'note.near-duplicate');
  if (existsSync(path.join(appDir, 'rules', 'nearDuplicates.js'))) {
    const { THRESHOLD } = await load('rules/nearDuplicates.js');
    const pairLabels = labels.filter((l) => ['duplicate', 'contradiction'].includes(l.category) && (l.files ?? []).length >= 2);
    const s = { tp: 0, fp: 0, fn: 0, tn: 0 };
    const nearLines = [];
    for (const label of pairLabels) {
      const hit = near.some((f) => (label.files ?? []).filter((file) => names(f, file)).length >= 2);
      const k = label.negative ? (hit ? 'fp' : 'tn') : hit ? 'tp' : 'fn';
      s[k]++;
      nearLines.push(`${label.id}\t${label.category}\t${label.negative ? 'negative' : 'positive'}\t${k.toUpperCase()}`);
    }
    if (!quiet) console.log(`\n${nearLines.join('\n')}`);
    const sameDir = near.filter((f) => path.dirname(f.notes[0]) === path.dirname(f.notes[1])).length;
    console.log(`\nnear-duplicates (threshold ${THRESHOLD}): ${near.length} pairs in the vault (${sameDir} in one folder, ${near.length - sameDir} across folders), ${near.filter((f) => f.fix).length} with a link fix`);
    console.log(`near-duplicates on pair labels: precision ${pct(s.tp, s.tp + s.fp)} (${s.tp} TP, ${s.fp} FP), recall ${pct(s.tp, s.tp + s.fn)} (${s.fn} missed), negatives left alone ${s.tn}/${s.tn + s.fp}`);
  }
}
