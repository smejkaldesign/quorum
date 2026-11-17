// Downloads the decision layer's model files (decide/models.json) into models/ for development and tests. The app
// downloads the same files in the background into its data folder (decide/download.js). Each file is pinned to a
// repository revision and its SHA-256; the script fails before any download when a file has no hash pinned, and keeps a
// file already on disk with the right hash. --print writes the hashes of the files on disk, for a manifest update.
// usage: node scripts/fetch-models.mjs [--print] [--manifest decide/models.json] [--dir models]
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i < 0 ? def : path.resolve(args[i + 1]); };
const manifest = JSON.parse(readFileSync(opt('manifest', path.join(root, 'decide/models.json')), 'utf8'));
const dir = opt('dir', path.join(root, 'models'));
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const print = args.includes('--print');

if (!print) {
  for (const [id, m] of Object.entries(manifest)) for (const [file, f] of Object.entries(m.files)) {
    if (!/^[0-9a-f]{64}$/.test(f?.sha256 ?? '')) { console.error(`fetch-models: no SHA-256 pinned for ${id}/${file}`); process.exit(1); }
  }
}
for (const [id, m] of Object.entries(manifest)) {
  for (const [file, { sha256: want }] of Object.entries(m.files)) {
    const dest = path.join(dir, id, file);
    if (print) { console.log(id, file, existsSync(dest) ? sha(readFileSync(dest)) : 'missing'); continue; }
    if (existsSync(dest) && sha(readFileSync(dest)) === want) continue;
    const url = `https://huggingface.co/${m.repo}/resolve/${m.revision}/${file}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch-models: ${url} answered ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (sha(buf) !== want) throw new Error(`fetch-models: ${m.repo} ${file} has SHA-256 ${sha(buf)}, the manifest pins ${want}`);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(`${dest}.part`, buf);
    renameSync(`${dest}.part`, dest);
    console.log(`fetch-models: ${id}/${file} ${(buf.length / 1e6).toFixed(1)} MB`);
  }
}
