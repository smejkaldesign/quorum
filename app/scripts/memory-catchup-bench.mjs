#!/usr/bin/env node
// Check everything now on a generated vault with a fake model (test/fixtures/catchupLoad.js): the event loop delay and
// the heap of the thread that plays main, and the model calls per note or pair. No real model is called.
//
//   node --expose-gc scripts/memory-catchup-bench.mjs [--mode engine|main] [--notes 2000] [--big 0] [--grow 0]
//     [--delay 5] [--agent ../../contradictionAgent.js] [--vault <path>]
//
// --mode main runs the rules on the measured thread with a save sweep after every call, as main.js did before the
// memory engine. --big adds one dated log note of that many characters; --grow appends that many characters to it
// after every call. --agent loads another contradictionAgent.js for --mode main, relative to test/fixtures. --vault reads
// an existing vault instead of a generated one; it is never written to (--grow is ignored).
import { runCatchupLoad } from '../test/fixtures/catchupLoad.js';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i < 0 ? def : args[i + 1]; };
const r = await runCatchupLoad({
  mode: opt('mode', 'engine'), notes: Number(opt('notes', 2000)), big: Number(opt('big', 0)), grow: Number(opt('grow', 0)),
  delay: Number(opt('delay', 5)), agentModule: opt('agent', '../../contradictionAgent.js'), vault: opt('vault', null), gcSamples: args.includes('--gc-samples'),
});
console.log(JSON.stringify(r, (k, v) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 10) / 10 : v), 1));
process.exit(0);
