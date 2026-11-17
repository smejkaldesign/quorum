// The background download of the decision layer's models (decide/download.js): files from pinned revisions over HTTPS,
// each SHA-256 checked before it is kept, a partial file resumed with a Range request, retries with backoff, a pause
// while Low Power Mode is on, and status in plain words. A fake server stands in for the model host.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createModelDownload, lowPowerFromPmset, modelsLabel, modelsSupported } from '../decide/download.js';
import { DECIDER_ON } from '../decide/index.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const A = Buffer.from('a'.repeat(5000));
const B = Buffer.from('b'.repeat(3000));
const manifest = (over = {}) => ({ embed: { repo: 'org/embed', revision: 'r1', files: { 'm.onnx': { sha256: sha(A), size: A.length }, ...over } }, nli: { repo: 'org/nli', revision: 'r2', files: { 't.json': { sha256: sha(B), size: B.length } } } });
const BODIES = { 'https://huggingface.co/org/embed/resolve/r1/m.onnx': A, 'https://huggingface.co/org/nli/resolve/r2/t.json': B };

// a fake fetch over BODIES. ignoreRange: answers 200 with the whole file; fail: the first n requests answer 503;
// corrupt: the first n bodies come back with a changed byte
function server({ ignoreRange = false, fail = 0, corrupt = 0, landAt = null } = {}) {
  const seen = [];
  const f = async (url, init = {}) => {
    const range = init.headers?.Range ?? null;
    seen.push({ url, range, headers: init.headers ?? {} });
    const reply = (r) => { Object.defineProperty(r, 'url', { value: landAt ? landAt(url) : url }); return r; };
    if (fail > 0) { fail--; return reply(new Response('busy', { status: 503 })); }
    let body = BODIES[url];
    if (!body) return reply(new Response('missing', { status: 404 }));
    if (corrupt > 0) { corrupt--; body = Buffer.from(body); body[0] ^= 1; }
    const from = !ignoreRange && range ? Number(range.match(/bytes=(\d+)-/)[1]) : 0;
    return reply(new Response(body.subarray(from), { status: from ? 206 : 200 }));
  };
  return { fetch: f, seen };
}
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'models-'));
const run = async (opts) => { const sleeps = []; const d = createModelDownload({ supported: true, sleep: async (ms) => { sleeps.push(ms); }, ...opts }); await d.start(); return { d, sleeps }; };

describe('model download', () => {
  it('downloads every file over HTTPS from its pinned revision, checks its hash and reports ready', async () => {
    const dir = tmp();
    const s = server();
    const { d } = await run({ dir, manifest: manifest(), fetch: s.fetch });
    expect(d.status()).toMatchObject({ state: 'ready', doneBytes: 8000, totalBytes: 8000 });
    expect(readFileSync(path.join(dir, 'embed/m.onnx'))).toEqual(A);
    expect(readFileSync(path.join(dir, 'nli/t.json'))).toEqual(B);
    expect(s.seen.every((r) => r.url.startsWith('https://huggingface.co/'))).toBe(true);
    expect(existsSync(path.join(dir, 'embed/m.onnx.part'))).toBe(false);
  });

  it('names itself in every request with the app version and sends nothing else about the person', async () => {
    const s = server({ fail: 1 });
    await run({ dir: tmp(), manifest: manifest(), fetch: s.fetch, userAgent: 'Quorum/1.2.3' });
    expect(s.seen.length).toBeGreaterThan(2);
    for (const r of s.seen) expect(Object.keys(r.headers).filter((k) => k !== 'Range')).toEqual(['User-Agent']);
    for (const r of s.seen) expect(r.headers['User-Agent']).toBe('Quorum/1.2.3');
  });

  it('keeps files already on disk with the right hash and downloads nothing', async () => {
    const dir = tmp();
    mkdirSync(path.join(dir, 'embed'), { recursive: true }); mkdirSync(path.join(dir, 'nli'), { recursive: true });
    writeFileSync(path.join(dir, 'embed/m.onnx'), A); writeFileSync(path.join(dir, 'nli/t.json'), B);
    const s = server();
    const { d } = await run({ dir, manifest: manifest(), fetch: s.fetch });
    expect(d.status().state).toBe('ready');
    expect(s.seen).toEqual([]);
  });

  it('trusts the size and time stamp it wrote after a verified download instead of hashing again at launch', async () => {
    const dir = tmp();
    await run({ dir, manifest: manifest(), fetch: server().fetch });
    const hashed = [];
    const hash = async (file) => { hashed.push(file); return sha(readFileSync(file)); };
    const s = server();
    const { d } = await run({ dir, manifest: manifest(), fetch: s.fetch, hash });
    expect(d.status().state).toBe('ready');
    expect(hashed).toEqual([]);
    expect(s.seen).toEqual([]);
    // a file changed after the stamp is hashed again, fails, and is downloaded again
    writeFileSync(path.join(dir, 'nli/t.json'), Buffer.from('c'.repeat(3000)));
    utimesSync(path.join(dir, 'nli/t.json'), new Date(), new Date(Date.now() + 5000));
    const again = await run({ dir, manifest: manifest(), fetch: s.fetch, hash });
    expect(again.d.status().state).toBe('ready');
    expect(hashed).toEqual([path.join(dir, 'nli/t.json')]);
    expect(readFileSync(path.join(dir, 'nli/t.json'))).toEqual(B);
  });

  it('resumes a partial file with a Range request', async () => {
    const dir = tmp();
    mkdirSync(path.join(dir, 'embed'), { recursive: true });
    writeFileSync(path.join(dir, 'embed/m.onnx.part'), A.subarray(0, 2000));
    const s = server();
    const { d } = await run({ dir, manifest: manifest(), fetch: s.fetch });
    expect(d.status().state).toBe('ready');
    expect(s.seen.find((r) => r.url.endsWith('m.onnx')).range).toBe('bytes=2000-');
    expect(readFileSync(path.join(dir, 'embed/m.onnx'))).toEqual(A);
  });

  it('keeps a partial file that is already complete when its hash matches, and starts over when it does not', async () => {
    const dir = tmp();
    mkdirSync(path.join(dir, 'embed'), { recursive: true });
    writeFileSync(path.join(dir, 'embed/m.onnx.part'), A);
    const s = server();
    const { d } = await run({ dir, manifest: manifest(), fetch: s.fetch });
    expect(d.status().state).toBe('ready');
    expect(s.seen.filter((r) => r.url.endsWith('m.onnx'))).toEqual([]);
    expect(readFileSync(path.join(dir, 'embed/m.onnx'))).toEqual(A);
    const bad = tmp();
    mkdirSync(path.join(bad, 'embed'), { recursive: true });
    writeFileSync(path.join(bad, 'embed/m.onnx.part'), Buffer.from('z'.repeat(A.length)));
    const s2 = server();
    const r2 = await run({ dir: bad, manifest: manifest(), fetch: s2.fetch });
    expect(r2.d.status().state).toBe('ready');
    expect(s2.seen.find((r) => r.url.endsWith('m.onnx')).range).toBe(null);
    expect(readFileSync(path.join(bad, 'embed/m.onnx'))).toEqual(A);
  });

  it('starts over when the server ignores the Range request', async () => {
    const dir = tmp();
    mkdirSync(path.join(dir, 'embed'), { recursive: true });
    writeFileSync(path.join(dir, 'embed/m.onnx.part'), A.subarray(0, 2000));
    const { d } = await run({ dir, manifest: manifest(), fetch: server({ ignoreRange: true }).fetch });
    expect(d.status().state).toBe('ready');
    expect(readFileSync(path.join(dir, 'embed/m.onnx'))).toEqual(A);
  });

  it('retries with growing waits after errors', async () => {
    const dir = tmp();
    const { d, sleeps } = await run({ dir, manifest: manifest(), fetch: server({ fail: 3 }).fetch, backoffMs: 1000 });
    expect(d.status().state).toBe('ready');
    expect(sleeps).toEqual([1000, 2000, 4000]);
    expect(readFileSync(path.join(dir, 'embed/m.onnx'))).toEqual(A);
  });

  it('marks a file whose complete download fails its hash as failed until the next launch', async () => {
    const dir = tmp();
    const s = server({ corrupt: 99 });
    const timers = [];
    const { d, sleeps } = await run({ dir, manifest: manifest(), fetch: s.fetch, setTimer: (fn, ms) => { timers.push(ms); return 1; } });
    expect(d.status()).toMatchObject({ state: 'failed', why: 'hash_mismatch' });
    expect(s.seen.filter((r) => r.url.endsWith('m.onnx'))).toHaveLength(1);
    expect(sleeps).toEqual([]);
    expect(timers).toEqual([]);
    await d.start();
    expect(s.seen.filter((r) => r.url.endsWith('m.onnx'))).toHaveLength(1);
    expect(existsSync(path.join(dir, 'embed/m.onnx'))).toBe(false);
    expect(existsSync(path.join(dir, 'embed/m.onnx.part'))).toBe(false);
    expect(modelsLabel(d.status())).toBe('Local models: download failed. Quorum tries again later; until then every check goes to Claude.');
  });

  it('stays stopped: stop() clears the hourly retry, and a later start() downloads nothing', async () => {
    const s = server({ fail: 99 });
    const timers = [];
    const cleared = [];
    const { d } = await run({ dir: tmp(), manifest: manifest(), fetch: s.fetch, retries: 1, setTimer: (fn, ms) => { timers.push({ fn, ms }); return 'timer-1'; }, clearTimer: (h) => cleared.push(h) });
    expect(d.status().state).toBe('failed');
    expect(timers.map((t) => t.ms)).toEqual([60 * 60 * 1000]);
    const before = s.seen.length;
    d.stop();
    expect(cleared).toEqual(['timer-1']);
    await timers[0].fn();
    await d.start();
    expect(s.seen.length).toBe(before);
  });

  it('reports an error code only, never a message that names a path', async () => {
    const root = tmp();
    const dir = path.join(root, 'models');
    writeFileSync(dir, 'a file where the folder should be');
    const logged = [];
    const { d } = await run({ dir, manifest: manifest(), fetch: server().fetch, retries: 1, log: (...a) => logged.push(a.join(' ')) });
    expect(d.status()).toMatchObject({ state: 'failed', why: 'disk' });
    expect(JSON.stringify(d.status())).not.toContain(root);
    expect(logged.join('\n')).toContain(root);
    const net = await run({ dir: tmp(), manifest: manifest(), fetch: async () => { throw new TypeError('fetch failed'); }, retries: 1 });
    expect(net.d.status().why).toBe('network');
    const http = await run({ dir: tmp(), manifest: manifest(), fetch: server({ fail: 99 }).fetch, retries: 1 });
    expect(http.d.status().why).toBe('http_error');
  });

  it('fails before any request when a file has no hash pinned', async () => {
    const s = server();
    const { d } = await run({ dir: tmp(), manifest: manifest({ 'x.json': { sha256: '', size: 1 } }), fetch: s.fetch });
    expect(d.status()).toMatchObject({ state: 'failed', why: 'no_hash' });
    expect(s.seen).toEqual([]);
  });

  it('waits while Low Power Mode is on and downloads once it is off', async () => {
    const answers = [{ ok: false, why: 'low_power' }, { ok: false, why: 'low_power' }];
    const states = [];
    const s = server();
    const { d, sleeps } = await run({ dir: tmp(), manifest: manifest(), fetch: s.fetch, waitMs: 60000, conditions: async () => answers.shift() ?? { ok: true }, onChange: (st) => states.push(st.state) });
    expect(states).toContain('waiting');
    expect(sleeps.filter((ms) => ms === 60000)).toHaveLength(2);
    expect(d.status().state).toBe('ready');
  });

  it('follows a redirect to the Hugging Face CDN and refuses one to any other host or to http', async () => {
    const cdn = await run({ dir: tmp(), manifest: manifest(), fetch: server({ landAt: (u) => u.replace('https://huggingface.co/', 'https://cdn-lfs-us-1.hf.co/') }).fetch });
    expect(cdn.d.status().state).toBe('ready');
    const xet = await run({ dir: tmp(), manifest: manifest(), fetch: server({ landAt: (u) => u.replace('https://huggingface.co/', 'https://cas-bridge.xethub.hf.co/') }).fetch });
    expect(xet.d.status().state).toBe('ready');
    for (const landAt of [(u) => u.replace('huggingface.co', 'evil.example'), (u) => u.replace('https:', 'http:'), (u) => u.replace('huggingface.co', 'huggingface.co.evil.example')]) {
      const dir = tmp();
      const { d } = await run({ dir, manifest: manifest(), fetch: server({ landAt }).fetch, retries: 1 });
      expect(d.status()).toMatchObject({ state: 'failed', why: 'host_refused' });
      expect(existsSync(path.join(dir, 'embed/m.onnx'))).toBe(false);
    }
  });

  it('downloads nothing while the decision layer is off', async () => {
    const s = server();
    const d = createModelDownload({ dir: tmp(), manifest: manifest(), fetch: s.fetch, supported: true, enabled: false });
    await d.start();
    expect(d.status().state).toBe('off');
    expect(s.seen).toEqual([]);
    // the contradiction agent calls the decider (memoryEngine.js), so main downloads the models
    expect(DECIDER_ON).toBe(true);
  });

  it('does nothing on a Mac the runtime does not support', async () => {
    const s = server();
    const d = createModelDownload({ dir: tmp(), manifest: manifest(), fetch: s.fetch, supported: false });
    await d.start();
    expect(d.status().state).toBe('unsupported');
    expect(s.seen).toEqual([]);
    expect(modelsLabel(d.status())).toBe('Local models: not available on this Mac');
    expect(modelsSupported('darwin', 'x64')).toBe(false);
    expect(modelsSupported('darwin', 'arm64')).toBe(true);
  });

  it('says what it is doing in plain words', () => {
    const MB = 1024 * 1024;
    expect(modelsLabel({ state: 'downloading', doneBytes: 40 * MB, totalBytes: 124.5 * MB })).toBe('Local models: downloading, 40 of 124 MB');
    expect(modelsLabel({ state: 'ready' })).toBe('Local models: ready');
    expect(modelsLabel({ state: 'waiting', why: 'low_power' })).toBe('Local models: paused while Low Power Mode is on');
    expect(lowPowerFromPmset('System-wide power settings:\n lowpowermode         1\n')).toBe(true);
    expect(lowPowerFromPmset(' lowpowermode         0\n')).toBe(false);
    expect(lowPowerFromPmset('')).toBe(false);
  });
});
