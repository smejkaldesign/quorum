// A meeting note's share choice, kept in its frontmatter, and the keys a rewrite of a note must carry over. Used by
// main.js (a saved call note written again, the visibility pill, the Properties panel), the meeting-notes importers
// (sources/index.js, ee/platforms.js) and the meetings knowledge base routing (ee/meetingsKb.js).
//
//   keep_private: true   visibility: private   the author's private note
//   keep_private: false  visibility: public    shared into the workspace's meetings knowledge base
//
// keep_private decides; visibility always follows it. A note with no keep_private is undecided, whatever visibility
// line its importer wrote.
import { readFrontmatter, setFrontmatterKey } from './frontmatter.js';

// what a rewrite keeps from the note on disk: the choice, the confidential mark, where it came from, whether it was
// recorded. Guardrail keys (a frontmatter key the guardrails deny) are added by the caller
export const KEPT_KEYS = ['keep_private', 'visibility', 'confidential', 'recorded', 'source_account'];

const simple = (v) => typeof v === 'string' && v.trim() !== '' && !/[\r\n]/.test(v);

// next with every listed key the previous text set, written as it was; keys the previous text did not set keep
// whatever next says
export function carryKeys(prevText, nextText, keys = KEPT_KEYS) {
  if (prevText === null || prevText === undefined) return nextText;
  const had = readFrontmatter(prevText);
  const raw = rawValues(prevText);
  let out = nextText;
  for (const k of new Set(keys)) if (simple(had[k]) && raw[k] !== undefined) out = setFrontmatterKey(out, k, raw[k]);
  return out;
}
// each key's value as written in the frontmatter, quotes included, so a carried value reads back the same
function rawValues(text) {
  const m = String(text ?? '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const out = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) { const kv = line.match(/^(\w+):\s*(\S.*?)\s*$/); if (kv) out[kv[1]] = kv[2]; }
  return out;
}

// 'private', 'shared', or null when the note has no keep_private
export function choiceOf(fm = {}) {
  const k = String(fm.keep_private ?? '').trim();
  return k === 'true' ? 'private' : k === 'false' ? 'shared' : null;
}

// the text with the choice written as both keys
export const withChoice = (text, keepPrivate) => setFrontmatterKey(setFrontmatterKey(text, 'keep_private', keepPrivate ? 'true' : 'false'), 'visibility', keepPrivate ? 'private' : 'public');

// a frontmatter edit from the person (the Properties panel, the visibility pill): whichever of the two keys they
// changed decides, and the other follows. Neither changed: the two are made to agree with keep_private
export function reconcile(prevText, nextText) {
  const a = readFrontmatter(prevText ?? ''), b = readFrontmatter(nextText);
  const vis = b.visibility === 'public' || b.visibility === 'private' ? b.visibility : null;
  const choice = choiceOf(b);
  if (vis && vis !== a.visibility) return withChoice(nextText, vis === 'private');
  if (choice && choice !== choiceOf(a)) return withChoice(nextText, choice === 'private');
  if (choice && vis !== (choice === 'private' ? 'private' : 'public')) return withChoice(nextText, choice === 'private');
  return nextText;
}
