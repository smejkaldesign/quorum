// clean.js: rule-based, deletion-only cleanup of a turn. Fillers, repeats and false starts go, casing and digits are
// written, and no word is ever replaced with a different one.
import { describe, expect, it } from 'vitest';
import { capitalize, cleanTurn, dropDisfluencies, writeNumbers } from '../clean.js';

describe('disfluencies', () => {
  it('deletes fillers at word boundaries and the comma that follows one', () => {
    expect(dropDisfluencies('um, so we should uh ship it')).toBe('so we should ship it');
    expect(dropDisfluencies('I think, um, that works. Erm, yes')).toBe('I think, that works. yes');
    expect(dropDisfluencies('and hmm.')).toBe('and.');
  });

  it('keeps a lone mm-hmm turn and words that contain a filler', () => {
    expect(dropDisfluencies('mm-hmm')).toBe('mm-hmm');
    expect(dropDisfluencies('Mm-hmm.')).toBe('Mm-hmm.');
    expect(dropDisfluencies('yeah mm-hmm right')).toBe('yeah right');
    expect(dropDisfluencies('uh-huh, the humble album')).toBe('uh-huh, the humble album');
  });

  it('deletes you know and I mean only when set off by commas or at a clause start', () => {
    expect(dropDisfluencies('I think, you know, it works. I mean, fine')).toBe('I think, it works. fine');
    expect(dropDisfluencies('you know the answer and I mean it')).toBe('you know the answer and I mean it');
  });

  it('deletes like only when doubled or before a comma, and never after a subject', () => {
    expect(dropDisfluencies('it was like, huge')).toBe('it was huge');
    expect(dropDisfluencies('it was like like huge')).toBe('it was like huge');
    expect(dropDisfluencies('I like it')).toBe('I like it');
    expect(dropDisfluencies('things I like, and things I do not')).toBe('things I like, and things I do not');
  });

  it('collapses immediate word repeats but leaves number words alone', () => {
    expect(dropDisfluencies('the the plan is I I I think fine')).toBe('the plan is I think fine');
    expect(dropDisfluencies("we we're done")).toBe("we're done");
    expect(dropDisfluencies('in twenty twenty six')).toBe('in twenty twenty six');
  });

  it('deletes a false start whose fragment the next words complete', () => {
    expect(dropDisfluencies('we sho- we should go')).toBe('we should go');
    expect(dropDisfluencies('sho- should we go')).toBe('should we go');
    expect(dropDisfluencies('I think we sho- we should go')).toBe('I think we should go');
    expect(dropDisfluencies('a well- a wall')).toBe('a well- a wall');
  });
});

describe('casing', () => {
  it('capitalizes the turn start and the first letter after a sentence end', () => {
    expect(capitalize('we ship friday. next item? yes! ok')).toBe('We ship friday. Next item? Yes! Ok');
  });

  it('lowercases nothing and leaves words with their own capitals alone', () => {
    expect(capitalize('iPhone and macOS work. macOS next')).toBe('iPhone and macOS work. macOS next');
    expect(capitalize('OK Friday')).toBe('OK Friday');
  });
});

describe('numbers', () => {
  it('writes number phrases of two or more words as digits', () => {
    expect(writeNumbers('twenty five and one hundred and three thousand and two point five')).toBe('25 and 100 and 3000 and 2.5');
    expect(writeNumbers('twenty-five and one hundred twenty three and two thousand twenty six')).toBe('25 and 123 and 2026');
  });

  it('keeps a single number word under ten unless a unit follows', () => {
    expect(writeNumbers('one more thing')).toBe('one more thing');
    expect(writeNumbers('zero and ten and three')).toBe('zero and 10 and three');
    expect(writeNumbers('one hour, two days, five people, three minutes')).toBe('1 hour, 2 days, 5 people, 3 minutes');
  });

  it('writes money, percent and k', () => {
    expect(writeNumbers('twenty five dollars, five bucks, ninety nine cents')).toBe('$25, $5, 99 cents');
    expect(writeNumbers('fifteen percent and 15 percent')).toBe('15% and 15%');
    expect(writeNumbers('two point five million dollars and twenty k and two million')).toBe('$2.5 million and 20k and 2 million');
  });

  it('writes times', () => {
    expect(writeNumbers('three pm, three thirty pm, 3 pm, ten fifteen am')).toBe('3 PM, 3:30 PM, 3 PM, 10:15 AM');
    expect(writeNumbers('half past two, quarter to five, quarter past twelve, quarter to one')).toBe('2:30, 4:45, 12:15, 12:45');
    expect(writeNumbers("at three p.m. sharp and at three p.m.")).toBe('at 3 PM sharp and at 3 PM.');
    expect(writeNumbers("four o'clock")).toBe("4 o'clock");
  });

  it('writes dates with the month capitalized and ordinals as plain digits', () => {
    expect(writeNumbers('march fifteenth and march fifteen and march twenty first')).toBe('March 15 and March 15 and March 21');
    expect(writeNumbers('march fifteenth twenty twenty six and march twenty twenty six')).toBe('March 15, 2026 and March 2026');
    expect(writeNumbers('you may first want to, by may fifth')).toBe('you may first want to, by May 5');
  });

  it('writes a spoken year only after in, by, for or a month', () => {
    expect(writeNumbers('in twenty twenty six and by nineteen ninety nine and for twenty twenty')).toBe('in 2026 and by 1999 and for 2020');
    expect(writeNumbers('twenty twenty six was fine')).toBe('twenty twenty six was fine');
  });

  it('leaves a run it cannot read as one number alone', () => {
    expect(writeNumbers('three thirty works')).toBe('three thirty works');
    expect(writeNumbers('one point I want')).toBe('one point I want');
    expect(writeNumbers('pick five three')).toBe('pick five three');
  });

  it('keeps punctuation and spacing where they were', () => {
    expect(writeNumbers('(twenty five), "fifteen percent".')).toBe('(25), "15%".');
    expect(writeNumbers('twenty, five')).toBe('20, five');
  });
});

describe('cleanTurn', () => {
  it('runs deletion, numbers and casing in order', () => {
    expect(cleanTurn('um, we we have twenty five people. so, uh, fifteen percent said yes')).toBe('We have 25 people. So, 15% said yes');
  });

  it('verbatim returns the input untouched except for casing', () => {
    expect(cleanTurn('um, we we have twenty five people. so what', { verbatim: true })).toBe('Um, we we have twenty five people. So what');
  });

  it('keeps a lone filler turn', () => {
    expect(cleanTurn('mm-hmm')).toBe('Mm-hmm');
  });

  it('keeps doubled words that are grammar', () => {
    expect(cleanTurn('I know that that is true', {})).toBe('I know that that is true');
    expect(cleanTurn('she had had enough', {})).toBe('She had had enough');
    expect(cleanTurn('the the plan', {})).toBe('The plan');
  });
});
