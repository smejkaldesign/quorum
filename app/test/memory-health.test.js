import { describe, expect, it } from 'vitest';
import { categoryCounts, categoryOf, countsLine, fileIssues, footerFacts, issueOf, optionsOf, topFolder, healthMarks, healthList } from '../memoryHealth.js';

const link = (target, sources, candidates = [], extra = {}) => ({ target, sources, count: sources.length, candidates, ...extra });
const exact = { rel: 'people/ada.md', title: 'Ada Lovelace', name: 'Ada', exact: true };
const near = { rel: 'projects/quorum-app.md', title: 'Quorum app', name: null, exact: false, score: 0.5, cover: 1, kindClash: false, shared: ['quorum', 'app'], neighbor: true, sameFolder: false };
const weak = { rel: 'misc/quorum-notes-old.md', title: 'Quorum notes old', name: null, exact: false, score: 0.4, cover: 0.5, kindClash: false, shared: ['quorum', 'old'], neighbor: false, sameFolder: false };
const said = (text, rel = 'a.md') => ({ rel, text });

describe('memory health categories', () => {
  it('sorts each missing link by the fix recommended first', () => {
    expect(categoryOf(link('Nowhere', ['a.md']))).toBe('unlink');
    expect(categoryOf(link('Roadmap', ['a.md', 'b.md']))).toBe('missing');
    expect(categoryOf(link('ada', ['a.md'], [exact]))).toBe('alias');
    expect(categoryOf(link('quorum app', ['a.md'], [near]))).toBe('similar');
    expect(categoryOf(link('../outside', ['a.md'], [exact]))).toBe('outside');
    expect(categoryOf(link('x/.claude/agents/rick', ['a.md']))).toBe('outside');
  });
  it('counts the categories in a fixed order without empty ones, with links left as is apart', () => {
    const items = [link('A', ['a.md']), link('B', ['b.md']), link('ada', ['c.md'], [exact]), link('Kept', ['d.md'])];
    const counts = categoryCounts(items, new Set(['kept']));
    expect(counts).toEqual([
      { id: 'alias', label: 'Likely matches', count: 1 },
      { id: 'unlink', label: 'Dead links', count: 2 },
      { id: 'left', label: 'Left as is', count: 1 },
    ]);
    expect(countsLine(counts)).toBe('Likely matches 1 · Dead links 2 · Left as is 1');
    expect(categoryCounts([])).toEqual([]);
  });
});

describe('memory health fix order', () => {
  it('points the link at a note that is clearly the one meant before anything else', () => {
    expect(optionsOf(link('quorum app', ['a.md'], [near]))).toEqual(['relink', 'unlink']);
    expect(optionsOf(link('quorum app', ['a.md', 'b.md'], [near]))).toEqual(['relink', 'create', 'unlink']);
  });
  it('writes the note when the linking notes say enough, and offers a weak match after it', () => {
    const long = said('Beacon Health Systems currently lacks a self-service inbound scheduling flow for patients, so they call the office');
    expect(optionsOf(link('beacon-scheduling-prd', ['index.md'], [], { contexts: [long] }))).toEqual(['create', 'unlink']);
    expect(optionsOf(link('quorum notes', ['a.md', 'b.md'], [weak]))).toEqual(['create', 'relink', 'unlink']);
  });
  it('takes the dead link out when nothing matches and nothing says enough', () => {
    expect(optionsOf(link('connector-hub-presentation-2026-04-14', ['index.md'], [], { contexts: [said('connector-hub-presentation-2026-04-14 - Pod Connect')] }))).toEqual(['unlink']);
  });
  it('moves to the next fix after a decline, and says so', () => {
    const m = link('Roadmap', ['a.md', 'b.md']);
    expect(issueOf(m)).toMatchObject({ action: 'create', next: 'unlink', decline: 'Quorum suggests the next fix instead: remove the links and keep the words.' });
    expect(issueOf({ ...m, declined: ['create'] })).toMatchObject({ action: 'unlink', category: 'unlink', next: null, decline: 'The links stay as they are, and the issue moves to Left as is.' });
  });
});

describe('memory health issue cards', () => {
  it('writes a plain title and the recommended fix for each kind', () => {
    const many = Array.from({ length: 16 }, (_, i) => `notes/n${i}.md`);
    expect(issueOf(link('Roadmap', many))).toMatchObject({
      title: '16 notes link to “Roadmap”, a note that does not exist',
      recommend: 'Make a note named “Roadmap” in notes from what the 16 linking notes say about it.', action: 'create', path: 'notes/n0.md', createIn: 'notes',
    });
    expect(issueOf(link('ada', ['a.md'], [exact]))).toMatchObject({ title: 'One note links to “ada”, which is almost certainly “Ada”', action: 'alias', recommend: 'Add “ada” as an alias of “Ada”.' });
    expect(issueOf(link('quorum app', ['a.md', 'b.md'], [near]))).toMatchObject({
      title: '2 notes link to “quorum app”, and the closest note is “Quorum app”', action: 'relink', recommend: 'Point the links at “Quorum app”.',
      problem: 'The links open nothing. “Quorum app” shares the words “quorum” and “app” and is already linked with these notes, so it is most likely the note meant.',
    });
    expect(issueOf(link('Gone', ['a.md']))).toMatchObject({ action: 'unlink', recommend: 'Remove the link and keep “Gone” as plain text.' });
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

describe('memory health write-up, tree marks and list', () => {
  it('states the problem, what fixing it does, and the recommended action', () => {
    const i = issueOf(link('Roadmap', ['a.md', 'b.md']));
    expect(i.problem).toBe('The links open nothing. 2 notes refer to “Roadmap”, so it reads as a topic of its own with no note for the agent to read.');
    expect(i.effect).toBe('A note named “Roadmap” holds what the 2 linking notes say about it, with a link back to each. The agent reads the topic in one place, and the graph connects the 2 notes through it.');
    expect(i.recommend).toBe('Make a note named “Roadmap” from what the 2 linking notes say about it.');
  });
  it('counts open issues per note and per folder, once per folder, leaving out the ones left as is', () => {
    const items = [link('x', ['p/a.md', 'p/q/b.md']), link('y', ['p/a.md']), link('z', ['top.md'])];
    expect(healthMarks(items, new Set(['z']))).toEqual({ files: { 'p/a.md': 2, 'p/q/b.md': 1 }, folders: { p: 2, 'p/q': 1 } });
  });
  it('lists one tab, narrowed by category and words, in the chosen order', () => {
    const items = [link('b', ['n/1.md']), link('a', ['n/1.md', 'n/2.md', 'n/3.md']), link('ada', ['m/1.md'], [exact])];
    expect(healthList(items).map((i) => i.target)).toEqual(['a', 'ada', 'b']);
    expect(healthList(items, { sort: 'az' }).map((i) => i.target)).toEqual(['a', 'ada', 'b']);
    expect(healthList(items, { categories: ['alias'] }).map((i) => i.target)).toEqual(['ada']);
    expect(healthList(items, { q: 'm/1' }).map((i) => i.target)).toEqual(['ada']);
    expect(healthList(items, { tab: 'left', left: new Set(['b']) }).map((i) => i.target)).toEqual(['b']);
  });
});

describe('memory health write-up for a single link', () => {
  it('reads in the singular', () => {
    const i = issueOf(link('Roadmap', ['a.md']));
    expect(i.problem).toBe('The link opens nothing. No note has a close name, and the linking note says too little about “Roadmap” to write one, so the agent follows a link to nothing.');
    expect(i.effect).toBe('The words stay in the text and the dead link goes. The agent stops following it, and the graph drops the empty node.');
  });
});
