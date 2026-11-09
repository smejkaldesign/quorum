// transcript.js: Apple result fragments become speaker turns ordered by audio time, with the echo fallback and the
// prompt text built from the same turns.
import { describe, expect, it } from 'vitest';
import { addFinal, dropSeam, isEcho, joinText, toJSON, toText } from '../transcript.js';

const piece = (channel, text, start, end, at = 0) => ({ channel, text, start, end, at });
const build = (pieces, gap) => pieces.reduce((turns, p) => addFinal(turns, p, gap).turns, []);

describe('merging', () => {
  it('joins same-channel finals inside the gap into one turn and reports it as replaced', () => {
    const a = addFinal([], piece('me', 'and then', 0, 1, 100));
    expect(a.replace).toBe(false);
    expect(a.changed).toMatchObject({ id: 1, channel: 'me', text: 'And then', raw: 'and then', start: 0, end: 1, at: 100 });
    const b = addFinal(a.turns, piece('me', 'we ship Friday', 1.8, 3, 200));
    expect(b.replace).toBe(true);
    expect(b.turns).toHaveLength(1);
    expect(b.changed).toMatchObject({ id: 1, text: 'And then we ship Friday', raw: 'and then we ship Friday', start: 0, end: 3, at: 100 });
  });

  it('starts a new turn after a pause longer than the gap, and the gap setting moves that line', () => {
    expect(build([piece('me', 'one', 0, 1), piece('me', 'two', 2.6, 3)], 1.5)).toHaveLength(2);
    expect(build([piece('me', 'one', 0, 1), piece('me', 'two', 2.6, 3)], 3)).toHaveLength(1);
  });

  it('starts a new turn when the channel changes even without a pause', () => {
    const turns = build([piece('me', 'is it ready', 0, 1), piece('them', 'yes', 1.1, 1.5)]);
    expect(turns.map((t) => t.channel)).toEqual(['me', 'them']);
  });

  it('ignores empty text and leaves the list untouched', () => {
    const turns = build([piece('me', 'hi', 0, 1)]);
    expect(addFinal(turns, piece('them', '   ', 2, 3))).toEqual({ turns, changed: null, replace: false });
  });
});

describe('ordering across channels', () => {
  it('places a them final that arrives late before the me answer by audio time', () => {
    const turns = build([piece('me', 'Friday works for me', 5, 7, 2000), piece('them', 'does Friday work', 2, 4, 2100)]);
    expect(turns.map((t) => [t.channel, t.start])).toEqual([['them', 2], ['me', 5]]);
    expect(turns.map((t) => t.id)).toEqual([2, 1]);
  });

  it('joins a late piece to the front of the same-channel turn that follows it', () => {
    const r = addFinal(build([piece('them', 'work for you', 2.5, 4)]), piece('them', 'does Friday', 1, 2.2));
    expect(r.replace).toBe(true);
    expect(r.turns).toHaveLength(1);
    expect(r.changed).toMatchObject({ text: 'Does Friday work for you', raw: 'does Friday work for you', start: 1, end: 4 });
  });
});

describe('join rule', () => {
  it('attaches a piece that starts with punctuation without a space', () => {
    expect(joinText('we ship Friday', ', right')).toBe('we ship Friday, right');
    expect(joinText('okay', '. Next item')).toBe('okay. Next item');
    expect(joinText('okay', 'next item')).toBe('okay next item');
    expect(joinText('', '  hello ')).toBe('hello');
  });

  it('drops the words a re-emitted final repeats from the tail of the piece before it', () => {
    expect(dropSeam('so I think we should ship the beta on Friday', 'we should ship the beta on Friday, and then rest')).toBe('and then rest');
    expect(joinText('so I think we should ship the beta on Friday', 'we should ship the beta on Friday, and then rest')).toBe('so I think we should ship the beta on Friday and then rest');
    expect(joinText('we should ship the beta on Friday', 'we should ship the beta on Friday')).toBe('we should ship the beta on Friday');
  });

  it('keeps a repeat of fewer than five words, which can be real speech', () => {
    expect(dropSeam('I said ship on Friday', 'on Friday we rest')).toBe('on Friday we rest');
  });

  it('dedupes the seam in addFinal on the raw text before cleaning', () => {
    const turns = build([piece('me', 'um so we ship the beta on Friday', 0, 2), piece('me', 'ship the beta on Friday and then we rest', 2.5, 4)]);
    expect(turns).toHaveLength(1);
    expect(turns[0].raw).toBe('um so we ship the beta on Friday and then we rest');
    expect(turns[0].text).toBe('So we ship the beta on Friday and then we rest');
  });
});

describe('cleaning', () => {
  it('keeps the raw text on the turn and cleans the shown text', () => {
    const [t] = build([piece('me', 'um, we have twenty five people', 0, 2)]);
    expect(t.raw).toBe('um, we have twenty five people');
    expect(t.text).toBe('We have 25 people');
  });

  it('re-cleans the whole turn when a piece joins it', () => {
    const turns = build([piece('me', 'we have twenty', 0, 1), piece('me', 'five people', 1.2, 2)]);
    expect(turns[0]).toMatchObject({ raw: 'we have twenty five people', text: 'We have 25 people' });
  });

  it('clean: false keeps every word and only capitalizes', () => {
    const r = addFinal([], piece('me', 'um, we have twenty five people', 0, 2), 1.5, { clean: false });
    expect(r.changed.text).toBe('Um, we have twenty five people');
    expect(r.changed.raw).toBe('um, we have twenty five people');
  });

  it('joins onto a stored turn that has no raw field', () => {
    const r = addFinal([{ id: 1, channel: 'me', text: 'we have twenty', start: 0, end: 1, at: 0 }], piece('me', 'five people', 1.2, 2));
    expect(r.changed).toMatchObject({ raw: 'we have twenty five people', text: 'We have 25 people' });
  });
});

describe('echo fallback', () => {
  const them = build([piece('them', 'we should ship the beta on Friday', 10, 13)]);

  it('drops a me piece of four or more words that repeats a them turn still sounding', () => {
    expect(isEcho(them, piece('me', 'ship the beta on Friday', 11, 13.5))).toBe(true);
  });

  it('keeps short replies that reuse their words', () => {
    expect(isEcho(them, piece('me', 'yes, exactly', 13.2, 13.8))).toBe(false);
    expect(isEcho(them, piece('me', 'the Friday one', 13.2, 14))).toBe(false);
  });

  it('keeps a long me turn when fewer than nine in ten words match', () => {
    expect(isEcho(them, piece('me', 'ship the beta on Friday or Monday maybe', 11, 14))).toBe(false);
  });

  it('ignores them turns that ended more than two seconds before the me piece started', () => {
    expect(isEcho(them, piece('me', 'ship the beta on Friday', 15.5, 17))).toBe(false);
  });

  it('counts the them partial that has not finalised yet', () => {
    expect(isEcho([], piece('me', 'ship the beta on Friday', 11, 13), 'we should ship the beta on Friday')).toBe(true);
  });
});

describe('text and json', () => {
  const turns = build([piece('them', 'does Friday work', 2, 4, 50), piece('me', 'Friday works for me', 5, 7, 60), piece('me', ', yes', 7.5, 8, 70)]);

  it('writes one labelled line per turn', () => {
    expect(toText(turns, { me: 'Eric', them: 'Others' })).toBe('Others: Does Friday work\nEric: Friday works for me, yes');
  });

  it('serialises channel, cleaned text, raw text, audio times and wall clock without ids', () => {
    expect(toJSON(turns)).toEqual([
      { channel: 'them', text: 'Does Friday work', raw: 'does Friday work', start: 2, end: 4, at: 50 },
      { channel: 'me', text: 'Friday works for me, yes', raw: 'Friday works for me, yes', start: 5, end: 8, at: 60 },
    ]);
  });
});
