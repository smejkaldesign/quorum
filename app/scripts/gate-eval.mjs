#!/usr/bin/env node
// Runs the quality gate of Needs review (qualityGate.js) READ-ONLY over a vault and Quorum's data folder, and scores
// the items it would show against labels. It never writes: the index is built in memory, fix runs, undo records, saved
// versions and the decision log are read from the data folder, git is only read, and no model is called (drafting is
// off, as on a new install).
//
//   node scripts/gate-eval.mjs <vault> <labels.json> --data <app data dir> [--runs-labels runs.json] [--verbose]
//
// labels.json is the memory eval's labels (scripts/memory-eval.mjs). runs.json is a JSON array of { index, label } for
// the fix runs in <data>/fix-runs.json, label correct, debatable or wrong (scripts/fix-recheck-eval.mjs). A shown item
// is right when:
//   link     its fix matches the labeled fix (a leave or unlink label is matched only by an unlink)
//   finding  its rule and note match a positive label; a negative label makes it wrong
//   pastfix  the run it corrects is labeled wrong (strict), or wrong or debatable (lenient)
// Items with no label are counted but not scored. --verbose prints each labeled item's id, kind, bucket and verdict,
// never note names or text. Keep the labels and the output out of the repo.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const verbose = args.includes('--verbose');
if (verbose) args.splice(args.indexOf('--verbose'), 1);
const dataArg = flag('--data');
const runsLabelsArg = flag('--runs-labels');
const [vaultArg, labelsArg] = args;
if (!vaultArg || !labelsArg || !dataArg) { console.error('usage: node scripts/gate-eval.mjs <vault> <labels.json> --data <dir> [--runs-labels runs.json] [--verbose]'); process.exit(2); }
const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (f) => import(pathToFileURL(path.join(appDir, f)).href);
const { createVaultIndex } = await load('vindex.js');
const { issueOf } = await load('memoryHealth.js');
const { createElsewhere, withFound } = await load('linkElsewhere.js');
const { isGenerated } = await load('linkRules.js');
const { runRules } = await load('rules/index.js');
const { skipped } = await load('rules/common.js');
const { scanTags } = await load('memorySweep.js');
const { recheckAll, undoPlan, fixVersions } = await load('fixRecheck.js');
const { approvePastFix, approveFinding, gitReader } = await load('reviewApprove.js');
const { linkItem, findingItem, pastFixItem } = await load('reviewItems.js');
const { runGate, summarize, PRIORS, SHOW_AT } = await load('qualityGate.js');
const { sha } = await load('fixUndo.js');

const vaultDir = path.resolve(vaultArg);
const dataDir = path.resolve(dataArg);
const labels = JSON.parse(readFileSync(path.resolve(labelsArg), 'utf8'));
const runLabels = runsLabelsArg ? new Map(JSON.parse(readFileSync(path.resolve(runsLabelsArg), 'utf8')).map((l) => [l.index, l.label])) : new Map();
const json = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const settings = json(path.join(dataDir, 'settings.json'), {});
const read = (rel) => { try { return readFileSync(path.join(vaultDir, rel), 'utf8'); } catch { return null; } };
const hashNotes = (rels) => Object.fromEntries([...new Set(rels)].map((r) => { const t = read(r); return [r, t == null ? null : sha(t)]; }));

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
      disk.add(path.relative(vaultDir, path.join(dir, base)).split(path.sep).join('/').toLowerCase());
    }
  }
};
walk(vaultDir, 0);
const onDisk = (t) => { const k = String(t).toLowerCase().replace(/\.md$/, ''); return disk.has(k) || disk.has(k.split('/').pop()); };

const idx = createVaultIndex({ vault: vaultDir, isExcludedPath: () => false, isExcludedText: () => false, redact: (t) => t, onChange: () => {} });
const vault = { rels: () => idx.rels(), note: (rel) => idx.note(rel), backlinks: (rel) => idx.backlinks(rel), resolve: (t, from) => idx.resolve(t, from), read };
const finder = createElsewhere({ vault: vaultDir });
const left = new Set((json(path.join(dataDir, 'links-left.json'), {})[vaultDir] ?? []).map((k) => String(k).toLowerCase()));
const runs = json(path.join(dataDir, 'fix-runs.json'), []);
const mine = runs.filter((r) => r.vault === undefined || path.resolve(r.vault) === vaultDir);
const undoFile = (id) => path.join(dataDir, 'fix-undo', `${String(id).replace(/[^a-z0-9_-]/gi, '_').slice(0, 200)}.json`);
const undoFiles = (id) => json(undoFile(id), {}).files ?? null;
const vhome = path.join(dataDir, 'memory-versions', createHash('sha1').update(vaultDir).digest('hex').slice(0, 16));
const vfiles = json(path.join(vhome, 'index.json'), {}).files ?? {};
const readVersion = (_rel, id) => { try { return readFileSync(path.join(vhome, 'v', `${id}.md`), 'utf8'); } catch { return null; } };
const mtime = (rel) => { try { const st = statSync(path.join(vaultDir, rel)); return Math.max(st.mtimeMs, st.ctimeMs); } catch { return null; } };
const gitShow = gitReader(vaultDir);
const decisions = json(path.join(dataDir, 'finding-decisions', `${createHash('sha256').update(vaultDir).digest('hex').slice(0, 16)}.json`), { records: [] }).records ?? [];

// one pass: the index read again from disk, and every item built from it, as main.js reviewItems() builds them
function pass() {
  idx.sync();
  const rels = idx.rels().filter((r) => !isGenerated(r, idx.note(r)?.props));
  const issues = withFound(idx.linkHealth().filter((m) => !onDisk(m.target)), finder, rels).filter((m) => !left.has(m.target.toLowerCase())).map(issueOf);
  const items = issues.map((issue) => ({ ...linkItem(issue, { noteOf: (rel) => idx.note(rel) }), hashes: hashNotes([...issue.sources, ...(issue.candidate ? [issue.candidate.rel] : [])]), issue }));
  const { results } = recheckAll(mine, { vault, find: (n) => finder.find(n) });
  mine.forEach((run, index) => {
    const res = results[run.id];
    if (!res?.flagged || run.status !== 'success' || run.undoneAt) return;
    if (res.action === 'create' && (!res.main || read(res.main) == null)) return;
    const plan = undoPlan(run, { vault, undoFiles: undoFiles(run.id), versions: fixVersions(vfiles, run), readVersion, mtime });
    if (!plan.ok) plan.approve = approvePastFix(run, plan, { vault, gitShow, undoFiles: undoFiles(run.id)?.map((f) => f.rel) ?? null, drafting: false, reasons: res.reasons.map((r) => r.text) });
    const item = pastFixItem({ run, res, plan });
    items.push({ ...item, hashes: hashNotes(item.ops.flatMap((o) => (o.rel ? [o.rel] : o.sources ?? []))), runIndex: index });
  });
  const tags = scanTags(vaultDir);
  const folders = settings.confidentialFolders?.[vaultDir] ?? {};
  const { findings } = runRules({ notes: idx.snapshot(), resolve: (t, from) => idx.resolve(t, from), tags, folders });
  const all = idx.rels();
  for (const f of findings) {
    const approve = f.fix ? null : approveFinding(f, { rels: all, title: (rel) => idx.note(rel)?.title ?? null, skip: (rel) => skipped({ rel, note: idx.note(rel) }) });
    const item = findingItem({ ...f, ...(approve ? { approve } : {}) });
    items.push({ ...item, hashes: hashNotes(f.notes), f });
  }
  return items;
}

const t0 = Date.now();
const first = pass();
const second = pass();
const STUB = 'Quorum made this note because';
const gate = runGate([first, second], decisions, { isStub: (rel) => (read(rel) ?? '').includes(STUB) });
const ms = Date.now() - t0;

// labels
const stem = (x) => String(x ?? '').toLowerCase().replace(/\.md$/, '').replace(/\/$/, '').split('/').pop();
const targetOf = (label) => {
  const wiki = String(label.evidence ?? '').match(/\[\[([^\]|#]+)/);
  if (wiki) return wiki[1].trim();
  const file = String(label.evidence ?? '').match(/([\w./-]+)\.md\b/);
  return file ? file[1] : null;
};
const linkLabel = new Map();
for (const l of labels.filter((x) => String(x.category).startsWith('broken-link'))) {
  const t = targetOf(l);
  if (t) linkLabel.set(stem(t), l);
}
// whether a shown link fix is the labeled fix
function linkRight(label, item) {
  const want = String(label.correct_action ?? '').toLowerCase().trim();
  const o = item.ops?.[0] ?? {};
  const to = o.op === 'alias' ? o.rel : o.to;
  const named = want.match(/\bto\s+([\w./-]+)/)?.[1] ?? null;
  const pointsAt = (x) => !!to && stem(to) === stem(x);
  if (want.startsWith('relink')) return (o.op === 'relink' || o.op === 'alias') && (!named || pointsAt(named));
  if (want.startsWith('add alias')) return o.op === 'alias' && (!named || pointsAt(named));
  if (want.startsWith('leave') || want.startsWith('unlink')) return o.op === 'unlink';
  return false;
}
const CAT_RULES = {
  duplicate: ['note.duplicate', 'note.near-duplicate'], contradiction: ['note.near-duplicate'], stale: ['note.stale'], orphan: ['note.orphan'],
  frontmatter: ['note.frontmatter', 'note.confidential-folder'], confidential: ['note.confidential-folder', 'note.secret'],
};
const names = (notes, file) => notes.some((rel) => (file.endsWith('/') ? rel.startsWith(file) : rel === file));
function findingLabel(item) {
  return labels.find((l) => (CAT_RULES[l.category] ?? []).includes(item.ruleId) && (l.files ?? []).some((file) => names(item.f.notes, file))) ?? null;
}

const score = { show: { right: 0, wrong: 0, lenient: 0, unlabeled: 0 }, check: { right: 0, wrong: 0, lenient: 0, unlabeled: 0 }, quiet: { right: 0, wrong: 0, lenient: 0, unlabeled: 0 } };
const lines = [];
for (const item of first) {
  const v = gate.verdicts.get(item.id);
  let verdict = null;
  let id = null;
  if (item.kind === 'link') {
    const l = linkLabel.get(stem(item.target));
    if (l && item.ops?.length) { id = l.id; verdict = linkRight(l, item) ? 'right' : 'wrong'; }
  } else if (item.kind === 'finding') {
    const l = findingLabel(item);
    if (l) { id = l.id; verdict = l.negative === true || l.negative === 'True' ? 'wrong' : 'right'; }
  } else if (item.kind === 'pastfix' && runLabels.has(item.runIndex)) {
    const lab = runLabels.get(item.runIndex);
    id = `run ${item.runIndex}`;
    verdict = lab === 'wrong' ? 'right' : lab === 'debatable' ? 'debatable' : 'wrong';
  }
  const s = score[v.bucket];
  if (!verdict) { s.unlabeled++; continue; }
  if (verdict === 'right') { s.right++; s.lenient++; } else if (verdict === 'debatable') { s.wrong++; s.lenient++; } else s.wrong++;
  lines.push(`${id}\t${v.kind}\t${v.bucket}\t${verdict}\t${v.reasons.join(',')}`);
}

if (verbose) console.log(`${lines.sort().join('\n')}\n`);
const pct = (a, b) => (b ? `${Math.round((a / b) * 1000) / 10}%` : 'n/a');
console.log(`gate over ${first.length} review items, 2 passes, ${ms} ms`);
console.log(`shown ${gate.counts.show}, check these first ${gate.counts.check}, not shown ${gate.counts.quiet}`);
console.log('\nper kind (shown / check first / not shown, expected precision, prior):');
for (const [k, e] of Object.entries(summarize(gate.verdicts)).sort()) console.log(`  ${k}: ${e.show} / ${e.check} / ${e.quiet}, expected ${e.expected}, prior ${PRIORS[k]?.p ?? 'none'}${Object.keys(e.reasons).length ? `, held for ${Object.entries(e.reasons).map(([r, n]) => `${r} ${n}`).join(', ')}` : ''}`);
for (const b of ['show', 'check', 'quiet']) {
  const s = score[b];
  console.log(`\n${b}: labeled ${s.right + s.wrong}, right ${s.right}, wrong ${s.wrong}, precision ${pct(s.right, s.right + s.wrong)} strict, ${pct(s.lenient, s.right + s.wrong)} counting debatable past fixes as right; ${s.unlabeled} unlabeled`);
}
console.log(`\ntarget: precision of shown items at least ${SHOW_AT * 100}%`);
if (!existsSync(dataDir)) console.error('no data folder at', dataDir);
