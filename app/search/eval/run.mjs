// The search eval: recall@5, recall@10 and MRR for keyword only, vector only, graph only and hybrid, plus the build
// and embed numbers. With no --vault it generates the test vault (make-vault.mjs) and its questions; with --vault it
// reads any vault and the question file given with --questions, which stays outside the repo when it names private
// content. A question file is JSON: [{ "q": "...", "expect": ["folder/note.md"], "type": "any label" }].
//
//   node search/eval/run.mjs [--notes 2500] [--tokens 1200] [--out <dir>] [--models <dir>] [--embedder bge|hash]
//   node search/eval/run.mjs --vault <path> --questions <file> [--out <dir>]
//   --weights '{"graph":1}' overrides hybrid.js WEIGHTS for a run; --fresh drops the cached index first
//
// recall@k counts the expected notes in the top k distinct notes, over min(expected, k); MRR is 1 over the rank of the
// first expected note in the top 20. The graph signal comes from the stand-in in miniGraph.js until app/graph lands.
// The index lives in --out (a temp folder by default), so a second run reuses its chunks and vectors.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { createVaultIndex } from '../../vindex.js';
import { openMemoryDb } from '../db.js';
import { createSearchIndex } from '../index.js';
import { WEIGHTS, createHybridSearch } from '../hybrid.js';
import { hashEmbedder, localEmbedder } from '../embed.js';
import { makeEvalVault } from './make-vault.mjs';
import { miniGraph } from './miniGraph.js';

const argv = process.argv.slice(2);
const opt = (k, d = null) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const notesN = Number(opt('notes', 2500));
const tokens = Number(opt('tokens', 1200));
const out = path.resolve(opt('out', path.join(tmpdir(), `quorum-search-eval-${notesN}-${tokens}`)));
const modelsDir = opt('models', path.join(homedir(), 'Library/Application Support/Quorum Dev/models'));
const kind = opt('embedder', 'bge');
mkdirSync(out, { recursive: true });

let vault = opt('vault');
let questions;
if (vault) {
  const qf = opt('questions');
  if (!qf) { console.error('--vault needs --questions <file>'); process.exit(1); }
  questions = JSON.parse(readFileSync(qf, 'utf8'));
} else {
  vault = path.join(out, 'vault');
  const qf = path.join(out, 'questions.json');
  if (!existsSync(qf)) { const t = Date.now(); const g = makeEvalVault(vault, { notes: notesN, tokens }); writeFileSync(qf, JSON.stringify(g.questions)); console.log(`generated ${g.notes} notes in ${Date.now() - t} ms`); }
  questions = JSON.parse(readFileSync(qf, 'utf8'));
}

const ms = (t) => Math.round(performance.now() - t);
let t = performance.now();
const vindex = createVaultIndex({ vault, isExcludedPath: () => false, isExcludedText: () => false, redact: (x) => x, onChange: () => {} });
vindex.sync();
const snap = vindex.snapshot();
const tokensTotal = snap.reduce((s, n) => s + Math.ceil(n.text.length / 4), 0);
console.log(`vault index: ${snap.length} notes, about ${(tokensTotal / 1e6).toFixed(2)}M tokens, ${ms(t)} ms`);

const embedder = kind === 'hash' ? hashEmbedder() : await localEmbedder({ dir: modelsDir, threads: 2 });
const dbFile = path.join(out, `memory-${embedder.id}.db`);
if (argv.includes('--fresh')) for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) rmSync(f, { force: true });
const { db } = openMemoryDb({ file: dbFile });
const index = createSearchIndex({ db, embedder: null });
t = performance.now();
const changed = await index.build(snap);
const ftsMs = ms(t);
console.log(`chunks and FTS: ${changed} notes written, ${index.status().chunks} chunks, ${ftsMs} ms`);

const withVec = createSearchIndex({ db, embedder });
t = performance.now();
const before = withVec.status().embedded;
await withVec.drain();
const embedMs = ms(t);
const st = withVec.status();
const embedded = st.embedded - before;
if (embedded) console.log(`embeddings: ${embedded} chunks in ${(embedMs / 1000).toFixed(1)} s, ${(embedded / (embedMs / 1000)).toFixed(1)} chunks/s`);
else console.log(`embeddings: all ${st.embedded} chunks already in the index`);
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
const size = statSync(dbFile).size;
const vecBytes = db.prepare('SELECT SUM(LENGTH(vec)) AS b FROM vectors').get().b ?? 0;
console.log(`database: ${(size / 1e6).toFixed(1)} MB, ${(size / 1e6 / (snap.length / 1000)).toFixed(1)} MB per 1,000 notes (vectors ${(vecBytes / 1e6).toFixed(1)} MB)`);

// an edit to one note, the way a save reaches the index
const one = snap.find((n) => n.rel.startsWith('projects/')) ?? snap[0];
const edited = { ...one, text: `${one.text}\nA line added in the eval.\n` };
t = performance.now();
await withVec.update([edited]);
const incMs = ms(t);
await withVec.update([one]);
await withVec.drain();
console.log(`incremental update of one note: ${incMs} ms`);

const graph = miniGraph(snap, (target, from) => vindex.resolve(target, from));
const weights = { ...WEIGHTS, ...JSON.parse(opt('weights', '{}')) };
const hybrid = createHybridSearch({ db, embedder, graph: () => graph, version: withVec.version, weights });
// the single-signal baselines rank by their signal alone: no recency, kind hint or supersession factor
const raw = createHybridSearch({ db, embedder, graph: () => graph, version: withVec.version, weights: { ...weights, recency: 0, kindHint: 1, superseded: 1 } });
const MODES = { keyword: ['fts'], vector: ['vec'], graph: ['graph'], hybrid: ['fts', 'vec', 'graph'] };
const rows = [];
const lat = [];
for (const [mode, signals] of Object.entries(MODES)) {
  const by = new Map();
  for (const qn of questions) {
    const s = performance.now();
    const r = await (mode === 'hybrid' ? hybrid : raw).search({ q: qn.q, budget: 1e9, k: 60, signals });
    if (mode === 'hybrid') lat.push(performance.now() - s);
    const rels = [...new Set(r.results.map((x) => x.rel))];
    const exp = new Set(qn.expect);
    const at = (k) => rels.slice(0, k).filter((x) => exp.has(x)).length / Math.min(exp.size, k);
    const first = rels.slice(0, 20).findIndex((x) => exp.has(x));
    for (const key of [qn.type ?? 'all', 'all']) {
      const b = by.get(key) ?? by.set(key, { n: 0, r5: 0, r10: 0, mrr: 0 }).get(key);
      b.n++; b.r5 += at(5); b.r10 += at(10); b.mrr += first >= 0 ? 1 / (first + 1) : 0;
    }
  }
  for (const [type, b] of by) rows.push({ mode, type, n: b.n, 'recall@5': +(b.r5 / b.n).toFixed(3), 'recall@10': +(b.r10 / b.n).toFixed(3), mrr: +(b.mrr / b.n).toFixed(3) });
}
rows.sort((a, b) => a.type.localeCompare(b.type) || Object.keys(MODES).indexOf(a.mode) - Object.keys(MODES).indexOf(b.mode));
console.table(rows);
lat.sort((a, b) => a - b);
console.log(`hybrid search latency: median ${lat[Math.floor(lat.length / 2)].toFixed(1)} ms, p95 ${lat[Math.floor(lat.length * 0.95)].toFixed(1)} ms`);
writeFileSync(path.join(out, 'results.json'), JSON.stringify({ notes: snap.length, tokens: tokensTotal, chunks: st.chunks, ftsMs, embedMs, embedded, dbBytes: size, incMs, rows }, null, 2));
await embedder.release?.();
db.close();
