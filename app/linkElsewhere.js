// The existence check Memory health runs before it offers to write a missing note: a link can name something that is
// not a note in this checkout but does exist, and writing a note with that name would split the topic or clash later.
// It looks at, in order:
//   folder  a folder in the vault with that name (a link to its index note is offered when it has one)
//   script  a script file anywhere in the vault's repo (a link to tidy-links can mean scripts/tidy-links.py)
//   skill   a skill folder in the repo or in ~/.claude/skills
//   file    a file kept in the vault's repo outside the vault folder
//   branch  a note at the same place on another local git branch of the vault's repo (git ls-tree, best effort,
//           skipped when the vault is not in a git repo)
// Reads only; caches the walk for five minutes (reset() drops it). The branch notes are read in the background with
// async git, a few branches at a time, and only for branches whose head moved (a commit's tree never changes); find()
// answers from the last read and onChange hears when a read changed the answer. refresh() waits for a current read.
import { execFile, execFileSync } from 'node:child_process';
import { readdirSync, realpathSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const SCRIPT_RE = /\.(py|js|mjs|cjs|ts|sh|bash|zsh|rb|pl)$/i;
const SKIP = new Set(['node_modules', '.git', '.trash', '.obsidian', 'dist', 'build', '__pycache__', '.venv', 'venv']);
const MAX_ENTRIES = 200000;
const MAX_BRANCHES = 40;
const TTL = 5 * 60000;
const BRANCH_TTL = 10000;
const GIT_JOBS = 4;
const posix = (p) => p.split(path.sep).join('/');
// a link target as a name: lowercased, no .md, the last part of a path
export const nameOf = (t) => String(t ?? '').trim().replace(/\/+$/, '').replace(/\.md$/i, '').split('/').pop().toLowerCase();

const GIT_OPTS = { encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 * 1024 };
const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { ...GIT_OPTS, stdio: ['ignore', 'pipe', 'ignore'] });
const gitAsync = (cwd, args) => new Promise((resolve, reject) => {
  const child = execFile('git', ['-C', cwd, ...args], GIT_OPTS, (err, out) => (err ? reject(err) : resolve(out)));
  child.stdin?.end();
});
// runs fn over items, at most jobs at a time
async function eachLimited(items, jobs, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, async () => { while (next < items.length) { const i = next++; await fn(items[i], i); } }));
}

// vault: the vault folder. skillRoots: more folders whose sub-folders are skills (default ~/.claude/skills).
// gitTop(vault) answers the repo root or null; listBranches and listTree read git, and are passed in by the tests
const real = (p) => { try { return realpathSync(p); } catch { return path.resolve(p); } };

// listBranches and listTree may answer with a value or a promise
export function createElsewhere({ vault: vaultIn, skillRoots = [path.join(os.homedir(), '.claude', 'skills')], useGit = true, gitTop, listBranches, listTree, onChange = () => {}, log = () => {} } = {}) {
  const vault = real(vaultIn);
  // the repo root, read once (reset() reads it again)
  let topKept;
  const top = () => {
    if (topKept !== undefined) return topKept;
    if (gitTop) { const t = gitTop(vault); topKept = t ? real(t) : null; }
    else if (!useGit) topKept = null;
    else { try { topKept = real(git(vault, ['rev-parse', '--show-toplevel']).trim()); } catch { topKept = null; } }
    return topKept;
  };
  const branches = listBranches ?? (async (root) => {
    let current = '';
    try { current = (await gitAsync(root, ['symbolic-ref', '--short', '-q', 'HEAD'])).trim(); } catch {}
    return (await gitAsync(root, ['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads'])).split('\n').filter(Boolean)
      .map((l) => { const [name, sha] = l.split(' '); return { name, sha }; }).filter((b) => b.name !== current);
  });
  const tree = listTree ?? (async (root, sha, prefix) => (await gitAsync(root, ['ls-tree', '-r', '--name-only', sha, '--', prefix || '.'])).split('\n').filter(Boolean));

  let walked = { at: 0, map: new Map() };
  let onBranches = { key: '', map: new Map(), at: 0 };
  // the note paths on each commit already read, by sha
  let bySha = new Map();
  let reading = null;
  // the branch notes have been read once, so find() answers for branches too
  let branchesRead = false;

  const put = (map, name, hit) => { if (name && !map.has(name)) map.set(name, hit); };
  // the walk as a generator: it yields each folder to read and takes back its entries (null when unreadable), so the
  // first walk reads synchronously and the later ones read in the background
  function* walkSteps() {
    const map = new Map();
    let n = 0;
    const root = top() ?? vault;
    function* visit(dir, depth) {
      if (depth > 10 || n > MAX_ENTRIES) return;
      const entries = yield dir;
      if (!entries) return;
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
          yield* visit(abs, depth + 1);
        } else if (SCRIPT_RE.test(e.name)) put(map, e.name.replace(SCRIPT_RE, '').toLowerCase(), { kind: 'script', where: posix(path.relative(root, abs)) });
        else if (!inVault && /\.md$/i.test(e.name)) put(map, e.name.replace(/\.md$/i, '').toLowerCase(), { kind: 'file', where: posix(path.relative(root, abs)) });
      }
    }
    yield* visit(root, 0);
    for (const s of skillRoots) {
      const entries = (yield s) ?? [];
      for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.')) put(map, e.name.toLowerCase(), { kind: 'skill', where: posix(path.join(s, e.name)).replace(posix(os.homedir()), '~') });
    }
    return map;
  }
  const opts = { withFileTypes: true };
  function walkNow() {
    const g = walkSteps();
    let step = g.next();
    while (!step.done) { let entries = null; try { entries = readdirSync(step.value, opts); } catch {} step = g.next(entries); }
    return step.value;
  }
  async function walkLater() {
    const g = walkSteps();
    let step = g.next();
    while (!step.done) { let entries = null; try { entries = await readdir(step.value, opts); } catch {} step = g.next(entries); }
    return step.value;
  }
  let walking = null;
  function walkAll() {
    if (!walked.at) walked = { at: Date.now(), map: walkNow() };
    else if (Date.now() - walked.at >= TTL && !walking) {
      const since = walked.at;
      walking = walkLater().then((map) => { if (walked.at === since) walked = { at: Date.now(), map }; }, (e) => log('elsewhere walk', e?.message ?? e)).finally(() => { walking = null; });
    }
    return walked.map;
  }

  // the branch list is read at most once per BRANCH_TTL: find() runs once per missing link. A read lists the
  // branches, then lists the notes of each branch head not read before
  async function readBranches() {
    const done = (key, map) => { const moved = key !== onBranches.key; onBranches = { key, map, at: Date.now() }; branchesRead = true; if (moved) onChange(); };
    const root = top();
    if (!root) return done('', new Map());
    let list;
    try { list = (await branches(root)).slice(0, MAX_BRANCHES); } catch { return done('', new Map()); }
    const key = list.map((b) => `${b.name}@${b.sha}`).join(',');
    if (key === onBranches.key) { onBranches.at = Date.now(); branchesRead = true; return; }
    const prefix = posix(path.relative(root, vault));
    const fresh = new Map();
    await eachLimited(list, GIT_JOBS, async (b) => {
      if (bySha.has(b.sha)) { fresh.set(b.sha, bySha.get(b.sha)); return; }
      let files;
      try { files = await tree(root, b.sha, prefix); } catch { return; }
      fresh.set(b.sha, files.filter((f) => /\.md$/i.test(f)).map((f) => (prefix && f.startsWith(`${prefix}/`) ? f.slice(prefix.length + 1) : f)));
    });
    bySha = fresh;
    const map = new Map();
    for (const b of list) for (const rel of fresh.get(b.sha) ?? []) put(map, nameOf(rel), { kind: 'branch', where: rel, branch: b.name });
    done(key, map);
  }
  function refresh() {
    reading ??= readBranches().catch((e) => log('elsewhere branches', e?.message ?? e)).finally(() => { reading = null; });
    return reading;
  }
  function branchNotes() {
    if (Date.now() - onBranches.at >= BRANCH_TTL) refresh();
    return onBranches.map;
  }

  // what a link target names outside the notes of this checkout, or null
  function find(target) {
    const name = nameOf(target);
    if (!name) return null;
    return walkAll().get(name) ?? branchNotes().get(name) ?? null;
  }
  // reset keeps the branch answer until the next read replaces it, so the marks do not go and come back
  return { find, refresh, ready: () => branchesRead, reset: () => { walked = { at: 0, map: new Map() }; topKept = undefined; onBranches = { ...onBranches, at: 0 }; } };
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
