// Knowledge editing beyond the text: bookmarks in Obsidian's file, today's daily note, the name a [[ link writes, and
// properties saved into the note's frontmatter
import { describe, expect, it } from 'vitest';
import { bookmarkedFiles, parseBookmarks, setBookmark, writeBookmarks } from '../bookmarks.js';
import { dailyConfig, dailyPath, fillTemplate, formatDate, templatePath } from '../dailyNote.js';
import { planSave, withFrontmatter } from '../noteEdit.js';
import { hashText } from '../handnote.js';
import { linkName } from '../src/editor/frontmatter.ts';

describe('bookmarks in .obsidian/bookmarks.json', () => {
  const obsidian = JSON.stringify({
    items: [
      { type: 'file', ctime: 1, path: 'a.md' },
      { type: 'search', ctime: 2, query: 'tag:#todo' },
      { type: 'group', ctime: 3, title: 'Work', items: [{ type: 'file', ctime: 4, path: 'w/b.md', subpath: '' }, { type: 'url', ctime: 5, url: 'https://example.com', title: 'Site' }] },
      { type: 'graph', ctime: 6, title: 'Graph', options: { localJumps: 1 } },
    ],
    version: 9,
  });

  it('lists the bookmarked notes in order, groups included', () => {
    expect(bookmarkedFiles(parseBookmarks(obsidian))).toEqual(['a.md', 'w/b.md']);
  });

  it('adds a note at the end of the top level, as Obsidian does, and keeps every other item and field', () => {
    const next = setBookmark(parseBookmarks(obsidian), 'c.md', true, 7);
    const back = JSON.parse(writeBookmarks(next));
    expect(back.items.at(-1)).toEqual({ type: 'file', ctime: 7, path: 'c.md' });
    expect(back.items.slice(0, -1)).toEqual(JSON.parse(obsidian).items);
    expect(back.version).toBe(9);
  });

  it('removes a note from inside a group and leaves the group and its other items', () => {
    const back = JSON.parse(writeBookmarks(setBookmark(parseBookmarks(obsidian), 'w/b.md', false)));
    expect(back.items[2]).toEqual({ type: 'group', ctime: 3, title: 'Work', items: [{ type: 'url', ctime: 5, url: 'https://example.com', title: 'Site' }] });
    expect(bookmarkedFiles(back)).toEqual(['a.md']);
  });

  it('leaves the file untouched for a toggle that changes nothing', () => {
    const data = parseBookmarks(obsidian);
    expect(setBookmark(data, 'a.md', true)).toBe(data);
    expect(setBookmark(data, 'missing.md', false)).toBe(data);
  });

  it('starts an empty list when there is no file, and never takes over a file that is not a bookmarks file', () => {
    expect(parseBookmarks(null)).toEqual({ items: [] });
    expect(parseBookmarks('{ not json')).toBeNull();
    expect(parseBookmarks('[1, 2]')).toBeNull();
  });
});

describe("today's daily note", () => {
  const day = new Date(2026, 10, 19, 9, 5);

  it('goes in 01-daily as YYYY-MM-DD when Obsidian has no daily notes settings', () => {
    expect(dailyPath(dailyConfig(null), day)).toBe('01-daily/2026-11-19.md');
    expect(dailyPath(dailyConfig('{}'), day)).toBe('01-daily/2026-11-19.md');
  });

  it("follows the folder, format and template in Obsidian's settings", () => {
    const c = dailyConfig(JSON.stringify({ folder: '/Journal/', format: 'YYYY/MM/ddd D MMM', template: 'Templates/Daily' }));
    expect(dailyPath(c, day)).toBe('Journal/2026/11/Thu 19 Nov.md');
    expect(templatePath(c)).toBe('Templates/Daily.md');
  });

  it('keeps [bracketed] text in a format as written', () => {
    expect(formatDate(day, '[Week of] YYYY-MM-DD')).toBe('Week of 2026-11-19');
  });

  it('fills the template the way Obsidian does', () => {
    expect(fillTemplate('# {{title}}\nMade {{date:dddd}} at {{time}}', day, '2026-11-19')).toBe('# 2026-11-19\nMade Thursday at 09:05');
  });
});

describe('the name a [[ link writes', () => {
  it('compares names without case, the way Obsidian resolves them', () => {
    expect(linkName('work/Plan.md', ['work/Plan.md', 'home/plan.md'])).toBe('work/Plan');
  });

  it('adds folders until the name points at one note', () => {
    expect(linkName('a/x/Note.md', ['a/x/Note.md', 'b/x/Note.md', 'c/Other.md'])).toBe('a/x/Note');
    expect(linkName('c/Other.md', ['a/x/Note.md', 'b/x/Note.md', 'c/Other.md'])).toBe('Other');
  });

  it('is not fooled by a note whose name ends the same way', () => {
    expect(linkName('Plan.md', ['Plan.md', 'Big Plan.md'])).toBe('Plan');
  });
});

describe('properties saved into the frontmatter', () => {
  const note = '---\ntitle: T\ntags: a\n---\n\n# T\n\nBody.\n';

  it('replaces the frontmatter and nothing else', () => {
    expect(withFrontmatter(note, '---\ntitle: T\ntags: b\n---\n')).toBe('---\ntitle: T\ntags: b\n---\n\n# T\n\nBody.\n');
  });

  it('removes the frontmatter and the blank line after it when every row is cleared', () => {
    expect(withFrontmatter(note, '')).toBe('# T\n\nBody.\n');
  });

  it('adds frontmatter to a note that had none', () => {
    expect(withFrontmatter('# T\n\nBody.\n', '---\ntags: a\n---\n')).toBe('---\ntags: a\n---\n\n# T\n\nBody.\n');
  });

  it('uses the same hash check as body edits', () => {
    expect(planSave(note, { hash: hashText('older'), frontmatter: '', withheld: false })).toEqual({ conflict: true });
  });

  it('saves the body but not properties that are not valid frontmatter', () => {
    const r = planSave(note, { hash: hashText(note), body: 'New.', frontmatter: '---\nbroken', withheld: false });
    expect(r).toEqual({ text: '---\ntitle: T\ntags: a\n---\n\n# T\n\nNew.\n', propsError: expect.any(String) });
  });
});
