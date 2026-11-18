// When Memory health runs its review rules (rules/index.js), and what it found, per vault. Plain Node, no Electron.
//
// Cadence:
//   save         the notes that changed, a few seconds after the index sees them change
//   incremental  every 3.5 hours: the notes changed since the last sweep
//   full         once a day, only while the person is away (no keyboard or mouse for 10 minutes)
// No sweep runs while a meeting is recorded: the saves wait until it ends. Sweeps can be paused in Settings, Memory; checks on save still run for the notes that changed.
// The state lives in Quorum's data folder: findings (paths, titles and plain evidence lines, never a secret's value),
// the time of each kind of sweep, and how long the last one took.
import { closeSync, openSync, readFileSync, readSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from './linkparse.js';
import { mergeFindings, runRules } from './rules/index.js';

export const INCREMENTAL_EVERY = 3.5 * 3600000;
export const FULL_EVERY = 24 * 3600000;
export const IDLE_FOR = 10 * 60000;
const HEAD = 8192;

// which sweep is due now, or null. idleMs: how long the keyboard and mouse have been still; recording: a meeting is
// being recorded or listened to
export function dueSweep(state, { now = Date.now(), paused = false, idleMs = 0, recording = false } = {}) {
  if (paused || recording) return null;
  if (!state?.lastFull || (now - state.lastFull >= FULL_EVERY && idleMs >= IDLE_FOR)) return state?.lastFull ? 'full' : 'first';
  if (now - (state.lastIncremental ?? state.lastFull) >= INCREMENTAL_EVERY) return 'incremental';
  return null;
}

// the confidential value of every note in the vault, read from the first 8 KB of each file only (its frontmatter):
// the confidential rule needs the notes the index leaves out, and reads nothing else of them
const headOf = (abs, buf) => { try { const fd = openSync(abs, 'r'); try { return buf.toString('utf8', 0, readSync(fd, buf, 0, HEAD, 0)); } finally { closeSync(fd); } } catch { return null; } };
const tagOf = (head) => { const v = parseFrontmatter(head).props.confidential; return v === undefined ? null : v; };
export function scanTags(vault, isExcluded = () => false) {
  const out = [];
  const buf = Buffer.alloc(HEAD);
  const walk = (dir, rel, depth) => {
    if (depth > 12) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(path.join(dir, e.name), r, depth + 1); continue; }
      if (!/\.md$/i.test(e.name) || isExcluded(r)) continue;
      const head = headOf(path.join(dir, e.name), buf);
      if (head != null) out.push({ rel: r, value: tagOf(head) });
    }
  };
  walk(vault, '', 0);
  return out;
}

// the scan after a save: the earlier scan with only the notes that changed read again, so a save never walks the vault
export function rescanTags(vault, tags, rels, isExcluded = () => false) {
  const changed = new Set(rels);
  const out = tags.filter((t) => !changed.has(t.rel));
  const buf = Buffer.alloc(HEAD);
  for (const r of changed) {
    if (!/\.md$/i.test(r) || isExcluded(r) || r.split('/').some((p) => p.startsWith('.') || p === 'node_modules')) continue;
    const head = headOf(path.join(vault, r), buf);
    if (head != null) out.push({ rel: r, value: tagOf(head) });
  }
  return out;
}

export function createMemorySweep({ file, now = () => Date.now() }) {
  let all = null;
  const load = () => { if (!all) { try { all = JSON.parse(readFileSync(file, 'utf8')); } catch { all = {}; } if (!all || typeof all !== 'object') all = {}; } return all; };
  const save = () => { try { writeFileSync(file, JSON.stringify(all)); } catch {} };
  const state = (vault) => load()[vault] ?? null;

  // runs the rules for one kind of sweep. ctx: { notes, resolve, tags }. only: the notes that changed (kind 'save').
  // A finding keeps the time it was first seen while its key stays; findings of a first sweep are marked initial, so
  // Notifications lists them as read. Answers the state with the kind, the notes checked and the time taken
  function run(vault, kind, ctx, { only = null } = {}) {
    const t0 = Date.now();
    const s = load()[vault] ?? (load()[vault] = { findings: [], lastFull: 0, lastIncremental: 0 });
    const live = new Set([...ctx.notes.map((n) => n.rel), ...(ctx.tags ?? []).map((t) => t.rel)]);
    const since = s.lastIncremental || s.lastFull || 0;
    const scope = kind === 'save' ? only : kind === 'incremental' ? ctx.notes.filter((n) => n.mtime > since).map((n) => n.rel) : null;
    // a finding on a note that is gone goes with it
    const prev = s.findings.filter((f) => f.notes.every((rel) => live.has(rel)));
    const { findings, ms, whole = [] } = scope && !scope.length ? { findings: [], ms: {} } : runRules(ctx, { only: scope });
    const seen = new Map(prev.map((f) => [f.key, f]));
    const at = now();
    for (const f of findings) { const was = seen.get(f.key); f.at = was?.at ?? at; f.initial = was ? !!was.initial : kind === 'first'; }
    s.findings = scope && !scope.length ? prev : mergeFindings(prev, findings, scope, whole);
    if (kind === 'full' || kind === 'first') s.lastFull = at;
    if (kind !== 'save') s.lastIncremental = at;
    s.last = { kind, at, ms: Date.now() - t0, rules: ms, notes: scope ? scope.length : ctx.notes.length, found: s.findings.length };
    save();
    return s;
  }
  // the state a sweep in another process left (main holds what the memory engine answers, memoryEngine.js); kept in
  // memory only, since the process that ran the sweep saved it
  const put = (vault, s) => { load()[vault] = s; };
  return { run, state, put, findings: (vault) => state(vault)?.findings ?? [] };
}
