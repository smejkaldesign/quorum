// Proves a packaged app can load: every relative import reachable from main.js and preload.cjs resolves to a file inside
// app.asar. electron-builder does not check this, and a module missing from build.files only fails at launch.
// usage: node scripts/check-package.mjs [release/mac-arm64/Quorum.app]
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const appDir = process.argv[2] ?? 'release/mac-arm64/Quorum.app';
const asar = path.join(appDir, 'Contents/Resources/app.asar');
const listed = new Set(execFileSync('npx', ['asar', 'list', asar], { encoding: 'utf8' }).split('\n').map((l) => l.trim().replace(/^\//, '')).filter(Boolean));
const read = (rel) => execFileSync('npx', ['asar', 'extract-file', asar, rel], { cwd: process.env.TMPDIR || '/tmp', encoding: 'utf8' }) && readFileSync(path.join(process.env.TMPDIR || '/tmp', path.basename(rel)), 'utf8');

const seen = new Set();
const missing = [];
const queue = ['main.js', 'preload.cjs'];
while (queue.length) {
  const rel = queue.shift();
  if (seen.has(rel)) continue;
  seen.add(rel);
  if (!listed.has(rel)) { missing.push(rel); continue; }
  const src = read(rel);
  for (const m of src.matchAll(/(?:import\s[^'"]*?from\s*|import\(|require\()\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1]));
    queue.push(target);
  }
}
if (missing.length) { console.error(`package check: ${missing.length} module(s) missing from app.asar:\n  ${missing.join('\n  ')}`); process.exit(1); }
console.log(`package check: ${seen.size} modules resolve inside app.asar`);
