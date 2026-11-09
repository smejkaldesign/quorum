#!/usr/bin/env node
// Transcription eval. Runs each engine over the corpus, turns the pieces into speaker turns through the same
// transcript.js path the app uses, scores WER, entity error rate and cpWER after the shared normalizer, prints a
// table per engine and writes results/<date>-<engine>.json.
//
//   node eval/run.mjs --engines apple[,assemblyai,deepgram] [--clean] [--corpus eval/corpus] [--items a,b]
//                     [--no-terms] [--yes] [--fail-over 0.25] [--helper <path>]
//
// Cloud engines print an estimated cost first and stop above 30 audio minutes unless --yes is passed.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addFinal } from '../transcript.js';
import { wavSeconds } from './wav.mjs';
import { aggregate, cpWER, entityErrorRate, wer } from './wer.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, def) => { const i = argv.indexOf(name); return i !== -1 && argv[i + 1] ? argv[i + 1] : def; };
const engines = opt('--engines', 'apple').split(',').map((s) => s.trim()).filter(Boolean);
const corpusDir = path.resolve(opt('--corpus', path.join(here, 'corpus')));
const only = opt('--items', '')?.split(',').filter(Boolean);
const clean = flag('--clean'), yes = flag('--yes'), useTerms = !flag('--no-terms');
const failOver = opt('--fail-over', null);
const COST_CAP_MINUTES = 30;

function loadCorpus() {
  if (!existsSync(corpusDir)) throw new Error(`no corpus at ${corpusDir}; run make-synthetic.mjs first`);
  return readdirSync(corpusDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
    .filter((name) => !only.length || only.includes(name))
    .map((name) => {
      const dir = path.join(corpusDir, name);
      const ref = path.join(dir, 'reference.json');
      if (!existsSync(ref)) return null;
      const two = existsSync(path.join(dir, 'me.wav'));
      const me = two ? path.join(dir, 'me.wav') : path.join(dir, 'audio.wav');
      const them = two ? path.join(dir, 'them.wav') : null;
      const seconds = wavSeconds(me) + (them ? wavSeconds(them) : 0);
      return { name, dir, me, them, seconds, reference: JSON.parse(readFileSync(ref, 'utf8')) };
    }).filter(Boolean);
}

// HOOK: --clean runs hypothesis turns through app/clean.js when that module exists. It is being added on another
// branch; until it lands this prints a note and scores the raw turns.
async function cleaner() {
  if (!clean) return null;
  const mod = await import('../clean.js').catch(() => null);
  if (!mod) { console.log('--clean: app/clean.js is not present, scoring raw turns'); return null; }
  if (typeof mod.cleanTurns === 'function') return mod.cleanTurns;
  if (typeof mod.cleanText === 'function') return (turns) => turns.map((t) => ({ ...t, text: mod.cleanText(t.text) }));
  console.log('--clean: app/clean.js exports neither cleanTurns nor cleanText, scoring raw turns');
  return null;
}

const toTurns = (pieces) => pieces.sort((a, b) => a.start - b.start).reduce((turns, p) => addFinal(turns, { ...p, at: 0 }).turns, []);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const pct = (x) => `${(x * 100).toFixed(1)}%`;

async function runEngine(name, items, applyClean) {
  const engine = await import(`./engines/${name}.mjs`);
  const seconds = items.reduce((n, it) => n + it.seconds, 0);
  if (engine.cloud) {
    const cost = (seconds / 3600) * engine.usdPerHour;
    console.log(`${name}: ${(seconds / 60).toFixed(1)} audio minutes, estimated $${cost.toFixed(3)} at $${engine.usdPerHour}/h`);
    if (seconds / 60 > COST_CAP_MINUTES && !yes) { console.log(`${name}: over ${COST_CAP_MINUTES} minutes; pass --yes to run`); return null; }
  }
  const results = [];
  for (const item of items) {
    const terms = useTerms ? item.reference.entities ?? [] : [];
    let out;
    try { out = await engine.transcribe(item, { terms, helper: opt('--helper', undefined) }); }
    catch (e) { console.log(`${name} ${item.name}: ${e.message}`); results.push({ item: item.name, error: e.message, refWords: 0, errors: 0, entities: 0, entitiesMissing: 0, cpErrors: 0 }); continue; }
    let turns = toTurns(out.pieces);
    if (applyClean) turns = applyClean(turns);
    const norm = { fillers: Boolean(applyClean) };
    const w = wer(item.reference.turns, turns, norm);
    const e = entityErrorRate(item.reference.entities, turns, norm);
    const c = cpWER(item.reference.turns, turns, norm);
    results.push({ item: item.name, seconds: item.seconds, wallMs: Math.round(out.wallMs), wer: w.wer, sub: w.sub, del: w.del, ins: w.ins, refWords: w.refWords, errors: w.errors, eer: e.eer, entities: e.total, entitiesMissing: e.missing.length, missing: e.missing, cpwer: c.cpwer, cpErrors: c.errors, mapping: c.mapping, turns });
    console.log(`  ${item.name.padEnd(24)} WER ${pct(w.wer).padStart(6)}  EER ${pct(e.eer).padStart(6)}  cpWER ${pct(c.cpwer).padStart(6)}  ${(out.wallMs / 1000).toFixed(1)}s`);
  }
  const agg = aggregate(results);
  const latency = median(results.filter((r) => r.wallMs).map((r) => r.wallMs / 1000));
  const failed = results.filter((r) => r.error).length;
  const summary = { engine: name, date: new Date().toISOString(), corpus: corpusDir, clean: Boolean(applyClean), terms: useTerms, cost: engine.cloud ? (seconds / 3600) * engine.usdPerHour : 0, audioSeconds: seconds, ...agg, failed, medianWallSeconds: latency, items: results };
  mkdirSync(path.join(here, 'results'), { recursive: true });
  const file = path.join(here, 'results', `${summary.date.slice(0, 10)}-${name}.json`);
  writeFileSync(file, JSON.stringify(summary, null, 2) + '\n');
  return summary;
}

const items = loadCorpus();
if (!items.length) { console.error('corpus is empty'); process.exit(2); }
const applyClean = await cleaner();
const summaries = [];
for (const name of engines) {
  console.log(`\n== ${name} (${items.length} items${applyClean ? ', clean' : ''}${useTerms ? ', terms on' : ', terms off'})`);
  const s = await runEngine(name, items, applyClean);
  if (s) summaries.push(s);
}
console.log('\nengine        WER     EER     cpWER   median s/item  cost    failed');
for (const s of summaries) {
  const scored = s.items.length - s.failed;
  const col = (x) => (scored ? pct(x) : 'n/a').padStart(6);
  console.log(`${s.engine.padEnd(12)}  ${col(s.wer)}  ${col(s.eer)}  ${col(s.cpwer)}  ${String(s.medianWallSeconds?.toFixed(1) ?? 'n/a').padStart(13)}  $${s.cost.toFixed(3)}  ${s.failed}/${s.items.length}`);
}
console.log(`results in ${path.join(here, 'results')}`);
if (failOver != null) {
  const worst = Math.max(...summaries.map((s) => s.wer));
  const failed = summaries.some((s) => s.failed);
  if (!summaries.length || failed || worst > Number(failOver)) { console.error(failed ? 'an engine failed on at least one item' : `WER ${pct(worst)} is over the ${pct(Number(failOver))} gate`); process.exit(1); }
}
