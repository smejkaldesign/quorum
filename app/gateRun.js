// The quality gate run (qualityGate.js) as main runs it after a sweep or a fix run, and where its verdicts are kept.
// Plain Node with no Electron, so the tests and scripts/save-sweep-bench.mjs run the same code as main.
//
// A run with no kept verdicts (a vault's first check, or a memory check) builds every review item twice, the second
// time after the whole vault is read again. A run with kept verdicts builds the items once: an item whose signature is
// the one its verdict was kept with passes the second pass as it is, and only the other items are built again after
// their notes are read again. Every item then gets its verdict anew, so a decision since the last run (a kind's
// precision, a demotion) reaches every item.
import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runGate, signature } from './qualityGate.js';

// first: the review items now. kept: Map id -> verdict with its sig, or null for a run over everything. again(items):
// the items built again after their notes are read again; items null: every item after the whole vault is read again.
// Answers { g: runGate's answer, verdicts with each sig, rebuilt: how many items were built again, same: the verdicts
// equal the kept ones }
export async function gatePasses({ first, kept = null, again, records = [], isStub = () => false }) {
  const sigs = new Map(first.map((i) => [i.id, signature(i)]));
  const changed = kept ? first.filter((i) => kept.get(i.id)?.sig !== sigs.get(i.id)) : first;
  let second;
  if (!kept) second = await again(null);
  else if (!changed.length) second = first;
  else {
    const fresh = new Map((await again(changed)).map((i) => [i.id, i]));
    const redo = new Set(changed.map((i) => i.id));
    second = first.flatMap((i) => (redo.has(i.id) ? (fresh.has(i.id) ? [fresh.get(i.id)] : []) : [i]));
  }
  const g = runGate([first, second], records, { isStub });
  const verdicts = new Map([...g.verdicts].map(([id, v]) => [id, { ...v, sig: sigs.get(id) }]));
  return { g, verdicts, rebuilt: kept ? changed.length : first.length, same: !!kept && sameVerdicts(kept, verdicts) };
}

// the verdict of an item now: its kept verdict while its fix and notes are the same, else pending until the next run.
// Reading a verdict never starts a gate run; the events that change items do (gateTriggers)
export const PENDING = { bucket: 'quiet', why: 'Quorum is still checking it.', reasons: ['pending'] };
export function verdictOf(verdicts, item, kind) {
  const v = verdicts?.get(item.id);
  if (v && v.sig === signature(item)) return v;
  return { ...PENDING, kind };
}

// the gate run main schedules delayMs after the events that change review items: a sweep, the end of a fix run, a draft
// tick that drafted or confirmed a fix, Let the agent draft fixes turned on or off, and an agent call on Approve that
// left a fallback. Several events in a row make one run
export function gateTriggers(run, { delayMs = 4000 } = {}) {
  let timer = null;
  const schedule = (ms = delayMs) => {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; run(); }, ms);
    timer.unref?.();
  };
  return {
    schedule,
    pending: () => timer != null,
    drafts: (r) => { if (r?.drafted || r?.confirmed) schedule(); },
    setting: (was, now) => { if (was !== now) schedule(); },
    fallback: (res) => { if (res && !res.draft && !res.cancelled) schedule(); },
  };
}

export function sameVerdicts(a, b) {
  if (a.size !== b.size) return false;
  for (const [id, v] of b) { const w = a.get(id); if (!w || JSON.stringify(w) !== JSON.stringify(v)) return false; }
  return true;
}

// the verdicts of every vault in one file: { [vault]: { at, verdicts: { [id]: verdict } } }. Read once; each put writes
// the whole file to a temporary file and renames it over the old one, one write after another
export function createGateStore(file, { log = () => {} } = {}) {
  let all = null;
  let writing = Promise.resolve();
  const load = () => {
    if (all) return all;
    try { all = JSON.parse(readFileSync(file, 'utf8')) ?? {}; } catch { all = {}; }
    if (typeof all !== 'object' || Array.isArray(all)) all = {};
    return all;
  };
  return {
    get: (vault) => load()[vault] ?? null,
    put(vault, entry) {
      load()[vault] = entry;
      const text = JSON.stringify(all);
      const tmp = `${file}.tmp`;
      writing = writing.then(async () => {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(tmp, text);
        await rename(tmp, file);
      }).catch((e) => log(e?.message));
      return writing;
    },
  };
}
