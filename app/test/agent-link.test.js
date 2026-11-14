import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { MARK, claudeEntry, codexServer, createAgentLink, readShell, realPath, startupFile, withCodexServer, withoutCodexServer } from '../agentLink.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'qlink-'));
const ENV = { ELECTRON_RUN_AS_NODE: '1' };
// a temp HOME with a runtime and a CLI file in it, so the moved checks see real files
function setup({ pathDirs = [], codexHome, kind = 'zsh', home: given } = {}) {
  const home = given ?? tmp();
  const app = path.join(home, 'Quorum App');
  mkdirSync(app, { recursive: true });
  const runtime = process.execPath;
  const cli = path.join(app, 'quorum.mjs');
  writeFileSync(cli, "console.log(JSON.stringify(process.argv.slice(2)), process.env.ELECTRON_RUN_AS_NODE);\n");
  const calls = [];
  const answers = [];
  const run = async (bin, args) => { calls.push([bin, ...args]); const a = answers.shift(); return typeof a === 'function' ? a(bin, args) : a ?? { ok: false, out: '', missing: true }; };
  const state = { kind, path: pathDirs.map((d) => d.replace('$HOME', home)).join(':'), which: {}, after: null };
  let reads = 0;
  const shell = async () => {
    reads++;
    if (state.unread) return { kind, unread: true, path: null, which: null };
    // after, when set, is what the shell answers from the second reading on
    const which = reads > 1 && state.after ? state.after : state.which;
    return { kind, path: state.path, which: { ...which } };
  };
  const link = createAgentLink({ runtime, cli, env: ENV, home, codexHome: codexHome?.(home), run, shell });
  return { home, runtime, cli, calls, answers, link, shell: state, reads: () => reads };
}
const getOut = (t, { scope = 'User config (available in all your projects)', command = t.runtime, cli = t.cli } = {}) => ({ ok: true, out: `quorum:\n  Scope: ${scope}\n  Status: ✔ Connected\n  Type: stdio\n  Command: ${command}\n  Args: ${cli} mcp\n  Environment:\n` });

describe('Claude Code registration', () => {
  it('reads scope and paths back from claude mcp get, and flags a moved entry', async () => {
    const t = setup();
    expect(claudeEntry(getOut(t, { cli: '/Apps/Quorum Dev.app/cli/quorum.mjs' }).out)).toEqual({ scope: 'user', command: t.runtime, cli: '/Apps/Quorum Dev.app/cli/quorum.mjs' });
    t.answers.push(getOut(t));
    expect(await t.link.claude.status()).toEqual({ installed: true, added: true, scope: 'user', error: null });
    t.answers.push(getOut(t, { cli: '/gone/quorum.mjs' }));
    expect((await t.link.claude.status()).error).toBe("Can't find Quorum where it used to be");
    t.answers.push({ ok: false, out: 'No MCP server found' });
    expect(await t.link.claude.status()).toEqual({ installed: true, added: false });
    t.answers.push({ ok: false, out: '', missing: true });
    expect(await t.link.claude.status()).toEqual({ installed: false, added: false });
  });
  it('replaces an existing entry in its own scope, then adds at user scope and reads it back', async () => {
    const t = setup();
    t.answers.push(getOut(t, { scope: 'Local config (private to you in this project)', cli: '/gone/q.mjs' }), { ok: true, out: 'Removed' }, { ok: true, out: 'Added' }, getOut(t));
    expect(await t.link.claude.add()).toEqual({ added: true, error: null });
    expect(t.calls[1]).toEqual(['claude', 'mcp', 'remove', 'quorum', '--scope', 'local']);
    expect(t.calls[2]).toEqual(['claude', 'mcp', 'add', 'quorum', '--scope', 'user', '--env', 'ELECTRON_RUN_AS_NODE=1', '--', t.runtime, t.cli, 'mcp']);
  });
  it('says when Claude Code is missing, kept an old entry, or dropped the new one', async () => {
    const t = setup();
    t.answers.push({ ok: false, out: '', missing: true });
    expect(await t.link.claude.add()).toMatchObject({ added: false, error: 'Install Claude Code first.' });
    t.answers.push(getOut(t, { scope: 'Project config (shared via .mcp.json)' }), { ok: false, out: 'Permission denied' });
    expect((await t.link.claude.add()).error).toBe("Claude Code kept the Quorum entry in its this folder's shared .mcp.json: Permission denied");
    t.answers.push({ ok: false, out: 'none' }, { ok: true, out: '' }, { ok: false, out: 'No MCP server found' });
    expect((await t.link.claude.add()).error).toMatch(/didn't keep/);
  });
  it('removes from the scope the entry is in, and names that scope when it cannot', async () => {
    const t = setup();
    t.answers.push(getOut(t, { scope: 'Project config (shared via .mcp.json)' }), { ok: true, out: '' }, { ok: false, out: 'none' });
    expect(await t.link.claude.remove()).toEqual({ added: false });
    expect(t.calls[1]).toEqual(['claude', 'mcp', 'remove', 'quorum', '--scope', 'project']);
    t.answers.push(getOut(t), { ok: false, out: '⚠ notice\nNo user-scoped MCP server found' });
    expect(await t.link.claude.remove()).toEqual({ added: true, error: 'Claude Code did not remove Quorum from its user settings: No user-scoped MCP server found' });
  });
});

describe('Codex registration', () => {
  it('uses codex mcp add when the command is there, and reads the JSON back', async () => {
    const t = setup();
    const got = (command) => ({ ok: true, out: JSON.stringify({ name: 'quorum', enabled: true, transport: { type: 'stdio', command, args: [t.cli, 'mcp'] } }) });
    t.answers.push({ ok: true, out: "Added global MCP server 'quorum'." }, got(t.runtime));
    expect(await t.link.codex.add()).toEqual({ added: true, error: null });
    expect(t.calls[0]).toEqual(['codex', 'mcp', 'add', 'quorum', '--env', 'ELECTRON_RUN_AS_NODE=1', '--', t.runtime, t.cli, 'mcp']);
    t.answers.push(got('/gone/Quorum'));
    expect(await t.link.codex.status()).toMatchObject({ installed: true, via: 'cli', added: true, error: "Can't find the runtime where it used to be" });
    t.answers.push({ ok: false, out: 'Error: oops' });
    expect(await t.link.codex.remove()).toEqual({ added: true, error: 'Codex did not remove Quorum: Error: oops' });
  });
  it('finds a quorum server in every TOML form', () => {
    expect(codexServer('[mcp_servers.quorum]\ncommand = "x"\n')).toEqual({ form: 'table', ours: false });
    expect(codexServer(`${MARK}\n[mcp_servers."quorum"]\ncommand = "x"\n`)).toEqual({ form: 'table', ours: true });
    expect(codexServer('mcp_servers.quorum.command = "x"\n')).toEqual({ form: 'key', ours: false });
    expect(codexServer('[mcp_servers]\nquorum = { command = "x" }\n')).toEqual({ form: 'key', ours: false });
    expect(codexServer('[mcp_servers]\nquorum.command = "x"\n')).toEqual({ form: 'key', ours: false });
    expect(codexServer('mcp_servers = { quorum = { command = "x" } }\n')).toEqual({ form: 'key', ours: false });
    expect(codexServer('[mcp_servers.quorum-two]\n[profiles.quorum]\nquorum = 1\n')).toBe(null);
  });
  const FORMS = {
    table: '[mcp_servers.quorum]\ncommand = "/theirs"\n',
    dotted: 'model = "gpt-5"\nmcp_servers.quorum.command = "/theirs"\n',
    inline: '[mcp_servers]\nquorum = { command = "/theirs" }\nother = { command = "x" }\n',
  };
  for (const [form, text] of Object.entries(FORMS)) {
    it(`leaves a ${form} entry Quorum did not write untouched, and the file still parses`, async () => {
      const t = setup({ codexHome: (h) => path.join(h, '.codex') });
      const f = path.join(t.home, '.codex', 'config.toml');
      mkdirSync(path.dirname(f));
      writeFileSync(f, text);
      expect(await t.link.codex.status()).toMatchObject({ installed: true, via: 'config', added: true, ours: false });
      expect(await t.link.codex.add()).toEqual({ added: true, error: null });
      expect(readFileSync(f, 'utf8')).toBe(text);
      expect(parse(readFileSync(f, 'utf8')).mcp_servers.quorum.command).toBe('/theirs');
      expect((await t.link.codex.remove()).error).toMatch(/left it in place/);
      expect(readFileSync(f, 'utf8')).toBe(text);
    });
  }
  it('writes, replaces and removes only its own table, keeping the rest parseable', async () => {
    const t = setup({ codexHome: (h) => path.join(h, '.codex') });
    const f = path.join(t.home, '.codex', 'config.toml');
    expect(await t.link.codex.status()).toEqual({ installed: false, added: false });
    expect((await t.link.codex.add()).error).toBe('Install Codex first.');
    mkdirSync(path.dirname(f));
    writeFileSync(f, 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n\n[profiles.fast]\nmodel = "o4"\n');
    expect(await t.link.codex.add()).toEqual({ added: true, error: null });
    const once = parse(readFileSync(f, 'utf8'));
    expect(once.mcp_servers.quorum).toEqual({ command: t.runtime, args: [t.cli, 'mcp'], env: { ELECTRON_RUN_AS_NODE: '1' } });
    expect(once.mcp_servers.other).toEqual({ command: 'x' });
    expect(once.profiles.fast.model).toBe('o4');
    expect(await t.link.codex.add()).toEqual({ added: true, error: null });
    expect(parse(readFileSync(f, 'utf8'))).toEqual(once);
    expect(await t.link.codex.status()).toMatchObject({ added: true, ours: true });
    expect(await t.link.codex.remove()).toEqual({ added: false });
    const after = parse(readFileSync(f, 'utf8'));
    expect(after.mcp_servers).toEqual({ other: { command: 'x' } });
    expect(after.profiles.fast.model).toBe('o4');
  });
  it('builds its own table with the mark', () => {
    expect(withCodexServer('', { command: '/a b', args: ['c'], env: {} })).toBe(`${MARK}\n[mcp_servers.quorum]\ncommand = "/a b"\nargs = ["c"]\n`);
    expect(withoutCodexServer(`a = 1\n\n${MARK}\n[mcp_servers.quorum]\ncommand = "x"\n\n[mcp_servers.quorum.env]\nA = "1"\n\n[b]\nc = 2\n`)).toBe('a = 1\n\n[b]\nc = 2\n');
  });
});

describe('quorum command', () => {
  it('installs a launcher in a user bin folder already on PATH with one shell reading, and it runs at once', async () => {
    const t = setup({ pathDirs: ['/usr/bin', '$HOME/.local/bin/'] });
    writeFileSync(path.join(t.home, '.zshrc'), `export A=1\nalias quorum='old' ${MARK}\n`);
    const s = await t.link.cli.add();
    const f = path.join(t.home, '.local', 'bin', 'quorum');
    expect(s).toMatchObject({ added: true, where: 'path', name: 'quorum', path: f, onPath: true, shadowed: false, error: null });
    expect(t.reads()).toBe(1);
    expect(statSync(f).mode & 0o111).not.toBe(0);
    expect(readFileSync(path.join(t.home, '.zshrc'), 'utf8')).toBe('export A=1\n');
    expect(execFileSync('/bin/sh', [f, 'status', "it's"], { encoding: 'utf8' }).trim()).toBe('["status","it\'s"] 1');
    t.shell.which = { quorum: f };
    expect(await t.link.cli.add()).toMatchObject({ name: 'quorum', where: 'path' });
    expect(await t.link.cli.remove()).toEqual({ added: false });
    expect(existsSync(f)).toBe(false);
  });
  it('writes the alias to the startup file of the shell in use, in its syntax', async () => {
    const z = setup({ pathDirs: ['/usr/bin'] });
    z.shell.after = { quorum: `alias quorum='ELECTRON_RUN_AS_NODE=1 "${z.runtime}" "${z.cli}"'` };
    expect(await z.link.cli.add()).toMatchObject({ added: true, where: 'alias', name: 'quorum', file: path.join(z.home, '.zshrc'), loaded: true, shadowed: false, error: null });
    expect(readFileSync(path.join(z.home, '.zshrc'), 'utf8')).toBe(`alias quorum='ELECTRON_RUN_AS_NODE=1 "${z.runtime}" "${z.cli}"' ${MARK}\n`);
    const b = setup({ pathDirs: ['/usr/bin'], kind: 'bash' });
    writeFileSync(path.join(b.home, '.profile'), 'export X=1\n');
    expect(startupFile('bash', b.home)).toBe(path.join(b.home, '.profile'));
    await b.link.cli.add();
    expect(readFileSync(path.join(b.home, '.profile'), 'utf8')).toBe(`export X=1\nalias quorum='ELECTRON_RUN_AS_NODE=1 "${b.runtime}" "${b.cli}"' ${MARK}\n`);
    expect(existsSync(path.join(b.home, '.bash_profile'))).toBe(false);
    const f = setup({ pathDirs: ['/usr/bin'], kind: 'fish' });
    expect(await f.link.cli.add()).toMatchObject({ where: 'alias', loaded: null, error: null });
    expect(readFileSync(path.join(f.home, '.config', 'fish', 'config.fish'), 'utf8')).toBe(`alias quorum 'env ELECTRON_RUN_AS_NODE=1 "${f.runtime}" "${f.cli}"' ${MARK}\n`);
    await f.link.cli.remove();
    expect(readFileSync(path.join(f.home, '.config', 'fish', 'config.fish'), 'utf8')).toBe('');
  });
  it('does not report an alias a new zsh does not load as working', async () => {
    const t = setup({ pathDirs: ['/usr/bin'] });
    expect(await t.link.cli.add()).toMatchObject({ where: 'alias', loaded: false, error: "A new Terminal window does not load Quorum's alias from .zshrc" });
  });
  it('adds no alias for a shell it does not know', async () => {
    const t = setup({ pathDirs: ['/usr/bin'], kind: 'other' });
    expect((await t.link.cli.add()).error).toMatch(/cannot add a command for your shell/);
    expect(existsSync(path.join(t.home, '.zshrc'))).toBe(false);
  });
  it('treats an unread shell as unknown: no PATH failure, no name picked, nothing written', async () => {
    const t = setup({ pathDirs: ['$HOME/.local/bin'] });
    await t.link.cli.add();
    t.shell.unread = true;
    expect(await t.link.cli.status()).toMatchObject({ added: true, where: 'path', onPath: null, shadowed: null, error: null });
    const u = setup({ pathDirs: ['$HOME/.local/bin'] });
    u.shell.unread = true;
    expect(await u.link.cli.add()).toMatchObject({ added: false, error: expect.stringMatching(/could not read your Terminal settings/) });
    expect(existsSync(path.join(u.home, '.local'))).toBe(false);
  });
  it('takes the quorum-app name when another program answers to quorum, and never touches that program', async () => {
    const u = setup({ pathDirs: ['$HOME/bin'] });
    mkdirSync(path.join(u.home, 'bin'));
    const theirs = path.join(u.home, 'bin', 'quorum');
    writeFileSync(theirs, '#!/bin/sh\necho mine\n');
    writeFileSync(path.join(u.home, '.zshrc'), "alias other='x'\n");
    u.shell.which = { quorum: theirs };
    expect(await u.link.cli.add()).toMatchObject({ added: true, where: 'path', name: 'quorum-app', path: path.join(u.home, 'bin', 'quorum-app'), shadowed: false });
    expect(readFileSync(theirs, 'utf8')).toBe('#!/bin/sh\necho mine\n');
    expect(readFileSync(path.join(u.home, '.zshrc'), 'utf8')).toBe("alias other='x'\n");
    await u.link.cli.remove();
    expect(existsSync(theirs)).toBe(true);
  });
  it('writes nothing when both names are taken, and offers the full path', async () => {
    const t = setup({ pathDirs: ['$HOME/.local/bin'] });
    t.shell.which = { quorum: '/opt/homebrew/bin/quorum', 'quorum-app': '/usr/local/bin/quorum-app' };
    const s = await t.link.cli.add();
    expect(s).toMatchObject({ added: false, command: `ELECTRON_RUN_AS_NODE=1 "${t.runtime}" "${t.cli}"` });
    expect(s.error).toMatch(/full path/);
    expect(existsSync(path.join(t.home, '.local', 'bin'))).toBe(false);
  });
  it('compares real paths: a symlinked home, double and trailing slashes', async () => {
    const real = tmp();
    const link = path.join(tmp(), 'home-link');
    symlinkSync(real, link);
    const t = setup({ home: link, pathDirs: [`${real}//.local/bin/`] });
    expect(await t.link.cli.add()).toMatchObject({ where: 'path', onPath: true });
    t.shell.which = { quorum: `${real}/.local//bin/quorum` };
    expect(await t.link.cli.status()).toMatchObject({ shadowed: false });
    t.shell.which = { quorum: '/opt/homebrew/bin/quorum' };
    expect(await t.link.cli.status()).toMatchObject({ shadowed: true });
    expect(realPath(path.join(link, 'not', 'yet'))).toBe(path.join(realPath(real), 'not', 'yet'));
  });
  it('says when the launcher points at a Quorum that moved', async () => {
    const t = setup({ pathDirs: ['$HOME/.local/bin'] });
    await t.link.cli.add();
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
  it('reads tagged lines from the shell, ignoring what startup files print, and marks a failed read unread', async () => {
    const exec = (_sh, args, o, cb) => { expect(args).toEqual(['-ilc', expect.any(String)]); expect(o.timeout).toBe(15000); cb(null, 'Welcome!\n__QUORUM__PATH=/a:/b\n__QUORUM__quorum=/b/quorum\n__QUORUM__quorum-app=\n'); };
    expect(await readShell({ exec, shell: '/bin/zsh' })).toEqual({ kind: 'zsh', path: '/a:/b', which: { quorum: '/b/quorum', 'quorum-app': '' } });
    const fish = (_sh, args, _o, cb) => { expect(args.slice(0, 3)).toEqual(['-i', '-l', '-c']); cb(null, '__QUORUM__PATH=/a\n'); };
    expect(await readShell({ exec: fish, shell: '/opt/homebrew/bin/fish' })).toEqual({ kind: 'fish', path: '/a', which: { quorum: '', 'quorum-app': '' } });
    expect(await readShell({ exec: (_s, _a, _o, cb) => cb(new Error('timeout'), 'partial'), shell: '/bin/zsh' })).toEqual({ kind: 'zsh', unread: true, path: null, which: null });
  });
  it('a real zsh with an empty temp home answers the script', async () => {
    const home = tmp();
    const exec = (sh, args, o, cb) => execFile(sh, args, { ...o, env: { HOME: home, ZDOTDIR: home, PATH: '/usr/bin:/bin' } }, cb);
    const r = await readShell({ exec, shell: '/bin/zsh' });
    expect(r.unread).toBeUndefined();
    expect(r.path).toContain('/usr/bin');
    expect(r.which).toEqual({ quorum: expect.any(String), 'quorum-app': expect.any(String) });
  });
});
