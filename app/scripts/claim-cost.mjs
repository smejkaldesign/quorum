#!/usr/bin/env node
// What a first full pass of claim reading would send, READ-ONLY and with no model call: the claim calls, the prompt
// characters and tokens, and the cost at API rates, for the excerpts the agent sends now and for whole notes (the
// agent before excerpts: up to 12,000 characters of each note, 20 notes a call, all on Sonnet). Prints counts only,
// never note names or text. It never writes: the index is built in memory.
//
//   node scripts/claim-cost.mjs <vault> [--seconds 16] [--parallel 4] [--pairs-per-note 0.5]
//
// --seconds is the time one call takes, --parallel how many calls a catch-up runs at once, for the wall time.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const flag = (name, def) => { const i = args.indexOf(name); if (i < 0) return def; const v = args[i + 1]; args.splice(i, 2); return Number(v); };
const seconds = flag('--seconds', 16);
const parallel = flag('--parallel', 4);
const pairsPerNote = flag('--pairs-per-note', 0.5);
const [vaultArg] = args;
if (!vaultArg) { console.error('usage: node scripts/claim-cost.mjs <vault> [--seconds 16] [--parallel 4] [--pairs-per-note 0.5]'); process.exit(2); }
const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (f) => import(pathToFileURL(path.join(appDir, f)).href);
const { createVaultIndex } = await load('vindex.js');
const { analyze } = await load('rules/contradictions.js');
const { packBatches } = await load('contradictionAgent.js');
const { claimPrompt, excerptOf } = await load('contradictionClaims.js');
const { JUDGE_IN_TOKENS, JUDGE_OUT_TOKENS, OUT_TOKENS_PER_NOTE, dollars, passCost, tokensOf } = await load('memoryModels.js');

const ix = createVaultIndex({ vault: path.resolve(vaultArg), isExcludedPath: () => false, isExcludedText: () => false, redact: (t) => t, onChange: () => {} });
ix.sync();
const a = analyze({ notes: ix.snapshot(), resolve: (t, f) => ix.resolve(t, f) });

// before: whole notes, cut at 12,000 characters, 20 a call up to 44,000 characters, with the old instructions (about
// 1,500 characters) in each prompt
const OLD = { chars: 44000, notes: 20, cut: 12000, ask: 1500, system: 330 };
const oldBatches = [];
let cur = [];
let used = 0;
for (const e of [...a.toRead].sort((x, y) => x.rank - y.rank || x.rel.localeCompare(y.rel))) {
  const n = Math.min(OLD.cut, e.text.length) + 200;
  if (cur.length && (used + n > OLD.chars || cur.length >= OLD.notes)) { oldBatches.push(cur); cur = []; used = 0; }
  cur.push(e);
  used += n;
}
if (cur.length) oldBatches.push(cur);
const numberedChars = (t) => { const lines = t.slice(0, OLD.cut).split('\n'); return lines.reduce((n, l, i) => n + String(i + 1).length + 2 + l.length + 1, 0); };
const oldChars = oldBatches.reduce((n, b) => n + OLD.ask + OLD.system + b.reduce((m, e) => m + e.rel.length + 20 + numberedChars(e.text), 0), 0);

// after: excerpts, packed by their length; a note with no line to read makes no call
const left = a.toRead.map((e) => ({ ...e, chars: excerptOf(e).length })).filter((e) => e.chars);
const batches = packBatches(left);
const newChars = batches.reduce((n, b) => { const p = claimPrompt(b); return n + p.prompt.length + p.system.length; }, 0);

const pairs = Math.round(left.length * pairsPerNote);
const oldIn = tokensOf(oldChars) + pairs * 2400;
const oldOut = a.toRead.length * OUT_TOKENS_PER_NOTE + pairs * JUDGE_OUT_TOKENS;
const oldUsd = dollars('sonnet', oldIn, oldOut);
const now = passCost({ promptChars: newChars, notes: left.length }, pairs);
const wall = (calls, p) => Math.round((calls * seconds) / p / 60);
const r = (v) => Math.round(v * 100) / 100;
console.log(`notes ${a.notes}; stage 1 sends ${a.toRead.length} to claim reading`);
console.log(`before: ${oldBatches.length} claim calls, ${tokensOf(oldChars).toLocaleString('en-US')} input tokens (${Math.round(tokensOf(oldChars) / oldBatches.length).toLocaleString('en-US')} a call), all on Sonnet`);
console.log(`after: ${batches.length} claim calls for ${left.length} notes (${a.toRead.length - left.length} with no line to read), ${tokensOf(newChars).toLocaleString('en-US')} input tokens (${Math.round(tokensOf(newChars) / Math.max(1, batches.length)).toLocaleString('en-US')} a call), on Haiku`);
console.log(`judge calls, estimated at ${pairsPerNote} pairs per note read: ${pairs}, ${JUDGE_IN_TOKENS} input tokens each on Sonnet (before: about 2,400 with the instructions in each prompt)`);
console.log(`cost at API rates, claims and judge: before $${r(oldUsd)}, after $${r(now.usd)}`);
console.log(`wall time at ${seconds} s a call: before ${wall(oldBatches.length + pairs, 1)} min one at a time; after ${wall(batches.length + pairs, 1)} min one at a time, ${wall(batches.length + pairs, parallel)} min with ${parallel} at once`);
