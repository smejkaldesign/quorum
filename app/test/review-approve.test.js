import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { aliasBacks, approveFinding, approvePastFix, folderIndex, gitReader, onlyFixChange, onlyStub, withLinkLine } from '../reviewApprove.js';
import { buildPlan, checkFirst, groupOf } from '../batchPlan.js';
import { findingItem, itemLine, pastFixItem } from '../reviewItems.js';
import { parseNote } from '../linkparse.js';
import { sha } from '../fixUndo.js';

// synthetic vaults only; every note name is made up
const vaultOf = (files) => {
  const rels = () => Object.keys(files);
  const note = (rel) => (files[rel] == null ? null : parseNote(rel, files[rel]));
  const resolve = (t) => rels().find((r) => r.replace(/\.md$/, '').toLowerCase() === t.toLowerCase() || path.posix.basename(r, '.md').toLowerCase() === t.toLowerCase()) ?? null;
  return { rels, note, resolve, backlinks: () => [], read: (rel) => files[rel] ?? null };
};
const relinkRun = (extra = {}) => ({
  id: 'run-1', key: 'kite', target: 'Kite', rel: 'a.md', status: 'success', outcome: 'Fixed 1 link in 1 note', steps: [{ label: 'Pointing the link at Kite Note' }],
  finding: { sources: ['a.md'], proposedFix: { action: 'relink', to: 'kite-note.md' } }, ...extra,
});
const refused = { ok: false, kind: 'exact', why: 'Other links also point at “kite-note.md”, so Quorum cannot tell which ones this fix changed.', files: [] };

const dirs = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { stdio: 'pipe' });
// a temp git repo with the vault in a subfolder, its notes committed as they read before the fix
function repoWith(before) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'quorum-approve-'));
  dirs.push(root);
  const vault = path.join(root, 'Vault');
  execFileSync('mkdir', ['-p', vault]);
  for (const [rel, text] of Object.entries(before)) writeFileSync(path.join(vault, rel), text);
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'notes');
  return vault;
}

describe('onlyFixChange', () => {
  it('accepts a line whose link to the target became a link elsewhere or its words, and nothing else', () => {
    expect(onlyFixChange('See [[Kite]] here.\n', 'See [[kite-note]] here.\n', { action: 'relink', target: 'Kite' })).toBe(true);
    expect(onlyFixChange('See [[Kite|the kite]] here.\n', 'See the kite here.\n', { action: 'unlink', target: 'Kite' })).toBe(true);
    expect(onlyFixChange('See [[Kite]] here.\n', 'See [[kite-note]] there.\n', { action: 'relink', target: 'Kite' })).toBe(false);
    expect(onlyFixChange('See [[Kite]] here.\n', 'See [[kite-note]] here.\nA new line.\n', { action: 'relink', target: 'Kite' })).toBe(false);
    expect(onlyFixChange('See [[Lamp]] here.\n', 'See [[kite-note]] here.\n', { action: 'relink', target: 'Kite' })).toBe(false);
    expect(onlyFixChange('same', 'same', { action: 'relink', target: 'Kite' })).toBe(false);
  });

  it('takes each way addAlias writes an alias back out', () => {
    expect(aliasBacks('---\naliases:\n  - Kite\n---\nbody', 'Kite')).toContain('body');
    expect(aliasBacks('---\ntitle: K\naliases: [Old, Kite]\n---\nbody', 'Kite')).toContain('---\ntitle: K\naliases: [Old]\n---\nbody');
    expect(aliasBacks('---\ntitle: K\naliases:\n  - Kite\n---\nbody', 'Kite')).toContain('---\ntitle: K\n---\nbody');
    expect(onlyFixChange('---\ntitle: K\n---\nbody', '---\ntitle: K\naliases:\n  - Kite\n---\nbody', { action: 'alias', target: 'Kite' })).toBe(true);
  });
});

describe('approvePastFix: restore from git history', () => {
  it('puts back the committed text when the fix is the only change since', () => {
    const vault = repoWith({ 'a.md': '# A\n\nSee [[Kite]] for more.\n', 'kite-note.md': '# Kite Note\n' });
    const now = '# A\n\nSee [[kite-note]] for more.\n';
    writeFileSync(path.join(vault, 'a.md'), now);
    const run = relinkRun({ startedAt: Date.now() + 2000 });
    const a = approvePastFix(run, refused, { vault: vaultOf({ 'a.md': now, 'kite-note.md': '# Kite Note\n' }), gitShow: gitReader(vault) });
    expect(a.kind).toBe('git');
    expect(a.ops).toEqual([{ op: 'restore', rel: 'a.md', before: '# A\n\nSee [[Kite]] for more.\n', expect: sha(now) }]);
    expect(a.why).toMatch(/git history/);
  });

  it('reads nothing from a commit made after the fix, and falls back to keep when the note changed in other ways', () => {
    const vault = repoWith({ 'a.md': '# A\n\nSee [[Kite]] for more.\n' });
    const edited = '# A\n\nSee [[kite-note]] for more. And a line the person wrote.\n';
    const files = { 'a.md': edited, 'kite-note.md': '# Kite Note\n' };
    expect(gitReader(vault)('a.md', Date.now() - 86400000)).toBe(null);
    const a = approvePastFix(relinkRun({ startedAt: Date.now() + 2000 }), refused, { vault: vaultOf(files), gitShow: gitReader(vault) });
    expect(a.kind).toBe('keep');
    expect(a.ops).toEqual([{ op: 'keep' }]);
    expect(a.why).toMatch(/Approve keeps the fix as it is/);
  });

  it('answers null outside a git repo', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'quorum-nogit-'));
    dirs.push(dir);
    expect(gitReader(dir)('a.md', Date.now())).toBe(null);
  });
});

describe('approvePastFix: remove what the fix left', () => {
  const stub = '# Kite\n\nQuorum made this note because 2 notes link to “Kite” and no note had that name. What those notes say about it:\n\n- [[a]]: flies high\n- [[b]]: red\n';
  const createRun = { id: 'run-2', key: 'kite', target: 'Kite', status: 'success', outcome: 'Wrote the note n/Kite.md from what the linking notes say', steps: [] };

  it('trashes a note the fix wrote that still holds only the stub', () => {
    expect(onlyStub(stub)).toBe(true);
    expect(onlyStub(`---\nconfidential: team\n---\n${stub}`)).toBe(true);
    const a = approvePastFix(createRun, { ok: false, kind: 'trash', why: 'changed after the fix' }, { vault: vaultOf({ 'n/Kite.md': stub }), gitShow: null });
    expect(a).toMatchObject({ kind: 'remove', ops: [{ op: 'trash', rel: 'n/Kite.md', expect: sha(stub) }] });
  });

  it('keeps a stub a person wrote in', () => {
    const own = `${stub}\nMy own notes on kites.\n`;
    expect(onlyStub(own)).toBe(false);
    expect(onlyStub(`---\ntags: [x]\n---\n${stub}`)).toBe(false);
    expect(approvePastFix(createRun, { ok: false, why: 'changed' }, { vault: vaultOf({ 'n/Kite.md': own }) }).kind).toBe('keep');
  });

  it('removes the links a relink left pointing at a note that is gone', () => {
    const files = { 'a.md': '# A\n\nSee [[Kite Note]] and [[Kite Note|it]].\n' };
    const a = approvePastFix(relinkRun({ finding: { sources: ['a.md'], proposedFix: { action: 'relink' } } }), { ok: false, why: 'gone' }, { vault: vaultOf(files) });
    expect(a.kind).toBe('remove');
    expect(a.ops).toEqual([{ op: 'unlink', target: 'Kite Note', sources: ['a.md'], lines: { 'a.md': [2, 2] }, links: 2 }]);
  });

  it('runs a drafted fix through the hook when nothing else applies', () => {
    const ops = [{ op: 'restore', rel: 'a.md', before: 'x', expect: 'h' }];
    const files = { 'a.md': 'See [[kite-note]].\n', 'kite-note.md': '# K\n' };
    expect(approvePastFix(relinkRun(), refused, { vault: vaultOf(files), draft: () => ({ ops, why: 'An agent drafted it.' }) })).toEqual({ kind: 'draft', why: 'An agent drafted it.', ops });
    expect(approvePastFix(relinkRun(), refused, { vault: vaultOf(files), draft: () => null }).kind).toBe('keep');
  });
});

describe('approveFinding', () => {
  const f = (ruleId, extra = {}) => ({ ruleId, key: `${ruleId}:notes/x.md`, rel: 'notes/x.md', facts: [], ...extra });
  it('adds missing frontmatter keys, with a value Quorum can tell or an empty one', () => {
    const a = approveFinding(f('note.frontmatter', { rel: 'log/2026-03-04 call.md', facts: ['missing:date', 'missing:owner', 'type:status'] }), { title: () => 'Call' });
    expect(a.ops).toEqual([{ op: 'setkey', rel: 'log/2026-03-04 call.md', key: 'date', value: '2026-03-04' }, { op: 'setkey', rel: 'log/2026-03-04 call.md', key: 'owner', value: '""' }]);
    expect(a.says).toBe('Add “date” (2026-03-04) and “owner” with an empty value.');
    expect(approveFinding(f('note.frontmatter', { facts: ['twice:tags'] })).kind).toBe('keep');
  });

  it('archives a stale note only on strong evidence, or marks it verified today when its folder checks on an interval', () => {
    const now = Date.UTC(2026, 10, 16);
    expect(approveFinding(f('note.stale', { facts: ['open', 'due'] }), { now }).ops).toEqual([{ op: 'setkey', rel: 'notes/x.md', key: 'status', value: 'archived' }]);
    for (const facts of [['open'], ['due'], ['title']]) expect(approveFinding(f('note.stale', { facts }), { now })).toMatchObject({ kind: 'keep', ops: [{ op: 'keep' }] });
    expect(approveFinding(f('note.stale', { facts: ['verify'] }), { now: new Date(2026, 10, 16, 12).getTime() }).ops).toEqual([{ op: 'setkey', rel: 'notes/x.md', key: 'last_verified', value: '2026-11-16' }]);
  });

  it('marks it verified on the local day, late at night and early in the morning', () => {
    for (const hour of [0, 23]) {
      const a = approveFinding(f('note.stale', { facts: ['verify'] }), { now: new Date(2026, 10, 16, hour, 30).getTime() });
      expect(a.ops[0].value).toBe('2026-11-16');
    }
  });

  it('links an orphan from its folder index, else keeps it', () => {
    const rels = ['notes/x.md', 'notes/index.md', 'other/x.md'];
    expect(folderIndex('notes/x.md', rels)).toBe('notes/index.md');
    expect(folderIndex('projects/p.md', ['projects/p.md', 'projects/projects.md'])).toBe('projects/projects.md');
    expect(approveFinding(f('note.orphan'), { rels }).ops).toEqual([{ op: 'addlink', rel: 'notes/index.md', line: '- [[notes/x]]', note: 'notes/x.md' }]);
    expect(approveFinding(f('note.orphan'), { rels: ['notes/x.md'] })).toMatchObject({ kind: 'keep', ops: [{ op: 'keep' }] });
    // a generated report or template named index is never written into
    const gen = (r) => r === 'notes/index.md';
    expect(folderIndex('notes/x.md', [...rels, 'notes/notes.md'], gen)).toBe('notes/notes.md');
    expect(approveFinding(f('note.orphan'), { rels, skip: gen })).toMatchObject({ kind: 'keep', ops: [{ op: 'keep' }] });
    expect(withLinkLine('# Index\n- [[a]]', '- [[x]]')).toBe('# Index\n- [[a]]\n- [[x]]\n');
    expect(withLinkLine('# Index\n- [[x]]\n', '- [[x]]')).toBe('# Index\n- [[x]]\n');
  });

  it('keeps an oversized note, a secret and a duplicate as they are', () => {
    for (const id of ['note.oversized', 'note.secret', 'note.duplicate']) expect(approveFinding(f(id)).says).toMatch(/Approve keeps the note as it is and marks the item done/);
  });
});

describe('review items and the planner', () => {
  it('turns each Approve into a plan step, keep included, so bulk works', () => {
    const keepFind = findingItem({ key: 'note.oversized:a.md', rel: 'a.md', approve: { kind: 'keep', ops: [{ op: 'keep' }] } });
    const stale = findingItem({ key: 'note.stale:b.md', rel: 'b.md', approve: { kind: 'setkey', ops: [{ op: 'setkey', rel: 'b.md', key: 'status', value: 'archived' }] } });
    const orphan1 = findingItem({ key: 'note.orphan:n/x.md', rel: 'n/x.md', approve: { kind: 'addlink', ops: [{ op: 'addlink', rel: 'n/index.md', line: '- [[x]]', note: 'n/x.md' }] } });
    const orphan2 = findingItem({ key: 'note.orphan:n/y.md', rel: 'n/y.md', approve: { kind: 'addlink', ops: [{ op: 'addlink', rel: 'n/index.md', line: '- [[y]]', note: 'n/y.md' }] } });
    const kept = pastFixItem({ run: { id: 'r9', key: 'kite', target: 'Kite' }, res: {}, plan: { ok: false, why: 'x', approve: { kind: 'keep', why: 'x', ops: [{ op: 'keep' }] } } });
    const git = pastFixItem({ run: { id: 'r8', key: 'lamp', target: 'Lamp' }, res: {}, plan: { ok: false, why: 'x', approve: { kind: 'git', why: 'x', ops: [{ op: 'restore', rel: 'c.md', before: 'old', expect: 'h' }] } } });
    expect(kept).toMatchObject({ keep: true, group: 'keep' });
    expect(kept.hold).toBeUndefined();
    expect(itemLine(kept)).toBe('Keep the earlier fix on “Kite” as it is');
    expect(itemLine(git)).toBe('Put back the notes the earlier fix on “Lamp” changed, from git history');
    expect(itemLine(stale)).toBe('Set status: archived in “b.md”');
    expect(itemLine(orphan1)).toBe('Link “n/x.md” from “n/index.md”');
    const p = buildPlan([keepFind, stale, orphan1, orphan2, kept, git]);
    expect(p.ok).toEqual(['r:pastfix:r9', 'r:pastfix:r8', 'r:find:note.oversized:a.md', 'r:find:note.stale:b.md', 'r:find:note.orphan:n/x.md', 'r:find:note.orphan:n/y.md']);
    expect(p.merged).toHaveLength(1);
    expect(p.groups.map((g) => g.label)).toEqual(['Put back 1 note an earlier fix changed', 'Update the frontmatter of 1 note', 'Link 2 notes from their folder indexes', 'Keep 2 items as they are']);
    expect(p.steps.at(-1).op).toEqual({ op: 'keep' });
    expect([keepFind, stale, orphan1, kept].map(checkFirst)).toEqual([null, null, null, null]);
    expect(groupOf(keepFind)).toBe('keep');
  });
});
