// Proves a packaged app can load: every relative import reachable from main.js and preload.cjs resolves to a file inside
// app.asar. electron-builder does not check this, and a module missing from build.files only fails at launch.
// usage: node scripts/check-package.mjs [release/mac-arm64/Quorum.app]
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = process.argv[2] ?? 'release/mac-arm64/Quorum.app';
const asar = path.resolve(appDir, 'Contents/Resources/app.asar');
const listed = new Set(execFileSync('npx', ['asar', 'list', asar], { encoding: 'utf8' }).split('\n').map((l) => l.trim().replace(/^\//, '')).filter(Boolean));
const tmp = process.env.TMPDIR || '/tmp';
const read = (rel) => { execFileSync('npx', ['asar', 'extract-file', asar, rel], { cwd: tmp, encoding: 'utf8' }); return readFileSync(path.join(tmp, path.basename(rel)), 'utf8'); };

const seen = new Set();
const missing = [];
// memoryWorker.js is started by path (utilityProcess.fork), so no import reaches it. The decision layer (decide/) is
// listed until the contradiction agent imports it
const queue = ['main.js', 'preload.cjs', 'memoryWorker.js', 'decide/index.js', 'decide/gate.js'];
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
// the decision layer's models and ONNX Runtime are read by native code, which cannot read inside the archive
const unpacked = path.resolve(appDir, 'Contents/Resources/app.asar.unpacked');
const models = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../decide/models.json'), 'utf8'));
const notUnpacked = [...Object.entries(models).flatMap(([id, m]) => Object.keys(m.files).map((f) => `models/${id}/${f}`)), 'node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/onnxruntime_binding.node', 'node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/libonnxruntime.1.dylib'].filter((rel) => !existsSync(path.join(unpacked, rel)));
if (notUnpacked.length) { console.error(`package check: not unpacked from app.asar:\n  ${notUnpacked.join('\n  ')}`); process.exit(1); }
// the CLI runs from Resources/cli outside the archive, so every file it imports has to sit next to it
const cli = path.resolve(appDir, 'Contents/Resources/cli');
const cliMissing = [...readFileSync(path.join(cli, 'quorum.mjs'), 'utf8').matchAll(/import\s[^'"]*?from\s*['"](\.{1,2}\/[^'"]+)['"]/g)].map((m) => m[1]).filter((rel) => !existsSync(path.join(cli, rel)));
if (cliMissing.length) { console.error(`package check: the CLI imports files missing from Resources/cli: ${cliMissing.join(', ')}`); process.exit(1); }
console.log(`package check: ${seen.size} modules resolve inside app.asar; read guard, models and ONNX Runtime unpacked`);
