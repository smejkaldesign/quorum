// Read-mostly access to the connected vault for the Knowledge tab: tree, link graph, new notes and folders.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SKIP = new Set(['node_modules', '.git', '.obsidian', '.trash', '.claude']);

export function walk(dir, rel, isExcluded, out) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.') || SKIP.has(name)) continue;
    const abs = path.join(dir, name);
    const r = rel ? `${rel}/${name}` : name;
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (st.isDirectory()) walk(abs, r, isExcluded, out);
    else if (name.endsWith('.md') && !isExcluded(r)) out.push(r);
  }
  return out;
}

export function vaultTree(vault, isExcluded) {
  const build = (dir, rel) => {
    const items = [];
    for (const name of readdirSync(dir).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
      if (name.startsWith('.') || SKIP.has(name)) continue;
      const abs = path.join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      let st;
      try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) items.push({ name, path: r, dir: true, children: build(abs, r) });
      else if (name.endsWith('.md') && !isExcluded(r)) items.push({ name: name.replace(/\.md$/, ''), path: r, dir: false, mtime: st.mtimeMs, ctime: st.birthtimeMs });
    }
    // folders first, like Obsidian's default file explorer
    return items.sort((a, b) => Number(b.dir) - Number(a.dir));
  };
  return build(vault, '');
}

// Obsidian graph search syntax, the subset graph.json color groups use: path:"exact" OR path:/regex/
function compileQuery(q) {
  const parts = q.split(/\s+OR\s+/);
  const exact = new Set();
  const regexes = [];
  for (const p of parts) {
    const ex = p.match(/^path:"(.+)"$/);
    const re = p.match(/^path:\/(.+)\/$/);
    if (ex) exact.add(ex[1]);
    else if (re) { try { regexes.push(new RegExp(re[1])); } catch {} }
  }
  return (rel) => exact.has(rel) || regexes.some((r) => r.test(rel));
}

const hex = (rgb) => `#${Number(rgb).toString(16).padStart(6, '0')}`;

// graph forces and color groups from the vault's Obsidian config (Quorum's own config takes over in T6)
export function graphConfig(vault) {
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(path.join(vault, '.obsidian/graph.json'), 'utf8')); } catch {}
  const groups = (cfg.colorGroups ?? []).map((g) => ({ query: g.query ?? '', color: hex(g.color?.rgb ?? 0), match: compileQuery(g.query ?? '') }));
  return {
    groups,
    settings: {
      centerStrength: cfg.centerStrength ?? 0.5,
      repelStrength: cfg.repelStrength ?? 10,
      linkStrength: cfg.linkStrength ?? 1,
      linkDistance: cfg.linkDistance ?? 250,
      nodeSizeMultiplier: cfg.nodeSizeMultiplier ?? 1,
      lineSizeMultiplier: cfg.lineSizeMultiplier ?? 1,
      textFadeMultiplier: cfg.textFadeMultiplier ?? 0,
      showOrphans: cfg.showOrphans ?? true,
      showUnresolved: !(cfg.hideUnresolved ?? false),
    },
  };
}

// when a note came to be, for the timelapse: a dated filename, then frontmatter, then the file's birth time
// (a cloned repo resets birth times, so the first two matter more than they look)
export function noteDate(vault, rel, text) {
  const named = path.basename(rel).match(/^(\d{4}-\d{2}-\d{2})/);
  const fm = text.startsWith('---') ? text.slice(0, text.indexOf('\n---', 3) + 1) : '';
  const meta = fm.match(/^(?:date|created|created_at):\s*["']?(\d{4}-\d{2}-\d{2}[^"'\n]*)/m);
  for (const d of [named?.[1], meta?.[1]]) { const t = d ? Date.parse(d) : NaN; if (!Number.isNaN(t)) return t; }
  try { return statSync(path.join(vault, rel)).birthtimeMs; } catch { return 0; }
}

const safeName = (s) => String(s).replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 120);

function inside(vault, rel) {
  const abs = path.resolve(vault, rel || '.');
  return abs === vault || abs.startsWith(vault + path.sep) ? abs : null;
}

export function createNote(vault, folderRel, title) {
  const dir = inside(vault, folderRel);
  const name = safeName(title) || 'Untitled';
  if (!dir || !existsSync(dir)) throw new Error('folder not in vault');
  let file = path.join(dir, `${name}.md`);
  for (let n = 1; existsSync(file); n++) file = path.join(dir, `${name} ${n}.md`);
  writeFileSync(file, `# ${path.basename(file, '.md')}\n\n`, { flag: 'wx' });
  return path.relative(vault, file);
}

export function createFolder(vault, parentRel, title) {
  const parent = inside(vault, parentRel);
  const name = safeName(title) || 'New folder';
  if (!parent || !existsSync(parent)) throw new Error('folder not in vault');
  let dir = path.join(parent, name);
  for (let n = 1; existsSync(dir); n++) dir = path.join(parent, `${name} ${n}`);
  mkdirSync(dir);
  return path.relative(vault, dir);
}

export function readVaultNote(vault, rel) {
  const abs = inside(vault, rel);
  if (!abs || !abs.endsWith('.md') || !existsSync(abs)) return null;
  return { abs, text: readFileSync(abs, 'utf8') };
}

// rename in place; notes keep their .md, and nothing is ever overwritten
export function renameItem(vault, rel, name) {
  const from = inside(vault, rel);
  if (!from || from === vault || !existsSync(from)) throw new Error('not in vault');
  const isNote = from.endsWith('.md');
  const clean = safeName(String(name).replace(/\.md$/, ''));
  if (!clean) throw new Error('empty name');
  const to = path.join(path.dirname(from), isNote ? `${clean}.md` : clean);
  if (to === from) return rel;
  if (existsSync(to)) throw new Error(`${path.basename(to)} already exists here`);
  renameSync(from, to);
  return path.relative(vault, to);
}

export function moveItem(vault, rel, folderRel) {
  const from = inside(vault, rel);
  const dir = inside(vault, folderRel);
  if (!from || from === vault || !dir || !existsSync(from) || !existsSync(dir)) throw new Error('not in vault');
  if (dir === from || dir.startsWith(from + path.sep)) throw new Error("can't move a folder into itself");
  const to = path.join(dir, path.basename(from));
  if (to === from) return rel;
  if (existsSync(to)) throw new Error(`${path.basename(to)} already exists there`);
  renameSync(from, to);
  return path.relative(vault, to);
}

// a copy next to the original, named like Finder does ("Note 1"), never overwriting
export function duplicateItem(vault, rel) {
  const from = inside(vault, rel);
  if (!from || from === vault || !existsSync(from)) throw new Error('not in vault');
  const isNote = from.endsWith('.md');
  const base = isNote ? from.slice(0, -3) : from;
  let n = 1;
  let to = isNote ? `${base} ${n}.md` : `${base} ${n}`;
  while (existsSync(to)) { n++; to = isNote ? `${base} ${n}.md` : `${base} ${n}`; }
  cpSync(from, to, { recursive: true, errorOnExist: true, force: false });
  return path.relative(vault, to);
}

export function vaultPath(vault, rel) {
  const abs = inside(vault, rel);
  return abs && abs !== vault && existsSync(abs) ? abs : null;
}
