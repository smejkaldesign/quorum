import { describe, expect, it } from 'vitest';
import { createDecider } from '../decide/index.js';
import { CHUNK_MAX_TOKENS, MAX_TOKENS } from '../decide/models.js';
import { createMemoryEngine } from '../memoryEngine.js';
import { engineEmbedder } from '../search/embed.js';

describe('search embeddings through the decider', () => {
  it('passes the chunk cap to the model, and refuses while the model is missing', async () => {
    const asked = [];
    const d = createDecider({ load: async () => ({ embed: async (texts, o) => { asked.push(o?.maxTokens); return texts.map(() => Float32Array.of(1, 0)); }, nli: async () => [], release: async () => {} }) });
    expect(await d.embed(['a', 'b'], { maxTokens: CHUNK_MAX_TOKENS })).toHaveLength(2);
    expect(asked).toEqual([CHUNK_MAX_TOKENS]);
    const gone = createDecider({ load: async () => { throw new Error('model file missing: embed/onnx/model_int8.onnx'); } });
    await expect(gone.embed(['a'])).rejects.toThrow('The local embedding model is missing');
    expect(MAX_TOKENS).toBe(128);
  });

  it('turns the host answer into normalized float vectors', async () => {
    const e = engineEmbedder(async (texts, max) => texts.map(() => [0.6, 0.8, max === CHUNK_MAX_TOKENS ? 0 : 1]));
    const [v] = await e.embed(['x']);
    expect(v).toBeInstanceOf(Float32Array);
    expect(Array.from(v)).toEqual([Float32Array.of(0.6)[0], Float32Array.of(0.8)[0], 0]);
    expect(e).toMatchObject({ id: 'bge-small-en-v1.5-int8', dim: 384 });
  });

  it('the memory engine embed call fails in plain words while the model is missing', async () => {
    const engine = createMemoryEngine({ dataDir: '/nonexistent-quorum-test' });
    await expect(engine.handle('embed', { texts: ['a'], maxTokens: 512 })).rejects.toThrow(/embedding model/);
  });
});
