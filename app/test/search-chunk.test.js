import { describe, expect, it } from 'vitest';
import { MAX_CHUNK_TOKENS, chunkNote, embedText, tokensOf } from '../search/chunk.js';

describe('chunkNote', () => {
  it('scopes chunks by heading, with the path from the title and 0-based lines', () => {
    const text = '---\ntype: project\npeople: [x]\n---\n# Heron\n\nIntro line.\n\n## Goal\n\nShip it.\n\n### Risks\n\nDelay.\n\n## Status\n\nGreen.\n';
    const c = chunkNote({ text, title: 'Heron' });
    expect(c.map((x) => x.heading)).toEqual(['Heron', 'Heron > Goal', 'Heron > Goal > Risks', 'Heron > Status']);
    expect(c.map((x) => x.text)).toEqual(['Intro line.', 'Ship it.', 'Delay.', 'Green.']);
    const lines = text.split('\n');
    for (const x of c) expect(lines[x.start_line]).toBe(x.text);
    expect(c.some((x) => x.text.includes('type: project'))).toBe(false);
  });

  it('reads a # inside a code fence as text', () => {
    const c = chunkNote({ text: '# T\n\n```sh\n# not a heading\n```\n', title: 'T' });
    expect(c).toHaveLength(1);
    expect(c[0].text).toContain('# not a heading');
  });

  it('splits a long section into windows under the cap that overlap', () => {
    const body = Array.from({ length: 200 }, (_, i) => `Line number ${i} says something about the plan.`).join('\n');
    const c = chunkNote({ text: `# Log\n\n## Day\n\n${body}\n`, title: 'Log' });
    expect(c.length).toBeGreaterThan(3);
    for (const x of c) expect(x.tokens).toBeLessThanOrEqual(MAX_CHUNK_TOKENS);
    for (let i = 1; i < c.length; i++) {
      expect(c[i].start_line).toBeLessThanOrEqual(c[i - 1].end_line);
      expect(c[i].start_line).toBeGreaterThan(c[i - 1].start_line);
    }
    expect(c.at(-1).text).toContain('Line number 199');
  });

  it('cuts one line longer than a chunk at spaces', () => {
    const long = 'word '.repeat(2000).trim();
    const c = chunkNote({ text: long, title: 'One line' });
    expect(c.length).toBeGreaterThan(4);
    for (const x of c) expect(x.tokens).toBeLessThanOrEqual(MAX_CHUNK_TOKENS);
    expect(c.map((x) => x.text).join(' ').split(' ').length).toBeGreaterThanOrEqual(2000);
  });

  it('gives a note with no body one chunk for its title, and none for an untitled empty note', () => {
    expect(chunkNote({ text: '---\na: 1\n---\n', title: 'Empty' })).toMatchObject([{ heading: 'Empty', text: '' }]);
    expect(chunkNote({ text: '', title: '' })).toEqual([]);
  });

  it('keeps the hash of an unchanged section when another section changes', () => {
    const a = chunkNote({ text: '# N\n\n## A\n\nsame\n\n## B\n\nold\n', title: 'N' });
    const b = chunkNote({ text: '# N\n\n## A\n\nsame\n\n## B\n\nnew\n', title: 'N' });
    expect(b[0].hash).toBe(a[0].hash);
    expect(b[1].hash).not.toBe(a[1].hash);
  });

  it('puts the heading path in front of the text the embedder reads', () => {
    const [c] = chunkNote({ text: '# N\n\n## A\n\nbody\n', title: 'N' });
    expect(embedText(c)).toBe('N > A\nbody');
    expect(tokensOf('abcdefgh')).toBe(2);
  });
});
