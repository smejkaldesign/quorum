// The note editor's markdown: what opens as rich text, round trips, wiki links, frontmatter rows, and the block a
// Record append replaces
import { describe, expect, it } from 'vitest';
import { firstChangedBlock, isLossless, roundTrip, toDoc, toMarkdown } from '../src/editor/markdown.ts';
import { linkName, parseProps, shownValue, storedValue, writeProps } from '../src/editor/frontmatter.ts';
import { newNoteText, rewriteNote, splitNote, validFrontmatter } from '../handnote.js';

const exact = [
  '# Title\n\nA paragraph with **bold**, *italic*, ~~strike~~ and `code`.',
  '## Section\n\n- one\n- two\n  - nested',
  '1. first\n2. second',
  '- [ ] open task\n- [x] done task',
  '> a quote',
  '```js\nconst a = 1;\n```',
  '[a link](https://example.com)',
  '---',
  'Line one\nline two',
  '**You:** Call the bank\n\n**Speaker 1:** Sure, Tuesday works',
];

describe('markdown round trip', () => {
  it.each(exact)('writes %j back unchanged', (md) => {
    expect(roundTrip(md)).toBe(md);
    expect(isLossless(md)).toBe(true);
  });

  it('keeps wiki links character for character, with aliases and headings', () => {
    const md = 'See [[Pricing review]], [[people/Ada Lovelace|Ada]] and [[Note#Heading]] today.\n\n- [ ] ask [[Sam]]';
    expect(roundTrip(md)).toBe(md);
    const link = toDoc('[[a/b|c]]').content[0].content[0];
    expect(link).toMatchObject({ type: 'wikiLink', attrs: { target: 'a/b', alias: 'c' } });
  });

  it('opens a note whose markdown would be rewritten as plain text', () => {
    expect(isLossless('* star bullet')).toBe(false);
    expect(isLossless('_under italic_')).toBe(false);
  });

  it('round trips a whole saved note body, frontmatter kept outside the editor', () => {
    const raw = newNoteText({ id: 'x', title: 'Standup', body: '## Notes\n\n- [x] shipped [[Release 0.3]]\n\n**You:** next steps', date: '2026-11-13', owner: 'Ada' });
    const { fm, body } = splitNote(raw);
    expect(fm.startsWith('---\nquorum_id: x\n')).toBe(true);
    expect(roundTrip(body)).toBe(body);
  });

  it('serializes an empty document as an empty note', () => {
    expect(toMarkdown(toDoc(''))).toBe('');
  });
});

describe('the block a Record append replaces', () => {
  it('is the end of the doc when text is only added', () => {
    const blocks = ['# A', 'para'];
    expect(firstChangedBlock(blocks, '# A\n\npara', '# A\n\npara\n\n**You:** hi')).toEqual({ index: 2, offset: 11 });
  });
  it('is the last block when that paragraph grew', () => {
    const blocks = ['# A', '**You:** hi'];
    expect(firstChangedBlock(blocks, '# A\n\n**You:** hi', '# A\n\n**You:** hi there')).toEqual({ index: 1, offset: 5 });
  });
  it('is the first block when everything changed', () => {
    expect(firstChangedBlock(['x'], 'x', 'y')).toEqual({ index: 0, offset: 0 });
  });
});

describe('properties', () => {
  const fm = '---\nquorum_id: 2026-x\ntype: note\ntitle: "Standup"\nparticipants:\n  - Ada (recorder)\n  - Sam\nsource: quorum\n---\n';

  it('splits frontmatter into rows and writes the same bytes back', () => {
    const rows = parseProps(fm);
    expect(rows?.map((r) => r.key)).toEqual(['quorum_id', 'type', 'title', 'participants', 'source']);
    expect(rows?.[3].value).toBe('\n  - Ada (recorder)\n  - Sam');
    expect(writeProps(rows ?? [])).toBe(fm);
  });

  it('edits one row and leaves the rest alone', () => {
    const rows = parseProps(fm) ?? [];
    rows[1] = { key: 'type', value: storedValue('meeting') };
    expect(writeProps(rows)).toBe(fm.replace('type: note', 'type: meeting'));
    expect(shownValue(' note')).toBe('note');
    expect(storedValue('')).toBe('');
  });

  it('removes the frontmatter when every row is cleared, and gives up on what it cannot split', () => {
    expect(writeProps([])).toBe('');
    expect(parseProps('')).toEqual([]);
    expect(parseProps('---\n# a comment\nkey: v\n---\n')).toBeNull();
    expect(parseProps('not frontmatter')).toBeNull();
  });
});

describe('the name a [[link]] writes', () => {
  const all = ['people/Ada Lovelace.md', 'projects/Pricing.md', 'archive/Pricing.md', 'Sam.md'];
  it('is the note name when it is unique, and a longer path when it is not', () => {
    expect(linkName('people/Ada Lovelace.md', all)).toBe('Ada Lovelace');
    expect(linkName('projects/Pricing.md', all)).toBe('projects/Pricing');
    expect(linkName('Sam.md', all)).toBe('Sam');
  });
});

describe('saving properties', () => {
  it('accepts one frontmatter block or none, and nothing else', () => {
    expect(validFrontmatter('')).toBe(true);
    expect(validFrontmatter('---\ntype: note\n---\n')).toBe(true);
    expect(validFrontmatter('type: note')).toBe(false);
    expect(validFrontmatter('---\na: 1\n---\n---\nb: 2\n---\n')).toBe(false);
    expect(validFrontmatter(null)).toBe(false);
  });

  it('puts new properties in front of the body and keeps the title line in step', () => {
    const raw = '---\ntitle: "Old"\ntype: note\n---\n\n# Old\n\nbody\n';
    const fm = writeProps([{ key: 'title', value: ' "Old"' }, { key: 'type', value: ' meeting' }, { key: 'tags', value: '\n  - pricing' }]);
    const next = rewriteNote(`${fm}${raw.slice(splitNote(raw).fm.length)}`, { title: 'New', body: 'body' });
    expect(next).toBe('---\ntitle: "New"\ntype: meeting\ntags:\n  - pricing\n---\n\n# New\n\nbody\n');
  });
});
