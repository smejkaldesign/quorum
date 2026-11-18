// What a connected source leaves on this Mac: its tokens and the app's client registration with its sign-in server,
// both as JSON in Quorum's secret store (secrets.js; names quorum[-dev]-source-<name>). Nothing of this reaches
// settings.json, the log or the renderer; IPC only ever says whether a source is connected.
import { isDevelopment } from '../edition.js';
import { secrets } from '../secrets.js';

const prefix = isDevelopment ? 'quorum-dev-source' : 'quorum-source';

// the Keychain printed values with non-ASCII bytes as hex, so an item moved from an earlier build may arrive that way
export function parseStored(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch {}
  if (!/^(?:[0-9a-f]{2})+$/i.test(raw)) return null;
  try { return JSON.parse(Buffer.from(raw, 'hex').toString('utf8')); } catch { return null; }
}

export function createTokenStore({ store = secrets } = {}) {
  const read = async (name) => parseStored(await store.get(name));
  const write = async (name, value) => { if (value === null) { await store.remove(name); return true; } return store.set(name, JSON.stringify(value)); };
  return {
    tokens: {
      get: (sourceId) => read(`${prefix}-${sourceId}`),
      set: (sourceId, tokens) => write(`${prefix}-${sourceId}`, tokens),
    },
    // one registration per sign-in server, keyed by its issuer host, shared by every source that server fronts
    clients: {
      get: (issuer) => read(`${prefix}-client-${new URL(issuer).host}`),
      set: (issuer, client) => write(`${prefix}-client-${new URL(issuer).host}`, client),
    },
  };
}
