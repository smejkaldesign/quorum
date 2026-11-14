// Check connection: proves the hand-off between Quorum and the person's agent. It writes a test note where meeting
// notes go, checks the agent's own search can see it, checks the quorum MCP server is set up in Claude Code and Codex
// and answers, and checks the quorum command runs in a new shell. The test note is always removed. Detection is
// generic: ignore files, hidden folders, Claude Code's Read deny rules and the exclude lists of search scripts in the
// folder; nothing here knows any one vault's layout. Each failure carries one sentence naming the fix.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const read = (f) => { try { return readFileSync(f, 'utf8'); } catch { return null; } };
const tilde = (p, home) => (p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p);

// a glob in gitignore syntax as a regular expression over a slash path
export function globRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      const before = i === 0 || glob[i - 1] === '/';
      const after = glob[i + 2] === '/' || i + 2 === glob.length;
      if (before && after) { re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*'; i += glob[i + 2] === '/' ? 2 : 1; continue; }
      re += '[^/]*'; i += 1; continue;
    }
    if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}
export function ignoreRules(text) {
  return String(text ?? '').split('\n').map((line) => {
    let s = line.replace(/\s+$/, '');
    if (!s || s.startsWith('#')) return null;
    const neg = s.startsWith('!');
    if (neg) s = s.slice(1);
    if (s.startsWith('\\')) s = s.slice(1);
    const dirOnly = s.endsWith('/');
    if (dirOnly) s = s.replace(/\/+$/, '');
    const anchored = s.includes('/');
    s = s.replace(/^\//, '');
    return s ? { raw: line.trim(), neg, dirOnly, anchored, re: globRe(s) } : null;
  }).filter(Boolean);
}
const ruleHits = (r, rel, isDir) => (!r.dirOnly || isDir) && r.re.test(r.anchored ? rel : path.posix.basename(rel));

const IGNORE_FILES = ['.gitignore', '.ignore', '.rgignore'];
// the first ignore file and line that hide `file` (inside root) from search tools that honor ignore files, such as
// ripgrep and Claude Code's own search. A folder that is ignored hides everything in it
export function ignoredBy(root, file) {
  const rel = path.relative(root, file).split(path.sep);
  const sources = [];
  if (existsSync(path.join(root, '.git', 'info', 'exclude'))) sources.push({ dir: root, file: path.join(root, '.git', 'info', 'exclude') });
  for (let n = 0; n < rel.length; n++) {
    const dir = path.join(root, ...rel.slice(0, n));
    for (const name of IGNORE_FILES) { const f = path.join(dir, name); if (existsSync(f)) sources.push({ dir, file: f }); }
  }
  const parsed = sources.map((s) => ({ ...s, rules: ignoreRules(read(s.file)) }));
  for (let n = 1; n <= rel.length; n++) {
    const target = path.join(root, ...rel.slice(0, n));
    const isDir = n < rel.length;
    let hit = null;
    for (const s of parsed) {
      if (!(target + path.sep).startsWith(s.dir + path.sep)) continue;
      const sub = path.relative(s.dir, target).split(path.sep).join('/');
      for (const r of s.rules) if (ruleHits(r, sub, isDir)) hit = r.neg ? null : { file: s.file, pattern: r.raw };
    }
    if (hit) return hit;
  }
  return null;
}

// Claude Code's permissions.deny rules that stop it reading `file`: Read(pattern) in the folder's .claude settings and
// the user's ~/.claude/settings.json. // is an absolute path, ~/ the home folder, anything else the Agent OS folder
export function deniedBy(root, file, home) {
  const files = [path.join(root, '.claude', 'settings.json'), path.join(root, '.claude', 'settings.local.json'), path.join(home, '.claude', 'settings.json')];
  for (const f of files) {
    let j; try { j = JSON.parse(read(f) ?? ''); } catch { continue; }
    for (const rule of Array.isArray(j?.permissions?.deny) ? j.permissions.deny : []) {
      const m = String(rule).match(/^Read\((.+)\)$/);
      if (!m) continue;
      const p = m[1];
      const abs = p.startsWith('//') ? p.slice(1) : p.startsWith('~/') ? path.join(home, p.slice(2)) : path.join(root, p.replace(/^\.?\//, ''));
      const re = globRe(abs.split(path.sep).join('/'));
      const parts = file.split(path.sep);
      for (let n = 2; n <= parts.length; n++) if (re.test(parts.slice(0, n).join('/'))) return { file: f, rule: String(rule) };
    }
  }
  return null;
}

// search scripts in the folder (a name with search, index, embed, recall or query; up to three folders deep) whose
// exclude, ignore or skip lists name a folder the meeting notes sit in
const SCRIPT = /\.(py|sh|bash|zsh|js|mjs|cjs|ts|rb)$/i;
const SEARCHY = /search|index|embed|recall|query|grep/i;
const SKIP_DIRS = new Set(['node_modules', 'venv', '.venv', '__pycache__', 'dist', 'build']);
export function scriptExcludes(root, file, { maxFiles = 40 } = {}) {
  const relDir = path.relative(root, path.dirname(file)).split(path.sep).filter(Boolean);
  if (!relDir.length) return [];
  const names = new Set([...relDir.map((s) => s.toLowerCase()), relDir.join('/').toLowerCase()]);
  const notesTop = path.join(root, relDir[0]);
  const scripts = [];
  const walk = (dir, depth) => {
    if (depth > 3 || scripts.length >= maxFiles) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!e.name.startsWith('.') && !SKIP_DIRS.has(e.name) && p !== notesTop) walk(p, depth + 1); }
      else if (e.isFile() && SCRIPT.test(e.name) && SEARCHY.test(e.name)) { try { if (statSync(p).size < 256 * 1024) scripts.push(p); } catch {} }
      if (scripts.length >= maxFiles) return;
    }
  };
  walk(root, 0);
  const out = [];
  for (const s of scripts) {
    const lines = (read(s) ?? '').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!/exclu|ignor|skip|prune/i.test(lines[i])) continue;
      // the list that starts on this line, up to its closing bracket or 20 lines
      let depth = 0;
      let block = '';
      for (let k = i; k < Math.min(lines.length, i + 20); k++) {
        block += `${lines[k]}\n`;
        depth += (lines[k].match(/[[{(]/g) ?? []).length - (lines[k].match(/[\]})]/g) ?? []).length;
        if (depth <= 0) break;
      }
      const hit = [...block.matchAll(/["'`]([^"'`\n]{1,200})["'`]/g)].map((m) => m[1]).find((q) => names.has(q.replace(/^\.\//, '').replace(/\/(\*\*)?\/?$/, '').toLowerCase()));
      if (hit) { out.push({ file: s, name: hit }); break; }
    }
  }
  return out;
}

// the folder a git work tree starts in, when `dir` is inside one
const gitRoot = (dir) => { for (let d = dir; ; d = path.dirname(d)) { if (existsSync(path.join(d, '.git'))) return d; if (path.dirname(d) === d) return null; } };
const gitCheckIgnore = (cwd, file) => new Promise((resolve) => {
  execFile('git', ['check-ignore', '-v', file], { cwd, timeout: 5000, encoding: 'utf8' }, (err, out) => {
    if (err) { resolve(null); return; }
    const m = String(out).match(/^(.*?):\d+:(.*?)\t/);
    resolve(m ? { file: path.resolve(cwd, m[1]), pattern: m[2] } : null);
  });
});

// every reason the agent's search would miss `file`, each as one sentence naming the fix
export async function searchProblems(root, file, { home = homedir(), git = gitCheckIgnore } = {}) {
  const rel = path.relative(root, file);
  const show = (p) => tilde(p, home);
  const relRoot = (p) => (p.startsWith(root + path.sep) ? path.relative(root, p) : show(p));
  const notesRel = path.dirname(rel);
  const out = [];
  const hidden = rel.split(path.sep).slice(0, -1).find((s) => s.startsWith('.'));
  if (hidden) out.push(`The folder "${hidden}" starts with a dot, so most search tools skip it. Choose a meetings folder without a dot in its path in Settings > Memory.`);
  let ig = ignoredBy(root, file);
  if (!ig) { const g = gitRoot(root); if (g) ig = await git(g, file); }
  if (ig) out.push(`${relRoot(ig.file)} hides ${notesRel} from your agent's search. Remove the line "${ig.pattern}" from ${relRoot(ig.file)}.`);
  const deny = deniedBy(root, file, home);
  if (deny) out.push(`${relRoot(deny.file)} stops Claude Code from reading ${notesRel}. Remove "${deny.rule}" from its permissions.deny list.`);
  for (const s of scriptExcludes(root, file)) out.push(`${relRoot(s.file)} skips "${s.name}" when it searches. Remove "${s.name}" from its exclude list so your agent finds meeting notes.`);
  return out;
}

export const CHECK_NOTE = 'quorum-connection-check';

// runs every check; agent is createAgentLink's result. Returns { ok, checks: [{ id, label, state, fix?, detail? }] }
// with state ok, fail, warn or skip
export async function checkConnection({ root, notesDir, agent, home = homedir(), git, now = Date.now }) {
  const checks = [];
  const add = (id, label, state, fix = null, detail = null) => checks.push({ id, label, state, fix, detail });
  const L = {
    folder: 'Quorum can write to your Agent OS folder',
    note: 'A test note saves where meeting notes go',
    search: "Your agent's search can find meeting notes",
    claude: 'Quorum MCP connected in Claude Code',
    codex: 'Quorum MCP connected in Codex',
    server: 'Quorum MCP server starts',
    cli: 'quorum command runs in Terminal',
  };

  if (!root) add('folder', L.folder, 'fail', 'Connect your Agent OS folder in Settings > Memory, then check again.');
  else if (!notesDir) add('folder', L.folder, 'fail', 'Choose a meetings folder in Settings > Memory so Quorum knows where to save notes.');
  else {
    const made = !existsSync(notesDir);
    const note = path.join(notesDir, `${CHECK_NOTE}-${now()}.md`);
    try {
      let wrote = false;
      try {
        mkdirSync(notesDir, { recursive: true });
        writeFileSync(note, `---\ntitle: Quorum connection check\n---\n\nQuorum wrote this note to check the connection and removes it right away.\n`);
        wrote = read(note)?.includes('Quorum connection check') === true;
      } catch {}
      if (!wrote) {
        add('folder', L.folder, 'fail', `Quorum cannot write to ${tilde(notesDir, home)}. Give your user account write access to that folder in Finder, then check again.`);
      } else {
        add('folder', L.folder, 'ok');
        add('note', L.note, 'ok', null, tilde(notesDir, home));
        if (path.relative(root, note).startsWith('..')) {
          add('search', L.search, 'fail', `Meeting notes save to ${tilde(notesDir, home)}, outside your Agent OS folder. Choose a meetings folder inside ${tilde(root, home)} in Settings > Memory.`);
        } else {
          const problems = await searchProblems(root, note, { home, ...(git ? { git } : {}) });
          add('search', L.search, problems.length ? 'fail' : 'ok', problems.length ? problems.join(' ') : null);
        }
      }
    } finally {
      try { unlinkSync(note); } catch {}
      if (made) { try { rmdirSync(notesDir); } catch {} }
    }
  }

  const [claude, codex] = await Promise.all([agent.claude.status(), agent.codex.status()]);
  if (!claude.installed && !codex.installed) add('claude', L.claude, 'fail', 'Install Claude Code or Codex, then press Add next to it.');
  else if (!claude.installed) add('claude', L.claude, 'skip', null, 'Claude Code is not installed on this Mac.');
  else add('claude', L.claude, claude.added ? 'ok' : 'fail', claude.added ? null : 'Press Add next to Claude Code to connect Quorum to it.');
  if (!codex.installed) add('codex', L.codex, 'skip', null, 'Codex is not installed on this Mac.');
  else if (codex.added && codex.error) add('codex', L.codex, 'fail', `${codex.error}. Press Add next to Codex to set it up again.`);
  else add('codex', L.codex, codex.added ? 'ok' : 'fail', codex.added ? null : 'Press Add next to Codex to connect Quorum to it.');

  const [server, cli] = await Promise.all([agent.handshake(), agent.cli.status()]);
  add('server', L.server, server.ok ? 'ok' : 'fail', server.ok ? null : "Quorum's MCP server did not answer. Quit and reopen Quorum, then check again.");
  if (!cli.added) add('cli', L.cli, 'fail', 'Press Connect next to Quorum CLI to add the quorum command.');
  else if (cli.error) add('cli', L.cli, 'fail', `${cli.error}. Choose Fix connection in the Quorum CLI menu.`);
  else if (cli.where === 'path' && cli.resolves?.startsWith('alias ')) add('cli', L.cli, 'fail', 'A quorum alias in your shell setup comes before the installed command. Remove the quorum alias from your .zshrc, then check again.');
  else if (cli.where === 'path' && cli.resolves && cli.resolves !== cli.path) add('cli', L.cli, 'fail', `Another quorum command at ${tilde(cli.resolves, home)} comes first on your PATH. Remove or rename it, then check again.`);
  else if (cli.where === 'path' && !cli.onPath) add('cli', L.cli, 'fail', `${tilde(path.dirname(cli.path), home)} is no longer on your PATH. Choose Fix connection in the Quorum CLI menu.`);
  else if (cli.where === 'alias') add('cli', L.cli, 'ok', null, 'Works in Terminal windows you open from now on.');
  else add('cli', L.cli, 'ok', null, cli.path ? tilde(cli.path, home) : null);

  return { ok: checks.every((c) => c.state === 'ok' || c.state === 'skip'), checks };
}
