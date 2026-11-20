// Finding the agent root and the notes vault in the folder the person picks (brainDetect.js).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findRoot, inspectBrain, vaultScore } from '../brainDetect.js';

const base = mkdtempSync('/tmp/qbrain-');
afterAll(() => rmSync(base, { recursive: true, force: true }));
// a home folder that sits outside every fixture, so the person's own ~/.claude never counts
const home = '/tmp/qbrain-home-none';

let n = 0;
function tree(files) {
  const dir = path.join(base, `case-${n++}`);
  for (const rel of files) {
    const abs = path.join(dir, rel);
    if (rel.endsWith('/')) mkdirSync(abs, { recursive: true });
    else { mkdirSync(path.dirname(abs), { recursive: true }); writeFileSync(abs, '---\nowner: someone@example.com\n---\n# note\n'); }
  }
  return dir;
}
const inspect = (folder) => inspectBrain(folder, { home });

const AGENT_OS = [
  'CLAUDE.md', '.claude/hooks/output-secret-tripwire.py',
  'MyBrain/index.md', 'MyBrain/01-daily/2026-01-02.md', 'MyBrain/08-meetings/standup.md', 'MyBrain/04-projects/alpha.md',
];

describe('inspectBrain', () => {
  it('connects an Obsidian vault exactly as before', () => {
    const dir = tree(['.obsidian/', 'a.md', 'b.md']);
    const b = inspect(dir);
    expect(b).toMatchObject({ root: dir, vault: dir, name: path.basename(dir) });
    expect(b.markers).toMatchObject({ agentOS: null, obsidian: true, notes: true });
  });

  it('uses the Obsidian vault under a CLAUDE.md root', () => {
    const dir = tree(['CLAUDE.md', 'MyBrain/.obsidian/', 'MyBrain/a.md']);
    const b = inspect(dir);
    expect(b).toMatchObject({ root: dir, vault: path.join(dir, 'MyBrain') });
    expect(b.markers).toMatchObject({ agentOS: 'CLAUDE.md', obsidian: true });
  });

  it('finds the notes in MyBrain when the root is picked and there is no .obsidian', () => {
    const dir = tree(AGENT_OS);
    const b = inspect(dir);
    expect(b).toMatchObject({ root: dir, vault: path.join(dir, 'MyBrain'), name: 'MyBrain' });
    expect(b.markers).toMatchObject({ agentOS: 'CLAUDE.md', obsidian: false, safetyHooks: true, notes: true });
  });

  it('keeps MyBrain as the vault when it is picked directly, with the root found above it', () => {
    const dir = tree(AGENT_OS);
    const b = inspect(path.join(dir, 'MyBrain'));
    expect(b).toMatchObject({ root: dir, vault: path.join(dir, 'MyBrain') });
    expect(b.markers.safetyHooks).toBe(true);
  });

  it('walks past a CLAUDE.md inside the vault to the parent with .claude/', () => {
    const dir = tree([...AGENT_OS, 'MyBrain/CLAUDE.md']);
    const b = inspect(path.join(dir, 'MyBrain'));
    expect(b).toMatchObject({ root: dir, vault: path.join(dir, 'MyBrain') });
    expect(b.markers).toMatchObject({ agentOS: 'CLAUDE.md', safetyHooks: true });
  });

  it('connects a plain folder of notes as the vault', () => {
    const dir = tree(['one.md', 'two.md', 'three.md', 'four.md', 'topics/five.md', 'topics/six.md']);
    const b = inspect(dir);
    expect(b).toMatchObject({ root: dir, vault: dir });
    expect(b.markers).toMatchObject({ agentOS: null, obsidian: false, notes: true });
  });

  it('keeps a root that is itself the vault', () => {
    const dir = tree(['CLAUDE.md', '.claude/', 'index.md', '01-daily/2026-01-02.md', '08-meetings/', 'archive/index.md', 'archive/01-daily/', 'archive/08-meetings/']);
    expect(inspect(dir)).toMatchObject({ root: dir, vault: dir });
  });

  it('reports no notes for a folder with nothing that looks like a vault', () => {
    const dir = tree(['CLAUDE.md', 'src/app.js']);
    const b = inspect(dir);
    expect(b).toMatchObject({ root: dir, vault: dir });
    expect(b.markers.notes).toBe(false);
  });

  it('keeps a notes folder the person chose', () => {
    const dir = tree([...AGENT_OS, 'other/x.md']);
    const b = inspectBrain(dir, { vault: path.join(dir, 'other'), home });
    expect(b).toMatchObject({ root: dir, vault: path.join(dir, 'other'), name: 'other' });
  });

  it('does not pick a subfolder when two look the same', () => {
    const dir = tree(['CLAUDE.md', 'a/01-daily/', 'a/08-meetings/', 'b/01-daily/', 'b/08-meetings/']);
    expect(inspect(dir).vault).toBe(dir);
  });
});

describe('findRoot', () => {
  it('stops at the first CLAUDE.md when no folder has an agent folder beside it', () => {
    const dir = tree(['CLAUDE.md', 'MyBrain/CLAUDE.md', 'MyBrain/index.md']);
    expect(findRoot(path.join(dir, 'MyBrain'), home)).toBe(path.join(dir, 'MyBrain'));
  });

  it('accepts AGENTS.md beside .agents/', () => {
    const dir = tree(['AGENTS.md', '.agents/', 'notes/CLAUDE.md']);
    expect(findRoot(path.join(dir, 'notes'), home)).toBe(dir);
  });

  it('never takes the home folder over a CLAUDE.md below it', () => {
    const dir = tree(['CLAUDE.md', '.claude/', 'vault/CLAUDE.md']);
    expect(findRoot(path.join(dir, 'vault'), dir)).toBe(path.join(dir, 'vault'));
  });
});

describe('vaultScore', () => {
  it('scores daily and meetings folders, numbered folders and index.md', () => {
    const dir = tree(['index.md', '01-daily/', '08-meetings/', '04-projects/']);
    expect(vaultScore(dir)).toBe(7);
    expect(vaultScore(tree(['src/', 'README.md']))).toBe(0);
  });
});
