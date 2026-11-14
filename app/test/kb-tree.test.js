import { describe, expect, it } from 'vitest';
import {
  accessDraft, buildFolderTree, checkGithubUrl, descendantIds, driveSummary, flattenFolders, folderPath, importSummary, moveCheck, moveTargets,
  notesIn, openPathTo, progressLabel, progressShare, readersOf, readersSummary, resolveKbLink, sourceLine, treeKey, visibleRows, withFolder, withoutFolder,
} from '../ee/src/kbTree.ts';

// Handbook / Onboarding / Week one, Handbook / Policies, and Archive at the top level
const ROWS = [
  { id: 'pol', parentId: null, name: 'Policies', position: 1 },
  { id: 'onb', parentId: null, name: 'Onboarding', position: 0 },
  { id: 'wk1', parentId: 'onb', name: 'Week one', position: 0 },
  { id: 'arc', parentId: null, name: 'Archive', position: 1 },
];
const tree = () => buildFolderTree(ROWS);

describe('building the folder tree', () => {
  it('nests folders under their parents and orders siblings by position, then name', () => {
    const t = tree();
    expect(t.map((f) => f.name)).toEqual(['Onboarding', 'Archive', 'Policies']);
    expect(t[0].children.map((f) => f.name)).toEqual(['Week one']);
  });

  it('shows a folder whose parent is gone at the top level', () => {
    const t = buildFolderTree([{ id: 'x', parentId: 'missing', name: 'Stray', position: 0 }]);
    expect(t).toEqual([{ id: 'x', parentId: 'missing', name: 'Stray', position: 0, children: [] }]);
  });

  it('round-trips through the flat rows, parents first', () => {
    const flat = flattenFolders(tree());
    expect(flat.map((f) => f.id)).toEqual(['onb', 'wk1', 'arc', 'pol']);
    expect(buildFolderTree(flat)).toEqual(tree());
  });

  it('adds, replaces and removes a folder as the server returns it', () => {
    const added = withFolder(tree(), { id: 'new', parentId: 'wk1', name: 'Day one', position: 0 });
    expect(folderPath(added, 'new')).toEqual(['Onboarding', 'Week one', 'Day one']);
    const moved = withFolder(tree(), { id: 'wk1', parentId: 'pol', name: 'Week one', position: 0 });
    expect(folderPath(moved, 'wk1')).toEqual(['Policies', 'Week one']);
    const gone = withoutFolder(tree(), 'onb');
    expect(flattenFolders(gone).map((f) => f.id)).toEqual(['arc', 'pol']);
  });

  it('lists every folder inside one', () => {
    expect([...descendantIds(tree(), 'onb')]).toEqual(['wk1']);
    expect(descendantIds(tree(), 'arc').size).toBe(0);
  });
});

describe('moving a folder', () => {
  it('refuses moving a folder into itself or into one of its own folders', () => {
    expect(moveCheck(tree(), 'onb', 'onb')).toEqual({ ok: false, reason: 'A folder cannot move inside itself.' });
    expect(moveCheck(tree(), 'onb', 'wk1')).toEqual({ ok: false, reason: 'A folder cannot move into one of its own folders.' });
  });

  it('refuses a move that changes nothing, a missing folder and a name clash', () => {
    expect(moveCheck(tree(), 'wk1', 'onb').ok).toBe(false);
    expect(moveCheck(tree(), 'nope', null).ok).toBe(false);
    const clash = buildFolderTree([...ROWS, { id: 'pol2', parentId: 'onb', name: 'policies', position: 1 }]);
    expect(moveCheck(clash, 'pol2', null)).toEqual({ ok: false, reason: 'A folder with that name is already there.' });
  });

  it('allows moving into a sibling or out to the top level', () => {
    expect(moveCheck(tree(), 'arc', 'pol')).toEqual({ ok: true });
    expect(moveCheck(tree(), 'wk1', null)).toEqual({ ok: true });
  });

  it('offers only valid targets in the Move menu', () => {
    expect(moveTargets(tree(), 'onb').map((t) => t.id)).toEqual(['arc', 'pol']);
    expect(moveTargets(tree(), 'wk1')).toEqual([
      { id: null, label: 'Top level', depth: 0 },
      { id: 'arc', label: 'Archive', depth: 1 },
      { id: 'pol', label: 'Policies', depth: 1 },
    ]);
  });
});

describe('the tree rows and the arrow keys', () => {
  const kbs = [{ id: 'k1', name: 'Handbook', folders: tree() }, { id: 'k2', name: 'Meetings', folders: [] }];
  const open = new Set(['kb:k1', 'f:k1:onb']);
  const rows = visibleRows(kbs, open);

  it('shows the open KBs and folders in screen order with their levels', () => {
    expect(rows.map((r) => [r.key, r.depth])).toEqual([['kb:k1', 0], ['f:k1:onb', 1], ['f:k1:wk1', 2], ['f:k1:arc', 1], ['f:k1:pol', 1], ['kb:k2', 0]]);
    expect(rows[0]).toMatchObject({ kind: 'kb', hasChildren: true, expanded: true });
    expect(rows[5]).toMatchObject({ kind: 'kb', hasChildren: false, expanded: false });
    expect(rows[2].parentKey).toBe('f:k1:onb');
  });

  it('moves down and up, and goes to the ends', () => {
    expect(treeKey(rows, 'kb:k1', 'ArrowDown')).toEqual({ focus: 'f:k1:onb' });
    expect(treeKey(rows, 'f:k1:onb', 'ArrowUp')).toEqual({ focus: 'kb:k1' });
    expect(treeKey(rows, 'kb:k1', 'ArrowUp')).toBeNull();
    expect(treeKey(rows, 'f:k1:arc', 'End')).toEqual({ focus: 'kb:k2' });
    expect(treeKey(rows, 'f:k1:arc', 'Home')).toEqual({ focus: 'kb:k1' });
  });

  it('opens and closes with right and left, and left on a leaf goes to its parent', () => {
    const closed = visibleRows(kbs, new Set(['kb:k1']));
    expect(treeKey(closed, 'f:k1:onb', 'ArrowRight')).toEqual({ open: 'f:k1:onb' });
    expect(treeKey(rows, 'f:k1:onb', 'ArrowRight')).toEqual({ focus: 'f:k1:wk1' });
    expect(treeKey(rows, 'f:k1:onb', 'ArrowLeft')).toEqual({ close: 'f:k1:onb' });
    expect(treeKey(rows, 'f:k1:wk1', 'ArrowLeft')).toEqual({ focus: 'f:k1:onb' });
    expect(treeKey(rows, 'kb:k2', 'ArrowRight')).toBeNull();
  });

  it('focuses the first row when nothing has focus yet', () => {
    expect(treeKey(rows, null, 'ArrowDown')).toEqual({ focus: 'kb:k1' });
    expect(treeKey([], null, 'ArrowDown')).toBeNull();
  });

  it('opens the path down to a folder', () => {
    expect(openPathTo(kbs[0], 'wk1')).toEqual(['kb:k1', 'f:k1:onb']);
    expect(openPathTo(kbs[0], null)).toEqual(['kb:k1']);
  });
});

describe('notes in a folder', () => {
  const notes = [
    { id: '1', path: 'b.md', title: 'Beta', folderId: 'onb', userId: 'u', updatedAt: null },
    { id: '2', path: 'a.md', title: 'Alpha', folderId: 'onb', userId: 'u', updatedAt: null },
    { id: '3', path: 'c.md', title: 'Top', folderId: null, userId: 'u', updatedAt: null },
  ];
  it('lists the notes directly in a folder by title, and the top level for null', () => {
    expect(notesIn(notes, 'onb').map((n) => n.title)).toEqual(['Alpha', 'Beta']);
    expect(notesIn(notes, null).map((n) => n.title)).toEqual(['Top']);
  });
});

describe('readers', () => {
  const ws = { principal: 'workspace', userId: null, teamId: null, role: 'reader', email: null, name: null };
  const ann = { principal: 'user', userId: 'ann', teamId: null, role: 'admin', email: null, name: 'Ann' };
  const bo = { principal: 'user', userId: 'bo', teamId: null, role: 'reader', email: null, name: 'Bo' };

  it('summarizes who reads a KB', () => {
    expect(readersSummary([ws, ann])).toBe('Whole workspace · 1 KB admin');
    expect(readersSummary([bo])).toBe('1 person');
    expect(readersSummary([])).toBe('Owners and admins only');
    expect(readersSummary(null)).toBe('Readers are visible to its admins');
    expect(readersSummary([{ ...ws, role: 'admin' }])).toBe('Whole workspace (all can manage)');
  });

  it('reads the current choice back from the access list', () => {
    expect(readersOf([ws, ann])).toEqual({ mode: 'workspace', people: [] });
    expect(readersOf([ann, bo])).toEqual({ mode: 'people', people: ['bo'] });
  });

  it('keeps KB admins and drops person readers when the whole workspace reads', () => {
    expect(accessDraft([ann, bo], 'workspace', ['bo'])).toEqual([
      { principal: 'workspace', role: 'reader' },
      { principal: 'user', userId: 'ann', role: 'admin' },
    ]);
  });

  it('lists chosen people once, never demoting an admin and never sending teams', () => {
    const team = { principal: 'team', userId: null, teamId: 't', role: 'reader', email: null, name: null };
    expect(accessDraft([ws, ann, team], 'people', ['bo', 'bo', 'ann'])).toEqual([
      { principal: 'user', userId: 'ann', role: 'admin' },
      { principal: 'user', userId: 'bo', role: 'reader' },
    ]);
  });
});

describe('import lines', () => {
  it('takes a GitHub repository address and refuses anything else', () => {
    expect(checkGithubUrl(' https://github.com/acme/handbook/ ')).toEqual({ url: 'https://github.com/acme/handbook' });
    expect(checkGithubUrl('https://github.com/acme/handbook.git')).toEqual({ url: 'https://github.com/acme/handbook.git' });
    expect('error' in checkGithubUrl('')).toBe(true);
    expect('error' in checkGithubUrl('https://gitlab.com/acme/handbook')).toBe(true);
    expect('error' in checkGithubUrl('https://github.com/acme')).toBe(true);
  });

  it('says what an import is doing', () => {
    expect(progressLabel(null)).toBe('Starting the import…');
    expect(progressLabel({ kbId: 'k', phase: 'fetching', done: 0, total: 0 })).toBe('Downloading…');
    expect(progressLabel({ kbId: 'k', phase: 'writing', done: 12, total: 40 })).toBe('Saving notes 12 of 40…');
    expect(progressShare({ kbId: 'k', phase: 'writing', done: 12, total: 40 })).toBeCloseTo(0.3);
    expect(progressShare({ kbId: 'k', phase: 'fetching', done: 0, total: 0 })).toBeNull();
  });

  it('summarizes the result and caps the skipped list', () => {
    expect(importSummary({ imported: 1, skipped: [] }).headline).toBe('Imported 1 note.');
    const skipped = Array.from({ length: 23 }, (_, i) => ({ path: `f${i}.png`, reason: 'Not a text file' }));
    const s = importSummary({ imported: 40, skipped });
    expect(s.headline).toBe('Imported 40 notes, skipped 23 files.');
    expect(s.skipped).toHaveLength(20);
    expect(s.more).toBe(3);
    expect(importSummary({ imported: 2, skipped: [], removed: 1 }).headline).toBe('Imported 2 notes, removed 1 note the source no longer has.');
    expect(importSummary({ imported: 2, skipped: [], kept: 1, suggested: 2 }).headline).toBe('Imported 2 notes, kept 1 edited note as it is, kept 2 edits as suggestions on the new text.');
    expect(driveSummary('Synced', 1, [], 2, 2, 1).headline).toBe('Synced 1 file from Google Drive, 2 unchanged since the last sync, kept 2 edited files as they are, kept 1 edit as a suggestion on the new text.');
  });

  it('names where a KB comes from, with the branch', () => {
    const base = { url: null, path: null, branch: null, subpath: null, name: null, importedAt: null };
    expect(sourceLine(null)).toBeNull();
    expect(sourceLine({ ...base, kind: 'github', url: 'https://github.com/acme/handbook', branch: 'main' })).toBe('GitHub acme/handbook (main)');
    expect(sourceLine({ ...base, kind: 'github', url: 'https://github.com/acme/handbook.git' })).toBe('GitHub acme/handbook');
    expect(sourceLine({ ...base, kind: 'github', url: 'https://github.com/acme/mono', subpath: '/docs/', branch: 'dev' })).toBe('GitHub acme/mono/docs (dev)');
    expect(sourceLine({ ...base, kind: 'zip', name: 'handbook.zip' })).toBe('Zip handbook.zip');
    expect(sourceLine({ ...base, kind: 'zip', path: '/tmp/x/export.zip' })).toBe('Zip export.zip');
    expect(sourceLine({ ...base, kind: 'git', url: 'https://example.com/team/kb.git' })).toBe('Repository example.com/team/kb');
    expect(sourceLine({ ...base, kind: 'folder', path: '/Volumes/Shared/kb' })).toBe('Folder /Volumes/Shared/kb');
  });
});

describe('following a link inside a KB note', () => {
  const n = (id, path, folderId = null) => ({ id, path, folderId });
  const byKb = {
    k1: [n('a', 'guides/setup.md', 'g'), n('b', 'setup.md'), n('c', 'guides/deep/setup.md', 'd'), n('d', 'guides/notsetup.md', 'g'), n('e', 'ops/run book.md', 'o')],
    k2: [n('x', 'policies/leave.md', 'p'), n('y', 'setup.md')],
  };
  const from = (path, folderId) => ({ kbId: 'k1', note: { path, folderId } });

  it('matches whole path segments, never part of a name', () => {
    expect(resolveKbLink('tup', from('index.md', null), byKb)).toBeNull();
    expect(resolveKbLink('notsetup', from('index.md', null), byKb).note.id).toBe('d');
    expect(resolveKbLink('book', from('index.md', null), byKb)).toBeNull();
    expect(resolveKbLink('Run Book', from('index.md', null), byKb).note.id).toBe('e');
  });

  it('takes the exact path relative to the linking note first', () => {
    expect(resolveKbLink('deep/setup', from('guides/intro.md', 'g'), byKb).note.id).toBe('c');
    expect(resolveKbLink('../setup.md', from('guides/intro.md', 'g'), byKb).note.id).toBe('b');
    expect(resolveKbLink('guides/setup', from('other/x.md', null), byKb).note.id).toBe('a');
  });

  it('prefers the same folder, then the same KB, for a bare name', () => {
    expect(resolveKbLink('setup', from('guides/intro.md', 'g'), byKb).note.id).toBe('a');
    expect(resolveKbLink('setup', from('guides/deep/other.md', 'd'), byKb).note.id).toBe('c');
    expect(resolveKbLink('setup', from('elsewhere/x.md', 'z'), byKb)).toEqual({ kbId: 'k1', note: byKb.k1[1] });
    expect(resolveKbLink('leave', from('index.md', null), byKb)).toEqual({ kbId: 'k2', note: byKb.k2[0] });
  });

  it('ignores headings and aliases and refuses paths above the top', () => {
    expect(resolveKbLink('policies/leave#Parental|leave policy', from('index.md', null), byKb).note.id).toBe('x');
    expect(resolveKbLink('../../setup', from('index.md', null), byKb)).toBeNull();
    expect(resolveKbLink('  ', from('index.md', null), byKb)).toBeNull();
  });
});
