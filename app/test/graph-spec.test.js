// Every node kind, edge kind and provenance the graph store defines is documented in the memory graph spec, so a new
// kind cannot ship without the spec saying what it means.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EDGE_KINDS, NODE_KINDS, PROVENANCE } from '../graph/store.js';

const spec = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../docs/specs/memory-graph.md'), 'utf8');
const documented = (word) => spec.includes(`\`${word}\``);

describe('memory graph spec', () => {
  it('documents every node kind, edge kind and provenance in store.js', () => {
    expect(NODE_KINDS.filter((k) => !documented(k))).toEqual([]);
    expect(EDGE_KINDS.filter((k) => !documented(k))).toEqual([]);
    expect(PROVENANCE.filter((k) => !documented(k))).toEqual([]);
  });
});
