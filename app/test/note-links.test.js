// Knowledge editing beyond the text: bookmarks in Obsidian's file, today's daily note, the name a [[ link writes, and
// properties saved into the note's frontmatter
import { describe, expect, it } from 'vitest';
import { bookmarkedFiles, parseBookmarks, renameBookmarks, setBookmark, writeBookmarks } from '../bookmarks.js';
import { dailyConfig, dailyPath, fillTemplate, formatDate, templatePath } from '../dailyNote.js';
import { editParts, withFrontmatter } from '../noteEdit.js';
import { planSave } from '../vaultEdit.js';
import { hashText } from '../handnote.js';
import { draftOf, edited, linkName } from '../src/editor/frontmatter.ts';

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

  describe('heading and block bookmarks (a file item with a subpath)', () => {
    const data = { items: [{ type: 'file', ctime: 1, path: 'n.md' }, { type: 'file', ctime: 2, path: 'n.md', subpath: '#Heading' }, { type: 'file', ctime: 3, path: 'only.md', subpath: '#^blk' }] };

    it('do not count as a bookmark of the note', () => {
      expect(bookmarkedFiles(data)).toEqual(['n.md']);
    });

    it('stay when the note is unstarred', () => {
      expect(setBookmark(data, 'n.md', false).items).toEqual(data.items.slice(1));
    });

    it('leave a note with only a heading bookmark unstarred, and starring it adds its own bookmark', () => {
      const next = setBookmark(data, 'only.md', true, 9);
      expect(next.items).toEqual([...data.items, { type: 'file', ctime: 9, path: 'only.md' }]);
    });
  });

  describe('after a rename or move', () => {
    const data = { items: [
      { type: 'file', ctime: 1, path: 'a/n.md' },
      { type: 'file', ctime: 2, path: 'a/n.md', subpath: '#H' },
      { type: 'folder', ctime: 3, path: 'a' },
      { type: 'group', ctime: 4, title: 'G', items: [{ type: 'file', ctime: 5, path: 'a/deep/x.md' }, { type: 'file', ctime: 6, path: 'ab.md' }] },
      { type: 'search', ctime: 7, query: 'a/n.md' },
    ], version: 2 };

    it('point a note bookmark, and its heading bookmarks, at the new path', () => {
      const next = renameBookmarks(data, 'a/n.md', 'a/m.md');
      expect(next.items.slice(0, 2).map((it) => it.path)).toEqual(['a/m.md', 'a/m.md']);
      expect(next.items[1].subpath).toBe('#H');
      expect(next.items.slice(2)).toEqual(data.items.slice(2));
      expect(next.version).toBe(2);
    });

    it('carry every bookmark inside a moved folder, and not a note whose name only starts the same', () => {
      const next = renameBookmarks(data, 'a', 'b');
      expect(bookmarkedFiles(next)).toEqual(['b/n.md', 'b/deep/x.md', 'ab.md']);
      expect(next.items[2]).toEqual({ type: 'folder', ctime: 3, path: 'b' });
      expect(next.items[4]).toEqual(data.items[4]);
    });

    it('are the same data when nothing pointed at the old path', () => {
      expect(renameBookmarks(data, 'z.md', 'y.md')).toBe(data);
    });
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
  });

  it('goes in the vault root when the settings file exists with no folder, as Obsidian does', () => {
    expect(dailyPath(dailyConfig('{}'), day)).toBe('2026-11-19.md');
    expect(dailyPath(dailyConfig('{"folder":"","format":""}'), day)).toBe('2026-11-19.md');
    expect(dailyPath(dailyConfig('{"folder":"/"}'), day)).toBe('2026-11-19.md');
  });

  it("follows the folder, format and template in Obsidian's settings", () => {
    const c = dailyConfig(JSON.stringify({ folder: '/Journal/', format: 'YYYY/MM/ddd D MMM', template: 'Templates/Daily' }));
    expect(dailyPath(c, day)).toBe('Journal/2026/11/Thu 19 Nov.md');
    expect(templatePath(c)).toBe('Templates/Daily.md');
  });

  it('keeps [bracketed] text in a format as written', () => {
    expect(formatDate(day, '[Week of] YYYY-MM-DD')).toBe('Week of 2026-11-19');
  });

  // the expected names are what Moment 2.30 gives for these days (week tokens checked at the turn of the year)
  it.each([
    ['Do MMMM YYYY', '19th November 2026'],
    ['DDD DDDD DDDo', '323 323 323rd'],
    ['gggg-[W]ww', '2026-W47'],
    ['GGGG-[W]WW', '2026-W47'],
    ['dd d do E e', 'Th 4 4th 4 4'],
    ['Q Qo Mo', '4 4th 11th'],
    ['h:mm A, H k, a', '9:05 AM, 9 9, am'],
    ['\\YYYY YYYY', 'YYYY 2026'],
  ])('writes the Moment format %s as %s', (fmt, out) => {
    expect(formatDate(day, fmt)).toBe(out);
  });

  it('numbers weeks the way Moment does around the new year', () => {
    // 2026-12-31 is a Thursday: week 1 of 2027 in the English locale (Sunday weeks, January 1st) and ISO week 53
    expect(formatDate(new Date(2026, 11, 31), 'gggg-ww GGGG-WW')).toBe('2027-01 2026-53');
    expect(formatDate(new Date(2027, 0, 3), 'gggg-ww GGGG-WW')).toBe('2027-02 2026-53');
    expect(formatDate(new Date(2027, 0, 4), 'gggg-ww GGGG-WW')).toBe('2027-02 2027-01');
    expect(formatDate(new Date(2021, 0, 1), 'gggg-ww GGGG-WW')).toBe('2021-01 2020-53');
    expect(formatDate(new Date(2023, 0, 1), 'gggg-ww GGGG-WW')).toBe('2023-01 2022-52');
  });

  it('writes ordinals the English way', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31].map((n) => formatDate(new Date(2026, 0, n), 'Do'))).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '31st']);
  });

  it('refuses a format with a Moment token it does not support, so a wrong file name is never made', () => {
    expect(() => formatDate(day, 'YYYY-MM-DD N')).toThrow(/doesn't support N/);
    expect(() => formatDate(day, 'HH:mm:ss.SSS')).toThrow(/SSS/);
    expect(formatDate(day, 'YYYY [N] T')).toBe('2026 N T');
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

describe('frontmatter the Properties rows find', () => {
  const add = '---\nb: 2\n---\n';

  it('sits after a byte order mark, which stays first', () => {
    const raw = '\ufeff---\na: 1\n---\n\nText.\n';
    expect(editParts(raw).fm).toBe('---\na: 1\n---\n');
    expect(withFrontmatter(raw, add)).toBe('\ufeff---\nb: 2\n---\n\nText.\n');
    expect(withFrontmatter(raw, '')).toBe('\ufeffText.\n');
  });

  it('can be empty', () => {
    const raw = '---\n---\n\nText.\n';
    expect(editParts(raw)).toMatchObject({ fm: '---\n---\n', body: 'Text.' });
    expect(withFrontmatter(raw, add)).toBe('---\nb: 2\n---\n\nText.\n');
  });

  it('can end the file with no line break', () => {
    const raw = '---\na: 1\n---';
    expect(editParts(raw)).toMatchObject({ fm: '---\na: 1\n---', body: '' });
    expect(withFrontmatter(raw, '---\na: 1\nb: 2\n---\n')).toBe('---\na: 1\nb: 2\n---\n');
  });

  it('is not an edit when the panel would only write it another way', () => {
    for (const fm of ['---\n---\n', '---\na: 1\n---', '---\na: 1\n---\n']) expect(edited(draftOf(fm))).toBe(false);
    const d = draftOf('---\na: 1\n---');
    expect(edited({ ...d, rows: [{ key: 'a', value: ' 2' }] })).toBe(true);
  });
});
