// Editing a vault note in Knowledge: the body cut out of the file and put back, rich text only for notes that write
// back byte for byte, and saves that keep every block that wasn't edited as written
import { describe, expect, it } from 'vitest';
import { editParts, withBody } from '../noteEdit.js';
import { planSave } from '../vaultEdit.js';
import { hashText } from '../handnote.js';
import { canSplice, splice, toDoc } from '../src/editor/markdown.ts';

const edit = (md, k, f) => { const d = toDoc(md); d.content[k] = f(d.content[k]); return d; };
const say = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });

describe('the body of a vault note', () => {
  const note = '---\ntitle: Plan\n---\n\n# Plan\n\nFirst line.\n\n- a\n- b\n';

  it('is the text after the frontmatter and the first heading, without the trailing line break', () => {
    const p = editParts(note);
    expect(p.body).toBe('First line.\n\n- a\n- b');
    expect(p.head + p.body + p.tail).toBe(note);
  });

  it('goes back with everything around it unchanged', () => {
    expect(withBody(note, 'Second line.')).toBe('---\ntitle: Plan\n---\n\n# Plan\n\nSecond line.\n');
    expect(withBody(note, editParts(note).body)).toBe(note);
  });

  it('keeps a heading that is not first in the body, the way the read view shows it', () => {
    expect(editParts('Intro\n\n# Later\n').body).toBe('Intro\n\n# Later');
  });

  it('starts a body under a note that had none', () => {
    expect(withBody('# Empty\n', 'Now text.')).toBe('# Empty\n\nNow text.\n');
    expect(withBody('---\na: 1\n---\n', 'Text.')).toBe('---\na: 1\n---\n\nText.\n');
  });

  it('removes the body and its blank lines when it is cleared', () => {
    expect(withBody('# T\n\nGone.\n', '')).toBe('# T\n');
  });

  it('edits a \\r\\n note with \\n and writes \\r\\n back', () => {
    const crlf = '# T\r\n\r\nOne\r\n\r\nTwo\r\n';
    const p = editParts(crlf);
    expect(p.body).toBe('One\n\nTwo');
    expect(p.mixed).toBe(false);
    expect(withBody(crlf, 'One\n\nThree')).toBe('# T\r\n\r\nOne\r\n\r\nThree\r\n');
  });

  it('flags a note that mixes line endings', () => {
    expect(editParts('a\r\nb\nc\n').mixed).toBe(true);
    expect(editParts('a\nb\n').mixed).toBe(false);
  });
});

describe('a save checks the file it was made from', () => {
  const note = '# T\n\nOld.\n';

  it('writes the new body when the file is as the editor read it', () => {
    expect(planSave(note, { hash: hashText(note), body: 'New.', withheld: false })).toEqual({ text: '# T\n\nNew.\n' });
  });

  it('is a conflict when the file changed on disk since it was read', () => {
    const changed = '# T\n\nChanged elsewhere.\n';
    expect(planSave(changed, { hash: hashText(note), body: 'New.', withheld: false })).toEqual({ conflict: true });
  });

  it('is refused for a note with withheld lines, so a redacted copy never replaces it', () => {
    expect(planSave(note, { hash: hashText(note), body: 'New.', withheld: true })).toHaveProperty('error');
  });

  it('is refused for a note that mixes line endings', () => {
    const mixed = '# T\r\n\nOld.\n';
    expect(planSave(mixed, { hash: hashText(mixed), body: 'New.', withheld: false })).toHaveProperty('error');
  });
});

describe('rich text opens only when lossless', () => {
  it('opens a note the editor writes back exactly', () => {
    expect(canSplice('# H\n\nText with [[Link]].\n\n- [ ] task')).toBe(true);
  });

  it.each([
    ['a * bullet the editor writes as -', '* one\n* two'],
    ['bold written with underscores', '__bold__'],
    ['raw HTML', 'a\n\n<div>x</div>\n\nb'],
    ['a link definition the editor drops', '[x]: https://example.com\n\ntext'],
    ['a table', '| a | b |\n| - | - |\n| 1 | 2 |'],
  ])('opens plain text for %s', (_, md) => {
    expect(canSplice(md)).toBe(false);
  });
});

describe('saving splices the edited blocks only', () => {
  const base = '## Notes\n\nFirst.\n\nSecond.\n\n- one\n- two\n\nLast.';

  it('writes an untouched document back as it was', () => {
    expect(splice(base, toDoc(base))).toBe(base);
  });

  it('changes only the block that was edited', () => {
    expect(splice(base, edit(base, 2, () => say('Second, edited.')))).toBe('## Notes\n\nFirst.\n\nSecond, edited.\n\n- one\n- two\n\nLast.');
  });

  it('adds and removes blocks around the ones that stay', () => {
    const d = toDoc(base);
    d.content.splice(1, 1);
    d.content.push(say('Added.'));
    expect(splice(base, d)).toBe('## Notes\n\nSecond.\n\n- one\n- two\n\nLast.\n\nAdded.');
  });

  it('keeps the original text of a block the editor would write differently', () => {
    // a heading set straight on top of its paragraph: the editor would put a blank line between them
    const tight = '# Top\nRight under it.\n\nOther.';
    const out = splice(tight, edit(tight, 2, () => say('Changed.')));
    expect(out).toBe('# Top\nRight under it.\n\nChanged.');
  });

  it('keeps extra blank lines between blocks that stay', () => {
    const spaced = 'One\n\n\n\nTwo';
    expect(canSplice(spaced)).toBe(true);
    expect(splice(spaced, edit(spaced, 2, () => say('Three')))).toBe('One\n\n\n\nThree');
  });

  it('edits the paragraph right above a checklist without doubling the blank line', () => {
    const md = 'Intro.\n\n- [ ] task\n- [x] done';
    expect(splice(md, edit(md, 0, () => say('Intro, edited.')))).toBe('Intro, edited.\n\n- [ ] task\n- [x] done');
  });

  it('leaves out empty paragraphs, which markdown cannot hold', () => {
    const d = toDoc(base);
    d.content.push({ type: 'paragraph' });
    expect(splice(base, d)).toBe(base);
  });
});
