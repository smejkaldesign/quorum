// context budget: the sizes of the files Claude Code loads into every session in an Agent OS, read-only. Claude Code
// loads the user CLAUDE.md in ~/.claude, every CLAUDE.md and CLAUDE.local.md from the vault root up to /, the root's
// .claude/CLAUDE.md and .claude/rules/*.md, the files any of those import with @path, and the first MEMORY_LINES
// lines of the project's auto-memory index. A CLAUDE.md in a subfolder loads only when Claude works in that folder. Quorum shows the numbers and the cause, and never edits these files
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { INSTRUCTIONS_LIMIT } from './agent.js';
import { LEARNED_CLOSE, LEARNED_FILE, LEARNED_OPEN } from './keeper.js';

// Claude Code reads this many lines of MEMORY.md and drops the rest
export const MEMORY_LINES = 200;
// Claude Code warns about a CLAUDE.md past this many characters
export const LARGE_FILE = 40000;
const NESTED_DEPTH = 4;
// Claude Code follows @imports this many hops deep
const IMPORT_DEPTH = 5;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'vendor']);

const read = (p) => { try { return statSync(p).isFile() ? readFileSync(p, 'utf8') : null; } catch { return null; } };
const tokens = (chars) => Math.ceil(chars / 4);
const listMd = (d) => { try { return readdirSync(d).filter((n) => n.endsWith('.md') && !n.startsWith('.')).sort(); } catch { return []; } };

// the folder name Claude Code keeps a project's transcripts and auto memory under: the absolute path with every
// character other than a letter or digit turned into a dash. Older versions changed only slashes and dots
export const projectSlugs = (root) => [...new Set([path.resolve(root).replace(/[^a-zA-Z0-9]/g, '-'), path.resolve(root).replace(/[/.]/g, '-')])];
export function projectDir(root, home = homedir()) {
  const dirs = projectSlugs(root).map((s) => path.join(home, '.claude', 'projects', s));
  return dirs.find((d) => { try { return statSync(d).isDirectory(); } catch { return false; } }) ?? dirs[0];
}

// the marked block the keeper writes, in characters: the facts, or a pointer to .quorum/learned.md
export function learnedBlock(text) {
  const a = text.indexOf(LEARNED_OPEN);
  const b = text.indexOf(LEARNED_CLOSE);
  return a >= 0 && b > a ? { start: a, chars: b + LEARNED_CLOSE.length - a } : null;
}

// the lines of MEMORY.md past the cut that hold something; each is an entry Claude Code never sees
export function memoryCut(text) {
  const lines = text.replace(/\n$/, '').split('\n');
  return { lines: lines.length, cut: lines.slice(MEMORY_LINES).filter((l) => l.trim()).length };
}

function nested(root) {
  const out = [];
  const walk = (dir, depth) => {
    let names;
    try { names = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of names) {
      if (!d.isDirectory() || d.name.startsWith('.') || SKIP_DIRS.has(d.name)) continue;
      const sub = path.join(dir, d.name);
      for (const f of ['CLAUDE.md', 'CLAUDE.local.md']) if (read(path.join(sub, f)) != null) out.push(path.join(sub, f));
      if (depth < NESTED_DEPTH) walk(sub, depth + 1);
    }
  };
  walk(root, 1);
  return out.sort();
}

// the @path imports in a CLAUDE.md, outside code blocks and code spans: relative to that file, or to the home folder
// for @~/. An email address is not an import, since the @ has to start a word
export function importsIn(text, from, home = homedir()) {
  const out = [];
  let fenced = false;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    for (const m of line.replace(/`[^`]*`/g, '').matchAll(/(?:^|\s)@((?:~\/)?[^\s@]+)/g)) {
      const ref = m[1].replace(/[),.;:]+$/, '');
      out.push(ref.startsWith('~/') ? path.join(home, ref.slice(2)) : path.resolve(path.dirname(from), ref));
    }
  }
  return out;
}

// a rule file with paths: in its frontmatter loads only when Claude works on a matching file
const scoped = (text) => {
  if (!/^---\r?\n/.test(text)) return false;
  const close = text.indexOf('\n---', 3);
  return close > 0 && /^paths\s*:/m.test(text.slice(0, close));
};

// every file in the budget with its size and scope (user, project, memory: every session; nested: only in that
// folder; paths: only for matching files), the totals for one session, Quorum's own share, and plain warnings.
// instructions is the file Quorum's own agent puts into its prompt, when it does; null when Claude Code loads the
// instructions itself or Instructions is not included
export function contextBudget({ root, vault = root, home = homedir(), instructions = null }) {
  const show = (abs) => (abs.startsWith(root + path.sep) ? path.relative(root, abs) : abs.startsWith(home + path.sep) ? `~/${path.relative(home, abs)}` : abs);
  const files = [];
  const add = (abs, scope, depth = 0) => {
    const text = read(abs);
    if (text == null || files.some((f) => f.abs === abs)) return;
    const f = { path: show(abs), abs, scope, chars: text.length, lines: text.split('\n').length, tokens: tokens(text.length), loaded: text.length, warn: null, learned: learnedBlock(text), importedBy: null };
    if (scope === 'memory') {
      const m = memoryCut(text);
      f.lines = m.lines;
      f.cut = m.cut;
      f.loaded = text.split('\n').slice(0, MEMORY_LINES).join('\n').length;
      if (m.cut) f.warn = `${m.cut} memory ${m.cut === 1 ? 'entry never loads' : 'entries never load'}. MEMORY.md has ${m.lines} lines and Claude Code reads the first ${MEMORY_LINES}.`;
    } else if (text.length > LARGE_FILE) f.warn = `Over ${LARGE_FILE.toLocaleString('en-US')} characters. Claude Code warns that a file this large slows every session.`;
    files.push(f);
    // imports load with the file that names them, up to IMPORT_DEPTH hops; a file already listed is not read twice
    if (scope !== 'memory' && depth < IMPORT_DEPTH) {
      for (const imp of importsIn(text, abs, home)) {
        const before = files.length;
        add(imp, scope, depth + 1);
        if (files.length > before) files[before].importedBy = f.path;
      }
    }
  };
  add(path.join(home, '.claude', 'CLAUDE.md'), 'user');
  for (let dir = path.resolve(root); ; dir = path.dirname(dir)) {
    add(path.join(dir, 'CLAUDE.md'), 'project');
    add(path.join(dir, 'CLAUDE.local.md'), 'project');
    if (path.dirname(dir) === dir) break;
  }
  add(path.join(root, '.claude', 'CLAUDE.md'), 'project');
  for (const n of listMd(path.join(root, '.claude', 'rules'))) {
    const abs = path.join(root, '.claude', 'rules', n);
    add(abs, scoped(read(abs) ?? '') ? 'paths' : 'project');
  }
  add(path.join(projectDir(root, home), 'memory', 'MEMORY.md'), 'memory');
  for (const abs of nested(root)) add(abs, 'nested');
  // the keeper's own CLAUDE.md, wherever the vault sits under the root
  add(path.join(vault, 'CLAUDE.md'), 'nested');

  const every = files.filter((f) => f.scope !== 'nested' && f.scope !== 'paths');
  const total = every.reduce((n, f) => n + f.loaded, 0);
  // the learned block the keeper writes into the vault's CLAUDE.md. When the facts live in .quorum/learned.md, the
  // block is a short pointer and the file itself is named as one Claude Code does not load on its own
  const mine = files.find((f) => f.abs === path.join(vault, 'CLAUDE.md') && f.learned);
  const aside = read(path.join(vault, LEARNED_FILE));
  const always = mine && mine.scope !== 'nested' && mine.scope !== 'paths';
  const quorum = mine ? { path: mine.path, chars: mine.learned.chars, everySession: !!always, share: always && total ? mine.learned.chars / total : null, aside: aside == null ? null : { path: show(path.join(vault, LEARNED_FILE)), chars: aside.length } } : null;
  // Quorum's own agent puts the first INSTRUCTIONS_LIMIT characters of the included instructions file into its prompt
  const itext = instructions ? read(instructions) : null;
  const ilearned = itext == null ? null : learnedBlock(itext);
  const agent = itext == null ? null : { path: show(instructions), chars: itext.length, limit: INSTRUCTIONS_LIMIT, cut: Math.max(0, itext.length - INSTRUCTIONS_LIMIT), learnedCut: !!ilearned && ilearned.start + ilearned.chars > INSTRUCTIONS_LIMIT };

  const warnings = files.filter((f) => f.warn).map((f) => `${f.path}: ${f.warn}`);
  if (agent?.cut) warnings.push(`${agent.path}: Quorum's own agent reads the first ${INSTRUCTIONS_LIMIT.toLocaleString('en-US')} characters, so the last ${agent.cut.toLocaleString('en-US')} are left out of its answers${agent.learnedCut ? ', including part of the learned facts' : ''}.`);
  return { files: files.map(({ learned, ...f }) => ({ ...f, learnedChars: learned?.chars ?? 0 })), total: { chars: total, tokens: tokens(total) }, quorum, agent, warnings };
}
