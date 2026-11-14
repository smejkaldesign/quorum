// Quorum reached from the person's agents: the quorum MCP server in Claude Code and in Codex, and the quorum command in
// Terminal. All three run the CLI that ships beside the app with the app's own runtime; nothing listens on a port.
// Pure Node with an injectable command runner, HOME, Codex folder and shell, so the tests never touch the real
// ~/.claude.json, ~/.codex, ~/.zshrc or PATH folders.
import { execFile, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { cliRun } from './claudeCli.js';

export const MARK = '# added by Quorum';
const read = (f) => { try { return readFileSync(f, 'utf8'); } catch { return null; } };
const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const toml = (s) => JSON.stringify(String(s));

// the folders a quorum launcher can go in, in order: user owned, and common on a Mac PATH
export const binDirs = (home) => [path.join(home, '.local', 'bin'), path.join(home, 'bin')];

// a fresh interactive login shell's PATH, and what `quorum` resolves to there: what a new Terminal window sees. The
// markers keep anything .zshrc prints out of the answer
const MARKER = '__QUORUM__';
export function readShell({ exec = execFile, shell = process.env.SHELL || '/bin/zsh' } = {}) {
  const script = `printf '\\n${MARKER}%s${MARKER}%s${MARKER}\\n' "$PATH" "$(command -v quorum 2>/dev/null)"`;
  return new Promise((resolve) => {
    exec(shell, ['-ilc', script], { timeout: 8000, encoding: 'utf8' }, (_err, out) => {
      const m = String(out ?? '').match(new RegExp(`${MARKER}(.*?)${MARKER}(.*?)${MARKER}`));
      resolve(m ? { path: m[1], quorum: m[2].trim() } : { path: process.env.PATH ?? '', quorum: '', unread: true });
    });
  });
}
const pathList = (p, home) => String(p ?? '').split(':').filter(Boolean).map((d) => path.resolve(d.replace(/^~(?=\/|$)/, home)).replace(/\/+$/, ''));

// ~/.codex/config.toml without the quorum server: its [mcp_servers.quorum] table and any [mcp_servers.quorum.*] subtable
const QUORUM_TABLE = /^\s*\[\s*mcp_servers\s*\.\s*(?:"quorum"|'quorum'|quorum)\s*(?:\]|\.)/;
export function withoutCodexServer(text) {
  const out = [];
  let skip = false;
  for (const line of String(text ?? '').split('\n')) {
    if (/^\s*\[/.test(line)) skip = QUORUM_TABLE.test(line);
    if (!skip) out.push(line);
  }
  return out.join('\n').replace(/\n{3,}$/, '\n\n');
}
export function withCodexServer(text, { command, args, env }) {
  const rest = withoutCodexServer(text).replace(/\s+$/, '');
  const envLines = Object.entries(env).map(([k, v]) => `${k} = ${toml(v)}`).join('\n');
  const block = `[mcp_servers.quorum]\ncommand = ${toml(command)}\nargs = [${args.map(toml).join(', ')}]\n${envLines ? `\n[mcp_servers.quorum.env]\n${envLines}\n` : ''}`;
  return rest ? `${rest}\n\n${block}` : block;
}
export const hasCodexServer = (text) => String(text ?? '').split('\n').some((l) => QUORUM_TABLE.test(l));

export function createAgentLink({ runtime, cli, env = {}, home = homedir(), codexHome, run = cliRun, shell = () => readShell(), spawnImpl = spawn }) {
  const envArgs = (flag) => Object.entries(env).flatMap(([k, v]) => [flag, `${k}=${v}`]);
  const envShell = Object.entries(env).map(([k, v]) => `${k}=${sh(v)}`).join(' ');
  const gone = (p) => !p || !existsSync(p);
  const movedError = (rt, c) => (gone(rt) ? "Can't find the runtime where it used to be" : gone(c) ? "Can't find Quorum where it used to be" : null);

  const claude = {
    async status() {
      const r = await run('claude', ['mcp', 'get', 'quorum'], { timeout: 20000 });
      return { installed: !r.missing, added: r.ok };
    },
    async add() {
      // the server name goes before -e: Claude Code's -e takes values until the next flag, so a name after it is read
      // as one more env value; -- ends the list
      const r = await run('claude', ['mcp', 'add', 'quorum', '--scope', 'user', ...envArgs('--env'), '--', runtime, cli, 'mcp'], { timeout: 20000 });
      if (r.missing) return { added: false, error: 'Install Claude Code first.' };
      if (!r.ok) return { added: false, error: r.out.trim().split('\n')[0] };
      // trust what Claude Code reads back, not the add's exit code; a proxy managing MCP config can drop the entry
      const added = (await claude.status()).added;
      return { added, error: added ? null : "Claude Code didn't keep the Quorum entry. Another tool may manage your MCP servers." };
    },
    async remove() { return { added: !(await run('claude', ['mcp', 'remove', 'quorum', '--scope', 'user'], { timeout: 20000 })).ok }; },
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
      return { installed: true, via: 'config', added: hasCodexServer(read(codexConfig())) };
    },
    async add() {
      const r = await run('codex', ['mcp', 'add', 'quorum', ...envArgs('--env'), '--', runtime, cli, 'mcp'], { timeout: 15000 });
      if (r.missing) {
        if (!existsSync(codexDir())) return { added: false, error: 'Install Codex first.' };
        writeFileSync(codexConfig(), withCodexServer(read(codexConfig()), { command: runtime, args: [cli, 'mcp'], env }));
      } else if (!r.ok) return { added: false, error: r.out.trim().split('\n')[0] };
      const added = (await codex.status()).added;
      return { added, error: added ? null : "Codex didn't keep the Quorum entry." };
    },
    async remove() {
      const r = await run('codex', ['mcp', 'remove', 'quorum'], { timeout: 15000 });
      if (r.missing && existsSync(codexConfig())) writeFileSync(codexConfig(), withoutCodexServer(read(codexConfig())));
      return { added: (await codex.status()).added };
    },
  };

  // the quorum command: a launcher script in a user bin folder that a new shell already has on PATH, so it works in
  // every Terminal window at once; with no such folder, an alias in ~/.zshrc, which works in new windows
  const ZSHRC = path.join(home, '.zshrc');
  const isAlias = (l) => l.startsWith('alias quorum=') && l.endsWith(MARK);
  const launcher = () => `#!/bin/sh\n${MARK}\n${envShell ? `${envShell} ` : ''}exec ${sh(runtime)} ${sh(cli)} "$@"\n`;
  const ours = (f) => (read(f) ?? '').split('\n')[1] === MARK;
  const unq = (s) => s.replace(/'\\''/g, "'");
  const launcherPaths = (text) => { const m = text.match(/exec '((?:[^']|'\\'')*)' '((?:[^']|'\\'')*)'/); return m ? [unq(m[1]), unq(m[2])] : []; };
  const removeAlias = () => { const t = read(ZSHRC); if (t !== null && t.split('\n').some(isAlias)) writeFileSync(ZSHRC, t.split('\n').filter((l) => !isAlias(l)).join('\n')); };
  const command = `${Object.entries(env).map(([k, v]) => `${k}=${v}`).join(' ')} "${runtime}" "${cli}"`.trim();
  const cliApi = {
    command,
    async status() {
      const s = await shell();
      const dirs = pathList(s.path, home);
      for (const dir of binDirs(home)) {
        const f = path.join(dir, 'quorum');
        if (!existsSync(f) || !ours(f)) continue;
        const [rt, c] = launcherPaths(read(f));
        return { added: true, where: 'path', path: f, onPath: dirs.includes(dir), resolves: s.quorum, error: movedError(rt, c), command };
      }
      const line = (read(ZSHRC) ?? '').split('\n').find(isAlias);
      if (line) {
        const [rt, c] = [...line.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
        return { added: true, where: 'alias', resolves: s.quorum, error: movedError(rt, c), command };
      }
      return { added: false, resolves: s.quorum, command };
    },
    async add() {
      const s = await shell();
      const dirs = pathList(s.path, home);
      const dir = binDirs(home).find((d) => dirs.includes(d) && (!existsSync(path.join(d, 'quorum')) || ours(path.join(d, 'quorum'))));
      if (dir) {
        const f = path.join(dir, 'quorum');
        mkdirSync(dir, { recursive: true });
        writeFileSync(f, launcher());
        chmodSync(f, 0o755);
        removeAlias();
      } else {
        const t = read(ZSHRC) ?? '';
        const kept = t.split('\n').filter((l) => !isAlias(l)).join('\n');
        writeFileSync(ZSHRC, `${kept}${kept && !kept.endsWith('\n') ? '\n' : ''}alias quorum='${Object.entries(env).map(([k, v]) => `${k}=${v}`).join(' ')} "${runtime}" "${cli}"' ${MARK}\n`);
      }
      return cliApi.status();
    },
    async remove() {
      for (const dir of binDirs(home)) { const f = path.join(dir, 'quorum'); if (existsSync(f) && ours(f)) unlinkSync(f); }
      removeAlias();
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

  return { claude, codex, cli: cliApi, handshake };
}
