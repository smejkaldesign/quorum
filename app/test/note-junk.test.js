import { describe, expect, it } from 'vitest';
import { junkOf, plainText, wordOf } from '../noteJunk.js';

// [title, body]
const JUNK = [
  ['kjhkjhkjh', 'twesrtykjhlkij'],
  ['asdf', ''],
  ['', 'asdfasdf'],
  ['qwerty', ''],
  ['jkl', ''],
  ['test', ''],
  ['New note', 'test test'],
  ['', 'aaaaaa'],
  ['sdfghjkl', ''],
  ['fjfjfjfj', ''],
  ['', 'xcvbnm'],
  ['hjkhjk hjkhjk', ''],
  ['asdkjh qwe', ''],
  ['', 'lkjlkj ;lkj'],
  ['dfgdfg', 'sdfsdf'],
  ['', ''],
  ['Untitled', '# \n\n- '],
];

const REAL = [
  ['call Ana re pricing', ''],
  ['', 'TODO: send deck'],
  ['Ship the new onboarding flow before Friday.', ''],
  ['', 'https://example.com/roadmap'],
  ['', 'example.com'],
  ['Team', 'Ana, Jiří, Bob, Kateřina'],
  ["Réunion avec l'équipe demain", ''],
  ['Reunión con el cliente el martes', ''],
  ['Morgen Besprechung über die Donaudampfschifffahrt', ''],
  ['Встреча с клиентом в пятницу', ''],
  ['会議のメモ', ''],
  ['1:1 with Sam', ''],
  ['Q4 OKRs', ''],
  ['', 'pls review PR'],
  ['Rhythm and strengths', ''],
  ['Pricing', ''],
  ['Groceries', '- eggs\n- milk\n- bread'],
  ['', '- [ ] send invoice\n- [x] call bank'],
  ['Spotkanie z zespołem w środę', ''],
  ['hello Ana', ''],
  ['lunch w/ Dana', ''],
  ['Property tax', 'pay by the 30th'],
];

describe('junkOf', () => {
  it.each(JUNK)('flags %j / %j', (title, body) => {
    const j = junkOf({ title, body });
    expect(j).not.toBeNull();
    expect(j.reason).toMatch(/^It has no recording/);
    expect(j.reason).not.toMatch(/\n/);
  });

  it.each(REAL)('keeps %j / %j', (title, body) => {
    expect(junkOf({ title, body })).toBeNull();
  });

  it('flags the note that started this: a mashed title and body with nothing recorded', () => {
    expect(junkOf({ title: 'kjhkjhkjh', body: 'twesrtykjhlkij' }).reason).toBe('It has no recording, and “kjhkjhkjh twesrtykjhlkij” does not read as words.');
  });

  it('never flags a note with a recording or a transcript, whatever its text', () => {
    expect(junkOf({ title: 'kjhkjhkjh', body: '', hasRecording: true })).toBeNull();
    expect(junkOf({ title: '', body: '', hasTranscript: true })).toBeNull();
  });

  it('names a placeholder and an empty note in their own words', () => {
    expect(junkOf({ title: 'test', body: '' }).reason).toBe('It has no recording and only says “test”.');
    expect(junkOf({ title: '', body: '---\ntitle: x\n---\n' }).reason).toBe('It has no recording and no text.');
  });

  it('shortens a long reason to one short quote', () => {
    const r = junkOf({ title: 'kjh'.repeat(40), body: '' }).reason;
    expect(r.length).toBeLessThan(120);
    expect(r).toContain('…');
  });
});

describe('wordOf', () => {
  it('reads keyboard runs, repeats, long consonant runs and vowel-less words as junk', () => {
    for (const w of ['asdf', 'lkjh', 'qwert', 'zxcv', 'kjhkjhkjh', 'aaaa', 'kjhlk', 'bcdfg']) expect(wordOf(w)).toBe('junk');
  });
  it('reads real words, acronyms, numbers, other scripts and links as real', () => {
    for (const w of ['property', 'strewn', 'murmur', 'haha', 'CRM', 'HTML', '2026', 'Jiří', 'пятницу']) expect(wordOf(w)).toBe('real');
    expect(wordOf('https://quorum.example/x')).toBe('url');
    expect(wordOf('ana@example.com')).toBe('url');
  });
  it('leaves short vowel-less words and single letters unsure', () => {
    expect(wordOf('pls')).toBe('unsure');
    expect(wordOf('w')).toBe('unsure');
  });
});

describe('plainText', () => {
  it('drops frontmatter and markdown syntax and keeps link text and targets', () => {
    expect(plainText('---\ntitle: a\n---\n# Head\n\n- [ ] **do** it\n> quote [docs](https://x.io/a)')).toBe('Head do it quote docs https://x.io/a');
  });
});
