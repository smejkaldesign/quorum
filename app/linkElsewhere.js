// The existence check Memory health runs before it offers to write a missing note: a link can name something that is
// not a note in this checkout but does exist, and writing a note with that name would split the topic or clash later.
// It looks at, in order:
//   folder  a folder in the vault with that name (a link to its index note is offered when it has one)
//   script  a script file anywhere in the vault's repo (a link to tidy-links can mean scripts/tidy-links.py)
//   skill   a skill folder in the repo or in ~/.claude/skills
//   file    a file kept in the vault's repo outside the vault folder
//   branch  a note at the same place on another local git branch of the vault's repo (git ls-tree, best effort,
//           skipped when the vault is not in a git repo)
// Reads only; caches the walk for five minutes (reset() drops it) and the branch notes until a branch moves.
import { execFileSync } from 'node:child_process';
import { readdirSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT_RE = /\.(py|js|mjs|cjs|ts|sh|bash|zsh|rb|pl)$/i;
const SKIP = new Set(['node_modules', '.git', '.trash', '.obsidian', 'dist', 'build', '__pycache__', '.venv', 'venv']);
const MAX_ENTRIES = 200000;
const MAX_BRANCHES = 40;
const TTL = 5 * 60000;
const BRANCH_TTL = 10000;
const posix = (p) => p.split(path.sep).join('/');
// a link target as a name: lowercased, no .md, the last part of a path
export const nameOf = (t) => String(t ?? '').trim().replace(/\/+$/, '').replace(/\.md$/i, '').split('/').pop().toLowerCase();

const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

// vault: the vault folder. skillRoots: more folders whose sub-folders are skills (default ~/.claude/skills).
// gitTop(vault) answers the repo root or null; listBranches and listTree read git, and are passed in by the tests
const real = (p) => { try { return realpathSync(p); } catch { return path.resolve(p); } };

export function createElsewhere({ vault: vaultIn, skillRoots = [path.join(os.homedir(), '.claude', 'skills')], useGit = true, gitTop, listBranches, listTree } = {}) {
  const vault = real(vaultIn);
  const top = () => {
    if (gitTop) { const t = gitTop(vault); return t ? real(t) : null; }
    if (!useGit) return null;
    try { return real(git(vault, ['rev-parse', '--show-toplevel']).trim()); } catch { return null; }
  };
  const branches = listBranches ?? ((root) => {
    let current = '';
    try { current = git(root, ['symbolic-ref', '--short', '-q', 'HEAD']).trim(); } catch {}
    return git(root, ['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads']).split('\n').filter(Boolean)
      .map((l) => { const [name, sha] = l.split(' '); return { name, sha }; }).filter((b) => b.name !== current);
  });
  const tree = listTree ?? ((root, sha, prefix) => git(root, ['ls-tree', '-r', '--name-only', sha, '--', prefix || '.']).split('\n').filter(Boolean));

  let walked = { at: 0, map: new Map() };
  let onBranches = { key: '', map: new Map(), at: 0 };

  const put = (map, name, hit) => { if (name && !map.has(name)) map.set(name, hit); };
  function walkAll() {
    if (Date.now() - walked.at < TTL) return walked.map;
    const map = new Map();
    let n = 0;
    const root = top() ?? vault;
    const visit = (dir, depth) => {
      if (depth > 10 || n > MAX_ENTRIES) return;
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (++n > MAX_ENTRIES) return;
        if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
        const abs = path.join(dir, e.name);
        const inVault = abs === vault || abs.startsWith(vault + path.sep);
        const rel = posix(path.relative(inVault ? vault : root, abs));
        if (e.isDirectory()) {
          const skill = /(^|\/)skills$/i.test(posix(dir));
          if (skill) put(map, e.name.toLowerCase(), { kind: 'skill', where: posix(path.relative(root, abs)) });
          else if (inVault) put(map, e.name.toLowerCase(), { kind: 'folder', where: rel });
          visit(abs, depth + 1);
        } else if (SCRIPT_RE.test(e.name)) put(map, e.name.replace(SCRIPT_RE, '').toLowerCase(), { kind: 'script', where: posix(path.relative(root, abs)) });
        else if (!inVault && /\.md$/i.test(e.name)) put(map, e.name.replace(/\.md$/i, '').toLowerCase(), { kind: 'file', where: posix(path.relative(root, abs)) });
      }
    };
    visit(root, 0);
    for (const s of skillRoots) {
      let entries = [];
      try { entries = readdirSync(s, { withFileTypes: true }); } catch {}
      for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.')) put(map, e.name.toLowerCase(), { kind: 'skill', where: posix(path.join(s, e.name)).replace(posix(os.homedir()), '~') });
    }
    walked = { at: Date.now(), map };
    return map;
  }

  // the branch list is read at most once per BRANCH_TTL: find() runs once per missing link, and each read starts git
  // processes on the main thread
  function branchNotes() {
    if (Date.now() - onBranches.at < BRANCH_TTL) return onBranches.map;
    const none = () => { onBranches = { key: '', map: new Map(), at: Date.now() }; return onBranches.map; };
    const root = top();
    if (!root) return none();
    let list;
    try { list = branches(root).slice(0, MAX_BRANCHES); } catch { return none(); }
    const key = list.map((b) => `${b.name}@${b.sha}`).join(',');
    if (key === onBranches.key) { onBranches.at = Date.now(); return onBranches.map; }
    const prefix = posix(path.relative(root, vault));
    const map = new Map();
    for (const b of list) {
      let files;
      try { files = tree(root, b.sha, prefix); } catch { continue; }
      for (const f of files) {
        if (!/\.md$/i.test(f)) continue;
        const rel = prefix && f.startsWith(`${prefix}/`) ? f.slice(prefix.length + 1) : f;
        put(map, nameOf(rel), { kind: 'branch', where: rel, branch: b.name });
      }
    }
    onBranches = { key, map, at: Date.now() };
    return map;
  }

  // what a link target names outside the notes of this checkout, or null
  function find(target) {
    const name = nameOf(target);
    if (!name) return null;
    return walkAll().get(name) ?? branchNotes().get(name) ?? null;
  }
  return { find, reset: () => { walked = { at: 0, map: new Map() }; onBranches = { key: '', map: new Map(), at: 0 }; } };
}

// the index note of a folder: index.md, _index.md, README.md or a note named like the folder
export function folderIndex(folder, rels) {
  const want = ['index', '_index', 'readme', nameOf(folder)].map((n) => `${folder}/${n}.md`.toLowerCase());
  const by = new Map(rels.map((r) => [r.toLowerCase(), r]));
  for (const w of want) if (by.has(w)) return by.get(w);
  return null;
}

// marks each missing link with what its target names elsewhere (found), unless a note already goes by that exact name
export function withFound(items, finder, rels) {
  return items.map((m) => {
    if (m.candidates?.[0]?.exact) return m;
    const hit = finder.find(m.target);
    if (!hit) return m;
    return { ...m, found: hit.kind === 'folder' ? { ...hit, rel: folderIndex(hit.where, rels) } : hit };
  });
}
