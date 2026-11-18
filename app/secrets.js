// The one store for Quorum's secrets on this Mac: source tokens and client registrations, provider keys and decision
// keys. Each value is encrypted with Electron safeStorage, whose key is a Keychain item only the signed Quorum app may
// read without a prompt, and kept in secrets.json (0600) in the data folder. No secret is ever passed on a command line.
// Earlier builds kept each secret as its own Keychain item written through /usr/bin/security. Reads fall back to those
// items (the value comes back on the pipe, never on argv) and copy them into this store. The Keychain items are kept
// for one release so a rollback to 0.3.1 keeps working; only remove() deletes them.
import { execFile } from 'node:child_process';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './edition.js';

const electron = process.versions.electron && process.type === 'browser' ? await import('electron') : null;
const ACCOUNT = 'quorum';
const keychain = (args) => new Promise((resolve) => execFile('/usr/bin/security', args, (err, out) => resolve(err ? null : String(out).trim())));

const fsyncPath = (p, flags) => { const fd = openSync(p, flags); try { fsyncSync(fd); } finally { closeSync(fd); } };

export function writeDurably(file, text) {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  fsyncPath(dir, 'r');
  renameSync(tmp, file);
  fsyncPath(dir, 'r');
}

const wellFormed = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string');

export function createSecrets({ file = path.join(DATA_DIR, 'secrets.json'), safeStorage = electron?.safeStorage ?? null, security = keychain, save = writeDurably, log = (...a) => console.warn(...a), now = Date.now } = {}) {
  let items = null;
  // a secrets.json that cannot be read is moved aside, and the store takes no writes until the next launch
  let readOnly = false;
  const load = () => {
    if (items) return items;
    if (!existsSync(file)) return (items = {});
    let parsed = null;
    try { parsed = JSON.parse(readFileSync(file, 'utf8')); } catch {}
    if (wellFormed(parsed)) return (items = parsed);
    const aside = `${file}.corrupt-${now()}`;
    try { renameSync(file, aside); } catch {}
    log('secrets', `${path.basename(file)} could not be read, moved to ${path.basename(aside)}; secrets come from the Keychain until the next launch`);
    readOnly = true;
    return (items = {});
  };
  const available = () => { try { return !!safeStorage?.isEncryptionAvailable(); } catch { return false; } };

  async function set(service, value) {
    load();
    if (readOnly || !available()) return false;
    const text = String(value);
    let sealed;
    try {
      const blob = safeStorage.encryptString(text);
      if (safeStorage.decryptString(blob) !== text) return false;
      sealed = blob.toString('base64');
    } catch { return false; }
    const next = { ...items, [service]: sealed };
    try { save(file, JSON.stringify(next)); } catch (e) { log('secrets', `could not write ${path.basename(file)}: ${e.code ?? e.message}`); return false; }
    items = next;
    return true;
  }

  // null when there is no secret; undefined when one is stored but could not be decrypted and the Keychain has none,
  // so callers do not cache it as absent. legacy names an older Keychain service the same secret may sit under
  async function get(service, legacy = []) {
    const stored = load()[service];
    let failed = false;
    if (stored) {
      try { return safeStorage.decryptString(Buffer.from(stored, 'base64')); } catch { failed = true; log('secrets', `could not decrypt ${service}; reading the Keychain`); }
    }
    for (const name of [service, ...legacy]) {
      const value = await security(['find-generic-password', '-s', name, '-a', ACCOUNT, '-w']);
      if (!value) continue;
      await set(service, value);
      return value;
    }
    return failed ? undefined : null;
  }

  async function remove(service, legacy = []) {
    load();
    if (!readOnly && items[service] !== undefined) {
      const next = { ...items };
      delete next[service];
      try { save(file, JSON.stringify(next)); items = next; } catch (e) { log('secrets', `could not write ${path.basename(file)}: ${e.code ?? e.message}`); }
    }
    await Promise.all([service, ...legacy].map((s) => security(['delete-generic-password', '-s', s, '-a', ACCOUNT])));
  }

  return { get, set, remove };
}

export const secrets = createSecrets();
