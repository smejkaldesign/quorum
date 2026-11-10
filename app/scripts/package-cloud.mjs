#!/usr/bin/env node
// Packages the Cloud edition. The installed app cannot read the repo's .env, so the two Supabase values are written
// into the packaged package.json (quorumCloud) through electron-builder's extraMetadata at build time. The anon key is
// the publishable one; the secret keys never leave the server. Run after `vite build` with QUORUM_EDITION=cloud and the
// helper release build (the package:cloud script does both first).
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(app, '..', '.env');
const vars = {};
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) vars[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const url = process.env.QUORUM_SUPABASE_URL || vars.QUORUM_SUPABASE_URL;
const key = process.env.QUORUM_SUPABASE_ANON_KEY || vars.QUORUM_SUPABASE_ANON_KEY;
if (!url || !key) { console.error('package-cloud: QUORUM_SUPABASE_URL and QUORUM_SUPABASE_ANON_KEY are needed (shell or repo .env)'); process.exit(1); }
const args = ['electron-builder', '--mac', '-c.extraMetadata.quorumEdition=cloud', `-c.extraMetadata.quorumCloud.url=${url}`, `-c.extraMetadata.quorumCloud.anonKey=${key}`, ...process.argv.slice(2)];
const r = spawnSync('npx', args, { cwd: app, stdio: 'inherit', env: { ...process.env, QUORUM_EDITION: 'cloud' } });
if (r.status) process.exit(r.status);
// a module left out of build.files only fails at launch, so prove every import resolves inside the asar before calling it built
const check = spawnSync('node', ['scripts/check-package.mjs', 'release/mac-arm64/Quorum.app'], { cwd: app, stdio: 'inherit' });
process.exit(check.status ?? 1);
