// Provider keys on this Mac: one Keychain item per provider (service quorum-connector-<id>, account quorum). A key
// stays in the Keychain and in this process; it is never logged, never written to settings and never returned over
// IPC except as the boolean "set". The Anthropic key saved by earlier builds under quorum-model-anthropic still reads
import { execFile } from 'node:child_process';
import { BY_ID, KEY_PROVIDER_IDS, needsBaseUrl, needsKey } from './catalog.js';
import { isDevelopment } from '../edition.js';

// a development copy keeps its own Keychain items, so a key added while testing never shows up in the installed app
const ACCOUNT = 'quorum';
const service = (id) => `${isDevelopment ? 'quorum-dev' : 'quorum'}-connector-${id}`;
const LEGACY = isDevelopment ? {} : { anthropic: 'quorum-model-anthropic' };
const security = (args) => new Promise((resolve) => execFile('/usr/bin/security', args, (err, out) => resolve(err ? null : out.trim())));
const read = (svc) => security(['find-generic-password', '-s', svc, '-a', ACCOUNT, '-w']);
const cache = {}; // per provider: undefined until looked up, null when there's no key

export async function connectorKey(id) {
  if (!needsKey(id)) return null;
  if (cache[id] === undefined) cache[id] = (await read(service(id))) || (LEGACY[id] ? await read(LEGACY[id]) : null) || null;
  return cache[id];
}

// which key providers have a key saved, as booleans only
export async function connectedKeys() {
  const pairs = await Promise.all(KEY_PROVIDER_IDS.map(async (id) => [id, !!(await connectorKey(id))]));
  return Object.fromEntries(pairs);
}

// the catalog's read-only request, so a key is proven before it is kept. Providers without a key (Ollama) are reached
// the same way; the key is used for the one request and never echoed in the answer
export async function testConnector({ provider, baseUrl, secret } = {}, fetchImpl = fetch) {
  const p = BY_ID[provider];
  if (!p?.test) return { error: 'That provider is not supported.' };
  const key = String(secret ?? '').trim();
  if (needsKey(provider) && !key) return { error: 'Paste the provider key first.' };
  const base = String(baseUrl ?? '').trim();
  if (needsBaseUrl(provider) && !/^https?:\/\/\S+$/.test(base)) return { error: 'Enter the base URL, starting with https://.' };
  let r;
  try {
    const req = p.test(key, base);
    r = await fetchImpl(req.url, { headers: req.headers, signal: AbortSignal.timeout(15000) });
  } catch {
    return { error: `Quorum could not reach ${p.name}. Check your connection${needsBaseUrl(provider) ? ' and the base URL' : provider === 'ollama' ? ' and that Ollama is running' : ''}.` };
  }
  if (r.status === 401 || r.status === 403) return { error: `${p.name} did not accept that key.` };
  if (!r.ok) return { error: `${p.name} answered ${r.status}. Try again in a minute.` };
  return { ok: true };
}

// proves the key with the catalog request, then keeps it
export async function setConnectorKey(id, key, baseUrl) {
  if (!needsKey(id)) return { error: 'That provider takes no key.' };
  const t = await testConnector({ provider: id, baseUrl, secret: key });
  if (t.error) return t;
  const saved = await security(['add-generic-password', '-U', '-s', service(id), '-a', ACCOUNT, '-l', `${BY_ID[id].name} API key (Quorum)`, '-w', String(key).trim()]);
  cache[id] = undefined;
  return saved === null ? { error: "Couldn't save the key to your Keychain" } : { ok: true };
}

export async function removeConnectorKey(id) {
  await security(['delete-generic-password', '-s', service(id), '-a', ACCOUNT]);
  if (LEGACY[id]) await security(['delete-generic-password', '-s', LEGACY[id], '-a', ACCOUNT]);
  cache[id] = null;
}

// tests the saved key (or one pasted in, before saving); the compatible provider takes its base URL from settings
export async function testSavedConnector(id, { secret, baseUrl } = {}) {
  if (!BY_ID[id]?.test) return { error: 'That provider is not supported.' };
  const key = String(secret ?? '').trim() || (needsKey(id) ? await connectorKey(id) : '');
  if (needsKey(id) && !key) return { error: 'No key saved yet.' };
  return testConnector({ provider: id, baseUrl, secret: key });
}
