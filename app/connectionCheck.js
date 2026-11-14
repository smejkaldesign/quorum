// Check connection: proves the hand-off between Quorum and the person's agent. It saves a test note in Quorum's own
// notes folder (only when that folder already exists) and removes it, checks whether the agent's own search would see
// it, checks the quorum MCP server is set up in Claude Code and Codex and answers, and checks the quorum command runs in
// a new shell. Quorum never asks anyone to change their Agent OS: when the agent's own search skips the notes, Quorum's
// MCP search tools cover them, and that is reported as covered. Every failure names a fix Quorum does itself, as an
// action the UI shows as a button: add or fix a registration, choose a folder, or check again. Detection is generic
// (ignore files, hidden folders, Claude Code's Read deny rules, the exclude lists of search scripts); nothing here knows
// any one vault's layout.
import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
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

// why the agent's own search would miss `file`, read only: hidden folders, ignore files (and git's own when the folder
// is a work tree), Claude Code Read deny rules and search scripts that exclude the folder
export async function searchProblems(root, file, { home = homedir(), git = gitCheckIgnore } = {}) {
  const out = [];
  const hidden = path.relative(root, file).split(path.sep).slice(0, -1).find((seg) => seg.startsWith('.'));
  if (hidden) out.push({ kind: 'hidden', name: hidden });
  let ig = ignoredBy(root, file);
  if (!ig) { const g = gitRoot(root); if (g) ig = await git(g, file); }
  if (ig) out.push({ kind: 'ignored', ...ig });
  const deny = deniedBy(root, file, home);
  if (deny) out.push({ kind: 'denied', ...deny });
  for (const sc of scriptExcludes(root, file)) out.push({ kind: 'script', ...sc });
  return out;
}

// what hides the notes from the agent's own search, as information only: Quorum never asks for a change there
export function problemText(p, root, home) {
  const at = (f) => (f.startsWith(root + path.sep) ? path.relative(root, f) : tilde(f, home));
  if (p.kind === 'hidden') return `Its own search skips hidden folders such as "${p.name}".`;
  if (p.kind === 'ignored') return `Its own search skips them because of "${p.pattern}" in ${at(p.file)}.`;
  if (p.kind === 'denied') return `Claude Code's own file reads skip them because of ${p.rule} in ${at(p.file)}.`;
  if (p.kind === 'script') return `${at(p.file)} leaves out "${p.name}".`;
  return 'They are saved outside your Agent OS folder.';
}

export const CHECK_NOTE = 'quorum-connection-check';
export const COVERED = "Your agent finds these through Quorum's search tools";

// runs every check; agent is createAgentLink's result. Returns { ok, checks: [{ id, label, state, fix, action, detail }] }
// with state ok, fail, warn or skip; action is what the fix button does: add-claude, add-codex, add-cli, fix-cli,
// connect-folder, choose-meetings or retry
export async function checkConnection({ root, notesDir, agent, home = homedir(), git, now = Date.now }) {
  const checks = [];
  const add = (id, label, state, { fix = null, action = null, detail = null } = {}) => checks.push({ id, label, state, fix, action, detail });
  const L = {
    folder: 'Quorum can save meeting notes',
    note: 'A test note saves where meeting notes go',
    search: 'Your agent can find meeting notes',
    claude: 'Quorum MCP connected in Claude Code',
    codex: 'Quorum MCP connected in Codex',
    server: 'Quorum MCP server starts',
    cli: 'quorum command runs in Terminal',
  };
  const [claude, codex] = await Promise.all([agent.claude.status(), agent.codex.status()]);
  const mcpOn = claude.added || (codex.added && !codex.error);

  let problems = null;
  if (!root) add('folder', L.folder, 'fail', { fix: 'Quorum has no Agent OS folder yet. Press Choose folder to connect one.', action: 'connect-folder' });
  else if (!notesDir) add('folder', L.folder, 'fail', { fix: 'Quorum has no meetings folder yet. Press Choose folder to pick one.', action: 'choose-meetings' });
  else if (!existsSync(notesDir)) {
    // Quorum's notes folder appears with the first meeting note; until then the check writes nothing and asks only
    // whether Quorum could create it
    let writable = false;
    try { accessSync(path.dirname(notesDir), constants.W_OK); writable = true; } catch {}
    if (!writable) add('folder', L.folder, 'fail', { fix: `Quorum cannot save notes in ${tilde(path.dirname(notesDir), home)}. Press Choose folder to pick another.`, action: 'choose-meetings' });
    else {
      add('folder', L.folder, 'ok');
      add('note', L.note, 'skip', { detail: 'Quorum creates its notes folder with your first meeting note.' });
      if (!path.relative(root, notesDir).startsWith('..')) problems = await searchProblems(root, path.join(notesDir, `${CHECK_NOTE}.md`), { home, ...(git ? { git } : {}) });
      else problems = [{ kind: 'outside' }];
    }
  } else {
    const note = path.join(notesDir, `${CHECK_NOTE}-${now()}.md`);
    let wrote = false;
    try {
      try {
        writeFileSync(note, `---\ntitle: Quorum connection check\n---\n\nQuorum wrote this note to check the connection and removes it right away.\n`, { flag: 'wx' });
        wrote = read(note)?.includes('Quorum connection check') === true;
      } catch {}
      if (!wrote) add('folder', L.folder, 'fail', { fix: `Quorum cannot save notes in ${tilde(notesDir, home)}. Press Choose folder to pick another.`, action: 'choose-meetings' });
      else {
        add('folder', L.folder, 'ok');
        add('note', L.note, 'ok', { detail: tilde(notesDir, home) });
        problems = path.relative(root, note).startsWith('..') ? [{ kind: 'outside' }] : await searchProblems(root, note, { home, ...(git ? { git } : {}) });
      }
    } finally {
      if (wrote || existsSync(note)) { try { unlinkSync(note); } catch {} }
    }
  }
  if (problems) {
    // the agent's own search is a bonus; Quorum's MCP search covers the notes either way
    const why = problems.length ? ` ${problemText(problems[0], root, home)}` : '';
    if (!problems.length) add('search', L.search, 'ok', { detail: "Your agent's own search sees them too." });
    else if (mcpOn) add('search', L.search, 'ok', { detail: `${COVERED}.${why}` });
    else add('search', L.search, 'warn', { detail: `${COVERED} once Quorum's MCP is added below.${why}` });
  }

  if (!claude.installed) add('claude', L.claude, 'skip', { detail: 'Claude Code is not installed on this Mac.' });
  else add('claude', L.claude, claude.added ? 'ok' : 'fail', claude.added ? {} : { fix: 'Quorum is not added to Claude Code yet.', action: 'add-claude' });
  if (!codex.installed) add('codex', L.codex, 'skip', { detail: 'Codex is not installed on this Mac.' });
  else if (codex.added && codex.error) add('codex', L.codex, 'fail', { fix: `${codex.error}. Press Add to Codex to set it up again.`, action: 'add-codex' });
  else add('codex', L.codex, codex.added ? 'ok' : 'fail', codex.added ? {} : { fix: 'Quorum is not added to Codex yet.', action: 'add-codex' });

  const [server, cli] = await Promise.all([agent.handshake(), agent.cli.status()]);
  add('server', L.server, server.ok ? 'ok' : 'fail', server.ok ? {} : { fix: "Quorum's MCP server did not answer. Press Check again to retry.", action: 'retry' });
  const named = cli.name && cli.name !== 'quorum' ? `Another quorum command is on this Mac, so Quorum's is called ${cli.name}.` : null;
  if (!cli.added) add('cli', L.cli, 'fail', { fix: 'The quorum command is not set up yet.', action: 'add-cli' });
  else if (cli.error) add('cli', L.cli, 'fail', { fix: `${cli.error}. Press Fix to set the quorum command up again.`, action: 'fix-cli' });
  else if (cli.where === 'path' && !cli.onPath) add('cli', L.cli, 'fail', { fix: `${tilde(path.dirname(cli.path), home)} is no longer on your PATH. Press Fix to set the quorum command up again.`, action: 'fix-cli' });
  else if (cli.shadowed) add('cli', L.cli, 'fail', { fix: 'Another program answers to this name in Terminal. Press Fix and Quorum picks a name that works.', action: 'fix-cli' });
  else if (cli.where === 'alias') add('cli', L.cli, 'ok', { detail: [named, `Type ${cli.name ?? 'quorum'} in Terminal windows you open from now on.`].filter(Boolean).join(' ') });
  else add('cli', L.cli, 'ok', { detail: [named, cli.path ? tilde(cli.path, home) : null].filter(Boolean).join(' ') || null });

  return { ok: checks.every((c) => c.state !== 'fail'), checks };
}
