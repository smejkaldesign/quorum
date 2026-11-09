// eval harness: the normalizer rules, WER by edit distance, entity error rate, cpWER speaker mapping and the
// summary faithfulness stub, each against hand-computed expectations.
import { describe, expect, it } from 'vitest';
import { normalize, words } from '../eval/normalize.mjs';
import { check, keyFacts } from '../eval/summary-check.mjs';
import { aggregate, cpWER, editOps, entityErrorRate, wer } from '../eval/wer.mjs';

const turn = (speaker, text) => ({ speaker, text });

describe('normalize', () => {
  it('lowercases and strips punctuation but keeps apostrophes inside words', () => {
    expect(normalize("Let's ship it, Friday!")).toBe("let's ship it friday");
    expect(normalize("'quoted' word")).toBe('quoted word');
  });
  it('maps percent and currency to one spelling', () => {
    expect(normalize('up 8% from $42,000')).toBe('up 8 percent from 42000 dollars');
    expect(normalize('up eight percent from forty two thousand dollars')).toBe('up 8 percent from 42000 dollars');
    expect(normalize('a $3 million deal')).toBe('a 3 million dollars deal');
  });
  it('collapses ordinals, spelled numbers and clock times', () => {
    expect(normalize('March 14th at 10:30')).toBe('march 14 at 1030');
    expect(normalize('march fourteenth at 10.30')).toBe('march 14 at 1030');
    expect(normalize('the third of twenty five')).toBe('the 3 of 25');
    expect(normalize('at 14:05 UTC')).toBe(normalize('at 1405 UTC'));
  });
  it('keeps decimal points and drops the dots in a.m. and p.m.', () => {
    expect(normalize('version 4.7 by 5 p.m.')).toBe('version 4.7 by 5 pm');
  });
  it('removes fillers only when asked', () => {
    expect(normalize('um so, uh, yes')).toBe('um so uh yes');
    expect(normalize('um so, uh, yes', { fillers: true })).toBe('so yes');
    expect(words('Hmm. Fine', { fillers: true })).toEqual(['fine']);
  });
});

describe('editOps and wer', () => {
  it('counts substitutions, deletions and insertions separately', () => {
    // ref: a b c d ; hyp: a x c d e  -> 1 sub (b->x), 1 ins (e)
    expect(editOps(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd', 'e'])).toEqual({ sub: 1, del: 0, ins: 1, errors: 2, refWords: 4 });
    // ref: a b c ; hyp: a c -> 1 del
    expect(editOps(['a', 'b', 'c'], ['a', 'c'])).toMatchObject({ sub: 0, del: 1, ins: 0, errors: 1 });
    expect(editOps([], ['a', 'b'])).toMatchObject({ ins: 2, errors: 2, refWords: 0 });
  });
  it('scores turn lists after normalization: 10 reference words, 2 errors', () => {
    const ref = [turn('me', 'The renewal is $42,000 for 12 months.'), turn('them', 'Up 8% from last year.')];
    const hyp = [turn('me', 'the renewal is $42,000 for twelve months'), turn('them', 'of 8 percent from last')];
    // ref words: the renewal is 42000 dollars for 12 months up 8 percent from last year = 14
    // errors: up->of (sub), year missing (del)
    expect(wer(ref, hyp)).toMatchObject({ sub: 1, del: 1, ins: 0, refWords: 14 });
    expect(wer(ref, hyp).wer).toBeCloseTo(2 / 14, 6);
  });
});

describe('entityErrorRate', () => {
  it('reports the fraction of entities missing as a word sequence', () => {
    const hyp = [turn('me', 'Confirm with Annalise Voked by Thursday about the Fieldmap add on at 10.30')];
    const r = entityErrorRate(['Anneliese Vogt', 'Fieldmap', '10:30', 'Thursday'], hyp);
    expect(r.missing).toEqual(['Anneliese Vogt']);
    expect(r.eer).toBeCloseTo(1 / 4, 6);
  });
  it('is zero with no entities', () => {
    expect(entityErrorRate([], [turn('me', 'x')])).toEqual({ missing: [], total: 0, eer: 0 });
  });
});

describe('cpWER', () => {
  const ref = [turn('me', 'does friday work'), turn('them', 'friday works for me'), turn('me', 'great')];
  it('is zero when channels match the reference speakers', () => {
    const hyp = [{ channel: 'me', text: 'does friday work' }, { channel: 'them', text: 'friday works for me' }, { channel: 'me', text: 'great' }];
    expect(cpWER(ref, hyp)).toMatchObject({ errors: 0, cpwer: 0, refWords: 8, mapping: { me: 'me', them: 'them' } });
  });
  it('maps swapped labels back through the best permutation', () => {
    const hyp = [{ channel: 'A', text: 'does friday work' }, { channel: 'B', text: 'friday works for me' }, { channel: 'A', text: 'great' }];
    expect(cpWER(ref, hyp)).toMatchObject({ errors: 0, mapping: { A: 'me', B: 'them' } });
  });
  it('charges words put on the wrong speaker: "great" on them costs one deletion and one insertion', () => {
    const hyp = [{ channel: 'me', text: 'does friday work' }, { channel: 'them', text: 'friday works for me great' }];
    expect(cpWER(ref, hyp)).toMatchObject({ errors: 2, refWords: 8 });
    expect(cpWER(ref, hyp).cpwer).toBeCloseTo(2 / 8, 6);
  });
  it('counts every word of an unmatched hypothesis speaker as an error', () => {
    const hyp = [{ channel: 'me', text: 'does friday work great' }, { channel: 'them', text: 'friday works for me' }, { channel: 'x', text: 'noise noise' }];
    // me and them match their references; the extra speaker x has no reference, so its 2 words are insertions
    expect(cpWER(ref, hyp)).toMatchObject({ errors: 2 });
  });
});

describe('aggregate', () => {
  it('sums errors and words before dividing', () => {
    const items = [
      { refWords: 10, errors: 1, entities: 2, entitiesMissing: 1, cpErrors: 1 },
      { refWords: 30, errors: 9, entities: 2, entitiesMissing: 0, cpErrors: 3 },
    ];
    expect(aggregate(items)).toEqual({ items: 2, wer: 0.25, eer: 0.25, cpwer: 0.1 });
  });
});

describe('summary-check', () => {
  const turns = [
    { id: 1, text: 'The renewal is $42,000 for 12 months, up 8% from last year.' },
    { id: 2, text: 'Can you confirm with Anneliese Vogt by Thursday?' },
  ];
  it('extracts numbers and capitalized names past the first word', () => {
    expect(keyFacts('Renewal priced at $42,000, up 8%, confirm with Anneliese Vogt')).toEqual({ numbers: ['42000', '8'], names: ['anneliese', 'vogt'] });
  });
  it('scores linked and grounded fractions', () => {
    const note = { sections: [{ bullets: [
      { text: 'Renewal is $42,000 for 12 months', refs: [1] },
      { text: 'Anneliese Vogt confirms by Thursday', refs: [2] },
      { text: 'Discount of 20% agreed', refs: [1] },
      { text: 'Unreferenced claim', refs: [9] },
    ] }] };
    const r = check(note, turns);
    expect(r.bullets).toBe(4);
    expect(r.linked).toBeCloseTo(3 / 4, 6);
    expect(r.grounded).toBeCloseTo(2 / 4, 6);
    expect(r.problems).toEqual([
      { text: 'Discount of 20% agreed', missingRefs: [], unsupported: ['20'] },
      { text: 'Unreferenced claim', missingRefs: [9], unsupported: [] },
    ]);
  });
  it('handles an empty note', () => {
    expect(check({ sections: [] }, turns)).toEqual({ bullets: 0, linked: 0, grounded: 0, problems: [] });
  });
});
