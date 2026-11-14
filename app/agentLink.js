// Quorum reached from the person's agents: the quorum MCP server in Claude Code and in Codex, and the quorum command in
// Terminal. All three run the CLI that ships beside the app with the app's own runtime; nothing listens on a port.
// Pure Node with an injectable command runner, HOME, Codex folder and shell, so the tests never touch the real
// ~/.claude.json, ~/.codex, shell startup files or PATH folders.
import { execFile, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { cliRun } from './claudeCli.js';

export const MARK = '# added by Quorum';
const read = (f) => { try { return readFileSync(f, 'utf8'); } catch { return null; } };
const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const toml = (s) => JSON.stringify(String(s));

// a path as the file system sees it: symlinks resolved (a symlinked home folder, /tmp on macOS), repeated and trailing
// slashes dropped. A path that does not exist yet resolves through its nearest existing parent
export function realPath(p) {
  if (!p) return '';
  const abs = path.resolve(String(p));
  const rest = [];
  for (let d = abs; ; d = path.dirname(d)) {
    try { return path.join(realpathSync(d), ...rest.reverse()); } catch {}
    if (path.dirname(d) === d) return abs;
    rest.push(path.basename(d));
  }
}
const samePath = (a, b) => !!a && !!b && realPath(a) === realPath(b);

// the folders a quorum launcher can go in, in order: user owned, and common on a Mac PATH
export const binDirs = (home) => [path.join(home, '.local', 'bin'), path.join(home, 'bin')];
export const CLI_NAMES = ['quorum', 'quorum-app'];

// the person's login shell and the startup file it reads in a new Terminal window, where Quorum's alias goes when no
// user bin folder is on PATH. bash on a Mac starts as a login shell, so it reads the first of .bash_profile,
// .bash_login and .profile; any other shell gets no alias
export const shellKind = (shell) => { const b = path.basename(String(shell || '')); return b === 'zsh' || b === 'bash' || b === 'fish' ? b : 'other'; };
export function startupFile(kind, home) {
  if (kind === 'zsh') return path.join(home, '.zshrc');
  if (kind === 'fish') return path.join(home, '.config', 'fish', 'config.fish');
  if (kind === 'bash') return ['.bash_profile', '.bash_login', '.profile'].map((f) => path.join(home, f)).find((f) => existsSync(f)) ?? path.join(home, '.bash_profile');
  return null;
}
const ALL_STARTUP = (home) => ['.zshrc', '.bash_profile', '.bash_login', '.profile', '.bashrc', path.join('.config', 'fish', 'config.fish')].map((f) => path.join(home, f));

// a fresh interactive login shell's PATH, and what each command name resolves to there: what a new Terminal window
// sees. One tagged line per value keeps anything the startup files print out of the answer. Without the PATH line
// (a timeout, a shell that would not start) the answer is unread, and nothing is decided from it
const TAG = '__QUORUM__';
export function readShell({ exec = execFile, shell = process.env.SHELL || '/bin/zsh', timeout = 15000 } = {}) {
  const kind = shellKind(shell);
  const script = kind === 'fish'
    ? `printf '%s\\n' "${TAG}PATH="(string join : $PATH) ${CLI_NAMES.map((n) => `"${TAG}${n}="(command -v ${n})`).join(' ')}`
    : `printf '%s\\n' "${TAG}PATH=$PATH" ${CLI_NAMES.map((n) => `"${TAG}${n}=$(command -v ${n} 2>/dev/null)"`).join(' ')}`;
  const args = kind === 'fish' ? ['-i', '-l', '-c', script] : ['-ilc', script];
  return new Promise((resolve) => {
    exec(shell, args, { timeout, encoding: 'utf8' }, (_err, out) => {
      const got = {};
      for (const line of String(out ?? '').split('\n')) { const m = line.match(new RegExp(`^${TAG}([\\w-]+)=(.*)$`)); if (m) got[m[1]] = m[2].trim(); }
      if (got.PATH === undefined) { resolve({ kind, unread: true, path: null, which: null }); return; }
      resolve({ kind, path: got.PATH, which: Object.fromEntries(CLI_NAMES.map((n) => [n, got[n] ?? ''])) });
    });
  });
}
const pathList = (p, home) => String(p ?? '').split(':').filter(Boolean).map((d) => realPath(d.replace(/^~(?=\/|$)/, home)));

// Codex's config.toml: where a quorum server sits in it. TOML allows three forms: a [mcp_servers.quorum] table (with
// [mcp_servers.quorum.*] subtables), dotted keys (mcp_servers.quorum.command = ... at the top, or quorum.command = ...
// under [mcp_servers]) and an inline table (quorum = { ... } under [mcp_servers], or mcp_servers = { quorum = ... }).
// A table Quorum wrote starts with Quorum's mark on the line above; that is the only form Quorum replaces or removes
const KEY = String.raw`(?:quorum|"quorum"|'quorum')`;
const HEADER = /^\s*\[\s*([^\]]+?)\s*\]\s*(#.*)?$/;
const QUORUM_HEADER = new RegExp(String.raw`^mcp_servers\s*\.\s*${KEY}\s*(\.|$)`);
const ROOT_KEY = new RegExp(String.raw`^\s*(mcp_servers\s*\.\s*${KEY}\s*[.=]|mcp_servers\s*=\s*\{.*(^|[{,\s])${KEY}\s*[.=])`);
const SERVERS_KEY = new RegExp(String.raw`^\s*${KEY}\s*[.=]`);
export function codexServer(text) {
  const lines = String(text ?? '').split('\n');
  let table = '';
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(HEADER);
    if (h && !lines[i].trim().startsWith('[[')) {
      table = h[1].replace(/\s+/g, '');
      if (QUORUM_HEADER.test(h[1])) return { form: 'table', ours: lines[i - 1]?.trim() === MARK };
      continue;
    }
    if (/^\s*(#|$)/.test(lines[i])) continue;
    if (table === '' && ROOT_KEY.test(lines[i])) return { form: 'key', ours: false };
    if (table === 'mcp_servers' && SERVERS_KEY.test(lines[i])) return { form: 'key', ours: false };
  }
  return null;
}
export const hasCodexServer = (text) => codexServer(text) !== null;
// the text without the table Quorum wrote: its mark, [mcp_servers.quorum] and the [mcp_servers.quorum.*] tables after it
export function withoutCodexServer(text) {
  const lines = String(text ?? '').split('\n');
  const out = [];
  let skip = false;
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(HEADER);
    if (lines[i].trim() === MARK && lines[i + 1]?.match(HEADER) && QUORUM_HEADER.test(lines[i + 1].match(HEADER)[1])) { skip = true; continue; }
    if (h) skip = skip && QUORUM_HEADER.test(h[1]);
    if (!skip) out.push(lines[i]);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}
export function withCodexServer(text, { command, args, env }) {
  const rest = withoutCodexServer(text).replace(/\s+$/, '');
  const envLines = Object.entries(env).map(([k, v]) => `${k} = ${toml(v)}`).join('\n');
  const block = `${MARK}\n[mcp_servers.quorum]\ncommand = ${toml(command)}\nargs = [${args.map(toml).join(', ')}]\n${envLines ? `\n[mcp_servers.quorum.env]\n${envLines}\n` : ''}`;
  return rest ? `${rest}\n\n${block}` : block;
}

// `claude mcp get quorum`: which settings hold the entry and what it runs. Args come joined by spaces, so the CLI path
// is everything before the trailing mcp
const SCOPES = { user: 'user', project: 'project', local: 'local' };
export function claudeEntry(out) {
  const t = String(out ?? '');
  const scope = (t.match(/^\s*Scope:\s*(\w+)/im)?.[1] ?? '').toLowerCase();
  const command = t.match(/^\s*Command:\s*(.+?)\s*$/m)?.[1] ?? null;
  const args = t.match(/^\s*Args:\s*(.*?)\s*$/m)?.[1] ?? '';
  return { scope: SCOPES[scope] ?? null, command, cli: args.replace(/\s+mcp$/, '') || null };
}
const SCOPE_NAME = { user: 'user settings', project: "this folder's shared .mcp.json", local: 'local settings for this folder' };

export function createAgentLink({ runtime, cli, env = {}, home = homedir(), codexHome, run = cliRun, shell = () => readShell(), spawnImpl = spawn }) {
  const envArgs = (flag) => Object.entries(env).flatMap(([k, v]) => [flag, `${k}=${v}`]);
  const envShell = Object.entries(env).map(([k, v]) => `${k}=${sh(v)}`).join(' ');
  const plainEnv = Object.entries(env).map(([k, v]) => `${k}=${v}`).join(' ');
  const gone = (p) => !p || !existsSync(p);
  const movedError = (rt, c) => (gone(rt) ? "Can't find the runtime where it used to be" : gone(c) ? "Can't find Quorum where it used to be" : null);
  const firstLine = (out) => String(out ?? '').trim().split('\n').find((l) => l.trim() && !l.startsWith('⚠')) ?? '';

  const claude = {
    async status() {
      const r = await run('claude', ['mcp', 'get', 'quorum'], { timeout: 20000 });
      if (r.missing) return { installed: false, added: false };
      if (!r.ok) return { installed: true, added: false };
      const e = claudeEntry(r.out);
      return { installed: true, added: true, scope: e.scope, error: e.command ? movedError(e.command, e.cli) : null };
    },
    // replaces any entry first, so an entry for a Quorum that moved is repaired
    async add() {
      const was = await claude.status();
      if (!was.installed) return { added: false, error: 'Install Claude Code first.' };
      if (was.added) {
        const rm = await run('claude', ['mcp', 'remove', 'quorum', '--scope', was.scope ?? 'user'], { timeout: 20000 });
        if (!rm.ok) return { added: true, error: `Claude Code kept the Quorum entry in its ${SCOPE_NAME[was.scope] ?? 'settings'}: ${firstLine(rm.out)}` };
      }
      // the server name goes before -e: Claude Code's -e takes values until the next flag, so a name after it is read
      // as one more env value; -- ends the list
      const r = await run('claude', ['mcp', 'add', 'quorum', '--scope', 'user', ...envArgs('--env'), '--', runtime, cli, 'mcp'], { timeout: 20000 });
      if (!r.ok) return { added: false, error: firstLine(r.out) };
      // trust what Claude Code reads back, not the add's exit code; a proxy managing MCP config can drop the entry
      const now = await claude.status();
      return { added: now.added, error: now.added ? now.error ?? null : "Claude Code didn't keep the Quorum entry. Another tool may manage your MCP servers." };
    },
    async remove() {
      const was = await claude.status();
      if (!was.added) return { added: false };
      const r = await run('claude', ['mcp', 'remove', 'quorum', '--scope', was.scope ?? 'user'], { timeout: 20000 });
      if (!r.ok) return { added: true, error: `Claude Code did not remove Quorum from its ${SCOPE_NAME[was.scope] ?? 'settings'}: ${firstLine(r.out)}` };
      return { added: (await claude.status()).added };
    },
  };

  // Codex: through `codex mcp` when the codex command is on PATH; with only the Codex app (a ~/.codex folder and no
  // command), through its config.toml, which both read
  const codexDir = () => codexHome ?? process.env.CODEX_HOME ?? path.join(home, '.codex');
  const codexConfig = () => path.join(codexDir(), 'config.toml');
  const codex = {
    async status() {
      const r = await run('codex', ['mcp', 'get', 'quorum', '--json'], { timeout: 15000 });
      if (!r.missing) {
        let j = null;
        try { j = JSON.parse(r.out); } catch {}
        const t = j?.transport ?? {};
        const error = r.ok && j ? (j.enabled === false ? 'Turned off in Codex' : movedError(t.command, t.args?.[0])) : null;
        return { installed: true, via: 'cli', added: r.ok, error };
      }
      if (!existsSync(codexDir())) return { installed: false, added: false };
      const found = codexServer(read(codexConfig()));
      return { installed: true, via: 'config', added: !!found, ours: found?.ours ?? false, error: null };
    },
    async add() {
      const r = await run('codex', ['mcp', 'add', 'quorum', ...envArgs('--env'), '--', runtime, cli, 'mcp'], { timeout: 15000 });
      if (r.missing) {
        if (!existsSync(codexDir())) return { added: false, error: 'Install Codex first.' };
        const text = read(codexConfig());
        const found = codexServer(text);
        // an entry Quorum did not write stays as it is; Codex already has a quorum server
        if (found && !found.ours) return { added: true, error: null };
        writeFileSync(codexConfig(), withCodexServer(text, { command: runtime, args: [cli, 'mcp'], env }));
      } else if (!r.ok) return { added: false, error: firstLine(r.out) };
      const added = (await codex.status()).added;
      return { added, error: added ? null : "Codex didn't keep the Quorum entry." };
    },
    async remove() {
      const r = await run('codex', ['mcp', 'remove', 'quorum'], { timeout: 15000 });
      if (!r.missing && !r.ok) return { added: true, error: `Codex did not remove Quorum: ${firstLine(r.out)}` };
      if (r.missing && existsSync(codexConfig())) {
        const text = read(codexConfig());
        const found = codexServer(text);
        if (found && !found.ours) return { added: true, error: 'Quorum did not write the quorum entry in your Codex settings, so it left it in place.' };
        if (found) writeFileSync(codexConfig(), withoutCodexServer(text));
      }
      return { added: (await codex.status()).added };
    },
  };

  // the quorum command: a launcher script in a user bin folder that a new shell already has on PATH, so it works in
  // every Terminal window at once; with no such folder, an alias in the startup file of the person's shell, which works
  // in new windows. When another program already answers to quorum, Quorum takes the next free name (quorum-app) and
  // says so. It only ever removes the launchers and alias lines it wrote
  const isAlias = (l, name) => (l.startsWith(`alias ${name}=`) || l.startsWith(`alias ${name} `)) && l.endsWith(MARK);
  const anyAlias = (l) => CLI_NAMES.some((n) => isAlias(l, n));
  const aliasLine = (kind, name) => (kind === 'fish' ? `alias ${name} ${sh(`env ${plainEnv} "${runtime}" "${cli}"`)} ${MARK}` : `alias ${name}='${plainEnv} "${runtime}" "${cli}"' ${MARK}`);
  const launcher = () => `#!/bin/sh\n${MARK}\n${envShell ? `${envShell} ` : ''}exec ${sh(runtime)} ${sh(cli)} "$@"\n`;
  const ours = (f) => (read(f) ?? '').split('\n')[1] === MARK;
  const unq = (s) => s.replace(/'\\''/g, "'");
  const launcherPaths = (text) => { const m = text.match(/exec '((?:[^']|'\\'')*)' '((?:[^']|'\\'')*)'/); return m ? [unq(m[1]), unq(m[2])] : []; };
  const addAlias = (file, kind, name) => {
    const t = read(file) ?? '';
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${t}${t && !t.endsWith('\n') ? '\n' : ''}${aliasLine(kind, name)}\n`);
  };
  const removeAliases = () => { for (const f of ALL_STARTUP(home)) { const t = read(f); if (t !== null && t.split('\n').some(anyAlias)) writeFileSync(f, t.split('\n').filter((l) => !anyAlias(l)).join('\n')); } };
  const removeLaunchers = () => { for (const dir of binDirs(home)) for (const n of CLI_NAMES) { const f = path.join(dir, n); if (existsSync(f) && ours(f)) unlinkSync(f); } };
  const command = `${plainEnv} "${runtime}" "${cli}"`.trim();
  // whether what a new shell runs for `name` is this Quorum: one of Quorum's launchers, or an alias holding this CLI
  const isOurs = (resolved, name) => {
    if (!resolved) return false;
    if (resolved.startsWith(`alias ${name}`)) return resolved.includes(cli) || resolved.includes(realPath(cli));
    return binDirs(home).some((d) => samePath(resolved, path.join(d, name))) && ours(realPath(resolved));
  };
  // status from one shell reading. unread leaves PATH unknown: onPath and shadowed are null, never a failure
  const statusFrom = (s) => {
    const known = !s.unread;
    const dirs = known ? pathList(s.path, home) : [];
    const rc = startupFile(s.kind ?? shellKind(process.env.SHELL), home);
    for (const name of CLI_NAMES) {
      const resolves = s.which?.[name] ?? '';
      for (const dir of binDirs(home)) {
        const f = path.join(dir, name);
        if (!existsSync(f) || !ours(f)) continue;
        const [rt, c] = launcherPaths(read(f));
        return { added: true, where: 'path', name, path: f, onPath: known ? dirs.includes(realPath(dir)) : null, resolves, shadowed: known ? !!resolves && !isOurs(resolves, name) : null, error: movedError(rt, c), command };
      }
      const line = rc && (read(rc) ?? '').split('\n').find((l) => isAlias(l, name));
      if (line) {
        const [rt, c] = [...line.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
        // zsh and bash list aliases in command -v; fish does not, so there it stays unknown
        const loaded = !known || s.kind === 'fish' ? null : !!resolves;
        const shadowed = loaded ? !isOurs(resolves, name) : null;
        const error = movedError(rt, c) ?? (loaded === false ? `A new Terminal window does not load Quorum's alias from ${path.basename(rc)}` : null);
        return { added: true, where: 'alias', name, file: rc, resolves, loaded, shadowed, error, command };
      }
    }
    return { added: false, command };
  };
  const cliApi = {
    command,
    async status() { return statusFrom(await shell()); },
    async add() {
      const s = await shell();
      if (s.unread) return { ...statusFrom(s), error: 'Quorum could not read your Terminal settings in time. Press Connect to try again' };
      const dirs = pathList(s.path, home);
      // the first name nothing else answers to in a new shell; Quorum's own launcher or alias counts as free
      const name = CLI_NAMES.find((n) => !s.which[n] || isOurs(s.which[n], n));
      if (!name) return { ...statusFrom(s), error: 'Another program already uses the quorum and quorum-app names. Run Quorum with its full path below' };
      const dir = binDirs(home).find((d) => dirs.includes(realPath(d)) && (!existsSync(path.join(d, name)) || ours(path.join(d, name))));
      const rc = startupFile(s.kind, home);
      if (!dir && !rc) return { ...statusFrom(s), error: `Quorum cannot add a command for your shell (${path.basename(String(process.env.SHELL ?? 'unknown'))}). Run Quorum with its full path below` };
      removeLaunchers();
      removeAliases();
      if (dir) {
        const f = path.join(dir, name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(f, launcher());
        chmodSync(f, 0o755);
        // the reading from before the write: the chosen name was free then, so nothing shadows it
        return statusFrom({ ...s, which: { ...s.which, [name]: '' } });
      }
      // an alias proves itself only in a new shell that loads it, so this one case reads the shell again
      addAlias(rc, s.kind, name);
      return statusFrom(await shell());
    },
    async remove() {
      removeLaunchers();
      removeAliases();
      return { added: false };
    },
  };

  // starts the MCP server the way Claude Code and Codex do and asks it to initialize; true once it answers as quorum
  const handshake = ({ timeout = 10000 } = {}) => new Promise((resolve) => {
    let p;
    try { p = spawnImpl(runtime, [cli, 'mcp'], { env: { ...process.env, ...env } }); } catch { resolve({ ok: false }); return; }
    let buf = '';
    let done = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); try { p.kill(); } catch {} resolve(r); };
    const timer = setTimeout(() => finish({ ok: false, timedOut: true }), timeout);
    p.stdout.on('data', (d) => {
      buf += d;
      for (const line of buf.split('\n')) {
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m?.id === 1) finish({ ok: m.result?.serverInfo?.name === 'quorum' });
      }
    });
    p.stderr?.on('data', () => {});
    p.stdin.on('error', () => {});
    p.on('error', () => finish({ ok: false }));
    p.on('close', () => finish({ ok: false }));
    p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'quorum-check', version: '1' } } })}\n`);
  });

  return { claude, codex, cli: cliApi, handshake, mcpCommand: `${plainEnv} "${runtime}" "${cli}" mcp`.trim() };
}
