// Embedders for search: { id, dim, maxTokens, embed(texts) -> Float32Array[] }, every vector normalized. The default
// is the bundled bge-small-en-v1.5 int8 in the memory engine's utility process (decide/models.js), called through
// memoryHost.embed, so no model runs in main. Another local model or a hosted provider fits the same shape later;
// nothing hosted ships here.
import { CHUNK_MAX_TOKENS } from '../decide/models.js';

export const BGE_SMALL = { id: 'bge-small-en-v1.5-int8', dim: 384 };
// bge v1.5 reads a short query better with its retrieval instruction; chunks go in as they are
export const BGE_QUERY = 'Represent this sentence for searching relevant passages: ';

const toVec = (v) => (v instanceof Float32Array ? v : Float32Array.from(v));

// call(texts, maxTokens) -> number[][]: the memory host's embed
export function engineEmbedder(call, { maxTokens = CHUNK_MAX_TOKENS } = {}) {
  return { ...BGE_SMALL, maxTokens, query: BGE_QUERY, embed: async (texts) => (await call(texts, maxTokens)).map(toVec) };
}

// the same model loaded in this process (the eval harness and scripts, never main)
export async function localEmbedder({ dir, threads = 2, maxTokens = CHUNK_MAX_TOKENS } = {}) {
  const { loadModels } = await import('../decide/models.js');
  const m = await loadModels({ dir, threads });
  return { ...BGE_SMALL, maxTokens, query: BGE_QUERY, embed: async (texts) => (await m.embed(texts, { maxTokens })).map(toVec), release: () => m.release() };
}

// a model-free embedder for tests: hashed word counts, normalized. Words shared means vectors close
export function hashEmbedder({ dim = 64, id = 'hash-test' } = {}) {
  const slot = (w) => { let h = 2166136261; for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w.charCodeAt(i), 16777619); return (h >>> 0) % dim; };
  return {
    id, dim, maxTokens: CHUNK_MAX_TOKENS, query: '',
    embed: async (texts) => texts.map((t) => {
      const v = new Float32Array(dim);
      for (const w of String(t).toLowerCase().match(/[a-z0-9]+/g) ?? []) v[slot(w)] += 1;
      const n = Math.hypot(...v) || 1;
      return v.map((x) => x / n);
    }),
  };
}
