// Check everything now (memoryCatchup.js): the plan shown before a pass starts, the note counts it shows while it runs,
// what it added to Needs review, and the last pass kept in the data folder so it shows again after a restart or a crash.
// Plain Node, so the tests drive it directly.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// with no pass to learn from: about how long one model call takes, and how many pairs to judge each note read brings
export const SECONDS_PER_CALL = 40;
export const PAIRS_PER_NOTE = 0.5;
// the stored claims and verdicts give the pairs per note once this many notes were read
const HISTORY_NOTES = 50;
// a pass this short says little about the time per call
const HISTORY_CALLS = 5;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// the seconds one call took in the last pass, or the default
export function secondsPerCall(last) {
  if (!last || !(last.done >= HISTORY_CALLS) || !(last.endedAt > last.startedAt)) return SECONDS_PER_CALL;
  return clamp(Math.round((last.endedAt - last.startedAt) / last.done / 1000), 5, 300);
}

// the plan for a pass from main's estimate: saved, the notes whose claims are stored from earlier passes; read, the
// notes still to read; claimed and judged, the notes and pairs the agent has stored, for the pairs per note. Pairs and
// seconds are estimates: a pair to judge is only known once both of its notes are read
export function planOf({ saved = 0, read = 0, claimCalls = 0, draftCalls = 0, claimed = 0, judged = 0 } = {}, last = null) {
  const perNote = claimed >= HISTORY_NOTES ? judged / claimed : PAIRS_PER_NOTE;
  const pairs = Math.round(read * perNote);
  const perCall = secondsPerCall(last);
  return { toCheck: saved + read, saved, pairs, seconds: Math.round((claimCalls + draftCalls + pairs) * perCall), perCall };
}

// the notes checked of the notes to check, counting the notes saved from earlier passes. left: the notes the agent
// still has queued to read. The total never shrinks during a pass, so the bar never moves back
export function progressOf(prevOf, { saved = 0, read = 0, left = 0 } = {}) {
  const checked = saved + read;
  return { checked, of: Math.max(prevOf ?? 0, checked + left) };
}

// what a pass added to Needs review: before and after are the items listed then ([{ id, type, drafted }], type
// 'contradiction' or 'other'). A new item counts by its type, or as a drafted fix when it has a draft; an item that
// was there and got its draft during the pass counts as a drafted fix. ids: the items, for the filter in Memory health
export const MAX_IDS = 1000;
export function diffReview(before, after) {
  const was = new Map((before ?? []).map((i) => [i.id, i]));
  const out = { contradictions: 0, drafts: 0, other: 0, ids: [] };
  for (const i of after ?? []) {
    const old = was.get(i.id);
    if (old && (old.drafted || !i.drafted)) continue;
    if (!old && i.type === 'contradiction') out.contradictions++;
    else if (i.drafted) out.drafts++;
    else out.other++;
    if (out.ids.length < MAX_IDS) out.ids.push(i.id);
  }
  return out;
}

// the last pass in the data folder. A pass saves itself as running when it starts and after each call; one still
// running when Quorum opens again was stopped by a crash or a quit, and reads as ended 'crashed' at its last save
export function createLastRunStore(file, now = () => Date.now()) {
  const load = () => {
    let last;
    try { last = JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
    if (!last || typeof last !== 'object' || typeof last.end !== 'string') return null;
    if (last.end === 'running') return { ...last, end: 'crashed', endedAt: last.savedAt ?? last.startedAt ?? null };
    return last;
  };
  const save = (last) => {
    try { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(`${file}.tmp`, JSON.stringify({ ...last, savedAt: now() })); renameSync(`${file}.tmp`, file); } catch {}
  };
  return { load, save };
}
