// What a link can open inside the brain besides an indexed note: a skill folder (.claude/skills/<name>/), a folder
// named by its path, a file of another kind, a note in a dot folder found by its frontmatter name:. The vault index
// (vindex.js) asks it after the note resolver (linkparse.js createResolver) finds no note, so Memory health, the graph
// and search read one answer.
//
// The walk is asynchronous (fs/promises), so it never holds the main process; the watcher's paths update it in place
// (update), and a full read runs again after a full sync of the index (refresh). Folders that hold builds, caches and
// installs (SKIP) are never walked, nor are paths the vault's guardrails exclude. At most PATHS_MAX entries are kept; a
// walk that reaches the cap stops and logs it.
//
// Matching, the same rules as createResolver where they apply:
//   a path ([[.claude/skills/deploy]], [[sub/dir/file.py]], [[../.claude/skills/deploy]], [[deploy/]]) opens the folder
//     or file it names: relative to the linking note (a ../ that leaves the vault continues at the brain root), from
//     the vault or the brain root, or as the end of a longer path
//   a bare name ([[deploy]]) opens only what goes by a name: a folder with an entry note (SKILL.md, README.md, index.md,
//     _index.md, or a note named like the folder), a note in a dot folder by its file name or its name:, and a file of
//     another kind by its full file name ([[chart.png]], as Obsidian opens attachments). A plain folder never answers a
//     bare name: [[Acme]] with only an acme/ folder stays a dead link.
import { open, readdir, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from './linkparse.js';

export const SKIP = new Set(['node_modules', '.git', '.trash', '.obsidian', '.venv', 'venv', 'dist', 'build', '.next', 'target', '__pycache__', '.cache', 'coverage', 'vendor']);
export const PATHS_MAX = 100000;
// the notes that open a folder, so a bare link to the folder's name means it
const ENTRY_NOTE = /^(skill|readme|index|_index)\.md$/i;
const HEAD = 4096;
const posix = (p) => p.split(path.sep).join('/');
const lower = (s) => String(s).toLowerCase();

// the frontmatter name: of a note, from its first lines
async function nameOf(abs) {
  let fh;
  try {
    fh = await open(abs, 'r');
    const buf = Buffer.alloc(HEAD);
    const { bytesRead } = await fh.read(buf, 0, HEAD, 0);
    const n = parseFrontmatter(buf.toString('utf8', 0, bytesRead)).props.name;
    return typeof n === 'string' && n ? n : null;
  } catch { return null; } finally { await fh?.close().catch(() => {}); }
}
// whether a folder listing holds an entry note for the folder
const hasEntry = (dirName, names) => names.some((n) => ENTRY_NOTE.test(n) || lower(n) === `${lower(dirName)}.md`);

// Walks dir. rel: its path from the walk's top. Answers [{ rel, kind: 'dir' | 'file' | 'note', entry, names }]: a note
// is a .md file the index leaves out (in a dot folder), with its name: read only there; a folder notes whether it has
// an entry note. inVault: the walk is the vault's, whose other .md files are indexed notes and stay out. skip: an
// absolute folder left out (the vault, when the walk is the brain root's). hidden: top is inside a dot folder.
// isExcluded(rel): the guardrails' exclusions
export async function walkPaths(top, { isExcluded = () => false, inVault = true, hidden = false, skip = null, max = PATHS_MAX, log = () => {} } = {}) {
  const out = [];
  let capped = false;
  const visit = async (dir, rel, hidden, depth) => {
    if (depth > 12) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= max) { capped = true; return; }
      if (SKIP.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if ((skip && abs === skip) || isExcluded(r)) continue;
      const dot = hidden || e.name.startsWith('.');
      if (e.isDirectory()) {
        let names = [];
        try { names = await readdir(abs); } catch { /* unreadable */ }
        out.push({ rel: r, kind: 'dir', entry: hasEntry(e.name, names), names: [] });
        await visit(abs, r, dot, depth + 1);
      } else if (!e.isFile()) continue;
      else if (!e.name.toLowerCase().endsWith('.md')) out.push({ rel: r, kind: 'file', entry: false, names: [] });
      else if (dot) out.push({ rel: r, kind: 'note', entry: false, names: ENTRY_NOTE.test(e.name) ? [] : [await nameOf(abs)].filter(Boolean) });
      else if (!inVault) out.push({ rel: r, kind: 'file', entry: false, names: [] });
    }
  };
  await visit(top, '', hidden, 0);
  if (capped) log('vault paths', `stopped at ${max} entries in ${top}`);
  return out;
}

const keyOf = (e) => lower(e.kind === 'note' ? e.rel.replace(/\.md$/i, '') : e.rel);
// the parts of a path from the end, two or more at a time, as far as MAX_SUFFIX parts: a/b/c/d -> c/d, b/c/d
const MAX_SUFFIX = 5;
function suffixes(key) {
  const parts = key.split('/');
  const out = [];
  for (let k = 2; k < parts.length && k <= MAX_SUFFIX; k++) out.push(parts.slice(-k).join('/'));
  return out;
}

// The lookup over the walks. vaultEntries: the vault's walk; rootEntries: the brain root's, with base the vault's path
// inside the root ('MyBrain'), or null when the vault is the root. Answers (target, fromRel) -> the rel it opens (a
// root entry as '<root>/<rel>'), or null
export function createPathIndex(vaultEntries, { rootEntries = [], base = null } = {}) {
  const byPath = new Map();
  const byRoot = new Map();
  const bySuffix = new Map();
  const byName = new Map();
  const dirs = new Map();
  const put = (m, k, v) => { if (k && !m.has(k)) m.set(k, v); };
  for (const e of vaultEntries) {
    const k = keyOf(e);
    put(byPath, k, e.rel);
    for (const s of suffixes(k)) put(bySuffix, s, e.rel);
    if (e.kind === 'dir') put(dirs, path.posix.basename(k), e.rel);
    const bare = e.kind === 'file' || (e.kind === 'dir' && e.entry) || (e.kind === 'note' && !/^(skill|readme|index|_index)$/.test(path.posix.basename(k)));
    if (bare) put(byName, path.posix.basename(k), e.rel);
    for (const n of e.names) put(byName, lower(n).trim(), e.rel);
  }
  for (const e of rootEntries) {
    const k = keyOf(e);
    const at = `<root>/${e.rel}`;
    put(byRoot, k, at);
    for (const s of suffixes(k)) put(bySuffix, s, at);
    if (e.kind === 'dir') put(dirs, path.posix.basename(k), at);
    const bare = (e.kind === 'dir' && e.entry) || (e.kind === 'note' && !/^(skill|readme|index|_index)$/.test(path.posix.basename(k)));
    if (bare) put(byName, path.posix.basename(k), at);
    for (const n of e.names) put(byName, lower(n).trim(), at);
  }
  return (target, fromRel = '') => {
    const raw = String(target ?? '').trim();
    const folder = /\/$/.test(raw);
    const t = lower(raw).replace(/\/+$/, '').replace(/\.md$/i, '').replace(/^\.\//, '');
    if (!t || t.startsWith('/')) return null;
    if (!t.includes('/')) return folder ? dirs.get(t) ?? null : byName.get(t) ?? null;
    const rel = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel || '.'), t));
    if (!rel.startsWith('../') && byPath.has(rel)) return byPath.get(rel);
    if (rel.startsWith('../') && base != null) {
      const r = path.posix.normalize(path.posix.join(base, rel));
      if (!r.startsWith('../') && byRoot.has(r)) return byRoot.get(r);
    }
    if (t.startsWith('../')) return null;
    return byPath.get(t) ?? byRoot.get(t) ?? bySuffix.get(t) ?? null;
  };
}

// the vault's path inside the brain root, or null when the root does not hold it. Compared on real paths, and without
// case on macOS, where a folder spelled Documents and documents is one folder
export function vaultBase(root, vault) {
  if (!root || !vault) return null;
  const real = (p) => { try { return realpathSync(p); } catch { return path.resolve(p); } };
  const r = real(root);
  const v = real(vault);
  const fold = process.platform === 'darwin' || process.platform === 'win32' ? lower : (s) => s;
  if (fold(v) === fold(r) || !fold(v).startsWith(fold(r) + path.sep)) return null;
  return posix(v.slice(r.length + 1));
}

// The walks of one vault, kept current. refresh() reads both again; update(rels) reads again only the vault paths the
// watcher named (and the folder above each, whose entry note may have come or gone). at(target, from) answers from the
// last read. onChange() hears when a read changed what links can open
export function createVaultPaths({ vault, root = null, isExcluded = () => false, onChange = () => {}, log = () => {}, max = PATHS_MAX }) {
  const base = vaultBase(root, vault);
  const top = base != null ? path.resolve(root) : null;
  let inVault = new Map();
  let inRoot = [];
  let at = () => null;
  let key = '';
  let running = null;
  let again = false;
  const rebuild = () => {
    const list = [...inVault.values()];
    const next = `${list.map((e) => `${e.rel}|${e.entry ? 1 : 0}|${e.names.join(',')}`).sort().join('\n')}\n--\n${inRoot.map((e) => `${e.rel}|${e.entry ? 1 : 0}|${e.names.join(',')}`).join('\n')}`;
    if (next === key) return false;
    key = next;
    at = createPathIndex(list, { rootEntries: inRoot, base });
    return true;
  };
  const changed = () => { if (rebuild()) { try { onChange(); } catch (e) { log('vault paths', String(e)); } } };
  async function readAll() {
    const v = await walkPaths(vault, { isExcluded, max, log });
    const r = top ? await walkPaths(top, { isExcluded, inVault: false, skip: path.resolve(vault), max: Math.max(0, max - v.length), log }) : [];
    inVault = new Map(v.map((e) => [e.rel, e]));
    inRoot = r;
    changed();
  }
  // one read at a time; a read asked for during one runs once more after it
  function refresh() {
    if (running) { again = true; return running; }
    running = (async () => {
      try { do { again = false; await readAll(); } while (again); } catch (e) { log('vault paths', String(e?.message ?? e)); } finally { running = null; }
    })();
    return running;
  }
  async function update(rels) {
    const touched = new Set();
    for (const rel of rels) {
      if (!rel || rel.split('/').some((s) => SKIP.has(s)) || isExcluded(rel)) continue;
      touched.add(rel);
      if (rel.includes('/')) touched.add(rel.slice(0, rel.lastIndexOf('/')));
    }
    if (!touched.size) return;
    // a path under another one read again here is read with it
    const under = (rel) => [...touched].some((t) => t !== rel && rel.startsWith(`${t}/`));
    for (const rel of touched) {
      if (under(rel)) continue;
      for (const k of [...inVault.keys()]) if (k === rel || k.startsWith(`${rel}/`)) inVault.delete(k);
      let st;
      try { st = await stat(path.join(vault, rel)); } catch { continue; }
      const name = rel.split('/').pop();
      const dot = rel.split('/').some((s) => s.startsWith('.'));
      if (st.isDirectory()) {
        let names = [];
        try { names = await readdir(path.join(vault, rel)); } catch { /* unreadable */ }
        inVault.set(rel, { rel, kind: 'dir', entry: hasEntry(name, names), names: [] });
        for (const e of await walkPaths(path.join(vault, rel), { isExcluded: (r) => isExcluded(`${rel}/${r}`), hidden: dot, max: Math.max(0, max - inVault.size), log })) inVault.set(`${rel}/${e.rel}`, { ...e, rel: `${rel}/${e.rel}` });
      } else if (!name.toLowerCase().endsWith('.md')) inVault.set(rel, { rel, kind: 'file', entry: false, names: [] });
      else if (dot) inVault.set(rel, { rel, kind: 'note', entry: false, names: ENTRY_NOTE.test(name) ? [] : [await nameOf(path.join(vault, rel))].filter(Boolean) });
    }
    changed();
  }
  return { refresh, update, at: (target, from) => at(target, from), base: () => base, size: () => inVault.size + inRoot.length };
}
