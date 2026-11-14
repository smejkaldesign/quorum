// brain check: a few known questions, asked of the Agent OS on the user's own model source, each with the terms a good
// answer contains. A run happens only when the user presses Run (or turns the plugin on); Quorum never starts one on
// its own. Each run is saved with the date and a fingerprint of the model, CLAUDE.md and MEMORY.md, so a later change
// to any of them shows as a reason to run again, and today's answers can be compared with the last run's.
// Checks and runs live in Quorum's own data folder, keyed by the vault root, and never in the vault
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { projectDir } from './context-budget.js';
import { writeAtomic } from './relink.js';

export const MAX_CHECKS = 6;
const MAX_TERMS = 10;
const KEEP_RUNS = 10;
const ANSWER_CAP = 4000;

// the starting questions; the user writes the expected terms for each
export const STARTER_CHECKS = [
  { id: 'team', prompt: 'What does my team do, and who is on it?', expect: [] },
  { id: 'rule', prompt: 'Name one rule I set for how you write or work.', expect: [] },
  { id: 'projects', prompt: 'Which projects am I working on now? Name the note you found them in.', expect: [] },
  { id: 'decision', prompt: 'What is the most recent decision recorded in my notes?', expect: [] },
];

const sha = (t) => (t == null ? null : createHash('sha256').update(t).digest('hex').slice(0, 16));
const read = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };

// what the user typed, made safe to store: at most MAX_CHECKS checks with a prompt, each with up to MAX_TERMS terms
export function cleanChecks(list) {
  if (!Array.isArray(list)) return [];
  const ids = new Set();
  const out = [];
  for (const c of list) {
    const prompt = String(c?.prompt ?? '').trim().slice(0, 500);
    if (!prompt) continue;
    let id = /^[\w-]{1,40}$/.test(String(c?.id ?? '')) ? String(c.id) : '';
    if (!id || ids.has(id)) { let i = out.length + 1; while (ids.has(`check-${i}`)) i++; id = `check-${i}`; }
    ids.add(id);
    const terms = (Array.isArray(c?.expect) ? c.expect : String(c?.expect ?? '').split(','))
      .map((t) => String(t).trim().slice(0, 80)).filter(Boolean);
    out.push({ id, prompt, expect: [...new Set(terms)].slice(0, MAX_TERMS) });
    if (out.length === MAX_CHECKS) break;
  }
  return out;
}

// a pass needs every expected term in the answer, in any case
export function grade(answer, expect) {
  const a = String(answer ?? '').toLowerCase();
  const missing = expect.filter((t) => !a.includes(t.toLowerCase()));
  return { pass: missing.length === 0, missing };
}

// what a run depends on: the model, and the text of CLAUDE.md and the auto-memory MEMORY.md
export function fingerprint({ model, root, home = homedir() }) {
  return { model: String(model ?? ''), claude: sha(read(path.join(root, 'CLAUDE.md'))), memory: sha(read(path.join(projectDir(root, home), 'memory', 'MEMORY.md'))) };
}
export function changes(prev, cur) {
  if (!prev || !cur) return [];
  return [prev.model !== cur.model && 'the model', prev.claude !== cur.claude && 'CLAUDE.md', prev.memory !== cur.memory && 'MEMORY.md'].filter(Boolean);
}

// ask(prompt) answers one question on the user's model source; print() is the current fingerprint
export function createBrainCheck({ file, ask, print = () => null, now = () => new Date(), onChange = () => {} }) {
  const running = new Map();
  const progress = new Map();
  const load = () => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } };
  const save = (data) => { mkdirSync(path.dirname(file), { recursive: true }); writeAtomic(file, JSON.stringify(data, null, 2) + '\n'); };
  const state = (root) => { const s = load()[root]; return { checks: s?.checks ?? STARTER_CHECKS, runs: s?.runs ?? [] }; };
  const put = (root, s) => { const data = load(); data[root] = s; save(data); };

  const status = (root) => {
    const s = state(root);
    const last = s.runs.at(-1) ?? null;
    return { checks: s.checks, last, previous: s.runs.at(-2) ?? null, running: running.has(root), done: progress.get(root) ?? 0, changed: last ? changes(last.print, print()) : [], ready: s.checks.filter((c) => c.expect.length).length };
  };
  const setChecks = (root, checks) => { const s = state(root); put(root, { ...s, checks: cleanChecks(checks) }); return status(root); };

  // one pass over the checks that have expected terms, one question at a time; a failed question is recorded as such
  const run = (root) => {
    if (running.has(root)) return running.get(root);
    const job = (async () => {
      const s = state(root);
      const todo = s.checks.filter((c) => c.expect.length);
      if (!todo.length) return status(root);
      const fp = print();
      const results = [];
      progress.set(root, 0);
      onChange();
      for (const c of todo) {
        let answer = '';
        let error = null;
        try { answer = String(await ask(c.prompt) ?? '').slice(0, ANSWER_CAP); } catch (e) { error = String(e?.message || e).slice(0, 300); }
        const g = error ? { pass: false, missing: c.expect } : grade(answer, c.expect);
        results.push({ id: c.id, prompt: c.prompt, expect: c.expect, answer, error, ...g });
        progress.set(root, results.length);
        onChange();
      }
      const rec = { at: now().toISOString(), print: fp, results };
      put(root, { ...state(root), runs: [...state(root).runs, rec].slice(-KEEP_RUNS) });
      return status(root);
    })().finally(() => { running.delete(root); progress.delete(root); onChange(); });
    running.set(root, job);
    return job;
  };
  return { status, setChecks, run };
}
