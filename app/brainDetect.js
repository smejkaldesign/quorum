// Finding the Agent OS folder and the notes folder in a folder the person picked. An Obsidian vault is found by its
// .obsidian/ folder; a vault without one is found by its shape: daily and meetings folders, a projects folder,
// numbered folders and an index.md, together with notes. Reads folder and file names only, never note contents.
// A saved Agent OS folder is never worked out again; detection runs only when the person picks a folder to connect.
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const NAMED = ['MyBrain', 'vault', 'notes'];
const SKIP = new Set(['node_modules', 'dist', 'build', 'out', 'vendor', 'target']);
const DAILY = /^(\d+[-_ ])?daily([-_ ]notes)?$/i;
const MEETINGS = /^(\d+[-_ ])?meetings?$/i;
const PROJECTS = /^(\d+[-_ ])?projects?$/i;
const NUMBERED = /^\d{2}[-_ ][a-z]/i;
// files every code repo carries; they are not the person's notes
const META = /^(CLAUDE|AGENTS|README|CHANGELOG|CHANGES|HISTORY|CONTRIBUTING|CONTRIBUTORS|SECURITY|CODE_OF_CONDUCT|LICENSE|LICENCE|NOTICE|AUTHORS|SUPPORT|GOVERNANCE|MAINTAINERS)\.md$/i;
const CODE = ['package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'setup.py', 'requirements.txt', 'Gemfile', 'pom.xml', 'build.gradle', 'composer.json', 'Package.swift', 'mix.exs', 'deno.json'];
const MANY_NOTES = 5;
// the file Quorum writes into every folder it builds (starter.js SETUP_FILE)
const QUORUM_BUILT = path.join('.quorum', 'setup.json');

const has = (...p) => existsSync(path.join(...p));
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
const agentFile = (d) => has(d, 'CLAUDE.md') || has(d, 'AGENTS.md');
const agentDir = (d) => isDir(path.join(d, '.claude')) || isDir(path.join(d, '.agents'));
const isCode = (d) => CODE.some((f) => has(d, f));

// the home folder and every folder above it; never an Agent OS by detection
function atOrAboveHome(d, home) {
  const r = path.relative(d, home);
  return !r.startsWith('..') && !path.isAbsolute(r);
}

// visible entries, with symlinks followed to what they point at; a broken link is left out
function entries(dir) {
  let list;
  try { list = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return list.filter((e) => !e.name.startsWith('.')).flatMap((e) => {
    const abs = path.join(dir, e.name);
    if (!e.isSymbolicLink()) return [{ name: e.name, abs, dir: e.isDirectory(), file: e.isFile() }];
    const dirLink = isDir(abs);
    return dirLink || isFile(abs) ? [{ name: e.name, abs, dir: dirLink, file: !dirLink }] : [];
  });
}

// notes in the folder and one level down. A folder reached twice through symlinks counts once, and the scan never goes
// deeper than one level, so a link that points back up cannot loop
export function noteCount(dir) {
  const seen = new Set();
  const real = (p) => { try { return realpathSync(p); } catch { return p; } };
  const count = (d, deep) => {
    const key = real(d);
    if (seen.has(key)) return 0;
    seen.add(key);
    let n = 0;
    for (const e of entries(d)) {
      if (e.file && /\.md$/i.test(e.name) && !META.test(e.name)) n++;
      else if (e.dir && deep && !SKIP.has(e.name)) n += count(e.abs, false);
    }
    return n;
  };
  return count(dir, true);
}

// the distinct vault signals at a folder's top level; a code manifest takes one away
export function vaultSignals(dir) {
  const dirs = entries(dir).filter((e) => e.dir).map((e) => e.name);
  const signals = {
    daily: dirs.some((d) => DAILY.test(d)),
    meetings: dirs.some((d) => MEETINGS.test(d)),
    projects: dirs.some((d) => PROJECTS.test(d)),
    numbered: dirs.filter((d) => NUMBERED.test(d)).length >= 2,
    index: has(dir, 'index.md'),
  };
  const score = Object.values(signals).filter(Boolean).length - (isCode(dir) ? 1 : 0);
  return { ...signals, score };
}

// a notes vault by shape: two signals or more, one of them a daily or meetings folder, and notes in it
export function structured(dir) {
  const s = vaultSignals(dir);
  return s.score >= 2 && (s.daily || s.meetings) && noteCount(dir) > 0;
}

// the Agent OS folder for a picked folder. The nearest folder with CLAUDE.md or AGENTS.md is the Agent OS, with one
// exception: a notes subfolder (MyBrain, vault, notes) whose CLAUDE.md sits under a parent that has CLAUDE.md or
// AGENTS.md beside .claude/ or .agents/ belongs to that parent. An Obsidian vault and a folder Quorum built keep their
// own CLAUDE.md. The walk stops below the home folder, so home or a folder above it is never chosen
export function findRoot(folder, home = homedir()) {
  for (let d = folder; !atOrAboveHome(d, home); d = path.dirname(d)) {
    if (agentFile(d)) {
      const parent = path.dirname(d);
      const own = agentDir(d) || has(d, '.obsidian') || has(d, QUORUM_BUILT);
      if (!own && NAMED.includes(path.basename(d)) && parent !== d && !atOrAboveHome(parent, home) && agentFile(parent) && agentDir(parent)) return parent;
      return d;
    }
    if (d === path.dirname(d)) break;
  }
  return folder;
}

// found: how the notes folder was decided. obsidian and structure keep today's behavior, child means Quorum picked
// a subfolder and asks the person to confirm it, notes is a plain folder of notes, none is nothing that looks like notes
export function findVault(folder, root, home = homedir()) {
  if (has(folder, '.obsidian')) return { vault: folder, found: 'obsidian' };
  const named = [...new Set([root, folder])].flatMap((base) => NAMED.map((c) => path.join(base, c)));
  const obsidian = named.find((c) => has(c, '.obsidian'));
  if (obsidian) return { vault: obsidian, found: 'obsidian' };
  if (has(root, '.obsidian')) return { vault: root, found: 'obsidian' };
  if (structured(folder)) return { vault: folder, found: 'structure' };
  // the notes live in one subfolder: a named one first, then the one clear winner among the others. Never under the
  // home folder, and only a named one in a code project, where any folder could look like notes
  if (!atOrAboveHome(folder, home)) {
    const namedHit = named.find((c) => isDir(c) && structured(c));
    if (namedHit) return { vault: namedHit, found: 'child' };
  }
  if (!atOrAboveHome(folder, home) && !isCode(folder)) {
    const scored = entries(folder).filter((e) => e.dir && !SKIP.has(e.name) && structured(e.abs))
      .map((e) => ({ dir: e.abs, score: vaultSignals(e.abs).score })).sort((a, b) => b.score - a.score);
    if (scored.length === 1 || (scored.length > 1 && scored[0].score > scored[1].score)) return { vault: scored[0].dir, found: 'child' };
  }
  const plain = !isCode(folder) && noteCount(folder) >= MANY_NOTES;
  return { vault: folder, found: plain ? 'notes' : 'none' };
}

function result(root, vault, found) {
  return {
    root, vault, name: path.basename(vault),
    markers: {
      agentOS: has(root, 'CLAUDE.md') ? 'CLAUDE.md' : has(root, 'AGENTS.md') ? 'AGENTS.md' : null,
      obsidian: has(vault, '.obsidian'),
      safetyHooks: has(root, '.claude/hooks/output-secret-tripwire.py'),
      notes: found !== 'none',
      found,
    },
  };
}

// folder: what the person picked. root and vault: folders already decided, kept as they are
export function inspectBrain(folder, { root = null, vault = null, home = homedir() } = {}) {
  const r = root || findRoot(vault || folder, home);
  if (vault) return result(r, vault, 'chosen');
  const v = findVault(folder, r, home);
  return result(r, v.vault, v.found);
}

// the connected Agent OS from saved settings: the saved folders exactly as they are
export function savedBrain(settings, home = homedir()) {
  if (!settings?.brainRoot) return null;
  return inspectBrain(settings.brainRoot, { root: settings.brainRoot, vault: settings.vaultPath || null, home });
}
