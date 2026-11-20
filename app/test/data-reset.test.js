// dataReset.js: Delete my data removes what Quorum keeps in its data folder and never the person's vault, wherever the
// vault sits and whatever links point at it.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkDataDir, checkReset, deleteMyData, forgetKeychain, protectedPaths, resetData } from '../dataReset.js';

let base, home, data;
const put = (p, text = 'x') => { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, text); };
beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), 'quorum-reset-')));
  home = path.join(base, 'home');
  data = path.join(home, 'Library/Application Support/Quorum');
  mkdirSync(data, { recursive: true });
  put(path.join(data, 'settings.json'), '{}');
  put(path.join(data, 'state.json'), '{}');
  put(path.join(data, 'chats/one.json'), '{}');
  put(path.join(data, 'sessions/s1/transcript.json'), '{}');
  put(path.join(data, 'memory/abc/memory.db'), 'db');
  put(path.join(data, 'models/embed.gguf'), 'model');
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('resetData', () => {
  it('empties the data folder but keeps the models and the folder itself', () => {
    const r = resetData({ dataDir: data, home });
    expect(readdirSync(data)).toEqual(['models']);
    expect(readFileSync(path.join(data, 'models/embed.gguf'), 'utf8')).toBe('model');
    expect(r.removed).toContain(path.join(data, 'chats'));
    expect(r.kept).toEqual([path.join(data, 'models')]);
    resetData({ dataDir: data, home, keep: [] });
    expect(readdirSync(data)).toEqual([]);
  });

  it('never touches a vault outside the data folder', () => {
    const vault = path.join(home, 'Documents/Brain');
    put(path.join(vault, 'notes/a.md'), '# A');
    put(path.join(vault, 'CLAUDE.md'), 'rules');
    resetData({ dataDir: data, home, protect: protectedPaths({ settings: { brainRoot: vault, vaultPath: vault } }) });
    expect(readFileSync(path.join(vault, 'notes/a.md'), 'utf8')).toBe('# A');
    expect(readFileSync(path.join(vault, 'CLAUDE.md'), 'utf8')).toBe('rules');
  });

  it('keeps a vault inside the data folder while its siblings go', () => {
    const vault = path.join(data, 'brains/Mine');
    put(path.join(vault, 'notes/a.md'), '# A');
    put(path.join(data, 'brains/old-cache.json'), '{}');
    const r = resetData({ dataDir: data, home, keep: [], protect: protectedPaths({ settings: { vaultPath: vault } }) });
    expect(readFileSync(path.join(vault, 'notes/a.md'), 'utf8')).toBe('# A');
    expect(existsSync(path.join(data, 'brains/old-cache.json'))).toBe(false);
    expect(existsSync(path.join(data, 'chats'))).toBe(false);
    expect(readdirSync(data)).toEqual(['brains']);
    expect(r.kept).toContain(vault);
  });

  it('unlinks a link inside the data folder that points at the vault, and never follows it', () => {
    const vault = path.join(home, 'Documents/Brain');
    put(path.join(vault, 'a.md'), '# A');
    symlinkSync(vault, path.join(data, 'vault-link'));
    symlinkSync(path.join(vault, 'a.md'), path.join(data, 'note-link.md'));
    resetData({ dataDir: data, home, protect: [vault] });
    expect(existsSync(path.join(data, 'vault-link'))).toBe(false);
    expect(existsSync(path.join(data, 'note-link.md'))).toBe(false);
    expect(readFileSync(path.join(vault, 'a.md'), 'utf8')).toBe('# A');
    // and with no vault listed at all, the link still goes as a link only
    symlinkSync(vault, path.join(data, 'vault-link'));
    resetData({ dataDir: data, home });
    expect(readFileSync(path.join(vault, 'a.md'), 'utf8')).toBe('# A');
  });

  it('keeps a folder that looks like a vault even when no setting names it', () => {
    put(path.join(data, 'made/My Agent OS/CLAUDE.md'), 'rules');
    put(path.join(data, 'made/My Agent OS/notes/b.md'), '# B');
    resetData({ dataDir: data, home });
    expect(readFileSync(path.join(data, 'made/My Agent OS/notes/b.md'), 'utf8')).toBe('# B');
  });

  it('refuses the home folder, the root and a folder that is not Quorum\'s', () => {
    put(path.join(home, 'keep.txt'));
    expect(() => resetData({ dataDir: home, home })).toThrow(/home or root/);
    expect(() => resetData({ dataDir: '/', home })).toThrow(/home or root/);
    const other = path.join(home, 'Documents');
    mkdirSync(other, { recursive: true });
    expect(() => resetData({ dataDir: other, home })).toThrow(/not a Quorum folder/);
    // a link named Quorum that resolves to the home folder is the home folder
    const disguised = path.join(base, 'Quorum');
    symlinkSync(home, disguised);
    expect(() => resetData({ dataDir: disguised, home })).toThrow(/home or root/);
    expect(existsSync(path.join(home, 'keep.txt'))).toBe(true);
    expect(() => resetData({ dataDir: 'relative/Quorum', home })).toThrow();
  });

  it('matches a vault path saved in another case, as APFS does', () => {
    const vault = path.join(data, 'brains/Mine');
    put(path.join(vault, 'notes/a.md'), '# A');
    put(path.join(data, 'brains/old-cache.json'), '{}');
    resetData({ dataDir: data, home, keep: [], caseless: true, protect: [path.join(data.toUpperCase(), 'BRAINS/mine')] });
    expect(readFileSync(path.join(vault, 'notes/a.md'), 'utf8')).toBe('# A');
    expect(existsSync(path.join(data, 'brains/old-cache.json'))).toBe(false);
    expect(() => resetData({ dataDir: data, home, caseless: true, protect: [path.join(home.toUpperCase(), 'library')] })).toThrow(/inside your vault/);
    expect(() => checkDataDir(path.join(home, '.'), { home: home.toUpperCase(), caseless: true })).toThrow(/home or root/);
  });

  it('refuses a data folder that sits inside the vault', () => {
    expect(() => resetData({ dataDir: data, home, protect: [path.join(home, 'Library')] })).toThrow(/inside your vault/);
    expect(existsSync(path.join(data, 'settings.json'))).toBe(true);
  });

  it('does nothing when the data folder is missing', () => {
    expect(resetData({ dataDir: path.join(base, 'gone/Quorum'), home })).toEqual({ removed: [], kept: [] });
    expect(checkDataDir(path.join(base, 'gone/Quorum Dev'), { home })).toBeNull();
  });
});

describe('checkReset', () => {
  it('runs every refusal and deletes nothing', () => {
    expect(() => checkReset({ dataDir: data, home, protect: [home] })).toThrow(/inside your vault/);
    expect(() => checkReset({ dataDir: home, home })).toThrow(/home or root/);
    expect(checkReset({ dataDir: data, home, protect: [path.join(home, 'Documents')] }).root).toBe(data);
    expect(readdirSync(data).sort()).toEqual(['chats', 'memory', 'models', 'sessions', 'settings.json', 'state.json']);
  });
});

describe('deleteMyData', () => {
  const steps = (over = {}) => {
    const order = [];
    const run = deleteMyData({
      check: () => { order.push('check'); checkReset({ dataDir: data, home, protect: over.protect ?? [] }); },
      busy: () => { order.push('busy'); return over.busy ?? null; },
      hosted: async () => { order.push('hosted'); return over.hosted ?? { ok: true }; },
      beforeWipe: async () => { order.push('keychain'); },
      wipe: () => { order.push('wipe'); return resetData({ dataDir: data, home, protect: over.protect ?? [] }); },
    });
    return { order, run };
  };

  it('validates, deletes the hosted data, clears the Keychain and wipes, in that order', async () => {
    const { order, run } = steps();
    const r = await run;
    expect(order).toEqual(['check', 'busy', 'hosted', 'keychain', 'wipe']);
    expect(r.ok).toBe(true);
    expect(existsSync(path.join(data, 'settings.json'))).toBe(false);
  });

  it('stops before the hosted delete and the Keychain when a local check refuses', async () => {
    const { order, run } = steps({ protect: [home] });
    expect(await run).toEqual({ error: 'The data folder sits inside your vault, so nothing was deleted.' });
    expect(order).toEqual(['check']);
    expect(existsSync(path.join(data, 'settings.json'))).toBe(true);
  });

  it('waits for a recording to end, and stops when the hosted delete fails', async () => {
    const busy = steps({ busy: 'Stop the recording first, then delete your data.' });
    expect(await busy.run).toEqual({ error: 'Stop the recording first, then delete your data.' });
    expect(busy.order).toEqual(['check', 'busy']);
    const failed = steps({ hosted: { error: 'Your data could not be deleted.' } });
    expect(await failed.run).toEqual({ error: 'Your data could not be deleted.' });
    expect(failed.order).toEqual(['check', 'busy', 'hosted']);
    expect(existsSync(path.join(data, 'settings.json'))).toBe(true);
  });
});

describe('protectedPaths', () => {
  it('collects every vault Quorum knows', () => {
    const p = protectedPaths({
      settings: { brainRoot: '/v/root', vaultPath: '/v/root/vault', meetingsDir: '/m', brainsMade: ['/made/one', 'relative'], teamKnowledge: { ws1: { path: '/team/folder' }, ws2: {} } },
      env: { QUORUM_VAULT: '/env/vault' }, defaultVault: '/home/a/Documents/Quorum',
    });
    expect(p.sort()).toEqual(['/env/vault', '/home/a/Documents/Quorum', '/m', '/made/one', '/team/folder', '/v/root', '/v/root/vault']);
  });
});

describe('forgetKeychain', () => {
  it('removes the safe storage key and the older per-secret items', async () => {
    const calls = [];
    let safeLeft = 2;
    const security = async (args) => { calls.push(args); if (args[2].endsWith('Safe Storage')) return safeLeft-- > 0 ? '' : null; return args[2] === 'svc-a' ? '' : null; };
    const file = path.join(base, 'secrets.json');
    writeFileSync(file, JSON.stringify({ 'svc-a': 'sealed', 'svc-b': 'sealed' }));
    const gone = await forgetKeychain({ appName: 'Quorum Dev', secretsFile: file, security });
    expect(gone).toEqual(['Quorum Dev Safe Storage', 'Quorum Dev Safe Storage', 'svc-a']);
    expect(calls.filter((c) => c[2] === 'Quorum Dev Safe Storage')).toHaveLength(3);
    expect(calls.find((c) => c[2] === 'svc-b')).toEqual(['delete-generic-password', '-s', 'svc-b', '-a', 'quorum']);
  });
});
