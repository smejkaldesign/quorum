import { describe, expect, it } from 'vitest';
import { categoryCounts, categoryOf, countsLine, fileIssues, footerFacts, issueOf, topFolder } from '../memoryHealth.js';

const link = (target, sources, candidates = [], extra = {}) => ({ target, sources, count: sources.length, candidates, ...extra });
const exact = { rel: 'people/ada.md', title: 'Ada Lovelace', name: 'Ada', exact: true };
const near = { rel: 'projects/quorum-app.md', title: 'Quorum app', name: null, exact: false };

describe('memory health categories', () => {
  it('sorts each missing link into one category', () => {
    expect(categoryOf(link('Nowhere', ['a.md']))).toBe('missing');
    expect(categoryOf(link('ada', ['a.md'], [exact]))).toBe('alias');
    expect(categoryOf(link('quorum', ['a.md'], [near]))).toBe('similar');
    expect(categoryOf(link('../outside', ['a.md'], [exact]))).toBe('outside');
    expect(categoryOf(link('x/.claude/agents/rick', ['a.md']))).toBe('outside');
  });
  it('counts the categories in a fixed order without empty ones, with links left as is apart', () => {
    const items = [link('A', ['a.md']), link('B', ['b.md']), link('ada', ['c.md'], [exact]), link('Kept', ['d.md'])];
    const counts = categoryCounts(items, new Set(['kept']));
    expect(counts).toEqual([
      { id: 'missing', label: 'Missing notes', count: 2 },
      { id: 'alias', label: 'Likely matches', count: 1 },
      { id: 'left', label: 'Left as is', count: 1 },
    ]);
    expect(countsLine(counts)).toBe('Missing notes 2 · Likely matches 1 · Left as is 1');
    expect(categoryCounts([])).toEqual([]);
  });
});

describe('memory health issue cards', () => {
  it('writes a plain title and the suggested fix for each category', () => {
    const many = Array.from({ length: 16 }, (_, i) => `notes/n${i}.md`);
    expect(issueOf(link('Roadmap', many))).toMatchObject({
      title: '16 notes link to “Roadmap”, a note that does not exist',
      fix: 'Write a note named “Roadmap”, so the links have a note to open.', action: 'create', path: 'notes/n0.md',
    });
    expect(issueOf(link('ada', ['a.md'], [exact]))).toMatchObject({ title: 'One note links to “ada”, which is almost certainly “Ada”', action: 'alias' });
    expect(issueOf(link('ada', ['a.md'], [exact])).fix).toBe('Add “ada” as an alias of “Ada”. Every link then opens that note, and no note text changes.');
    expect(issueOf(link('quorum', ['a.md', 'b.md'], [near]))).toMatchObject({ title: '2 notes link to “quorum”, and no note has that name', fix: 'Change the links to point at “Quorum app”, the note with the closest name.', action: 'relink' });
    expect(issueOf(link('../x', ['a.md']))).toMatchObject({ category: 'outside', action: 'leave' });
  });
  it('fills the footer with links, the main folder and the last change', () => {
    const i = issueOf(link('X', ['p/a.md', 'p/b.md', 'q/c.md'], [], { links: 5, lastAt: Date.UTC(2026, 10, 12, 12) }));
    expect(footerFacts(i)).toEqual(['5 links', '2 of 3 from p', 'Changed Nov 12, 2026']);
    expect(footerFacts(issueOf(link('Y', ['top.md'])))).toEqual(['1 link', 'From the vault root']);
  });
  it('finds the folder most links come from', () => {
    expect(topFolder(['a/x.md', 'b/y.md', 'b/z.md'])).toEqual({ folder: 'b', count: 2 });
    expect(topFolder([])).toBeNull();
  });
  it('lists the issues of one note in line order, without links left as is', () => {
    const items = [link('A', ['n.md']), link('B', ['n.md']), link('C', ['n.md'])];
    const lines = [{ target: 'b', line: 9 }, { target: 'A', line: 2 }, { target: 'C', line: 4 }, { target: 'Gone', line: 1 }];
    expect(fileIssues(lines, items, new Set(['c'])).map((x) => [x.line, x.issue.target])).toEqual([[2, 'A'], [9, 'B']]);
  });
});
