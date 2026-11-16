import { describe, expect, it } from 'vitest';
import { parseNote } from '../linkparse.js';
import { findingItem } from '../reviewItems.js';
import { THRESHOLD, dropMirrors, jaccard, relatedLine, run, shingleOf, shingles, similarPairs } from '../rules/nearDuplicates.js';

// Synthetic notes; every word is made up. A seeded generator keeps the text the same on every run
let seed = 11;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const VOCAB = Array.from({ length: 2000 }, (_, i) => `zq${i.toString(36)}`);
const para = (n) => Array.from({ length: n }, () => VOCAB[Math.floor(rnd() * VOCAB.length)]).join(' ');
const edit = (text, rate) => text.split(' ').map((w) => (rnd() < rate ? VOCAB[Math.floor(rnd() * VOCAB.length)] : w)).join(' ');
const note = (rel, text) => ({ rel, text, note: parseNote(rel, text), mtime: 0, size: text.length, inbound: 1, outbound: 1 });

describe('near-duplicates', () => {
  it('finds an edited copy and leaves unrelated notes alone', () => {
    const body = para(220);
    const notes = [note('topics/orbit.md', `# Orbit\n\n${body}\n`), note('drafts/orbit-copy.md', `# Orbit copy\n\n${edit(body, 0.02)}\n`), ...Array.from({ length: 8 }, (_, i) => note(`topics/other${i}.md`, `# Other ${i}\n\n${para(220)}\n`))];
    const found = run({ notes });
    expect(found).toHaveLength(1);
    expect(found[0].ruleId).toBe('note.near-duplicate');
    expect(found[0].notes).toEqual(['drafts/orbit-copy.md', 'topics/orbit.md']);
    expect(found[0].fix).toEqual({ kind: 'link', to: 'topics/orbit.md' });
  });

  it('leaves equal bodies to the duplicates rule, and short notes out', () => {
    const body = para(200);
    expect(run({ notes: [note('a/one.md', body), note('b/two.md', body)] })).toEqual([]);
    expect(run({ notes: [note('a/one.md', 'zq1 zq2 zq3 zq4 zq5 zq6'), note('b/two.md', 'zq1 zq2 zq3 zq4 zq5 zq7')] })).toEqual([]);
  });

  it('strips frontmatter, repeated headings and template lines before it compares', () => {
    const tmpl = '## Attendees\n\n## Agenda\n\nwrite the agenda for the meeting here\n\n## Decisions\n\nwrite the decisions here\n';
    const notes = Array.from({ length: 4 }, (_, i) => note(`meetings/m${i}.md`, `---\ntype: meeting\nowner: zqowner\n---\n# M${i}\n\n${tmpl}\n${para(70)}\n`));
    expect(run({ notes })).toEqual([]);
    const lines = ['## attendees', 'shared words one two three four'];
    expect(shingles(lines, new Map([['## attendees', 2]])).has(shingleOf('shared words one'))).toBe(true);
    expect(shingles(lines, new Map([['## attendees', 2]])).has(shingleOf('attendees shared words'))).toBe(false);
    expect(shingles(lines).has(shingleOf('attendees shared words'))).toBe(true);
  });

  it('skips two dated notes (a daily log) and a mirror of five or more pairs between two folders', () => {
    const body = para(200);
    expect(run({ notes: [note('logs/2026-11-01.md', body), note('logs/2026-11-02.md', edit(body, 0.02))] })).toEqual([]);
    const pairs = Array.from({ length: 5 }, (_, i) => ({ a: `seed/n${i}.md`, b: `staging/n${i}.md`, sim: 0.9 }));
    expect(dropMirrors(pairs)).toEqual([]);
    expect(dropMirrors(pairs.slice(0, 4))).toHaveLength(4);
  });

  it('offers no link fix when the notes already link each other', () => {
    const body = para(220);
    const notes = [note('a/alpha.md', `${body}\n\n[[beta]]`), note('a/beta.md', edit(body, 0.02))];
    const [f] = run({ notes });
    expect(f.fix).toBeUndefined();
    expect(findingItem(f).hold).toMatch(/no automatic fix/);
  });

  it('turns its fix into a link op, and the Related line links by path', () => {
    const body = para(220);
    const [f] = run({ notes: [note('x/one.md', body), note('y/two.md', edit(body, 0.02))] });
    expect(findingItem(f).ops).toEqual([{ op: 'link', rel: 'x/one.md', to: 'y/two.md' }]);
    expect(relatedLine('y/two.md')).toBe('Related: [[y/two]]');
  });

  it('measures similarity as Jaccard of the shingle sets', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['b', 'c']))).toBeCloseTo(1 / 3);
    expect(jaccard(new Set(), new Set(['a']))).toBe(0);
    const body = para(220);
    const [p] = similarPairs([note('a.md', body), note('b.md', edit(body, 0.05))], { min: 0.2 });
    expect(p.sim).toBeGreaterThanOrEqual(THRESHOLD);
    expect(p.sim).toBeLessThan(1);
  });
});
