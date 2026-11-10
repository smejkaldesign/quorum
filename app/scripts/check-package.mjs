// Proves a packaged app can load: every relative import reachable from main.js and preload.cjs resolves to a file inside
// app.asar. electron-builder does not check this, and a module missing from build.files only fails at launch.
// usage: node scripts/check-package.mjs [release/mac-arm64/Quorum.app]
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const appDir = process.argv[2] ?? 'release/mac-arm64/Quorum.app';
const asar = path.resolve(appDir, 'Contents/Resources/app.asar');
const listed = new Set(execFileSync('npx', ['asar', 'list', asar], { encoding: 'utf8' }).split('\n').map((l) => l.trim().replace(/^\//, '')).filter(Boolean));
const tmp = process.env.TMPDIR || '/tmp';
const read = (rel) => { execFileSync('npx', ['asar', 'extract-file', asar, rel], { cwd: tmp, encoding: 'utf8' }); return readFileSync(path.join(tmp, path.basename(rel)), 'utf8'); };

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
// scripts another process runs (python3 for the read guard) must exist as real files outside the archive
const guard = path.resolve(appDir, 'Contents/Resources/app.asar.unpacked/guards/read-guard.py');
if (!existsSync(guard)) { console.error(`package check: read guard is not unpacked at ${guard}`); process.exit(1); }
execFileSync('python3', ['-c', `compile(open(${JSON.stringify(guard)}).read(), 'read-guard.py', 'exec')`]);
console.log(`package check: ${seen.size} modules resolve inside app.asar; read guard unpacked`);
