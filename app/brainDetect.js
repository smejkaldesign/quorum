// Finding the agent root and the notes vault in a folder the person picked. An Obsidian vault is found by its
// .obsidian/ folder; a vault without one is found by its shape: daily and meetings folders, numbered folders,
// an index.md, and markdown notes. Reads folder and file names only, never note contents.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const NAMED = ['MyBrain', 'vault', 'notes'];
const SKIP = new Set(['node_modules', 'dist', 'build', 'out']);
const DAILY = /^(\d+[-_ ])?daily([-_ ]notes)?$/i;
const MEETINGS = /^(\d+[-_ ])?meetings?$/i;
const PROJECTS = /^(\d+[-_ ])?projects?$/i;
const NUMBERED = /^\d{2}[-_ ][a-z]/i;
const MANY_NOTES = 5;

const has = (...p) => existsSync(path.join(...p));
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const AGENT_FILE = (d) => has(d, 'CLAUDE.md') || has(d, 'AGENTS.md');
const AGENT_DIR = (d) => isDir(path.join(d, '.claude')) || isDir(path.join(d, '.agents'));

function entries(dir) {
  try { return readdirSync(dir, { withFileTypes: true }).filter((e) => !e.name.startsWith('.')); } catch { return []; }
}

// markdown files in the folder and one level down; agent instruction files are not notes
function noteCount(dir) {
  let n = 0;
  for (const e of entries(dir)) {
    if (e.isFile() && /\.md$/i.test(e.name) && !/^(CLAUDE|AGENTS|README)\.md$/i.test(e.name)) n++;
    else if (e.isDirectory() && !SKIP.has(e.name)) n += entries(path.join(dir, e.name)).filter((f) => f.isFile() && /\.md$/i.test(f.name)).length;
  }
  return n;
}

// how much a folder looks like a notes vault by its own top level; 0 means no vault structure
export function vaultScore(dir) {
  const dirs = entries(dir).filter((e) => e.isDirectory()).map((e) => e.name);
  let s = 0;
  if (dirs.some((d) => DAILY.test(d))) s += 2;
  if (dirs.some((d) => MEETINGS.test(d))) s += 2;
  if (dirs.some((d) => PROJECTS.test(d))) s += 1;
  if (dirs.filter((d) => NUMBERED.test(d)).length >= 2) s += 1;
  if (has(dir, 'index.md')) s += 1;
  return s;
}

const structured = (dir) => vaultScore(dir) >= 2;

// the agent root: walking up, a folder with CLAUDE.md or AGENTS.md beside .claude/ or .agents/ wins; a CLAUDE.md with
// no agent folder beside it belongs to the vault, so the walk keeps going. The home folder and above hold the
// person's own Claude settings, so they only count when nothing below matches
export function findRoot(folder, home = homedir()) {
  const above = (d) => !path.relative(d, home).startsWith('..');
  let first = null;
  for (let d = folder; ; d = path.dirname(d)) {
    if (AGENT_FILE(d)) {
      if (AGENT_DIR(d) && !above(d)) return d;
      first ??= d;
    }
    if (d === path.dirname(d)) break;
  }
  return first ?? folder;
}

function findVault(folder, root) {
  if (has(folder, '.obsidian')) return { vault: folder, notes: true };
  const named = [...new Set([root, folder])].flatMap((base) => NAMED.map((c) => path.join(base, c)));
  const obsidian = named.find((c) => has(c, '.obsidian'));
  if (obsidian) return { vault: obsidian, notes: true };
  if (has(root, '.obsidian')) return { vault: root, notes: true };
  if (structured(folder)) return { vault: folder, notes: true };
  // the notes live in one subfolder: a named one first, then the one clear winner among the others
  const namedHit = named.find((c) => isDir(c) && structured(c));
  if (namedHit) return { vault: namedHit, notes: true };
  const scored = entries(folder).filter((e) => e.isDirectory() && !SKIP.has(e.name))
    .map((e) => ({ dir: path.join(folder, e.name), score: vaultScore(path.join(folder, e.name)) }))
    .filter((c) => c.score >= 2).sort((a, b) => b.score - a.score);
  if (scored.length && (scored.length === 1 || scored[0].score > scored[1].score)) return { vault: scored[0].dir, notes: true };
  return { vault: folder, notes: noteCount(folder) >= MANY_NOTES };
}

// folder: what the person picked. vault: a notes folder they already chose, kept as is
export function inspectBrain(folder, { vault: chosen = null, home = homedir() } = {}) {
  const root = findRoot(chosen || folder, home);
  const found = chosen ? { vault: chosen, notes: true } : findVault(folder, root);
  const vault = found.vault;
  return {
    root, vault, name: path.basename(vault),
    markers: {
      agentOS: has(root, 'CLAUDE.md') ? 'CLAUDE.md' : has(root, 'AGENTS.md') ? 'AGENTS.md' : null,
      obsidian: has(vault, '.obsidian'),
      safetyHooks: has(root, '.claude/hooks/output-secret-tripwire.py'),
      notes: found.notes,
    },
  };
}
