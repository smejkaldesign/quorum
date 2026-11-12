// Speaker.tsx: the similar-turn count behind the Apply to similar turns offer
import { describe, expect, it } from 'vitest';
import { similarCounts } from '../src/Speaker.tsx';

const turns = [
  { id: 1, channel: 'me', text: 'hi' },
  { id: 2, channel: 'them', text: 'hello', cluster: 'c1' },
  { id: 3, channel: 'them', text: 'yes', cluster: 'c1' },
  { id: 4, channel: 'them', text: 'no', cluster: 'c1', corrected: true },
  { id: 5, channel: 'them', text: 'maybe', cluster: 'c2' },
  { id: 6, channel: 'them', text: 'later' },
  { id: 7, channel: 'me', text: 'ok', cluster: 'c1' },
];

describe('similarCounts', () => {
  it('counts the other uncorrected them turns of the same cluster', () => {
    const similar = similarCounts(turns);
    // turns 2 and 3 share c1 with each other; the corrected turn 4 is never counted
    expect(similar(turns[1])).toBe(1);
    expect(similar(turns[2])).toBe(1);
    // a corrected turn still sees the two live ones in its cluster
    expect(similar(turns[3])).toBe(2);
    // alone in its cluster, no cluster, or a me turn: nothing to apply to
    expect(similar(turns[4])).toBe(0);
    expect(similar(turns[5])).toBe(0);
    expect(similar(turns[6])).toBe(2);
    expect(similar(turns[0])).toBe(0);
  });

  it('answers zero for every turn of an empty or unclustered transcript', () => {
    expect(similarCounts([])({ id: 9, channel: 'them', text: 'x', cluster: 'c1' })).toBe(0);
    const plain = [{ id: 1, channel: 'them', text: 'a' }, { id: 2, channel: 'them', text: 'b' }];
    const similar = similarCounts(plain);
    expect(plain.map(similar)).toEqual([0, 0]);
  });
});
