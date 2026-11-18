// The one store for Quorum's secrets on this Mac: source tokens and client registrations, provider keys and decision
// keys. Each value is encrypted with Electron safeStorage, whose key is a Keychain item only the signed Quorum app may
// read without a prompt, and kept in secrets.json (0600) in the data folder. No secret is ever passed on a command line.
// Earlier builds kept each secret as its own Keychain item written through /usr/bin/security; get() still reads those
// (the value comes back on the pipe, never on argv), moves it into this store and deletes the old item.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './edition.js';

const electron = process.versions.electron && process.type === 'browser' ? await import('electron') : null;
const ACCOUNT = 'quorum';
const keychain = (args) => new Promise((resolve) => execFile('/usr/bin/security', args, (err, out) => resolve(err ? null : String(out).trim())));

export function createSecrets({ file = path.join(DATA_DIR, 'secrets.json'), safeStorage = electron?.safeStorage ?? null, security = keychain } = {}) {
  let items = null;
  const load = () => {
    if (items) return items;
    try { items = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}; } catch { items = {}; }
    return items;
  };
  const save = () => {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(items), { mode: 0o600 });
    renameSync(tmp, file);
  };
  const available = () => { try { return !!safeStorage?.isEncryptionAvailable(); } catch { return false; } };
  const dropLegacy = (services) => Promise.all(services.map((s) => security(['delete-generic-password', '-s', s, '-a', ACCOUNT])));

  async function set(service, value) {
    if (!available()) return false;
    load()[service] = safeStorage.encryptString(String(value)).toString('base64');
    save();
    await dropLegacy([service]);
    return true;
  }

  // legacy names an older Keychain service the same secret may still sit under
  async function get(service, legacy = []) {
    const stored = load()[service];
    if (stored) { try { return safeStorage.decryptString(Buffer.from(stored, 'base64')); } catch { return null; } }
    for (const name of [service, ...legacy]) {
      const value = await security(['find-generic-password', '-s', name, '-a', ACCOUNT, '-w']);
      if (!value) continue;
      if (await set(service, value)) await dropLegacy([service, ...legacy]);
      return value;
    }
    return null;
  }

  async function remove(service, legacy = []) {
    if (load()[service] !== undefined) { delete items[service]; save(); }
    await dropLegacy([service, ...legacy]);
  }

  return { get, set, remove };
}

export const secrets = createSecrets();
