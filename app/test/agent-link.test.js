import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MARK, createAgentLink, hasCodexServer, readShell, withCodexServer, withoutCodexServer } from '../agentLink.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'qlink-'));
const ENV = { ELECTRON_RUN_AS_NODE: '1' };
// a temp HOME with a runtime and a CLI file in it, so the moved checks see real files
function setup({ pathDirs = [], codexHome } = {}) {
  const home = tmp();
  const app = path.join(home, 'Quorum App');
  mkdirSync(app, { recursive: true });
  const runtime = process.execPath;
  const cli = path.join(app, 'quorum.mjs');
  writeFileSync(cli, "console.log(JSON.stringify(process.argv.slice(2)), process.env.ELECTRON_RUN_AS_NODE);\n");
  const calls = [];
  const answers = [];
  const run = async (bin, args) => { calls.push([bin, ...args]); const a = answers.shift(); return typeof a === 'function' ? a(bin, args) : a ?? { ok: false, out: '', missing: true }; };
  const shellPath = { path: pathDirs.map((d) => d.replace('$HOME', home)).join(':'), which: {} };
  const link = createAgentLink({ runtime, cli, env: ENV, home, codexHome: codexHome?.(home), run, shell: async () => shellPath });
  return { home, runtime, cli, calls, answers, link, shellPath };
}

describe('Claude Code registration', () => {
  it('adds at user scope with the env before -- and trusts the read back', async () => {
    const t = setup();
    t.answers.push({ ok: true, out: 'Added' }, { ok: true, out: 'quorum: ...' });
    expect(await t.link.claude.add()).toEqual({ added: true, error: null });
    expect(t.calls[0]).toEqual(['claude', 'mcp', 'add', 'quorum', '--scope', 'user', '--env', 'ELECTRON_RUN_AS_NODE=1', '--', t.runtime, t.cli, 'mcp']);
    expect(t.calls[1]).toEqual(['claude', 'mcp', 'get', 'quorum']);
  });
  it('says when Claude Code is missing or dropped the entry', async () => {
    const t = setup();
    t.answers.push({ ok: false, out: '', missing: true });
    expect(await t.link.claude.add()).toMatchObject({ added: false, error: 'Install Claude Code first.' });
    t.answers.push({ ok: true, out: '' }, { ok: false, out: 'No MCP server found' });
    expect((await t.link.claude.add()).error).toMatch(/didn't keep/);
    t.answers.push({ ok: false, out: '', missing: true });
    expect(await t.link.claude.status()).toEqual({ installed: false, added: false });
  });
});

describe('Codex registration', () => {
  it('uses codex mcp add when the command is there, and reads the JSON back', async () => {
    const t = setup();
    const got = (command) => ({ ok: true, out: JSON.stringify({ name: 'quorum', enabled: true, transport: { type: 'stdio', command, args: [t.cli, 'mcp'] } }) });
    t.answers.push({ ok: true, out: "Added global MCP server 'quorum'." }, got(t.runtime));
    expect(await t.link.codex.add()).toEqual({ added: true, error: null });
    expect(t.calls[0]).toEqual(['codex', 'mcp', 'add', 'quorum', '--env', 'ELECTRON_RUN_AS_NODE=1', '--', t.runtime, t.cli, 'mcp']);
    expect(t.calls[1]).toEqual(['codex', 'mcp', 'get', 'quorum', '--json']);
    t.answers.push(got('/gone/Quorum'));
    expect(await t.link.codex.status()).toMatchObject({ installed: true, via: 'cli', added: true, error: "Can't find the runtime where it used to be" });
    t.answers.push({ ok: false, out: "Error: No MCP server named 'quorum' found." });
    expect(await t.link.codex.status()).toMatchObject({ installed: true, added: false, error: null });
  });
  it('writes config.toml when only the Codex folder is there, keeping the rest of the file', async () => {
    const t = setup({ codexHome: (h) => path.join(h, '.codex') });
    const dir = path.join(t.home, '.codex');
    expect(await t.link.codex.status()).toEqual({ installed: false, added: false });
    expect((await t.link.codex.add()).error).toBe('Install Codex first.');
    mkdirSync(dir);
    const before = 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n\n[mcp_servers.quorum]\ncommand = "/old"\n\n[mcp_servers.quorum.env]\nA = "1"\n\n[profiles.fast]\nmodel = "o4"\n';
    writeFileSync(path.join(dir, 'config.toml'), before);
    expect(await t.link.codex.add()).toEqual({ added: true, error: null });
    const text = readFileSync(path.join(dir, 'config.toml'), 'utf8');
    expect(text).toContain('[mcp_servers.other]');
    expect(text).toContain('[profiles.fast]');
    expect(text).not.toContain('/old');
    expect(text).toContain(`command = ${JSON.stringify(t.runtime)}`);
    expect(text).toContain(`args = [${JSON.stringify(t.cli)}, "mcp"]`);
    expect(text).toContain('[mcp_servers.quorum.env]\nELECTRON_RUN_AS_NODE = "1"');
    expect(await t.link.codex.status()).toEqual({ installed: true, via: 'config', added: true });
    expect(await t.link.codex.remove()).toEqual({ added: false });
    const after = readFileSync(path.join(dir, 'config.toml'), 'utf8');
    expect(after).toContain('[mcp_servers.other]');
    expect(after).toContain('[profiles.fast]');
    expect(hasCodexServer(after)).toBe(false);
  });
  it('edits TOML tables by header only', () => {
    expect(withCodexServer('', { command: '/a b', args: ['c'], env: {} })).toBe('[mcp_servers.quorum]\ncommand = "/a b"\nargs = ["c"]\n');
    expect(hasCodexServer('[mcp_servers."quorum"]\n')).toBe(true);
    expect(hasCodexServer('[mcp_servers.quorum-other]\n')).toBe(false);
    expect(withoutCodexServer('[mcp_servers.quorum_two]\ncommand = "x"\n')).toContain('quorum_two');
  });
});

describe('quorum command', () => {
  it('installs a launcher in a user bin folder already on PATH, which runs at once', async () => {
    const t = setup({ pathDirs: ['/usr/bin', '$HOME/.local/bin/'] });
    writeFileSync(path.join(t.home, '.zshrc'), `export A=1\nalias quorum='old' ${MARK}\n`);
    const s = await t.link.cli.add();
    const f = path.join(t.home, '.local', 'bin', 'quorum');
    expect(s).toMatchObject({ added: true, where: 'path', path: f, onPath: true, error: null });
    expect(statSync(f).mode & 0o111).not.toBe(0);
    expect(readFileSync(path.join(t.home, '.zshrc'), 'utf8')).toBe('export A=1\n');
    expect(execFileSync('/bin/sh', [f, 'status', "it's"], { encoding: 'utf8' }).trim()).toBe('["status","it\'s"] 1');
    expect(await t.link.cli.remove()).toEqual({ added: false });
    expect(existsSync(f)).toBe(false);
  });
  it('falls back to the .zshrc alias without a user bin folder on PATH', async () => {
    const t = setup({ pathDirs: ['/usr/bin'] });
    expect(await t.link.cli.add()).toMatchObject({ added: true, where: 'alias', name: 'quorum', error: null });
    expect(readFileSync(path.join(t.home, '.zshrc'), 'utf8')).toBe(`alias quorum='ELECTRON_RUN_AS_NODE=1 "${t.runtime}" "${t.cli}"' ${MARK}\n`);
  });
  it('takes the quorum-app name when another program answers to quorum, and never touches that program', async () => {
    const u = setup({ pathDirs: ['$HOME/bin'] });
    mkdirSync(path.join(u.home, 'bin'));
    const theirs = path.join(u.home, 'bin', 'quorum');
    writeFileSync(theirs, '#!/bin/sh\necho mine\n');
    writeFileSync(path.join(u.home, '.zshrc'), "alias other='x'\n");
    u.shellPath.which = { quorum: theirs };
    const s = await u.link.cli.add();
    expect(s).toMatchObject({ added: true, where: 'path', name: 'quorum-app', path: path.join(u.home, 'bin', 'quorum-app'), shadowed: false });
    expect(readFileSync(theirs, 'utf8')).toBe('#!/bin/sh\necho mine\n');
    expect(readFileSync(path.join(u.home, '.zshrc'), 'utf8')).toBe("alias other='x'\n");
    await u.link.cli.remove();
    expect(existsSync(theirs)).toBe(true);
    expect(existsSync(path.join(u.home, 'bin', 'quorum-app'))).toBe(false);
  });
  it('writes nothing when both names are taken, and offers the full path', async () => {
    const t = setup({ pathDirs: ['$HOME/.local/bin'] });
    t.shellPath.which = { quorum: '/opt/homebrew/bin/quorum', 'quorum-app': '/usr/local/bin/quorum-app' };
    const s = await t.link.cli.add();
    expect(s).toMatchObject({ added: false, command: `ELECTRON_RUN_AS_NODE=1 "${t.runtime}" "${t.cli}"` });
    expect(s.error).toMatch(/full path/);
    expect(existsSync(path.join(t.home, '.local', 'bin'))).toBe(false);
    expect(existsSync(path.join(t.home, '.zshrc'))).toBe(false);
  });
  it('reports a launcher another program shadows', async () => {
    const t = setup({ pathDirs: ['/opt/homebrew/bin', '$HOME/.local/bin'] });
    await t.link.cli.add();
    t.shellPath.which = { quorum: '/opt/homebrew/bin/quorum' };
    expect(await t.link.cli.status()).toMatchObject({ name: 'quorum', shadowed: true });
  });
  it('says when the launcher left PATH or points at a Quorum that moved', async () => {
    const t = setup({ pathDirs: ['$HOME/.local/bin'] });
    await t.link.cli.add();
    t.shellPath.path = '/usr/bin';
    expect(await t.link.cli.status()).toMatchObject({ where: 'path', onPath: false });
    const f = path.join(t.home, '.local', 'bin', 'quorum');
    writeFileSync(f, readFileSync(f, 'utf8').replace(t.cli, '/gone/quorum.mjs'));
    expect((await t.link.cli.status()).error).toBe("Can't find Quorum where it used to be");
  });
});

describe('MCP handshake and shell', () => {
  it('passes when the server answers initialize as quorum, fails when it exits', async () => {
    const dir = tmp();
    const good = path.join(dir, 'good.mjs');
    writeFileSync(good, "import { createInterface } from 'node:readline';\ncreateInterface({ input: process.stdin }).on('line', (l) => { const m = JSON.parse(l); process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { serverInfo: { name: 'quorum' } } }) + '\\n'); });\n");
    const bad = path.join(dir, 'bad.mjs');
    writeFileSync(bad, 'process.exit(1);\n');
    expect(await createAgentLink({ runtime: process.execPath, cli: good, env: ENV, home: dir }).handshake()).toEqual({ ok: true });
    expect((await createAgentLink({ runtime: process.execPath, cli: bad, env: ENV, home: dir }).handshake()).ok).toBe(false);
  });
  it('reads PATH and quorum from between the markers, ignoring what .zshrc prints', async () => {
    const exec = (_sh, args, _o, cb) => { expect(args[0]).toBe('-ilc'); cb(null, 'Welcome!\n\n__QUORUM__/a:/b__QUORUM__/b/quorum__QUORUM____QUORUM__\n'); };
    expect(await readShell({ exec })).toEqual({ path: '/a:/b', which: { quorum: '/b/quorum', 'quorum-app': '' } });
    expect((await readShell({ exec: (_s, _a, _o, cb) => cb(new Error('timeout'), '') })).unread).toBe(true);
  });
});
