// Proves a packaged app's memory engine can load the decision layer's models: runs the packaged Electron binary as Node
// (the runtime the engine's utility process has), imports decide/ from app.asar, and scores two synthetic pairs.
// Fails when T1 does not load, when it drops the contradiction, or when it does not mark the paraphrase equivalent.
// usage: node scripts/decider-smoke.mjs [release/mac-arm64/Quorum.app]
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.argv[2] === '--inside') {
  const { createDecider } = await import(path.join(process.argv[3], 'decide/index.js'));
  const d = createDecider({ log: (...a) => console.error(...a) });
  const c = (quote, value) => ({ rel: 'x.md', quote, subject: 'atlas', attribute: 'database', value, polarity: 'positive' });
  const contra = await d.relatedPair(c('Atlas will use Postgres for its database.', 'Postgres'), c('Atlas moved off Postgres and now uses MySQL.', 'MySQL'));
  const same = await d.relatedPair(c('Atlas uses Postgres as its main database.', 'Postgres'), c('The primary database for Atlas is Postgres.', 'PostgreSQL'));
  const t1 = d.tiers().find((t) => t.id === 't1');
  console.log(JSON.stringify({ electron: process.versions.electron, t1, contra, same, rssMB: Math.round(process.memoryUsage().rss / 1e6) }));
  process.exit(t1.state === 'ready' && !contra.drop && same.equivalent ? 0 : 1);
}

const appDir = path.resolve(process.argv[2] ?? 'release/mac-arm64/Quorum.app');
const bin = path.join(appDir, 'Contents/MacOS/Quorum');
const asar = path.join(appDir, 'Contents/Resources/app.asar');
const out = execFileSync(bin, [fileURLToPath(import.meta.url), '--inside', asar], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 120000 });
console.log(`decider smoke: ${out.trim()}`);
