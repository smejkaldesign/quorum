import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSecrets, writeDurably } from '../secrets.js';
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
const store = (file, kc, extra = {}) => createSecrets({ file, safeStorage: fakeSafe(), security: kc.security, log: () => {}, ...extra });

describe('secret store', () => {
  it('keeps a value encrypted in a 0600 file and reads it back', async () => {
    const file = tmpFile();
    const kc = fakeKeychain();
    const s = store(file, kc);
    expect(await s.set('quorum-connector-openai', SECRET)).toBe(true);
    expect(await s.get('quorum-connector-openai')).toBe(SECRET);
    expect(readFileSync(file, 'utf8')).not.toContain(SECRET);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(await store(file, kc).get('quorum-connector-openai')).toBe(SECRET);
    expect(argvHas(kc.calls, SECRET)).toBe(false);
  });

  it('copies an item an earlier build left in the Keychain and leaves the item in place', async () => {
    const file = tmpFile();
    const kc = fakeKeychain({ 'quorum-source-slack': SECRET });
    expect(await store(file, kc).get('quorum-source-slack')).toBe(SECRET);
    expect(kc.items['quorum-source-slack']).toBe(SECRET);
    const later = fakeKeychain();
    expect(await store(file, later).get('quorum-source-slack')).toBe(SECRET);
    expect(later.calls).toEqual([]);
    expect(argvHas(kc.calls, SECRET)).toBe(false);
  });

  it('falls back to a legacy service name and keeps it', async () => {
    const kc = fakeKeychain({ 'quorum-model-anthropic': SECRET });
    const s = store(tmpFile(), kc);
    expect(await s.get('quorum-connector-anthropic', ['quorum-model-anthropic'])).toBe(SECRET);
    expect(kc.items).toEqual({ 'quorum-model-anthropic': SECRET });
    expect(await s.get('quorum-connector-anthropic')).toBe(SECRET);
  });

  it('never deletes or writes a Keychain item on get or set', async () => {
    const kc = fakeKeychain({ 'quorum-source-github': 'old' });
    const s = store(tmpFile(), kc);
    await s.get('quorum-source-github');
    await s.set('quorum-source-github', SECRET);
    await s.set('quorum-source-notion', SECRET);
    expect(kc.calls.every((a) => a[0] === 'find-generic-password')).toBe(true);
    expect(kc.items['quorum-source-github']).toBe('old');
    expect(await s.get('quorum-source-github')).toBe(SECRET);
  });

  it('remove deletes the store entry and the Keychain items', async () => {
    const file = tmpFile();
    const kc = fakeKeychain({ 'quorum-connector-anthropic': 'a', 'quorum-model-anthropic': 'b' });
    const s = store(file, kc);
    await s.set('quorum-connector-anthropic', SECRET);
    await s.remove('quorum-connector-anthropic', ['quorum-model-anthropic']);
    expect(kc.items).toEqual({});
    expect(await s.get('quorum-connector-anthropic', ['quorum-model-anthropic'])).toBeNull();
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({});
  });

  it('reads the Keychain without copying when encryption is unavailable', async () => {
    const file = tmpFile();
    const kc = fakeKeychain({ 'quorum-source-notion': SECRET });
    const s = store(file, kc, { safeStorage: fakeSafe(false) });
    expect(await s.get('quorum-source-notion')).toBe(SECRET);
    expect(kc.items['quorum-source-notion']).toBe(SECRET);
    expect(existsSync(file)).toBe(false);
    expect(await s.set('quorum-source-notion', 'new')).toBe(false);
  });

  it('a decrypt failure reads the Keychain, keeps the item and stores the value again', async () => {
    const file = tmpFile();
    await store(file, fakeKeychain()).set('quorum-source-slack', 'unreadable');
    const safe = { ...fakeSafe(), decryptString: (b) => { const v = fakeSafe().decryptString(b); if (v === 'unreadable') throw new Error('bad key'); return v; } };
    const kc = fakeKeychain({ 'quorum-source-slack': SECRET });
    expect(await store(file, kc, { safeStorage: safe }).get('quorum-source-slack')).toBe(SECRET);
    expect(kc.items['quorum-source-slack']).toBe(SECRET);
    const later = fakeKeychain();
    expect(await store(file, later, { safeStorage: safe }).get('quorum-source-slack')).toBe(SECRET);
    expect(later.calls).toEqual([]);
  });

  it('answers undefined when a stored value cannot be decrypted and the Keychain has none', async () => {
    const file = tmpFile();
    await store(file, fakeKeychain()).set('x', SECRET);
    const broken = { ...fakeSafe(), decryptString: () => { throw new Error('bad key'); } };
    expect(await store(file, fakeKeychain(), { safeStorage: broken }).get('x')).toBeUndefined();
    expect(await store(file, fakeKeychain(), { safeStorage: broken }).get('missing')).toBeNull();
  });

  it('moves a corrupt file aside, keeps reading the Keychain and refuses writes for the run', async () => {
    const file = tmpFile();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '{"quorum-source-slack": "abc"');
    const logged = [];
    const kc = fakeKeychain({ 'quorum-source-slack': SECRET });
    const s = store(file, kc, { log: (...a) => logged.push(a.join(' ')), now: () => 42 });
    expect(await s.get('quorum-source-slack')).toBe(SECRET);
    expect(readFileSync(`${file}.corrupt-42`, 'utf8')).toBe('{"quorum-source-slack": "abc"');
    expect(existsSync(file)).toBe(false);
    expect(await s.set('quorum-source-notion', SECRET)).toBe(false);
    expect(existsSync(file)).toBe(false);
    expect(logged.join('\n')).toMatch(/corrupt-42/);
    expect(logged.join('\n')).not.toContain(SECRET);
  });

  it('treats a file of the wrong shape as corrupt', async () => {
    const file = tmpFile();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '{"quorum-source-slack": {"nested": true}}');
    const s = store(file, fakeKeychain(), { now: () => 7 });
    expect(await s.set('a', SECRET)).toBe(false);
    expect(existsSync(`${file}.corrupt-7`)).toBe(true);
  });

  it('a failed save (ENOSPC) leaves the file and the store as they were', async () => {
    const file = tmpFile();
    let full = false;
    const save = (f, text) => { if (full) throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }); writeDurably(f, text); };
    const s = store(file, fakeKeychain(), { save });
    await s.set('a', SECRET);
    const before = readFileSync(file, 'utf8');
    full = true;
    expect(await s.set('b', 'other')).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(await s.get('b')).toBeNull();
    expect(await s.get('a')).toBe(SECRET);
  });

  it('a value that does not survive encryption is not stored', async () => {
    const file = tmpFile();
    const throws = { ...fakeSafe(), encryptString: () => { throw new Error('keychain locked'); } };
    expect(await store(file, fakeKeychain(), { safeStorage: throws }).set('a', SECRET)).toBe(false);
    const lossy = { ...fakeSafe(), decryptString: () => 'something else' };
    expect(await store(file, fakeKeychain(), { safeStorage: lossy }).set('a', SECRET)).toBe(false);
    expect(existsSync(file)).toBe(false);
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
    const s = fresh({ file, safeStorage: fakeSafe(), log: () => {} });
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
    const fake = { get: async (k) => kept[k] ?? null, set: async (k, v) => { kept[k] = v; return true; }, remove: async (k) => { delete kept[k]; } };
    const t = createTokenStore({ store: fake });
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
