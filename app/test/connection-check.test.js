import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
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
  it('lists every reason, each with its fix', async () => {
    const root = tmp();
    const note = path.join(root, '.notes', 'quorum', 'n.md');
    put(path.join(root, '.gitignore'), '.notes\n');
    const out = await searchProblems(root, note, { home: tmp(), git: noGit });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatch(/^The folder "\.notes" starts with a dot/);
    expect(out[1]).toBe('.gitignore hides .notes/quorum from your agent\'s search. Remove the line ".notes" from .gitignore.');
  });
  it('asks git when the folder is a work tree and the ignore files say nothing', async () => {
    const root = tmp();
    mkdirSync(path.join(root, '.git'));
    const seen = [];
    const git = async (cwd) => { seen.push(cwd); return { file: path.join(root, '.git', 'info', 'global'), pattern: 'quorum/' }; };
    const out = await searchProblems(root, path.join(root, 'M', 'quorum', 'n.md'), { home: tmp(), git });
    expect(seen).toEqual([root]);
    expect(out[0]).toMatch(/Remove the line "quorum\/"/);
  });
});

describe('checkConnection', () => {
  it('passes, and leaves no test note or new folder behind', async () => {
    const root = tmp();
    const notesDir = path.join(root, 'Meetings', 'quorum');
    const r = await checkConnection({ root, notesDir, agent: agent(), home: tmp(), git: noGit });
    expect(r.ok).toBe(true);
    expect(r.checks.map((c) => [c.id, c.state])).toEqual([['folder', 'ok'], ['note', 'ok'], ['search', 'ok'], ['claude', 'ok'], ['codex', 'skip'], ['server', 'ok'], ['cli', 'ok']]);
    expect(existsSync(notesDir)).toBe(false);
    expect(existsSync(path.join(root, 'Meetings'))).toBe(true);
  });
  it('removes the test note from an existing folder too', async () => {
    const root = tmp();
    const notesDir = path.join(root, 'Meetings', 'quorum');
    put(path.join(notesDir, 'kept.md'), 'x');
    put(path.join(root, '.gitignore'), 'Meetings/\n');
    const r = await checkConnection({ root, notesDir, agent: agent(), home: tmp(), git: noGit });
    expect(byId(r).search).toMatchObject({ state: 'fail', fix: expect.stringContaining('Remove the line "Meetings/" from .gitignore.') });
    expect(readdirSync(notesDir)).toEqual(['kept.md']);
  });
  it('names the fix for a missing folder, notes outside the folder and a folder Quorum cannot write', async () => {
    expect(byId(await checkConnection({ root: null, notesDir: null, agent: agent() })).folder.fix).toBe('Connect your Agent OS folder in Settings > Memory, then check again.');
    const root = tmp();
    expect(byId(await checkConnection({ root, notesDir: null, agent: agent() })).folder.fix).toMatch(/^Choose a meetings folder in Settings > Memory/);
    const outside = path.join(tmp(), 'quorum');
    expect(byId(await checkConnection({ root, notesDir: outside, agent: agent(), git: noGit })).search.fix).toMatch(/outside your Agent OS folder/);
    const locked = path.join(root, 'Locked');
    mkdirSync(locked);
    chmodSync(locked, 0o555);
    const r = await checkConnection({ root, notesDir: path.join(locked, 'quorum'), agent: agent(), git: noGit });
    chmodSync(locked, 0o755);
    expect(byId(r).folder).toMatchObject({ state: 'fail', fix: expect.stringMatching(/^Quorum cannot write to /) });
    expect(byId(r).note).toBeUndefined();
  });
  it('reports each agent, the server and the command with one fix each', async () => {
    const root = tmp();
    const notesDir = path.join(root, 'M', 'quorum');
    const none = await checkConnection({ root, notesDir, git: noGit, agent: agent({ claude: { installed: false, added: false }, server: { ok: false }, cli: { added: false } }) });
    expect(byId(none).claude.fix).toBe('Install Claude Code or Codex, then press Add next to it.');
    expect(byId(none).server.fix).toMatch(/did not answer/);
    expect(byId(none).cli.fix).toBe('Press Connect next to Quorum CLI to add the quorum command.');
    expect(none.ok).toBe(false);
    const codexOnly = await checkConnection({ root, notesDir, git: noGit, agent: agent({ claude: { installed: false, added: false }, codex: { installed: true, added: false } }) });
    expect(byId(codexOnly).claude.state).toBe('skip');
    expect(byId(codexOnly).codex.fix).toBe('Press Add next to Codex to connect Quorum to it.');
    const shadowed = await checkConnection({ root, notesDir, git: noGit, agent: agent({ cli: { added: true, where: 'path', path: '/h/.local/bin/quorum', onPath: true, resolves: '/opt/homebrew/bin/quorum', error: null } }) });
    expect(byId(shadowed).cli.fix).toMatch(/^Another quorum command at \/opt\/homebrew\/bin\/quorum comes first/);
    const aliased = await checkConnection({ root, notesDir, git: noGit, agent: agent({ cli: { added: true, where: 'path', path: '/h/.local/bin/quorum', onPath: true, resolves: "alias quorum='x'", error: null } }) });
    expect(byId(aliased).cli.fix).toMatch(/^A quorum alias in your shell setup/);
    const alias = await checkConnection({ root, notesDir, git: noGit, agent: agent({ cli: { added: true, where: 'alias', error: null } }) });
    expect(byId(alias).cli).toMatchObject({ state: 'ok', detail: 'Works in Terminal windows you open from now on.' });
  });
});
