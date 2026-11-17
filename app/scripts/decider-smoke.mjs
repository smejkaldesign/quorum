// Proves a packaged app can fetch and load the decision layer's models: runs the packaged Electron binary as Node (the
// runtime of the app and of the engine's utility process), downloads the models with the packaged decide/download.js
// into a temporary data folder, then loads them with the packaged decider and scores two synthetic pairs. Fails when the
// download does not reach ready, when T1 does not load, when it drops the contradiction, or when it does not mark the
// paraphrase equivalent. Needs the network; the models come from their pinned revisions.
// usage: node scripts/decider-smoke.mjs [release/mac-arm64/Quorum.app]
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.argv[2] === '--inside') {
  const [, , , asar, data] = process.argv;
  const { createModelDownload } = await import(path.join(asar, 'decide/download.js'));
  const { createDecider } = await import(path.join(asar, 'decide/index.js'));
  const dir = path.join(data, 'models');
  const at = Date.now();
  const dl = createModelDownload({ dir, supported: true, log: (...a) => console.error(...a) });
  await dl.start();
  const download = { ...dl.status(), seconds: Math.round((Date.now() - at) / 1000) };
  const d = createDecider({ dir, log: (...a) => console.error(...a) });
  const c = (quote, value) => ({ rel: 'x.md', quote, subject: 'atlas', attribute: 'database', value, polarity: 'positive' });
  const contra = await d.relatedPair(c('Atlas will use Postgres for its database.', 'Postgres'), c('Atlas uses MySQL for its database.', 'MySQL'));
  const same = await d.relatedPair(c('Atlas uses Postgres as its main database.', 'Postgres'), c('The primary database for Atlas is Postgres.', 'PostgreSQL'));
  const t1 = d.tiers().find((t) => t.id === 't1');
  console.log(JSON.stringify({ electron: process.versions.electron, download: { state: download.state, label: download.label, seconds: download.seconds }, t1, contra: { drop: contra.drop, tier: contra.tier, reason: contra.reason }, same: { drop: same.drop, equivalent: same.equivalent, tier: same.tier }, rssMB: Math.round(process.memoryUsage().rss / 1e6) }));
  process.exit(download.state === 'ready' && t1.state === 'ready' && !contra.drop && same.equivalent ? 0 : 1);
}

const appDir = path.resolve(process.argv[2] ?? 'release/mac-arm64/Quorum.app');
const bin = path.join(appDir, 'Contents/MacOS/Quorum');
const asar = path.join(appDir, 'Contents/Resources/app.asar');
const data = mkdtempSync(path.join(os.tmpdir(), 'quorum-smoke-'));
try {
  const out = execFileSync(bin, [fileURLToPath(import.meta.url), '--inside', asar, data], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 600000 });
  console.log(`decider smoke: ${out.trim()}`);
} finally {
  rmSync(data, { recursive: true, force: true });
}
