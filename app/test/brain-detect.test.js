// Finding the Agent OS folder and the notes folder in the folder the person picks (brainDetect.js).
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findRoot, inspectBrain, noteCount, savedBrain, structured, vaultSignals } from '../brainDetect.js';
import { createVault } from '../onboarding.js';

const base = mkdtempSync('/tmp/qbrain-');
afterAll(() => rmSync(base, { recursive: true, force: true }));
// a home folder that holds none of the fixtures, so the person's own ~/.claude never counts
const away = '/tmp/qbrain-home-none';

let n = 0;
function tree(files, at = base) {
  const dir = path.join(at, `case-${n++}`);
  build(dir, files);
  return dir;
}
function build(dir, files) {
  mkdirSync(dir, { recursive: true });
  for (const rel of files) {
    const abs = path.join(dir, rel);
    if (rel.endsWith('/')) mkdirSync(abs, { recursive: true });
    else { mkdirSync(path.dirname(abs), { recursive: true }); writeFileSync(abs, '---\nowner: someone@example.com\n---\n# note\n'); }
  }
}
const inspect = (folder, home = away) => inspectBrain(folder, { home });

const AGENT_OS = [
  'CLAUDE.md', '.claude/hooks/output-secret-tripwire.py',
  'MyBrain/index.md', 'MyBrain/01-daily/2026-01-02.md', 'MyBrain/08-meetings/standup.md', 'MyBrain/04-projects/alpha.md',
];

describe('inspectBrain on a picked folder', () => {
  it('connects an Obsidian vault exactly as before', () => {
    const dir = tree(['.obsidian/', 'a.md', 'b.md']);
    const b = inspect(dir);
    expect(b).toMatchObject({ root: dir, vault: dir, name: path.basename(dir) });
    expect(b.markers).toMatchObject({ agentOS: null, obsidian: true, notes: true, found: 'obsidian' });
  });

  it('uses the Obsidian vault under a CLAUDE.md root', () => {
    const dir = tree(['CLAUDE.md', 'MyBrain/.obsidian/', 'MyBrain/a.md']);
    const b = inspect(dir);
    expect(b).toMatchObject({ root: dir, vault: path.join(dir, 'MyBrain') });
    expect(b.markers).toMatchObject({ agentOS: 'CLAUDE.md', obsidian: true });
  });

  it('finds the notes in MyBrain when the Agent OS folder is picked and there is no .obsidian, and asks to confirm', () => {
    const dir = tree(AGENT_OS);
    const b = inspect(dir);
    expect(b).toMatchObject({ root: dir, vault: path.join(dir, 'MyBrain'), name: 'MyBrain' });
    expect(b.markers).toMatchObject({ agentOS: 'CLAUDE.md', obsidian: false, safetyHooks: true, notes: true, found: 'child' });
  });

  it('finds MyBrain in an Agent OS folder that is also a code project', () => {
    const dir = tree([...AGENT_OS, 'package.json']);
    expect(inspect(dir).vault).toBe(path.join(dir, 'MyBrain'));
  });

  it('keeps MyBrain as the notes folder when it is picked directly, with the Agent OS found above it', () => {
    const dir = tree(AGENT_OS);
    const b = inspect(path.join(dir, 'MyBrain'));
    expect(b).toMatchObject({ root: dir, vault: path.join(dir, 'MyBrain') });
    expect(b.markers).toMatchObject({ safetyHooks: true, found: 'structure' });
  });

  it('walks past a CLAUDE.md inside MyBrain to the parent with .claude/', () => {
    const dir = tree([...AGENT_OS, 'MyBrain/CLAUDE.md']);
    const b = inspect(path.join(dir, 'MyBrain'));
    expect(b).toMatchObject({ root: dir, vault: path.join(dir, 'MyBrain') });
    expect(b.markers).toMatchObject({ agentOS: 'CLAUDE.md', safetyHooks: true });
  });

  it('connects a plain folder of notes as the notes folder', () => {
    const dir = tree(['one.md', 'two.md', 'three.md', 'four.md', 'topics/five.md', 'topics/six.md']);
    const b = inspect(dir);
    expect(b).toMatchObject({ root: dir, vault: dir });
    expect(b.markers).toMatchObject({ agentOS: null, obsidian: false, notes: true, found: 'notes' });
  });

  it('keeps a folder that is itself the notes folder', () => {
    const dir = tree(['CLAUDE.md', '.claude/', 'index.md', '01-daily/2026-01-02.md', '08-meetings/', 'archive/index.md', 'archive/01-daily/', 'archive/08-meetings/']);
    expect(inspect(dir)).toMatchObject({ root: dir, vault: dir, markers: { found: 'structure' } });
  });

  it('reports no notes for a folder with nothing that looks like notes', () => {
    const dir = tree(['CLAUDE.md', 'src/app.js']);
    const b = inspect(dir);
    expect(b).toMatchObject({ root: dir, vault: dir });
    expect(b.markers).toMatchObject({ notes: false, found: 'none' });
  });

  it('does not pick a subfolder when two look the same', () => {
    const dir = tree(['CLAUDE.md', 'a/01-daily/x.md', 'a/08-meetings/', 'b/01-daily/y.md', 'b/08-meetings/']);
    expect(inspect(dir).vault).toBe(dir);
  });
});

describe('notes that are not a vault', () => {
  it('needs more than a lone meetings or daily folder', () => {
    expect(structured(tree(['meetings/a.md']))).toBe(false);
    expect(structured(tree(['daily/2026-01-02.md']))).toBe(false);
  });

  it('does not treat a web app with a meetings route folder as notes', () => {
    const dir = tree(['package.json', 'index.md', 'meetings/page.md', 'src/app.js']);
    expect(structured(dir)).toBe(false);
    expect(inspect(dir).markers.found).toBe('none');
  });

  it('does not take a repo subfolder with index.md and projects/ as notes', () => {
    const dir = tree(['site/index.md', 'site/projects/a.md', 'other/README.md']);
    expect(inspect(dir)).toMatchObject({ vault: dir });
    expect(inspect(dir).markers.found).not.toBe('child');
  });

  it('does not count the usual repo files as notes', () => {
    const dir = tree(['README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md', 'LICENSE.md', 'src/app.js']);
    expect(noteCount(dir)).toBe(0);
    expect(inspect(dir).markers.found).toBe('none');
  });

  it('asks about a code project full of docs', () => {
    const dir = tree(['package.json', 'docs/a.md', 'docs/b.md', 'docs/c.md', 'docs/d.md', 'docs/e.md', 'docs/f.md']);
    expect(inspect(dir).markers.found).toBe('none');
  });

  it('never picks a subfolder of the home folder when home is picked', () => {
    const home = tree(['Work/Meetings/a.md', 'Work/Projects/b.md', 'Work/index.md']);
    const b = inspect(home, home);
    expect(b).toMatchObject({ root: home, vault: home });
    expect(b.markers.found).not.toBe('child');
  });
});

describe('symlinked folders', () => {
  it('counts symlinked daily and meetings folders', () => {
    const other = tree(['daily/2026-01-02.md', 'meetings/standup.md']);
    const dir = tree(['index.md']);
    symlinkSync(path.join(other, 'daily'), path.join(dir, '01-daily'));
    symlinkSync(path.join(other, 'meetings'), path.join(dir, '08-meetings'));
    expect(vaultSignals(dir)).toMatchObject({ daily: true, meetings: true });
    expect(inspect(dir)).toMatchObject({ vault: dir, markers: { found: 'structure' } });
  });

  it('stops on a symlink that points back up and counts a folder reached twice once', () => {
    const dir = tree(['a.md', 'sub/b.md']);
    symlinkSync(dir, path.join(dir, 'loop'));
    symlinkSync(path.join(dir, 'sub'), path.join(dir, 'again'));
    expect(noteCount(dir)).toBe(2);
  });

  it('leaves out a broken symlink', () => {
    const dir = tree(['a.md']);
    symlinkSync(path.join(dir, 'gone'), path.join(dir, 'broken.md'));
    expect(noteCount(dir)).toBe(1);
  });
});

describe('findRoot', () => {
  it('stops at the first CLAUDE.md when no folder has an agent folder beside it', () => {
    const dir = tree(['CLAUDE.md', 'MyBrain/CLAUDE.md', 'MyBrain/index.md']);
    expect(findRoot(path.join(dir, 'MyBrain'), away)).toBe(path.join(dir, 'MyBrain'));
  });

  it('accepts AGENTS.md beside .agents/', () => {
    const dir = tree(['AGENTS.md', '.agents/', 'notes/CLAUDE.md']);
    expect(findRoot(path.join(dir, 'notes'), away)).toBe(dir);
  });

  it('keeps a folder with its own CLAUDE.md that is not a notes subfolder', () => {
    const dir = tree(['CLAUDE.md', '.claude/', 'Journal/CLAUDE.md', 'Journal/index.md']);
    expect(findRoot(path.join(dir, 'Journal'), away)).toBe(path.join(dir, 'Journal'));
  });

  it('keeps an Obsidian vault with its own CLAUDE.md, as before', () => {
    const dir = tree(['CLAUDE.md', '.claude/', 'notes/CLAUDE.md', 'notes/.obsidian/']);
    expect(findRoot(path.join(dir, 'notes'), away)).toBe(path.join(dir, 'notes'));
  });

  it('never picks the home folder, even when it holds the only CLAUDE.md', () => {
    const home = tree(['CLAUDE.md', '.claude/', 'Documents/notes/a.md']);
    expect(findRoot(path.join(home, 'Documents', 'notes'), home)).toBe(path.join(home, 'Documents', 'notes'));
  });

  it('never takes the home folder over a CLAUDE.md below it', () => {
    const home = tree(['CLAUDE.md', '.claude/', 'vault/CLAUDE.md']);
    expect(findRoot(path.join(home, 'vault'), home)).toBe(path.join(home, 'vault'));
  });

  it('keeps a Quorum-built folder as its own Agent OS inside a folder with CLAUDE.md and .claude/', () => {
    const home = tree([]);
    const docs = path.join(home, 'Documents');
    build(docs, ['CLAUDE.md', '.claude/']);
    const quorum = path.join(docs, 'Quorum');
    createVault(quorum, 'My Agent OS');
    expect(findRoot(quorum, home)).toBe(quorum);
    expect(inspect(quorum, home)).toMatchObject({ root: quorum, vault: quorum });
  });

  it('keeps a folder Quorum built with its setup file as its own Agent OS', () => {
    const home = tree([]);
    const parent = path.join(home, 'agents');
    build(parent, ['CLAUDE.md', '.claude/', 'notes/CLAUDE.md', 'notes/.quorum/setup.json']);
    expect(findRoot(path.join(parent, 'notes'), home)).toBe(path.join(parent, 'notes'));
  });
});

describe('saved folders', () => {
  it('keeps a pre-update Obsidian connection exactly as saved', () => {
    const home = tree([]);
    const code = path.join(home, 'code');
    build(code, ['CLAUDE.md', '.claude/', 'notes/CLAUDE.md', 'notes/.obsidian/', 'notes/a.md']);
    const settings = { brainRoot: path.join(code, 'notes'), vaultPath: path.join(code, 'notes'), brainMade: null };
    const b = savedBrain(settings, home);
    expect(b).toMatchObject({ root: settings.brainRoot, vault: settings.vaultPath });
  });

  it('keeps a pre-update MyBrain connection exactly as saved, even when detection would now pick the parent', () => {
    const home = tree([]);
    const os = path.join(home, 'agent-os');
    build(os, [...AGENT_OS, 'MyBrain/CLAUDE.md']);
    const settings = { brainRoot: path.join(os, 'MyBrain'), vaultPath: path.join(os, 'MyBrain') };
    expect(savedBrain(settings, home)).toMatchObject({ root: settings.brainRoot, vault: settings.vaultPath });
    expect(inspect(path.join(os, 'MyBrain'), home).root).toBe(os);
  });

  it('keeps the Agent OS folder when the notes folder is outside it', () => {
    const os = tree(AGENT_OS);
    const elsewhere = tree(['a.md']);
    const b = inspectBrain(elsewhere, { root: os, vault: elsewhere, home: away });
    expect(b).toMatchObject({ root: os, vault: elsewhere, name: path.basename(elsewhere), markers: { found: 'chosen', safetyHooks: true } });
  });

  it('has no Agent OS without a saved folder', () => {
    expect(savedBrain({ brainRoot: null, vaultPath: null })).toBeNull();
  });
});
