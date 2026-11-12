// Speaker.tsx: the one-pass similar-turn count answers the same as the per-turn filter the review page used
import { describe, expect, it } from 'vitest';
import { similarCount, similarCounts } from '../src/Speaker.tsx';

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
    expect(similar(turns[1])).toBe(1);
    expect(similar(turns[2])).toBe(1);
    expect(similar(turns[3])).toBe(2);
    expect(similar(turns[4])).toBe(0);
    expect(similar(turns[5])).toBe(0);
    expect(similar(turns[6])).toBe(2);
  });

  it('matches the per-turn filter for every turn', () => {
    const similar = similarCounts(turns);
    for (const t of turns) expect(similar(t)).toBe(similarCount(turns, t));
  });
});
