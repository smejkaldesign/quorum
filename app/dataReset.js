// Delete my data (Settings, Preferences, Danger zone): removes what Quorum keeps on this Mac, in its data folder and
// the Keychain, and never the person's vault. Pure Node with every outside effect passed in, so the tests drive it on
// temp folders.
//
// The guarantee, in the order it is checked:
//  1. Only the data folder is touched. Its real path must exist, must not be the root or the home folder, and its last
//     segment must be one of Quorum's data folder names (edition.js DATA_DIR: Quorum, or Quorum Dev).
//  2. Every vault path Quorum knows (protectedPaths below) is collected with its real path. An entry that equals one,
//     sits inside one, or holds one is not deleted; a folder that holds one is entered and only its other entries go.
//  3. A folder that looks like a vault (it holds .obsidian, CLAUDE.md or AGENTS.md) is kept as well, for a vault Quorum
//     made once and no longer lists.
//  4. Symbolic links are never followed: a link is removed as a link, so its target stays as it is.
// Paths are compared by their real paths as the disk spells them (realpathSync.native), and without case on macOS,
// whose APFS volumes ignore case, so a vault path saved in another case still matches.
// deleteMyData runs the whole delete in a fixed order: every local refusal first, then the hosted delete, then the
// Keychain and the wipe, so a refusal never leaves the hosted data or the Keychain half deleted.
import { lstatSync, readdirSync, readFileSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';

export const DATA_DIR_NAMES = ['Quorum', 'Quorum Dev'];
// the downloaded on-device models stay unless asked, so a fresh start does not download them again
export const KEPT_BY_DEFAULT = ['models'];
const VAULT_MARKS = ['.obsidian', 'CLAUDE.md', 'AGENTS.md'];

const real = (p) => { try { return realpathSync.native(p); } catch { return null; } };
const lstat = (p) => { try { return lstatSync(p); } catch { return null; } };
export const CASELESS = process.platform === 'darwin';
const fold = (p, caseless) => (caseless ? p.toLowerCase() : p);
const same = (a, b, caseless) => fold(a, caseless) === fold(b, caseless);
const inside = (child, parent, caseless) => { const r = path.relative(fold(parent, caseless), fold(child, caseless)); return r === '' || (!!r && !r.startsWith('..') && !path.isAbsolute(r)); };

// every folder on this Mac that holds the person's notes, as Quorum knows it: the connected Agent OS and its vault, the
// meetings folder, each team knowledge folder chosen on this Mac, every folder Quorum built a brain in during
// onboarding, the default place it builds one, and QUORUM_VAULT when the environment sets it
export function protectedPaths({ settings = {}, env = {}, defaultVault = null } = {}) {
  const out = [settings.brainRoot, settings.vaultPath, settings.meetingsDir, env.QUORUM_VAULT, defaultVault];
  for (const p of Array.isArray(settings.brainsMade) ? settings.brainsMade : []) out.push(p);
  for (const t of Object.values(settings.teamKnowledge ?? {})) out.push(t?.path);
  return [...new Set(out.filter((p) => typeof p === 'string' && path.isAbsolute(p)).map((p) => path.resolve(p)))];
}

// checks the data folder; returns its real path or throws with a sentence for the person
export function checkDataDir(dataDir, { home, names = DATA_DIR_NAMES, caseless = CASELESS } = {}) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw new Error('Quorum could not find its data folder.');
  const dir = real(dataDir);
  if (!dir) return null;
  const homeReal = home ? real(home) ?? path.resolve(home) : null;
  if (same(dir, path.parse(dir).root, caseless) || (homeReal && same(dir, homeReal, caseless)) || (home && same(path.resolve(dataDir), path.resolve(home), caseless))) throw new Error('The data folder is the home or root folder, so nothing was deleted.');
  const named = (p) => names.some((n) => same(path.basename(p), n, caseless));
  if (!named(dir) || !named(path.resolve(dataDir))) throw new Error('The data folder is not a Quorum folder, so nothing was deleted.');
  if (!lstat(dir)?.isDirectory()) throw new Error('Quorum could not find its data folder.');
  return dir;
}

// every check resetData makes before it deletes anything, with nothing deleted: the data folder (checkDataDir) and no
// vault around it. Returns { root, guards } for resetData, or root null when the folder does not exist; throws with a
// sentence for the person
export function checkReset({ dataDir, home, protect = [], names = DATA_DIR_NAMES, caseless = CASELESS } = {}) {
  const root = checkDataDir(dataDir, { home, names, caseless });
  // each vault by the path settings give and by its real path, so a link to a vault and the vault both count
  const guards = [...new Set(protect.flatMap((p) => [path.resolve(p), real(p)]).filter(Boolean))];
  if (root) for (const g of guards) if (inside(root, g, caseless)) throw new Error('The data folder sits inside your vault, so nothing was deleted.');
  return { root, guards };
}

// Deletes the data folder's contents and returns { removed, kept } as paths. `protect` lists the vault paths
// (protectedPaths), `keep` names top-level entries to leave (KEPT_BY_DEFAULT). The data folder itself stays, empty or
// holding only what was kept. remove and rmdir are injectable for the tests.
export function resetData({ dataDir, home, protect = [], keep = KEPT_BY_DEFAULT, names = DATA_DIR_NAMES, caseless = CASELESS, remove = unlinkSync, rmdir = rmdirSync } = {}) {
  const { root, guards } = checkReset({ dataDir, home, protect, names, caseless });
  const removed = [], kept = [];
  if (!root) return { removed, kept };
  const guarded = (p) => guards.some((g) => inside(p, g, caseless));
  const holdsGuard = (p) => guards.some((g) => !same(g, p, caseless) && inside(g, p, caseless));
  const looksLikeVault = (dir) => VAULT_MARKS.some((m) => !!lstat(path.join(dir, m)));

  // returns true when the folder is now empty of everything it held
  const sweep = (dir) => {
    let names;
    try { names = readdirSync(dir); } catch { kept.push(dir); return false; }
    let clear = true;
    for (const name of names) {
      const p = path.join(dir, name);
      const st = lstat(p);
      if (!st) continue;
      if ((dir === root && keep.some((k) => same(k, name, caseless))) || guarded(p)) { kept.push(p); clear = false; continue; }
      if (st.isSymbolicLink() || !st.isDirectory()) {
        try { remove(p); removed.push(p); } catch { kept.push(p); clear = false; }
        continue;
      }
      if (looksLikeVault(p)) { kept.push(p); clear = false; continue; }
      // a folder whose real path is a vault (a bind or firmlink) is kept too
      const r = real(p);
      if (r && !same(r, p, caseless) && (guarded(r) || holdsGuard(r))) { kept.push(p); clear = false; continue; }
      if (sweep(p) && !holdsGuard(p)) {
        try { rmdir(p); removed.push(p); } catch { kept.push(p); clear = false; }
      } else clear = false;
    }
    return clear;
  };
  sweep(root);
  return { removed, kept };
}

// the Keychain items this build reads: Electron's safeStorage key ("<app name> Safe Storage") and the older per-secret
// items earlier builds wrote under account quorum (secrets.js), named by the keys of secrets.json. security runs
// /usr/bin/security with an argument list and resolves null on a failure; nothing secret is on the command line.
export async function forgetKeychain({ appName, secretsFile = null, security }) {
  const gone = [];
  // a Keychain can hold the same service more than once; each call removes the first match
  for (let i = 0; i < 5; i += 1) {
    if ((await security(['delete-generic-password', '-s', `${appName} Safe Storage`])) == null) break;
    gone.push(`${appName} Safe Storage`);
  }
  let services = [];
  try { services = Object.keys(JSON.parse(readFileSync(secretsFile, 'utf8')) ?? {}); } catch {}
  for (const s of services) if ((await security(['delete-generic-password', '-s', s, '-a', 'quorum'])) != null) gone.push(s);
  return gone;
}

// Delete my data in its fixed order. check runs every local refusal (checkReset) and busy names a reason to wait (a
// recording); both come before anything is deleted. Then hosted deletes the Cloud data when there is any, beforeWipe
// clears the Keychain and stops the helper, and wipe deletes the data folder. Each step after a refusal is skipped;
// returns { error } or { ok, ...what wipe answered }
export async function deleteMyData({ check, busy = () => null, hosted = null, beforeWipe = async () => {}, wipe }) {
  try { check(); } catch (err) { return { error: err.message }; }
  const why = busy();
  if (why) return { error: why };
  if (hosted) {
    const r = await hosted();
    if (r?.error) return { error: r.error };
  }
  await beforeWipe();
  try { return { ok: true, ...wipe() }; } catch (err) { return { error: err.message }; }
}
