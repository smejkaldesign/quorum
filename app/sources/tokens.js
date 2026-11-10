// What a connected source leaves on this Mac: its tokens and the app's client registration with its sign-in server,
// both as JSON in the login Keychain (service quorum[-dev]-source-<name>, account quorum). Nothing of this reaches
// settings.json, the log or the renderer; IPC only ever says whether a source is connected.
import { execFile } from 'node:child_process';
import { isDevelopment } from '../edition.js';

const ACCOUNT = 'quorum';
const prefix = isDevelopment ? 'quorum-dev-source' : 'quorum-source';
const security = (args) => new Promise((resolve) => execFile('/usr/bin/security', args, (err, out) => resolve(err ? null : out.trim())));

const read = async (service) => { const raw = await security(['find-generic-password', '-s', service, '-a', ACCOUNT, '-w']); if (!raw) return null; try { return JSON.parse(raw); } catch { return null; } };
const write = async (service, label, value) => {
  if (value === null) { await security(['delete-generic-password', '-s', service, '-a', ACCOUNT]); return true; }
  return (await security(['add-generic-password', '-U', '-s', service, '-a', ACCOUNT, '-l', label, '-w', JSON.stringify(value)])) !== null;
};

export function createTokenStore({ securityImpl } = {}) {
  const rd = securityImpl ? securityImpl.read : read, wr = securityImpl ? securityImpl.write : write;
  return {
    tokens: {
      get: (sourceId) => rd(`${prefix}-${sourceId}`),
      set: (sourceId, tokens) => wr(`${prefix}-${sourceId}`, `Quorum source: ${sourceId}`, tokens),
    },
    // one registration per sign-in server, keyed by its issuer host, shared by every source that server fronts
    clients: {
      get: (issuer) => rd(`${prefix}-client-${new URL(issuer).host}`),
      set: (issuer, client) => wr(`${prefix}-client-${new URL(issuer).host}`, `Quorum client registration: ${new URL(issuer).host}`, client),
    },
  };
}
