// What an update changed, as the Memory tab's After view draws it (src/noteDiff.ts).
import { describe, expect, it } from 'vitest';
import { alike, noteDiff, tokens, wordDiff } from '../src/noteDiff.ts';
import { mdLine } from '../src/mdLine.ts';

const shown = (d) => d.rows.filter((r) => r.segs).map((r) => r.segs.map((s) => (s.kind === 'add' ? `+[${s.text}]` : s.kind === 'del' ? `-[${s.text}]` : s.text)).join(''));
const after = (segs) => segs.filter((s) => s.kind !== 'del').map((s) => s.text).join('');
const before = (segs) => segs.filter((s) => s.kind !== 'add').map((s) => s.text).join('');

describe('wordDiff', () => {
  it('shows the old words, then the new ones', () => {
    expect(wordDiff('The launch is on Friday', 'The launch is on Monday')).toEqual([
      { kind: 'same', text: 'The launch is on ' }, { kind: 'del', text: 'Friday' }, { kind: 'add', text: 'Monday' },
    ]);
  });
  it('joins changed words that only a space separates', () => {
    expect(wordDiff('ship the old plan today', 'ship the new idea today')).toEqual([
      { kind: 'same', text: 'ship the ' }, { kind: 'del', text: 'old plan' }, { kind: 'add', text: 'new idea' }, { kind: 'same', text: ' today' },
    ]);
  });
  it('gives a pure addition no removed text and a pure deletion no added text', () => {
    expect(wordDiff('one three', 'one two three').map((s) => s.kind)).not.toContain('del');
    expect(wordDiff('one two three', 'one three').map((s) => s.kind)).not.toContain('add');
  });
  it('never splits bold, code, a link or a wiki link', () => {
    expect(tokens('**a b** `c d` [e f](https://x.test/g) [[H I|j k]]').filter((t) => t.trim())).toEqual(['**a b**', '`c d`', '[e f](https://x.test/g)', '[[H I|j k]]']);
    expect(wordDiff('see [[Old Note]] now', 'see [[New Note]] now')).toEqual([
      { kind: 'same', text: 'see ' }, { kind: 'del', text: '[[Old Note]]' }, { kind: 'add', text: '[[New Note]]' }, { kind: 'same', text: ' now' },
    ]);
  });
  it('holds the whole new text in order, and the words of the old one', () => {
    const bits = ['alpha', 'beta', ' ', 'gamma', '**x y**', ', ', '[[N]]', 'é', '  ', 'one two', '.', '-'];
    let seed = 7;
    const next = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const line = () => Array.from({ length: next(9) }, () => bits[next(bits.length)]).join('');
    for (let k = 0; k < 400; k++) {
      const a = line(), b = line();
      const segs = wordDiff(a, b);
      expect(after(segs)).toBe(b);
      expect(before(segs).replace(/\s+/g, '')).toBe(a.replace(/\s+/g, ''));
    }
  });
});

describe('noteDiff', () => {
  it('draws an edited line as one row, with the unchanged lines around it', () => {
    const d = noteDiff('# T\n- call Ada on Friday\nend', '# T\n- call Ada on Monday\nend');
    expect(d.rows).toHaveLength(3);
    expect(shown(d)).toEqual(['call Ada on -[Friday]+[Monday]']);
    expect(d.hunks).toEqual([[1]]);
  });
  it('draws a removed line struck and an added line highlighted', () => {
    expect(shown(noteDiff('a\nthis line goes\nb', 'a\nb'))).toEqual(['-[this line goes]']);
    expect(shown(noteDiff('a\nb', 'a\n- new here\nb'))).toEqual(['+[new here]']);
  });
  it('puts the old line before the new one when they read nothing alike', () => {
    expect(shown(noteDiff('the budget is approved', 'Ada joins in May'))).toEqual(['-[the budget is approved]', '+[Ada joins in May]']);
  });
  it('does not match lines of different kinds', () => {
    expect(shown(noteDiff('## Plan for May', '### Plan for May'))).toEqual(['-[Plan for May]', '+[Plan for May]']);
  });
  it('steps through pure deletions too, and joins changes across blank lines only', () => {
    expect(noteDiff('a\ngone\nb\nc', 'a\nb\nnew\n\nmore\nc').hunks).toEqual([[1], [3, 5]]);
  });
  it('shows nothing for spaces at the end of a line or blank lines', () => {
    expect(noteDiff('a\nb', 'a  \n\n\nb').hunks).toEqual([]);
  });
  it('shows a ticked checkbox', () => {
    expect(shown(noteDiff('- [ ] send the deck to Ada', '- [x] send the deck to Ada'))).toEqual(['-[☐]+[☑] send the deck to Ada']);
  });
  it('shows nothing for a change in the spaces inside a line', () => {
    expect(noteDiff('one  two three', 'one two three').hunks).toEqual([]);
  });
  it('stays quick on a large rewrite, and keeps the whole new text', () => {
    const w = 'the plan for Ada and Grace moves to May when pricing closes with'.split(' ');
    // every bullet differs and shares its words in another order, so the quick check by words never rules a pair out
    const bullet = (n, step) => `- ${Array.from({ length: 200 }, (_, k) => w[((k + n) * step) % w.length]).join(' ')} ${n}x${step}`;
    const part = (step) => Array.from({ length: 6 }, (_, p) => [`## P${p}`, ...Array.from({ length: 50 }, (_, k) => bullet(p * 50 + k, step))].join('\n')).join('\n');
    const a = part(1), b = part(5);
    const t = performance.now();
    const d = noteDiff(a, b);
    expect(performance.now() - t).toBeLessThan(800);
    expect(d.rows.filter((r) => !r.segs || r.segs.some((x) => x.kind !== 'del')).map((r) => r.line).join('\n')).toBe(b);
  });
  it('marks every line of a new note', () => {
    expect(shown(noteDiff('', 'one\n\ntwo'))).toEqual(['+[one]', '+[two]']);
  });
  it('keeps every line of the new text, in order', () => {
    const a = 'h\na1 one two three\nb\n\nc\nd four five six\ne', b = 'h\nb\na1 one two four\n\nd four five seven\nx\ne\nf';
    const rows = noteDiff(a, b).rows.filter((r) => !r.segs || r.segs.some((s) => s.kind !== 'del'));
    expect(rows.map((r) => r.line).filter((l) => l.trim())).toEqual(b.split('\n').filter((l) => l.trim()));
  });
});

describe('alike and mdLine', () => {
  it('scores the shared words of two lines', () => {
    expect(alike(['a', 'b'], ['a', 'b'])).toBe(1);
    expect(alike(['abcd'], ['wxyz'])).toBe(0);
    expect(alike(['a', 'b'], ['b', 'a'])).toBe(0.5);
  });
  it('reads a line the way Markdown shows it', () => {
    expect(mdLine('  - [x] done')).toEqual({ kind: 'bullet', level: 1, text: '☑ done' });
    expect(mdLine('### Head')).toEqual({ kind: 'heading', level: 3, text: 'Head' });
    expect(mdLine('##### deep')).toEqual({ kind: 'text', level: 0, text: 'deep' });
  });
});
