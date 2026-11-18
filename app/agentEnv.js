// The environment and the executable for the agent CLIs Quorum starts (claude, codex, agy). They get the person's own
// environment minus Quorum's settings and keys: everything named QUORUM_* (except the edition and data folder switches
// the quorum CLI and MCP server read), SUPABASE_* or VITE_*, the names in the
// .env files a build from source loads, the Google client secret and Picker key, and Electron's run-as-node switch.
// What the CLIs need stays: HOME, PATH, USER, SHELL, TMPDIR, the locale, TERM, proxy settings and anything the person
// set for the CLI itself (ANTHROPIC_*, CLAUDE_*, CODEX_*, OPENAI_*), except where a caller removes a key on purpose.
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnvFile } from './sources/env.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_PREFIX = /^(QUORUM_|SUPABASE_|VITE_)/;
const APP_NAMES = new Set(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_PICKER_API_KEY', 'GOOGLE_PICKER_APP_ID', 'ELECTRON_RUN_AS_NODE']);
// QUORUM_ENV picks the data folder (Quorum or Quorum Dev), QUORUM_EDITION the edition and QUORUM_MCP_TOOLS the tool set;
// none of them is a secret
const KEEP = /^(QUORUM_ENV|QUORUM_EDITION|QUORUM_MCP_TOOLS|HOME|PATH|USER|LOGNAME|SHELL|TMPDIR|LANG|LANGUAGE|LC_[A-Z]+|TERM|COLORTERM|TZ|(HTTPS?|ALL|NO)_PROXY|(https?|all|no)_proxy)$/;

// the names (never the values) set in the .env files a build from source reads into the app's environment
export function dotenvNames(root = REPO) {
  const names = new Set();
  for (const dir of [root, path.join(root, 'app')]) {
    for (const f of ['.env', '.env.development']) for (const k of Object.keys(readEnvFile(path.join(dir, f)))) names.add(k);
  }
  return names;
}

let fileNames = null;
export function agentEnv(base = process.env, { names = (fileNames ??= dotenvNames()) } = {}) {
  const out = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (!KEEP.test(k) && (APP_PREFIX.test(k) || APP_NAMES.has(k) || names.has(k))) continue;
    out[k] = v;
  }
  return out;
}

// the absolute path of a CLI on PATH, looked up once per name and again when that file is gone (a reinstall moved it);
// the bare name when it is not found, so spawn reports it as not installed
const found = new Map();
export function resolveBin(name, { pathVar = process.env.PATH ?? '' } = {}) {
  if (found.has(name) && existsSync(found.get(name))) return found.get(name);
  found.delete(name);
  for (const dir of pathVar.split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const file = path.join(dir, name);
    try {
      if (!statSync(file).isFile()) continue;
      accessSync(file, constants.X_OK);
      found.set(name, file);
      return file;
    } catch { /* not in this folder */ }
  }
  return name;
}
export const forgetBins = () => found.clear();
