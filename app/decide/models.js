// T1 of the decision layer: the two bundled ONNX models, run with onnxruntime-node in the process that imports this file
// (the memory engine's utility process). bge-small-en-v1.5 (int8) gives sentence vectors for similarity;
// nli-deberta-v3-xsmall (int8) gives contradiction, entailment and neutral probabilities for a pair of sentences.
// The files come from decide/models.json, fetched into models/ at package time (scripts/fetch-models.mjs). In a packaged
// app they sit in app.asar.unpacked, since the runtime reads them with its own file calls.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const MODELS_DIR = path.join(here, '..', 'models').replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
export const MANIFEST = JSON.parse(readFileSync(path.join(here, 'models.json'), 'utf8'));
// tokens per text; claims are one sentence, and a cap keeps one long quote from costing a long run
export const MAX_TOKENS = 128;
// search chunks (search/chunk.js) are embedded up to 384 tokens. bge-small reads 512, but onnxruntime crashed the
// process (SIGTRAP) after a few consecutive batches of 512-token sequences on a real vault; 384 ran every chunk
export const CHUNK_MAX_TOKENS = 384;
// the most padded tokens one embed run takes; a call splits into runs below this, so a batch of long chunks never
// reaches the sizes that crashed the runtime
export const MAX_RUN_TOKENS = 4096;

// groups encodings, in order, so each group's padded size (count times longest) stays at or under max
export function runGroups(encs, max = MAX_RUN_TOKENS) {
  const groups = [];
  let cur = [];
  let width = 0;
  for (const e of encs) {
    const w = Math.max(width, e.ids.length);
    if (cur.length && (cur.length + 1) * w > max) { groups.push(cur); cur = []; width = 0; }
    cur.push(e);
    width = Math.max(width, e.ids.length);
  }
  if (cur.length) groups.push(cur);
  return groups;
}
const ONNX = { embed: 'onnx/model_int8.onnx', nli: 'onnx/model_qint8_arm64.onnx' };

// the files a model needs, or the first one missing
export function missingFile(dir = MODELS_DIR) {
  for (const [id, m] of Object.entries(MANIFEST)) for (const f of Object.keys(m.files)) if (!existsSync(path.join(dir, id, f))) return `${id}/${f}`;
  return null;
}

export const hashFile = (file) => new Promise((resolve, reject) => { const h = createHash('sha256'); createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject); });
// files whose hash matched, by path, size and modified time, so a load after an idle unload does not read them again
const verified = new Map();
// throws unless every file matches the SHA-256 the manifest pins
export async function verifyFiles(dir = MODELS_DIR) {
  for (const [id, m] of Object.entries(MANIFEST)) for (const [f, { sha256 }] of Object.entries(m.files)) {
    const file = path.join(dir, id, f);
    const st = statSync(file);
    const stamp = `${st.size}:${st.mtimeMs}:${sha256}`;
    if (verified.get(file) === stamp) continue;
    if (!sha256 || (await hashFile(file)) !== sha256) throw new Error(`model file ${id}/${f} does not match its pinned SHA-256`);
    verified.set(file, stamp);
  }
}

const json = (dir, id, f) => JSON.parse(readFileSync(path.join(dir, id, f), 'utf8'));

// one batch of encodings as int64 tensors, padded to the longest
function batch(ort, encs, withTypes) {
  const width = Math.max(...encs.map((e) => e.ids.length));
  const n = encs.length;
  const ids = new BigInt64Array(n * width);
  const mask = new BigInt64Array(n * width);
  encs.forEach((e, i) => e.ids.forEach((id, j) => { ids[i * width + j] = BigInt(id); mask[i * width + j] = 1n; }));
  const feeds = { input_ids: new ort.Tensor('int64', ids, [n, width]), attention_mask: new ort.Tensor('int64', mask, [n, width]) };
  if (withTypes) feeds.token_type_ids = new ort.Tensor('int64', new BigInt64Array(n * width), [n, width]);
  return feeds;
}

// an encoding cut to max tokens that still ends with the closing special token
const capped = (e, max = MAX_TOKENS) => (e.ids.length <= max ? e : { ids: [...e.ids.slice(0, max - 1), e.ids[e.ids.length - 1]] });

// checks every file's SHA-256, then loads both models. Answers { embed(texts) -> Float32Array[], nli(pairs) -> [{ contradiction, entailment, neutral }] }.
// Throws when a file or the runtime is missing; the decider then reports T1 as missing and passes every item on
export async function loadModels({ dir = MODELS_DIR, threads = 2 } = {}) {
  const gone = missingFile(dir);
  if (gone) throw new Error(`model file missing: ${gone}`);
  await verifyFiles(dir);
  const require = createRequire(import.meta.url);
  const ort = require('onnxruntime-node');
  const { Tokenizer } = await import('@huggingface/tokenizers');
  // two threads each, so a sweep never takes every core from the person's other work. The NLI model loads without graph
  // optimization: constant folding expands its int8 embedding table (128k tokens) to float32, about 170 MB more memory.
  // No CPU arena and no memory patterns: each batch has its own shape, and the arena kept the largest one's buffers while
  // the patterns kept a plan per shape, so memory grew over a long embed pass. Buffers now go back after every run
  const opts = { intraOpNumThreads: threads, interOpNumThreads: 1, graphOptimizationLevel: 'all', enableCpuMemArena: false, enableMemPattern: false };
  const [embedS, nliS] = await Promise.all([ort.InferenceSession.create(path.join(dir, 'embed', ONNX.embed), opts), ort.InferenceSession.create(path.join(dir, 'nli', ONNX.nli), { ...opts, graphOptimizationLevel: 'disabled' })]);
  const embedT = new Tokenizer(json(dir, 'embed', 'tokenizer.json'), json(dir, 'embed', 'tokenizer_config.json'));
  const nliT = new Tokenizer(json(dir, 'nli', 'tokenizer.json'), json(dir, 'nli', 'tokenizer_config.json'));
  const labels = json(dir, 'nli', 'config.json').id2label;
  const order = [0, 1, 2].map((i) => labels[i]);
  return {
    // frees both sessions; the decider calls it after an idle period
    release: () => Promise.all([embedS.release(), nliS.release()]),
    // maxTokens: MAX_TOKENS for claims, up to CHUNK_MAX_TOKENS for search chunks
    async embed(texts, { maxTokens = MAX_TOKENS } = {}) {
      const max = Math.min(CHUNK_MAX_TOKENS, Math.max(8, maxTokens));
      const vecs = [];
      for (const group of runGroups(texts.map((t) => capped(embedT.encode(String(t)), max)))) {
        const feeds = batch(ort, group, true);
        const out = await embedS.run(feeds);
        const h = out.last_hidden_state;
        const [n, , dim] = h.dims;
        const width = h.dims[1];
        const data = h.data;
        // bge pools with the first token's state, then normalizes; only those rows are kept, the rest of the output goes
        for (let i = 0; i < n; i++) {
          const v = data.slice(i * width * dim, i * width * dim + dim);
          let norm = 0;
          for (let j = 0; j < dim; j++) norm += v[j] * v[j];
          norm = Math.sqrt(norm) || 1;
          for (let j = 0; j < dim; j++) v[j] /= norm;
          vecs.push(v);
        }
        for (const t of [...Object.values(out), ...Object.values(feeds)]) t.dispose?.();
      }
      return vecs;
    },
    async nli(pairs) {
      const encs = pairs.map(([a, b]) => { const e = nliT.encode(String(a), { text_pair: String(b) }); return e.ids.length <= MAX_TOKENS * 2 ? e : { ids: [...e.ids.slice(0, MAX_TOKENS * 2 - 1), e.ids[e.ids.length - 1]] }; });
      const out = await nliS.run(batch(ort, encs, false));
      const l = out.logits.data;
      return pairs.map((_, i) => {
        const row = [l[i * 3], l[i * 3 + 1], l[i * 3 + 2]];
        const m = Math.max(...row);
        const ex = row.map((x) => Math.exp(x - m));
        const sum = ex.reduce((s, x) => s + x, 0);
        return Object.fromEntries(order.map((k, j) => [k, ex[j] / sum]));
      });
    },
  };
}

export const cosine = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
