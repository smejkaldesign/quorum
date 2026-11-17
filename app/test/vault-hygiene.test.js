import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseNote } from '../linkparse.js';
import { findingItem, itemLine } from '../reviewItems.js';
import { approveFinding } from '../reviewApprove.js';
import { effects, groupOf } from '../batchPlan.js';
import { compactText, repeatedBlocks, run, rule } from '../rules/hygiene.js';
import { addIgnores, backupNote, commitNotes, gitState, litterKind, recordSizes, scanHygiene, scanLitter, stillLitter } from '../vaultHygiene.js';

// Synthetic vaults in the OS temp folder. Every name and line is made up.
const NOW = Date.UTC(2026, 10, 16);
const DAY = 86400000;
let dirs = [];
const fresh = (prefix = 'qhyg-') => { const d = mkdtempSync(path.join(tmpdir(), prefix)); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });
const put = (vault, rel, t) => { mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true }); writeFileSync(path.join(vault, rel), t); };
const note = (rel, text, extra = {}) => ({ rel, text, note: parseNote(rel, text), mtime: NOW - DAY, size: text.length, inbound: 1, outbound: 1, ...extra });
const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const repo = () => {
  const v = fresh('qhyg-git-');
  g(v, 'init', '-q', '-b', 'main');
  g(v, 'config', 'user.email', 'test@example.com');
  g(v, 'config', 'user.name', 'Test');
  g(v, 'config', 'commit.gpgsign', 'false');
  put(v, 'kept.md', '# Kept\n');
  put(v, '.gitignore', '.DS_Store\n');
  g(v, 'add', '.');
  g(v, 'commit', '-q', '-m', 'start');
  return v;
};
const old = (abs, days) => { const t = (Date.now() - days * DAY) / 1000; utimesSync(abs, t, t); };
// a block a script appends word for word on every run
const block = () => '## Auto capture\n\n- hook ran, nothing new\n';
const entry = (i) => `## Day ${i}\n\nWeight: ${170 + (i % 9)}\n`;

describe('litter folder names', () => {
  it('matches the names tools and tests give, and leaves real folders alone', () => {
    expect(litterKind('qrules-a8Bc2D')).toMatchObject({ kind: 'temp', ignore: 'qrules-??????/' });
    expect(litterKind('vault_x9k2pQ')).toMatchObject({ kind: 'temp', ignore: 'vault_??????/' });
    expect(litterKind('TemporaryDirectory.k3j2l1')).toMatchObject({ kind: 'temp', ignore: 'TemporaryDirectory.*/' });
    expect(litterKind('tmpa8x2kq91')).toMatchObject({ kind: 'temp' });
    expect(litterKind('index.lock')).toMatchObject({ kind: 'lock', ignore: '*.lock/' });
    expect(litterKind('node_modules')).toMatchObject({ kind: 'build', strict: true });
    for (const name of ['project-finale', 'notes', 'build', 'out', 'sessions', '2026-11-16', 'q3-review', 'design-system']) expect(litterKind(name)).toBeNull();
  });
});

describe('the litter scan', () => {
  it('finds temp folders at any depth with no linked note, and keeps folders a note links into', () => {
    const v = fresh();
    put(v, 'qrules-a8Bc2D/scratch.md', '# Scratch\n');
    put(v, 'qrules-a8Bc2D/data.json', '{"a":1}');
    put(v, 'tools/runs/TemporaryDirectory.k3j2l1/out.txt', 'x'.repeat(2048));
    put(v, 'kept-Zx9k2P/plan.md', '# Plan\n');
    put(v, 'web/node_modules/pkg/index.js', 'module.exports = 1;');
    put(v, 'dist/readme.md', '# A note in a dist folder\n');
    put(v, 'project-finale/notes.md', '# Finale\n');
    const found = scanLitter(v, new Set(['kept-Zx9k2P/plan.md']));
    expect(found.map((d) => [d.rel, d.kind])).toEqual([['qrules-a8Bc2D', 'temp'], ['tools/runs/TemporaryDirectory.k3j2l1', 'temp'], ['web/node_modules', 'build']]);
    expect(found[1].bytes).toBe(2048);
    expect(stillLitter(v, 'qrules-a8Bc2D', new Set())).toBe(true);
    expect(stillLitter(v, 'qrules-a8Bc2D', new Set(['qrules-a8Bc2D/scratch.md']))).toBe(false);
    expect(stillLitter(v, 'project-finale')).toBe(false);
  });
  it('writes one grouped item that says what Approve does, with git ignore patterns when the vault has a .gitignore', () => {
    const litter = [
      ...Array.from({ length: 3593 }, (_, i) => ({ rel: `qrules-a${String(i).padStart(4, '0')}Z`, kind: 'temp', ignore: 'qrules-??????/', bytes: 26800, files: 3 })),
    ];
    const [f] = run({ notes: [], hygiene: { litter, git: { repo: true, gitignore: '/v/.gitignore', dirty: [] } }, now: NOW });
    expect(f.ruleId).toBe(rule.id);
    expect(f.proposal).toBe('Move 3,593 temp folders (92 MB) from test runs to the Trash and ignore them in git.');
    expect(f.title).toBe('3,593 temp folders from test runs take 92 MB of the vault');
    expect(f.fix).toMatchObject({ kind: 'trashdirs', ignore: ['qrules-??????/'], gitignore: '/v/.gitignore' });
    const item = findingItem(f);
    expect(item.title).toBe(f.title);
    expect(itemLine(item)).toBe('Move 3,593 temp folders (92 MB) from test runs to the Trash and ignore them in git');
    expect(groupOf(item)).toBe('trashdirs');
    const [noGit] = run({ notes: [], hygiene: { litter: litter.slice(0, 1), git: { repo: false } }, now: NOW });
    expect(noGit.proposal).toBe('Move 1 temp folder (26 KB) from test runs to the Trash.');
    expect(noGit.fix.ignore).toEqual([]);
  });
  it('adds each ignore pattern once', () => {
    const v = fresh();
    put(v, '.gitignore', '.DS_Store');
    expect(addIgnores(path.join(v, '.gitignore'), ['qrules-??????/', '*.lock/'])).toEqual(['qrules-??????/', '*.lock/']);
    expect(addIgnores(path.join(v, '.gitignore'), ['qrules-??????/'])).toEqual([]);
    const text = readFileSync(path.join(v, '.gitignore'), 'utf8');
    expect(text.startsWith('.DS_Store\n')).toBe(true);
    expect(text.match(/qrules-\?{6}\//g)).toHaveLength(1);
  });
});

describe('runaway notes', () => {
  it('finds a block repeated word for word 20 or more times and keeps its first and last copy and everything else', () => {
    const text = `# Session log\n\nIntro line.\n\n${Array.from({ length: 25 }, (_, i) => (i === 12 ? entry(1) : block())).join('\n')}\n## Decisions\n\nShip it.\n`;
    expect(repeatedBlocks(text)).toEqual([{ heading: 'Auto capture', count: 24 }]);
    const c = compactText(text);
    expect(c.removed).toBe(22);
    expect(c.text).toContain('Intro line.');
    expect(c.text).toContain('## Day 1\n\nWeight: 171');
    expect(c.text).toContain('## Decisions\n\nShip it.');
    expect(c.text.match(/## Auto capture/g)).toHaveLength(2);
    expect(compactText(c.text).removed).toBe(0);
    expect(repeatedBlocks(Array.from({ length: 19 }, () => block()).join('\n'))).toEqual([]);
  });
  it('never treats numbered entries as copies: a different number is different data', () => {
    const text = `# Weight log\n\n${Array.from({ length: 60 }, (_, i) => entry(i + 1)).join('\n')}`;
    expect(repeatedBlocks(text)).toEqual([]);
    expect(compactText(text)).toMatchObject({ text, removed: 0 });
    // the same text with different whitespace is still a copy
    expect(repeatedBlocks(Array.from({ length: 20 }, (_, i) => `## Ping\n\nok${' '.repeat(i % 3)}\n`).join('\n'))).toEqual([{ heading: 'Ping', count: 20 }]);
  });
  it('splits only at the entry level, so identical sub-sections of different entries stay', () => {
    const text = `# Journal\n\n${Array.from({ length: 30 }, (_, i) => `## 2026-10-${String(i + 1).padStart(2, '0')}\n\nWrote page ${i}.\n\n### Checklist\n\n- [ ] stretch\n`).join('\n')}`;
    expect(repeatedBlocks(text)).toEqual([]);
    expect(compactText(text).text).toBe(text);
  });
  it('leaves a heading inside fenced code in its block', () => {
    const text = `# Note\n\n\`\`\`md\n## Not a heading\n\`\`\`\n${Array.from({ length: 20 }, () => block()).join('\n')}`;
    const c = compactText(text);
    expect(c.removed).toBe(18);
    expect(c.text).toContain('```md\n## Not a heading\n```');
  });
  it('offers to compact a note with repeats, and keeps a big note with none as it is', () => {
    const reps = note('memory/sessions/2026-11-16.md', `# Log\n${Array.from({ length: 30 }, () => block()).join('\n')}`);
    const big = note('notes/big.md', `# Big\n${'word '.repeat(220000)}`);
    const small = note('notes/small.md', '# Small\nShort.\n');
    const fs = run({ notes: [reps, big, small], hygiene: null, now: NOW });
    expect(fs.map((f) => f.key)).toEqual(['note.hygiene:runaway:memory/sessions/2026-11-16.md', 'note.hygiene:runaway:notes/big.md']);
    const [c, b] = fs;
    expect(c.fix).toMatchObject({ kind: 'compact', copies: 28 });
    expect(c.proposal).toBe('Save a backup copy in the hygiene-backups folder of Quorum’s data folder, then remove 28 copies of a block repeated word for word in “memory/sessions/2026-11-16.md”, keeping the first and last copy and the rest of the note. Undo in the activity history puts the note back.');
    expect(itemLine(findingItem(c))).toBe('Back up “memory/sessions/2026-11-16.md” to Quorum’s data folder, then remove 28 word-for-word repeated copies from it');
    expect(effects(findingItem(c).ops[0]).writes).toEqual([{ rel: 'memory/sessions/2026-11-16.md', region: 'all' }]);
    expect(b.fix).toBeUndefined();
    expect(b.title).toBe('“Big” is 1 MB');
    expect(approveFinding(b)).toEqual({ kind: 'keep', says: b.proposal, ops: [{ op: 'keep' }] });
  });
  it('flags a note that grew more than five times in a week, past the floor', () => {
    const grown = note('ops/agent-log.md', `# Agent log\n${'line of output\n'.repeat(6000)}`);
    const { before } = recordSizes({ 'ops/agent-log.md': [[NOW - 6 * DAY, 12000]] }, [grown], NOW);
    expect(before['ops/agent-log.md']).toBe(12000);
    const [f] = run({ notes: [grown], hygiene: { history: before }, now: NOW });
    expect(f.title).toMatch(/grew from 12 KB to 88 KB in a week/);
    const tiny = note('ops/tiny.md', 'x'.repeat(9000));
    expect(run({ notes: [tiny], hygiene: { history: { 'ops/tiny.md': 1000 } }, now: NOW })).toEqual([]);
  });
  it('keeps one size sample per six hours and drops samples older than eight days', () => {
    const n = { rel: 'a.md', size: 50 };
    const h1 = recordSizes({ 'a.md': [[NOW - 9 * DAY, 1], [NOW - 3600000, 40]] }, [n], NOW).history;
    expect(h1['a.md']).toEqual([[NOW - 3600000, 40]]);
    expect(recordSizes(h1, [n], NOW + 7 * 3600000).history['a.md']).toEqual([[NOW - 3600000, 40], [NOW + 7 * 3600000, 50]]);
  });
  it('writes a backup copy to the data folder', () => {
    const v = fresh();
    const data = fresh('qhyg-data-');
    put(v, 'memory/log.md', '# Log\n');
    const to = backupNote(data, v, 'memory/log.md', NOW);
    expect(readFileSync(to, 'utf8')).toBe('# Log\n');
    expect(path.basename(to)).toMatch(/memory__log\.md$/);
  });
});

describe('uncommitted notes', () => {
  it('groups notes untracked or changed for over a week, and commits them on Approve', () => {
    const v = repo();
    put(v, 'projects/a.md', '# A\n');
    put(v, 'projects/b.md', '# B\n');
    put(v, 'inbox/fresh.md', '# Fresh\n');
    put(v, 'kept.md', '# Kept\nChanged.\n');
    put(v, 'scripts/run.py', 'print(1)\n');
    for (const r of ['projects/a.md', 'projects/b.md', 'kept.md']) old(path.join(v, r), 10);
    const state = gitState(v);
    expect(state).toMatchObject({ repo: true, branch: 'main', behind: 0, merging: null, gitignore: path.join(v, '.gitignore') });
    expect(state.dirty.map((d) => d.rel).sort()).toEqual(['inbox/fresh.md', 'kept.md', 'projects/a.md', 'projects/b.md']);
    const [f] = run({ notes: [], hygiene: { litter: [], git: state }, now: Date.now() });
    expect(f.title).toBe('3 notes in 2 folders have gone uncommitted for over 7 days');
    expect(f.proposal).toBe('Stage and commit 3 notes on main with the message “Commit 3 notes in 2 folders left uncommitted for over 7 days”.');
    expect(f.fix.paths.sort()).toEqual(['kept.md', 'projects/a.md', 'projects/b.md']);
    put(v, 'other.txt', 'staged by the person\n');
    g(v, 'add', 'other.txt');
    expect(commitNotes(v, f.fix.paths, f.fix.message)).toEqual({ branch: 'main', count: 3 });
    expect(g(v, 'log', '-1', '--format=%s').trim()).toBe(f.fix.message);
    expect(g(v, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort()).toEqual(['kept.md', 'projects/a.md', 'projects/b.md']);
    // what the person staged stays staged and out of the commit
    expect(g(v, 'diff', '--cached', '--name-only').trim()).toBe('other.txt');
  });
  it('reads only the vault folder of a larger repository', () => {
    const top = repo();
    put(top, 'MyBrain/notes/x.md', '# X\n');
    put(top, 'code/readme.md', '# Code\n');
    const state = gitState(path.join(top, 'MyBrain'));
    expect(state.dirty.map((d) => d.rel)).toEqual(['notes/x.md']);
    expect(state.prefix).toBe('MyBrain/');
  });
  it('does not commit mid-merge or behind the upstream, and says why', () => {
    const v = repo();
    put(v, 'a.md', '# A\n');
    old(path.join(v, 'a.md'), 9);
    writeFileSync(path.join(v, '.git', 'MERGE_HEAD'), 'deadbeef\n');
    const merging = gitState(v);
    expect(merging.merging).toBe('merge');
    const [f] = run({ notes: [], hygiene: { litter: [], git: merging }, now: Date.now() });
    expect(f.fix).toBeUndefined();
    expect(f.proposal).toBe('Quorum does not commit while a merge is in progress on main. Approve keeps the notes as they are and marks the item done.');
    expect(() => commitNotes(v, ['a.md'], 'x')).toThrow(/A merge is in progress/);
    rmSync(path.join(v, '.git', 'MERGE_HEAD'));
    // a status that reports the branch 2 commits behind its upstream
    const exec = (cmd, args, opts) => (args[0] === 'status' ? '# branch.oid abc\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +0 -2\0? a.md\0' : execFileSync(cmd, args, opts));
    const behind = gitState(v, { exec });
    expect(behind).toMatchObject({ behind: 2, upstream: 'origin/main' });
    const [b] = run({ notes: [], hygiene: { litter: [], git: behind }, now: Date.now() });
    expect(b.proposal).toMatch(/^Quorum does not commit while the branch main is 2 commits behind origin\/main\./);
    expect(() => commitNotes(v, ['a.md'], 'x', { exec })).toThrow(/2 commits behind origin\/main/);
    expect(g(v, 'log', '--format=%s').trim()).toBe('start');
  });
  it('answers no repository outside git, and the scan leaves litter out of the uncommitted notes', () => {
    const plain = fresh();
    expect(gitState(plain)).toEqual({ repo: false });
    const v = repo();
    put(v, 'qrules-a8Bc2D/x.md', '# temp\n');
    put(v, 'notes/n.md', '# N\n');
    old(path.join(v, 'qrules-a8Bc2D/x.md'), 30);
    old(path.join(v, 'notes/n.md'), 30);
    const data = fresh('qhyg-data-');
    const h = scanHygiene({ vault: v, notes: [{ rel: 'notes/n.md', size: 6, inbound: 0 }], file: path.join(data, 'memory-hygiene.json'), now: NOW });
    expect(h.litter.map((d) => d.rel)).toEqual(['qrules-a8Bc2D']);
    expect(h.git.dirty.map((d) => d.rel)).toEqual(['notes/n.md']);
    expect(existsSync(path.join(data, 'memory-hygiene.json'))).toBe(true);
    expect(readdirSync(data)).toEqual(['memory-hygiene.json']);
  });
});
