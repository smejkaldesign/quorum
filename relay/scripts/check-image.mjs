#!/usr/bin/env node
// Builds the tree the root Dockerfile builds (its COPY lines and its node_modules link) in a temporary folder, then
// imports relay/server.js and relay/kbSyncWorker.js there with placeholder settings. An import the image would not
// have fails here, before a deploy does. Run from relay/ after npm ci: npm run check:image
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = mkdtempSync(path.join(tmpdir(), 'relay-image-'));
const copied = [];

// one COPY source: a file, a folder (trailing slash), or a single-folder glob like app/*.js
function sources(src) {
  if (!src.includes('*')) return [src.replace(/\/$/, '')];
  const dir = path.posix.dirname(src);
  const re = new RegExp(`^${path.posix.basename(src).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`);
  return readdirSync(path.join(root, dir)).filter((n) => re.test(n) && statSync(path.join(root, dir, n)).isFile()).map((n) => `${dir}/${n}`);
}

try {
  for (const line of readFileSync(path.join(root, 'Dockerfile'), 'utf8').split('\n')) {
    const m = line.match(/^COPY\s+(.+)$/);
    if (!m) continue;
    const parts = m[1].trim().split(/\s+/);
    const dest = parts.pop();
    for (const src of parts.flatMap(sources)) {
      const from = path.join(root, src);
      if (!existsSync(from)) throw new Error(`Dockerfile copies ${src}, which does not exist`);
      // Docker's rules: a folder's contents go into dest; a file goes into dest/ under its own name, or becomes dest
      const isDir = statSync(from).isDirectory();
      const to = isDir ? path.join(out, dest) : dest.endsWith('/') ? path.join(out, dest, path.basename(src)) : path.join(out, dest);
      mkdirSync(path.dirname(to), { recursive: true });
      cpSync(from, to, { recursive: true, filter: (f) => !f.includes(`${path.sep}node_modules`) });
      copied.push(src);
    }
  }
  // the image installs the relay's packages and links them for app/, as the Dockerfile does
  symlinkSync(path.join(root, 'relay', 'node_modules'), path.join(out, 'relay', 'node_modules'));
  symlinkSync(path.join(out, 'relay', 'node_modules'), path.join(out, 'app', 'node_modules'));
  const env = {
    PATH: process.env.PATH, NODE_ENV: 'production', PORT: '0',
    SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_ANON_KEY: 'placeholder', SUPABASE_SERVICE_ROLE_KEY: 'placeholder', ASSEMBLYAI_API_KEY: 'placeholder',
  };
  const code = "await import('./server.js'); await import('./kbSyncWorker.js'); console.log('relay image imports: ok'); process.exit(0);";
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: path.join(out, 'relay'), env, encoding: 'utf8', timeout: 30000 });
  if (r.status !== 0) {
    process.stderr.write(`relay image imports failed (${copied.length} COPY sources):\n${(r.stderr || r.stdout || '').split('\n').filter((l) => /Error|Cannot find|imported from/.test(l)).slice(0, 10).join('\n')}\n`);
    process.exitCode = 1;
  } else process.stdout.write(r.stdout.split('\n').filter((l) => l.includes('relay image imports')).join('\n') + '\n');
} finally {
  rmSync(out, { recursive: true, force: true });
}
