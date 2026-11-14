// Settings the app reads at run time from the shell first, then the repo's .env and .env.development (a build from
// source). One lookup shared by the Google client (gcal.js) and the personal OAuth connectors (accounts.js).
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export function readEnvFile(file) {
  const out = {};
  if (!file || !existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

// (key) => value or null; the .env files are read once per lookup
export function envLookup({ env = process.env, root = null } = {}) {
  const files = root ? [readEnvFile(path.join(root, '.env')), readEnvFile(path.join(root, '.env.development'))] : [];
  return (key) => env[key] || files.map((f) => f[key]).find(Boolean) || null;
}
