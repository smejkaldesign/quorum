// The Knowledge editor never changes bytes the person didn't edit: every note in the corpus saves back exactly when
// untouched, through the editor's schema as a live editor holds it, and an edit to one block keeps every other block
// as written
import { describe, expect, it } from 'vitest';
import { getSchema } from '@tiptap/core';
import { editParts, withBody } from '../noteEdit.js';
import { noteExtensions } from '../src/editor/extensions.ts';
import { canSplice, markdownManager, splice, toDoc } from '../src/editor/markdown.ts';
import { CORPUS } from './note-corpus.js';

const say = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
// the doc with the paragraph that reads from replaced by one that reads to
const swap = (doc, from, to) => { const k = doc.content.findIndex((n) => n.content?.[0]?.text === from); expect(k).toBeGreaterThanOrEqual(0); doc.content[k] = say(to); return doc; };
const schema = getSchema(noteExtensions());
// what a Tiptap editor's getJSON() gives after the schema has normalized the parsed document
const live = (doc) => schema.nodeFromJSON(doc).toJSON();
// each top-level block as written in the text
const written = (md) => markdownManager().instance.lexer(md).filter((t) => t.type !== 'space').map((t) => t.raw.replace(/^\n+|\n+$/g, ''));
const rich = Object.entries(CORPUS).filter(([, raw]) => { const p = editParts(raw); return !p.mixed && canSplice(p.body); });

describe('the lossless corpus', () => {
  it('has rich, plain and read-only notes in it', () => {
    expect(rich.length).toBeGreaterThan(20);
    expect(Object.values(CORPUS).some((raw) => editParts(raw).mixed)).toBe(true);
    expect(Object.values(CORPUS).some((raw) => { const p = editParts(raw); return !p.mixed && !canSplice(p.body); })).toBe(true);
  });

  it.each(Object.entries(CORPUS))('%s saves back exactly when untouched', (_, raw) => {
    const p = editParts(raw);
    expect(p.head + p.body + p.tail).toBe(p.eol === '\r\n' ? raw.replace(/\r\n/g, '\n') : raw);
    if (p.mixed) return;
    expect(withBody(raw, p.body)).toBe(raw);
    if (canSplice(p.body)) expect(withBody(raw, splice(p.body, live(toDoc(p.body))))).toBe(raw);
  });

  const tries = {
    'a paragraph added at the end': (d) => { d.content.push(say('ADDED')); return written; },
    'a paragraph added at the start': (d) => { d.content.unshift(say('ADDED')); return written; },
    'the first block deleted': (d) => { d.content.shift(); return (b) => written(b).slice(1); },
    'the last block deleted': (d) => { d.content.pop(); return (b) => written(b).slice(0, -1); },
    'the first block edited': (d) => { d.content[0] = say('EDITED'); return (b) => written(b).slice(1); },
    'the last block edited': (d) => { d.content[d.content.length - 1] = say('EDITED'); return (b) => written(b).slice(0, -1); },
  };
  for (const [name, change] of Object.entries(tries)) {
    it.each(rich)(`%s keeps its other blocks as written with ${name}`, (_, raw) => {
      const body = editParts(raw).body;
      const doc = live(toDoc(body));
      if (!doc.content?.length && !name.startsWith('a paragraph')) return;
      const d = structuredClone(doc);
      d.content ??= [];
      const kept = change(d)(body);
      const out = splice(body, live(d));
      for (const block of kept) expect(out).toContain(block);
    });
  }
});

describe('cases the review found', () => {
  it('keeps the indentation of an indented code block that starts the body', () => {
    const raw = '# T\n\n    code first\n\nAfter.\n';
    const p = editParts(raw);
    expect(p.head).toBe('# T\n\n');
    expect(p.body).toBe('    code first\n\nAfter.');
    expect(withBody(raw, `NEW\n\n${p.body}`)).toBe('# T\n\nNEW\n\n    code first\n\nAfter.\n');
    expect(withBody(raw, 'After.')).toBe('# T\n\nAfter.\n');
  });

  it('keeps indentation on the first line after frontmatter and blank lines with spaces in them', () => {
    expect(editParts('---\na: 1\n---\n \n\t\n  two spaces\n').body).toBe('  two spaces');
  });

  it('keeps the run of blank lines after an edited block', () => {
    const body = 'One\n\n\n\nTwo';
    expect(canSplice(body)).toBe(true);
    expect(splice(body, live(swap(toDoc(body), 'One', 'One X')))).toBe('One X\n\n\n\nTwo');
    expect(splice(body, live(swap(toDoc(body), 'Two', 'Two X')))).toBe('One\n\n\n\nTwo X');
  });

  it('keeps the gaps around a block edited in the middle', () => {
    const body = 'A\n\n\nB\n\n\n\nC';
    expect(splice(body, live(swap(toDoc(body), 'B', 'B edited')))).toBe('A\n\n\nB edited\n\n\n\nC');
  });
});

describe('a byte order mark', () => {
  it('stays first, ahead of the heading and the frontmatter', () => {
    expect(editParts('﻿# T\n\nText.\n')).toMatchObject({ head: '﻿# T\n\n', body: 'Text.' });
    expect(editParts('﻿---\na: 1\n---\n\nText.\n')).toMatchObject({ fm: '---\na: 1\n---\n', body: 'Text.' });
    expect(withBody('﻿# T\n\nText.\n', 'More.')).toBe('﻿# T\n\nMore.\n');
  });

  it('stays first in a note that had nothing else', () => {
    expect(withBody('﻿', 'Now text.')).toBe('﻿Now text.');
    expect(withBody('﻿', '')).toBe('﻿');
  });
});
