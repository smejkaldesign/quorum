import { mkdtempSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSecrets } from '../secrets.js';
import { createTokenStore, parseStored } from '../sources/tokens.js';

const SECRET = 'fake-secret-value-123';
// stands in for safeStorage: reversible, and the stored bytes never equal the plain text
const fakeSafe = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from(`enc:${Buffer.from(s).toString('hex')}`),
  decryptString: (b) => Buffer.from(b.toString().slice(4), 'hex').toString(),
});
// stands in for /usr/bin/security: answers find/delete from a map and records every argv
const fakeKeychain = (items = {}) => {
  const calls = [];
  const security = async (args) => {
    calls.push(args);
    const svc = args[args.indexOf('-s') + 1];
    if (args[0] === 'find-generic-password') return items[svc] ?? null;
    if (args[0] === 'delete-generic-password') { const had = svc in items; delete items[svc]; return had ? '' : null; }
    return null;
  };
  return { items, calls, security };
};
const tmpFile = () => path.join(mkdtempSync(path.join(tmpdir(), 'quorum-secrets-')), 'data', 'secrets.json');
const argvHas = (calls, value) => calls.some((args) => args.some((a) => String(a).includes(value)));

describe('secret store', () => {
  it('keeps a value encrypted in a 0600 file and reads it back', async () => {
    const file = tmpFile();
    const kc = fakeKeychain();
    const s = createSecrets({ file, safeStorage: fakeSafe(), security: kc.security });
    expect(await s.set('quorum-connector-openai', SECRET)).toBe(true);
    expect(await s.get('quorum-connector-openai')).toBe(SECRET);
    expect(readFileSync(file, 'utf8')).not.toContain(SECRET);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    // a fresh process reads the same file
    expect(await createSecrets({ file, safeStorage: fakeSafe(), security: kc.security }).get('quorum-connector-openai')).toBe(SECRET);
    expect(argvHas(kc.calls, SECRET)).toBe(false);
  });

  it('reads an item an earlier build left in the Keychain, moves it and deletes the old item', async () => {
    const file = tmpFile();
    const kc = fakeKeychain({ 'quorum-source-slack': SECRET });
    const s = createSecrets({ file, safeStorage: fakeSafe(), security: kc.security });
    expect(await s.get('quorum-source-slack')).toBe(SECRET);
    expect(kc.items['quorum-source-slack']).toBeUndefined();
    expect(await createSecrets({ file, safeStorage: fakeSafe(), security: kc.security }).get('quorum-source-slack')).toBe(SECRET);
    expect(argvHas(kc.calls, SECRET)).toBe(false);
  });

  it('falls back to a legacy service name and clears both', async () => {
    const kc = fakeKeychain({ 'quorum-model-anthropic': SECRET });
    const s = createSecrets({ file: tmpFile(), safeStorage: fakeSafe(), security: kc.security });
    expect(await s.get('quorum-connector-anthropic', ['quorum-model-anthropic'])).toBe(SECRET);
    expect(kc.items).toEqual({});
    expect(await s.get('quorum-connector-anthropic')).toBe(SECRET);
  });

  it('leaves the Keychain item in place when encryption is unavailable', async () => {
    const kc = fakeKeychain({ 'quorum-source-notion': SECRET });
    const s = createSecrets({ file: tmpFile(), safeStorage: fakeSafe(false), security: kc.security });
    expect(await s.get('quorum-source-notion')).toBe(SECRET);
    expect(kc.items['quorum-source-notion']).toBe(SECRET);
    expect(await s.set('quorum-source-notion', 'new')).toBe(false);
  });

  it('a write replaces the old Keychain item, and remove clears both stores', async () => {
    const file = tmpFile();
    const kc = fakeKeychain({ 'quorum-source-github': 'old' });
    const s = createSecrets({ file, safeStorage: fakeSafe(), security: kc.security });
    await s.set('quorum-source-github', SECRET);
    expect(kc.items['quorum-source-github']).toBeUndefined();
    expect(await s.get('quorum-source-github')).toBe(SECRET);
    await s.remove('quorum-source-github');
    expect(await s.get('quorum-source-github')).toBeNull();
    expect(readFileSync(file, 'utf8')).toBe('{}');
    expect(argvHas(kc.calls, SECRET)).toBe(false);
  });

  it('answers null for a value it cannot decrypt', async () => {
    const file = tmpFile();
    await createSecrets({ file, safeStorage: fakeSafe(), security: fakeKeychain().security }).set('x', SECRET);
    const broken = { ...fakeSafe(), decryptString: () => { throw new Error('bad key'); } };
    expect(await createSecrets({ file, safeStorage: broken, security: fakeKeychain().security }).get('x')).toBeNull();
  });
});

describe('the default Keychain reader', () => {
  afterEach(() => { vi.doUnmock('node:child_process'); vi.resetModules(); });

  it('only runs /usr/bin/security to find or delete, never with the secret on argv', async () => {
    const calls = [];
    vi.resetModules();
    vi.doMock('node:child_process', () => ({
      execFile: (bin, args, cb) => { calls.push([bin, ...args]); cb(null, args[0] === 'find-generic-password' ? `${SECRET}\n` : ''); },
    }));
    const { createSecrets: fresh } = await import('../secrets.js');
    const file = tmpFile();
    const s = fresh({ file, safeStorage: fakeSafe() });
    expect(await s.get('quorum-source-slack')).toBe(SECRET);
    await s.set('quorum-source-slack', `${SECRET}-2`);
    await s.remove('quorum-source-slack');
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c[0] === '/usr/bin/security' && ['find-generic-password', 'delete-generic-password'].includes(c[1]))).toBe(true);
    expect(calls.some((c) => c.some((a) => String(a).includes(SECRET)))).toBe(false);
    expect(existsSync(file)).toBe(true);
  });
});

describe('source token store', () => {
  it('stores tokens as JSON and deletes on null', async () => {
    const kept = {};
    const store = { get: async (k) => kept[k] ?? null, set: async (k, v) => { kept[k] = v; return true; }, remove: async (k) => { delete kept[k]; } };
    const t = createTokenStore({ store });
    await t.tokens.set('slack', { access_token: 'a' });
    expect(await t.tokens.get('slack')).toEqual({ access_token: 'a' });
    await t.clients.set('https://mcp.notion.com/x', { client_id: 'c' });
    expect(Object.keys(kept).some((k) => k.endsWith('-source-client-mcp.notion.com'))).toBe(true);
    await t.tokens.set('slack', null);
    expect(await t.tokens.get('slack')).toBeNull();
  });

  it('reads JSON the Keychain printed as hex because it held non-ASCII text', () => {
    const value = { name: 'café' };
    expect(parseStored(Buffer.from(JSON.stringify(value)).toString('hex'))).toEqual(value);
    expect(parseStored(JSON.stringify(value))).toEqual(value);
    expect(parseStored('not json')).toBeNull();
    expect(parseStored(null)).toBeNull();
  });
});
