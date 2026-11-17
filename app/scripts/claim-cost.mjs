#!/usr/bin/env node
// What a first full pass would send, READ-ONLY and with no model call: claim calls, judge calls, input tokens, the
// cost at API rates and the wall time, for the agent before this change (Sonnet, one call at a time, one pair per judge
// call) and for each model and answer the claim stage can use now (memoryModels.js), with calls in parallel. Output
// tokens and seconds per call are the ones measured on 100 notes (memoryModels.js MEASURED). Prints counts only, never
// note names or text. It never writes: the index is built in memory.
//
//   node scripts/claim-cost.mjs <vault> [--parallel 4,6] [--pairs-per-note 0.32]
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const flag = (name, def) => { const i = args.indexOf(name); if (i < 0) return def; const v = args[i + 1]; args.splice(i, 2); return v; };
const parallel = String(flag('--parallel', '4,6')).split(',').map(Number);
const pairsPerNote = Number(flag('--pairs-per-note', 0.32));
const [vaultArg] = args;
if (!vaultArg) { console.error('usage: node scripts/claim-cost.mjs <vault> [--parallel 4,6] [--pairs-per-note 0.32]'); process.exit(2); }
const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (f) => import(pathToFileURL(path.join(appDir, f)).href);
const { createVaultIndex } = await load('vindex.js');
const { analyze } = await load('rules/contradictions.js');
const { packBatches } = await load('contradictionAgent.js');
const { claimPrompt, excerptOf } = await load('contradictionClaims.js');
const M = await load('memoryModels.js');

const ix = createVaultIndex({ vault: path.resolve(vaultArg), isExcludedPath: () => false, isExcludedText: () => false, redact: (t) => t, onChange: () => {} });
ix.sync();
const a = analyze({ notes: ix.snapshot(), resolve: (t, f) => ix.resolve(t, f) });
const left = a.toRead.map((e) => ({ ...e, chars: excerptOf(e).length })).filter((e) => e.chars);
const batches = packBatches(left);
const pairs = Math.round(left.length * pairsPerNote);
const jc = M.judgeCalls(pairs);
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const usd = (v) => `$${v.toFixed(2)}`;
console.log(`notes ${a.notes}; ${left.length} to read in ${batches.length} claim calls; ${pairs} pairs to judge at ${pairsPerNote} a note read`);

// before: the same claim calls on Sonnet one at a time, and one judge call per pair with its instructions in the prompt
const oldChars = batches.reduce((n, b) => { const p = claimPrompt(b, { answer: 'json' }); return n + p.prompt.length + p.system.length; }, 0);
const oldIn = M.tokensOf(oldChars) + (batches.length + pairs) * M.CALL_OVERHEAD_TOKENS * M.CACHE_WRITE + pairs * 700;
const oldOut = left.length * M.MEASURED['sonnet/json'].outPerNote + pairs * M.JUDGE_OUT_TOKENS;
const oldSec = (batches.length + pairs) * M.MEASURED['sonnet/json'].seconds;
console.log(`before: ${batches.length + pairs} calls, ${fmt(oldIn)} input and ${fmt(oldOut)} output tokens, ${usd(M.dollars('sonnet', oldIn, oldOut))}, ${fmt(oldSec / 60)} min one at a time`);

for (const key of Object.keys(M.MEASURED)) {
  const [model, answer] = key.split('/');
  const chars = batches.reduce((n, b) => { const p = claimPrompt(b, { answer }); return n + p.prompt.length + p.system.length; }, 0);
  const c = M.passCost({ promptChars: chars, notes: left.length, calls: batches.length }, pairs, { model, answer });
  const sec = batches.length * M.MEASURED[key].seconds + jc * M.JUDGE_SECONDS;
  const now = key === `${M.MEMORY_MODELS.claims}/${M.CLAIM_ANSWER}` ? ' (the setting now)' : '';
  console.log(`${key}${now}: ${batches.length + jc} calls, ${fmt(c.inputTokens)} input and ${fmt(c.outputTokens)} output tokens, ${usd(c.usd)}; ${parallel.map((p) => `${fmt(sec / p / 60)} min with ${p} at once`).join(', ')}`);
}
