import { chmodSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkConnection, deniedBy, globRe, ignoredBy, ignoreRules, scriptExcludes, searchProblems } from '../connectionCheck.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'qcheck-'));
const put = (f, text) => { mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, text); };
const noGit = async () => null;
const agent = ({ claude = { installed: true, added: true }, codex = { installed: false, added: false }, server = { ok: true }, cli = { added: true, where: 'path', path: '/h/.local/bin/quorum', onPath: true, resolves: '/h/.local/bin/quorum', error: null } } = {}) => ({
  claude: { status: async () => claude }, codex: { status: async () => codex }, handshake: async () => server, cli: { status: async () => cli },
});
const byId = (r) => Object.fromEntries(r.checks.map((c) => [c.id, c]));

describe('ignore files', () => {
  it('reads gitignore patterns: folders, anchors, globs and negation', () => {
    expect(globRe('**/meetings').test('a/b/meetings')).toBe(true);
    expect(globRe('**/meetings').test('meetings')).toBe(true);
    expect(globRe('*.md').test('a/b.md')).toBe(false);
    const [r] = ignoreRules('# c\n\nMeetings/\n');
    expect(r).toMatchObject({ dirOnly: true, anchored: false, raw: 'Meetings/' });
  });
  it('finds the file and line that hide a note, honoring later negation and nested files', () => {
    const root = tmp();
    const note = path.join(root, '20-meetings', 'quorum', 'n.md');
    expect(ignoredBy(root, note)).toBe(null);
    put(path.join(root, '.gitignore'), 'node_modules\n20-meetings/\n');
    expect(ignoredBy(root, note)).toEqual({ file: path.join(root, '.gitignore'), pattern: '20-meetings/' });
    put(path.join(root, '.gitignore'), '/20-meetings/*\n!/20-meetings/quorum/\n');
    expect(ignoredBy(root, note)).toBe(null);
    put(path.join(root, '20-meetings', '.rgignore'), 'quorum\n');
    expect(ignoredBy(root, note)).toEqual({ file: path.join(root, '20-meetings', '.rgignore'), pattern: 'quorum' });
  });
  it('a file pattern matches by name anywhere, and the parent folder rule hides everything under it', () => {
    const root = tmp();
    put(path.join(root, '.ignore'), '*.md\n');
    expect(ignoredBy(root, path.join(root, 'm', 'q', 'n.md'))?.pattern).toBe('*.md');
    put(path.join(root, '.ignore'), 'm\n!m/q/n.md\n');
    expect(ignoredBy(root, path.join(root, 'm', 'q', 'n.md'))?.pattern).toBe('m');
  });
});

describe('Claude Code deny rules and search scripts', () => {
  it('finds a Read deny that covers the notes folder', () => {
    const root = tmp();
    const home = tmp();
    const note = path.join(root, 'Meetings', 'quorum', 'n.md');
    put(path.join(root, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: ['Bash(rm:*)', 'Read(./Meetings/**)'] } }));
    expect(deniedBy(root, note, home)).toEqual({ file: path.join(root, '.claude', 'settings.json'), rule: 'Read(./Meetings/**)' });
    put(path.join(root, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: ['Read(./Other/**)'] } }));
    expect(deniedBy(root, note, home)).toBe(null);
    put(path.join(home, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: [`Read(/${root}/Meetings/**)`] } }));
    expect(deniedBy(root, note, home)?.rule).toContain('Meetings');
  });
  it('finds a search script whose exclude list names the notes folder, across lines', () => {
    const root = tmp();
    const note = path.join(root, 'Meetings', 'quorum', 'n.md');
    put(path.join(root, 'scripts', 'search-memory.py'), 'import os\nEXCLUDE_DIRS = {\n    ".git",\n    "node_modules",\n    "Meetings",\n}\n');
    put(path.join(root, 'scripts', 'deploy.sh'), 'SKIP="Meetings"\n');
    put(path.join(root, 'scripts', 'index.mjs'), "const ignore = ['drafts/'];\n");
    expect(scriptExcludes(root, note)).toEqual([{ file: path.join(root, 'scripts', 'search-memory.py'), name: 'Meetings' }]);
  });
  it('lists every reason as data, with no instruction to edit the folder', async () => {
    const root = tmp();
    const note = path.join(root, '.notes', 'quorum', 'n.md');
    put(path.join(root, '.gitignore'), '.notes\n');
    const out = await searchProblems(root, note, { home: tmp(), git: noGit });
    expect(out).toEqual([{ kind: 'hidden', name: '.notes' }, { kind: 'ignored', file: path.join(root, '.gitignore'), pattern: '.notes' }]);
  });
  it('asks git when the folder is a work tree and the ignore files say nothing', async () => {
    const root = tmp();
    mkdirSync(path.join(root, '.git'));
    const seen = [];
    const git = async (cwd) => { seen.push(cwd); return { file: path.join(root, '.git', 'info', 'global'), pattern: 'quorum/' }; };
    const out = await searchProblems(root, path.join(root, 'M', 'quorum', 'n.md'), { home: tmp(), git });
    expect(seen).toEqual([root]);
    expect(out[0]).toMatchObject({ kind: 'ignored', pattern: 'quorum/' });
  });
});

// every fix is a Quorum action and no sentence asks for an edit in the Agent OS folder
const VAULT_EDIT = /\b(remove|edit|delete|rename|change)\b.*\b(line|\.gitignore|script|CLAUDE\.md|exclude)/i;
const noVaultEdits = (r) => { for (const c of r.checks) { expect(c.fix ?? '').not.toMatch(VAULT_EDIT); if (c.state === 'fail') expect(c.action).toBeTruthy(); } };
const snapshot = (dir) => readdirSync(dir, { recursive: true }).map(String).sort();

describe('checkConnection', () => {
  it('passes and writes nothing when Quorum has not made its notes folder yet', async () => {
    const root = tmp();
    mkdirSync(path.join(root, 'Meetings'));
    const before = snapshot(root);
    const r = await checkConnection({ root, notesDir: path.join(root, 'Meetings', 'quorum'), agent: agent(), home: tmp(), git: noGit });
    expect(r.ok).toBe(true);
    expect(r.checks.map((c) => [c.id, c.state])).toEqual([['folder', 'ok'], ['note', 'skip'], ['search', 'ok'], ['claude', 'ok'], ['codex', 'skip'], ['server', 'ok'], ['cli', 'ok']]);
    expect(snapshot(root)).toEqual(before);
  });
  it('saves the test note only in the existing Quorum folder and removes it', async () => {
    const root = tmp();
    const notesDir = path.join(root, 'Meetings', 'quorum');
    put(path.join(notesDir, 'kept.md'), 'x');
    const before = snapshot(root);
    const r = await checkConnection({ root, notesDir, agent: agent(), home: tmp(), git: noGit });
    expect(byId(r).note).toMatchObject({ state: 'ok' });
    expect(snapshot(root)).toEqual(before);
  });
  it('counts notes the agent search skips as covered by Quorum search, and never asks for a vault edit', async () => {
    const root = tmp();
    const notesDir = path.join(root, 'Meetings', 'quorum');
    put(path.join(notesDir, 'kept.md'), 'x');
    put(path.join(root, '.gitignore'), 'Meetings/\n');
    put(path.join(root, 'scripts', 'search.py'), 'EXCLUDE = ["Meetings"]\n');
    const covered = await checkConnection({ root, notesDir, agent: agent(), home: tmp(), git: noGit });
    expect(byId(covered).search).toMatchObject({ state: 'ok', fix: null, detail: "Your agent finds these through Quorum's search tools." });
    expect(covered.ok).toBe(true);
    noVaultEdits(covered);
    const noMcp = await checkConnection({ root, notesDir, agent: agent({ claude: { installed: true, added: false } }), home: tmp(), git: noGit });
    expect(byId(noMcp).search.state).toBe('warn');
    expect(byId(noMcp).claude).toMatchObject({ state: 'fail', action: 'add-claude' });
    noVaultEdits(noMcp);
    const outside = await checkConnection({ root, notesDir: path.join(tmp(), 'quorum'), agent: agent(), git: noGit });
    expect(byId(outside).search).toMatchObject({ state: 'ok', detail: expect.stringContaining("Quorum's search tools") });
  });
  it('offers a folder picker for a missing folder or one Quorum cannot write', async () => {
    expect(byId(await checkConnection({ root: null, notesDir: null, agent: agent() })).folder.action).toBe('connect-folder');
    const root = tmp();
    expect(byId(await checkConnection({ root, notesDir: null, agent: agent() })).folder.action).toBe('choose-meetings');
    const locked = path.join(root, 'Locked');
    mkdirSync(path.join(locked, 'quorum'), { recursive: true });
    chmodSync(path.join(locked, 'quorum'), 0o555);
    chmodSync(locked, 0o555);
    const a = await checkConnection({ root, notesDir: path.join(locked, 'quorum'), agent: agent(), git: noGit });
    const b = await checkConnection({ root, notesDir: path.join(locked, 'new'), agent: agent(), git: noGit });
    chmodSync(locked, 0o755);
    chmodSync(path.join(locked, 'quorum'), 0o755);
    for (const r of [a, b]) { expect(byId(r).folder).toMatchObject({ state: 'fail', action: 'choose-meetings', fix: expect.stringMatching(/^Quorum cannot save notes in /) }); noVaultEdits(r); }
  });
  it('gives each agent, the server and the command a fix button', async () => {
    const root = tmp();
    const notesDir = path.join(root, 'M', 'quorum');
    const none = await checkConnection({ root, notesDir, git: noGit, agent: agent({ claude: { installed: false, added: false }, server: { ok: false }, cli: { added: false } }) });
    expect(byId(none).claude.state).toBe('skip');
    expect(byId(none).server).toMatchObject({ state: 'fail', action: 'retry' });
    expect(byId(none).cli).toMatchObject({ state: 'fail', action: 'add-cli' });
    noVaultEdits(none);
    const codex = await checkConnection({ root, notesDir, git: noGit, agent: agent({ codex: { installed: true, added: true, error: 'Turned off in Codex' } }) });
    expect(byId(codex).codex).toMatchObject({ state: 'fail', action: 'add-codex' });
    const shadowed = await checkConnection({ root, notesDir, git: noGit, agent: agent({ cli: { added: true, where: 'path', path: '/h/.local/bin/quorum', onPath: true, resolves: '/opt/homebrew/bin/quorum', error: null } }) });
    expect(byId(shadowed).cli).toMatchObject({ state: 'fail', action: 'fix-cli' });
    const withAlias = await checkConnection({ root, notesDir, git: noGit, agent: agent({ cli: { added: true, where: 'path', path: '/h/.local/bin/quorum', onPath: true, alias: true, resolves: "alias quorum='x'", error: null } }) });
    expect(byId(withAlias).cli).toMatchObject({ state: 'ok', detail: 'Works in Terminal windows you open from now on.' });
    const offPath = await checkConnection({ root, notesDir, git: noGit, agent: agent({ cli: { added: true, where: 'path', path: '/h/.local/bin/quorum', onPath: false, resolves: '', error: null } }) });
    expect(byId(offPath).cli.action).toBe('fix-cli');
  });
});
