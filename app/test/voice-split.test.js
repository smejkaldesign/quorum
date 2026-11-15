import { describe, expect, it } from 'vitest';
import { MIX, SOUND, addSound, addVoices, pickTone, spansOf, splitPiece, voiceAt } from '../voices.js';

const w = (t, s, e, c = 0.95) => ({ t: ` ${t}`, s, e, c });
// the three-voice test clip: voice 1 from 13.6 to 17.7, voice 0 from 16.0, both talking from 16.0 to 17.7
const spans = [{ voice: 0, start: 9.4, end: 13.2 }, { voice: 1, start: 13.6, end: 17.7 }, { voice: 0, start: 16.0, end: 20.0 }];

describe('voiceAt', () => {
  it('picks the voice covering the word', () => {
    expect(voiceAt(spans, 14.0, 14.4)).toBe(1);
    expect(voiceAt(spans, 18.0, 18.5)).toBe(0);
  });
  it('reads two voices at once as mixed', () => expect(voiceAt(spans, 16.5, 17.0)).toBe(MIX));
  it('is null where nobody is speaking', () => expect(voiceAt(spans, 30, 31)).toBeNull());
  it('counts repeated spans of one voice once', () => {
    const dup = [{ voice: 0, start: 0, end: 1 }, { voice: 0, start: 0, end: 1 }, { voice: 1, start: 0.8, end: 2 }];
    expect(voiceAt(dup, 0, 1)).toBe(0);
  });
});

describe('splitPiece', () => {
  const piece = { channel: 'me', text: 'x', start: 13.1, end: 18.5, isFinal: true,
    words: [w('Then', 13.6, 13.9), w('someone', 13.9, 14.1), w('has', 14.1, 14.4), w('to', 14.4, 14.5), w('Wait,', 16.2, 16.4), w('wait,', 16.4, 16.6), w('I', 18.0, 18.1), w('can', 18.1, 18.3)] };
  it('splits a final where the voice changes and marks the overlap', () => {
    const out = splitPiece(piece, spans);
    expect(out.map((p) => [p.voice, p.text])).toEqual([[1, 'Then someone has to'], [MIX, 'Wait, wait,'], [0, 'I can']]);
    expect(out[0].start).toBe(13.6);
    expect(out[2].end).toBe(18.3);
    expect(out.every((p) => !('words' in p))).toBe(true);
  });
  it('passes a final through whole without spans or word times', () => {
    expect(splitPiece({ ...piece, words: undefined }, spans)).toEqual([{ channel: 'me', text: 'x', start: 13.1, end: 18.5, isFinal: true }]);
    expect(splitPiece(piece, []).length).toBe(1);
  });
  it('gives an uncovered word the voice before it', () => {
    const out = splitPiece({ ...piece, words: [w('Then', 13.6, 13.9), w('gap', 13.3, 13.5)] }, spans);
    expect(out).toHaveLength(1);
    expect(out[0].voice).toBe(1);
  });
  it('marks a piece unclear when most words are low confidence', () => {
    const quiet = { ...piece, words: [w('I', 21.6, 21.8, 0.4), w('can', 21.8, 22, 0.38), w('help', 22, 22.3, 0.7)] };
    expect(splitPiece(quiet, [{ voice: 2, start: 21.5, end: 24.6 }])[0]).toMatchObject({ voice: 2, unclear: true, text: 'I can help' });
  });
});

describe('addVoices', () => {
  it('keeps finalized spans and replaces tentative ones', () => {
    let s = addVoices(null, [{ voice: 0, start: 0, end: 1, final: true }, { voice: 1, start: 1, end: 1.5, final: false }]);
    s = addVoices(s, [{ voice: 1, start: 1, end: 2, final: true }, { voice: 0, start: 2, end: 2.4, final: false }]);
    expect(spansOf(s).map((p) => [p.voice, p.start, p.end])).toEqual([[0, 0, 1], [1, 1, 2], [0, 2, 2.4]]);
  });
});

describe('addSound', () => {
  it('joins nearby hits of one sound and keeps audio order', () => {
    let turns = [{ id: 1, channel: 'me', voice: 0, text: 'hi', start: 0, end: 1, at: 1 }, { id: 2, channel: 'me', voice: 1, text: 'later', start: 9, end: 10, at: 2 }];
    ({ turns } = addSound(turns, { channel: 'me', label: 'Laughing', start: 3, end: 4.5, at: 3 }));
    const r = addSound(turns, { channel: 'me', label: 'Laughing', start: 5, end: 6 });
    expect(r.replace).toBe(true);
    expect(r.turns.map((t) => [t.voice, t.text, t.start, t.end])).toEqual([[0, 'hi', 0, 1], [SOUND, 'Laughing', 3, 6], [1, 'later', 9, 10]]);
  });
});

describe('pickTone', () => {
  it('takes the likeliest tone above the bar', () => {
    expect(pickTone({ debating: { probability: 0.8 }, joking: { probability: 0.3 } })).toBe('debating');
    expect(pickTone({ debating: { probability: 0.4 } })).toBeNull();
    expect(pickTone(null)).toBeNull();
  });
});
