// The file system and git side of the vault hygiene rule (rules/hygiene.js): one folder walk and one git status per full
// sweep, read-only, and the steps Approve runs. Plain Node with no Electron; the Trash comes in as a function, so the
// tests pass a stand-in and the app passes shell.trashItem.
import { execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { compactText } from './rules/hygiene.js';

// Folder names tools and tests leave. Each rule names its kind, the .gitignore pattern that covers it, and whether a
// folder of that name may hold Markdown nobody links to (a temp folder) or must hold none at all (a build folder, where
// the same name can be a folder of notes)
const RANDOM6 = /^(.+?)[-_.]([A-Za-z0-9]{6})$/;
// six characters that read as random: a digit and a letter, or both cases, so a word like "finale" is never one
const looksRandom = (s) => (/\d/.test(s) && /[A-Za-z]/.test(s)) || (/[a-z]/.test(s) && /[A-Z]/.test(s));
const BUILD_NAMES = new Set(['node_modules', 'dist', '.next', '.turbo', '.cache', '__pycache__', '.pytest_cache', '.parcel-cache', 'coverage', '.nyc_output', 'out-tsc']);
export function litterKind(name) {
  if (/^TemporaryDirectory\.[A-Za-z0-9_]+$/.test(name)) return { kind: 'temp', ignore: 'TemporaryDirectory.*/', strict: false };
  if (/^tmp[A-Za-z0-9_]{6,}$/.test(name) && looksRandom(name.slice(3))) return { kind: 'temp', ignore: 'tmp*/', strict: false };
  const m = name.match(RANDOM6);
  if (m && looksRandom(m[2]) && /^[A-Za-z][\w.-]*$/.test(m[1])) return { kind: 'temp', ignore: `${m[1]}${name[m[1].length]}??????/`, strict: false };
  if (/\.lock$/.test(name)) return { kind: 'lock', ignore: '*.lock/', strict: false };
  if (BUILD_NAMES.has(name)) return { kind: 'build', ignore: `${name}/`, strict: true };
  return null;
}

// the size and file count of a folder, and the Markdown files in it. budget: entries left to read in this sweep; a
// folder past it counts what was read
function measure(abs, budget) {
  let bytes = 0;
  let files = 0;
  const md = [];
  const stack = [abs];
  while (stack.length && budget.left > 0) {
    const d = stack.pop();
    let ents;
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (--budget.left <= 0) break;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      if (!e.isFile()) continue;
      files++;
      try { bytes += statSync(p).size; } catch {}
      if (/\.md$/i.test(e.name)) md.push(p);
    }
  }
  return { bytes, files, md };
}

// the litter folders of a vault: a folder whose name a tool gives (litterKind) and that holds no note another note links
// to (a build folder holds no Markdown at all). linked: the vault-relative notes some note links to. A litter folder is
// not walked further, and .git and .obsidian never are
export function scanLitter(vault, linked = new Set(), { maxEntries = 400000 } = {}) {
  const out = [];
  const budget = { left: maxEntries };
  const stack = [''];
  while (stack.length && budget.left > 0) {
    const rel = stack.pop();
    let ents;
    try { ents = readdirSync(path.join(vault, rel), { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (!e.isDirectory() || e.name === '.git' || e.name === '.obsidian' || e.name === '.trash') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      const k = litterKind(e.name);
      if (!k) { budget.left--; stack.push(r); continue; }
      const m = measure(path.join(vault, r), budget);
      const mdRels = m.md.map((p) => path.relative(vault, p).split(path.sep).join('/'));
      if (k.strict ? mdRels.length : mdRels.some((x) => linked.has(x))) continue;
      out.push({ rel: r, kind: k.kind, ignore: k.ignore, bytes: m.bytes, files: m.files });
    }
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

// input: text for git's stdin, for a path list too long for the command line
const git = (cwd, args, exec, input = null) => exec('git', args, { cwd, encoding: 'utf8', timeout: 30000, maxBuffer: 64 << 20, ...(input == null ? { stdio: ['ignore', 'pipe', 'ignore'] } : { input, stdio: ['pipe', 'pipe', 'pipe'] }) });

// The git state of the vault with two git calls: rev-parse for the repository, then one status with the branch, its
// upstream and how far behind it is. dirty: the vault's Markdown files git holds no current copy of, with their mtime.
// Answers { repo: false } outside a repository
export function gitState(vault, { exec = execFileSync, skip = () => false } = {}) {
  let top;
  let gitDir;
  let prefix;
  try {
    [top, gitDir, prefix = ''] = git(vault, ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--show-prefix'], exec).split('\n');
  } catch { return { repo: false }; }
  if (!top) return { repo: false };
  let raw;
  try { raw = git(vault, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--', '.'], exec); } catch { return { repo: false }; }
  let branch = null;
  let upstream = null;
  let behind = 0;
  const dirty = [];
  const recs = raw.split('\0');
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    if (r.startsWith('# branch.head ')) { const b = r.slice(14); branch = b === '(detached)' ? null : b; continue; }
    if (r.startsWith('# branch.upstream ')) { upstream = r.slice(18); continue; }
    if (r.startsWith('# branch.ab ')) { behind = Math.abs(Number(r.split(' ')[3] ?? 0)) || 0; continue; }
    let file = null;
    let untracked = false;
    if (r.startsWith('? ')) { file = r.slice(2); untracked = true; }
    else if (r.startsWith('1 ')) file = r.split(' ').slice(8).join(' ');
    else if (r.startsWith('2 ')) { file = r.split(' ').slice(9).join(' '); i++; }
    if (!file || !/\.md$/i.test(file) || !file.startsWith(prefix)) continue;
    const rel = file.slice(prefix.length);
    if (skip(rel)) continue;
    let mtime;
    try { mtime = statSync(path.join(vault, rel)).mtimeMs; } catch { continue; }
    dirty.push({ rel, untracked, mtime });
  }
  const merging = existsSync(path.join(gitDir, 'MERGE_HEAD')) ? 'merge'
    : existsSync(path.join(gitDir, 'rebase-merge')) || existsSync(path.join(gitDir, 'rebase-apply')) ? 'rebase'
      : existsSync(path.join(gitDir, 'CHERRY_PICK_HEAD')) ? 'cherry-pick' : null;
  // the .gitignore an ignore entry goes in: the vault's own, else the repository's
  const own = path.join(vault, '.gitignore');
  const root = path.join(top, '.gitignore');
  const gitignore = existsSync(own) ? own : existsSync(root) ? root : null;
  return { repo: true, top, prefix, branch, upstream, behind, merging, gitignore, dirty };
}

// Size history for the growth check: per note, the sizes seen at sweeps over the last 8 days, one sample per 6 hours.
// Answers the history to keep and, per note, its smallest size a week ago or later
const SAMPLE_MS = 6 * 3600000;
const KEEP_MS = 8 * 86400000;
const WEEK_MS = 7 * 86400000;
export function recordSizes(history, notes, now) {
  const next = {};
  const before = {};
  for (const x of notes) {
    const samples = (history?.[x.rel] ?? []).filter(([at]) => now - at < KEEP_MS);
    const last = samples[samples.length - 1];
    if (!last || now - last[0] >= SAMPLE_MS) samples.push([now, x.size ?? 0]);
    next[x.rel] = samples;
    const week = samples.filter(([at]) => now - at <= WEEK_MS && at < now);
    if (week.length) before[x.rel] = Math.min(...week.map(([, s]) => s));
  }
  return { history: next, before };
}

// The whole read-only scan the rule needs, once per full sweep: the litter walk, git status, and the size history.
// file: where the size history is kept between sweeps
export function scanHygiene({ vault, notes, file = null, now = Date.now(), exec = execFileSync, history = null }) {
  let past = history;
  if (!past && file) { try { past = JSON.parse(readFileSync(file, 'utf8'))?.[vault] ?? {}; } catch { past = {}; } }
  const sizes = recordSizes(past ?? {}, notes, now);
  if (file) {
    let all = {};
    try { all = JSON.parse(readFileSync(file, 'utf8')) ?? {}; } catch {}
    all[vault] = sizes.history;
    try { writeJson(file, all); } catch {}
  }
  const linked = new Set(notes.filter((x) => x.inbound > 0).map((x) => x.rel));
  const litter = scanLitter(vault, linked);
  const inLitter = (rel) => litter.some((d) => rel === d.rel || rel.startsWith(`${d.rel}/`));
  const g = gitState(vault, { exec, skip: inLitter });
  return { litter, git: g, history: sizes.before };
}
function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, file);
}

// ---- the steps Approve runs ----

// a folder still litter when Approve runs: it exists, still has a litter name, and still holds no linked note
export function stillLitter(vault, rel, linked = new Set()) {
  const abs = path.join(vault, rel);
  const k = litterKind(path.basename(rel));
  if (!k || !existsSync(abs)) return false;
  const m = measure(abs, { left: 400000 });
  const md = m.md.map((p) => path.relative(vault, p).split(path.sep).join('/'));
  return k.strict ? md.length === 0 : !md.some((x) => linked.has(x));
}

// the ignore patterns not yet in a .gitignore, appended under one comment line. Answers the patterns it added
export function addIgnores(gitignore, patterns) {
  if (!gitignore || !patterns.length) return [];
  let text = '';
  try { text = readFileSync(gitignore, 'utf8'); } catch {}
  const have = new Set(text.split('\n').map((l) => l.trim()));
  const add = patterns.filter((p) => !have.has(p) && !have.has(p.replace(/\/$/, '')));
  if (!add.length) return [];
  appendFileSync(gitignore, `${text && !text.endsWith('\n') ? '\n' : ''}\n# temp and build folders tools leave (added by Quorum)\n${add.join('\n')}\n`);
  return add;
}

// the backup copy of a note before a compact step: <dataDir>/hygiene-backups/<time>-<path with / as __>
export function backupNote(dataDir, vault, rel, now = Date.now()) {
  const dir = path.join(dataDir, 'hygiene-backups');
  mkdirSync(dir, { recursive: true });
  const to = path.join(dir, `${new Date(now).toISOString().replace(/[:.]/g, '-')}-${rel.replace(/[/\\]/g, '__')}`);
  copyFileSync(path.join(vault, rel), to);
  return to;
}
export const compactNote = (text) => compactText(text);

// stages and commits paths on the current branch, after the same checks the rule made: a branch checked out, nothing in
// progress, not behind its upstream. Only the given paths go in the commit; anything else staged stays staged
export function commitNotes(vault, paths, message, { exec = execFileSync } = {}) {
  const g = gitState(vault, { exec });
  if (!g.repo) throw new Error('The vault is no longer in a git repository, so Quorum did not commit');
  if (!g.branch) throw new Error('The repository has no branch checked out, so Quorum did not commit');
  if (g.merging) throw new Error(`A ${g.merging} is in progress, so Quorum did not commit`);
  if (g.behind > 0) throw new Error(`The branch ${g.branch} is ${g.behind} ${g.behind === 1 ? 'commit' : 'commits'} behind ${g.upstream ?? 'its upstream'}, so Quorum did not commit. Pull first`);
  const live = paths.filter((p) => existsSync(path.join(vault, p)));
  if (!live.length) throw new Error('None of the notes are there any more, so Quorum did not commit');
  const list = `${live.join('\0')}\0`;
  git(vault, ['add', '--pathspec-from-file=-', '--pathspec-file-nul'], exec, list);
  // a commit with a path list commits those paths only (git commit --only)
  git(vault, ['commit', '-q', '-m', message, '--pathspec-from-file=-', '--pathspec-file-nul'], exec, list);
  return { branch: g.branch, count: live.length };
}
