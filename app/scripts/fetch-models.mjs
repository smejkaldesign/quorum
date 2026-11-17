// Downloads the decision layer's model files (decide/models.json) into models/ before a package build, so the app ships
// them and never downloads at runtime. Each file is pinned to a repository revision and its SHA-256; a file already on
// disk with the right hash is kept. --print writes the hashes of the files on disk, for a manifest update.
// usage: node scripts/fetch-models.mjs [--print]
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(path.join(root, 'decide/models.json'), 'utf8'));
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const print = process.argv.includes('--print');

for (const [id, m] of Object.entries(manifest)) {
  for (const [file, want] of Object.entries(m.files)) {
    const dest = path.join(root, 'models', id, file);
    if (print) { console.log(id, file, existsSync(dest) ? sha(readFileSync(dest)) : 'missing'); continue; }
    if (existsSync(dest) && sha(readFileSync(dest)) === want) continue;
    const url = `https://huggingface.co/${m.repo}/resolve/${m.revision}/${file}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch-models: ${url} answered ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (want && sha(buf) !== want) throw new Error(`fetch-models: ${m.repo} ${file} has SHA-256 ${sha(buf)}, the manifest pins ${want}`);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(`${dest}.part`, buf);
    renameSync(`${dest}.part`, dest);
    console.log(`fetch-models: ${id}/${file} ${(buf.length / 1e6).toFixed(1)} MB`);
  }
}
