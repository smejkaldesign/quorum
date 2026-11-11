#!/usr/bin/env node
// Packages the Cloud edition. The installed app cannot read the repo's .env, so the two Supabase values are written
// into the packaged package.json (quorumCloud) through electron-builder's extraMetadata at build time. The anon key is
// the publishable one; the secret keys never leave the server. Run after `vite build` with QUORUM_EDITION=cloud and the
// helper release build (the package:cloud script does both first).
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
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
// the Cloud build updates from a generic feed on the "cloud" channel (updater.js): cloud-mac.yml plus the zip it names,
// next to the Local build's latest-mac.yml. The default feed is the latest GitHub release, where the release workflow
// puts both editions; QUORUM_CLOUD_UPDATES_URL points a build at another host (a self-hosted copy, a staging feed).
// The artifacts carry no version in their names, so the feed URL below resolves to the newest release without a lookup
const CLOUD_FEED = 'https://github.com/smejkaldesign/quorum/releases/latest/download';
const CLOUD_ARTIFACT = 'Quorum-Cloud-${arch}.${ext}';
const updates = (process.env.QUORUM_CLOUD_UPDATES_URL || vars.QUORUM_CLOUD_UPDATES_URL || CLOUD_FEED).replace(/\/+$/, '');
// the whole build config goes through one file: -c.publish.* on the command line would merge into package.json's
// GitHub publish block and leave its owner and repo behind, which the generic provider's schema rejects
const build = JSON.parse(readFileSync(path.join(app, 'package.json'), 'utf8')).build;
const config = {
  ...build,
  mac: { ...build.mac, artifactName: CLOUD_ARTIFACT },
  publish: { provider: 'generic', url: updates, channel: 'cloud' },
  extraMetadata: { ...(build.extraMetadata ?? {}), quorumEdition: 'cloud', quorumCloud: { url, anonKey: key, updates } },
};
const configFile = path.join(mkdtempSync(path.join(tmpdir(), 'quorum-cloud-')), 'electron-builder.json');
writeFileSync(configFile, JSON.stringify(config));
// the release workflow drafts the GitHub release itself; electron-builder must not try to publish on its own when it detects CI
const args = ['electron-builder', '--mac', '--publish', 'never', '--config', configFile, ...process.argv.slice(2)];
const r = spawnSync('npx', args, { cwd: app, stdio: 'inherit', env: { ...process.env, QUORUM_EDITION: 'cloud' } });
if (r.status) process.exit(r.status);
// a module left out of build.files only fails at launch, so prove every import resolves inside the asar before calling it built
const check = spawnSync('node', ['scripts/check-package.mjs', 'release/mac-arm64/Quorum.app'], { cwd: app, stdio: 'inherit' });
process.exit(check.status ?? 1);
