// The background download of the decision layer's models (decide/download.js): files from pinned revisions over HTTPS,
// each SHA-256 checked before it is kept, a partial file resumed with a Range request, retries with backoff, a pause
// while Low Power Mode is on, and status in plain words. A fake server stands in for the model host.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
function server({ ignoreRange = false, fail = 0, corrupt = 0 } = {}) {
  const seen = [];
  const f = async (url, init = {}) => {
    const range = init.headers?.Range ?? null;
    seen.push({ url, range });
    if (fail > 0) { fail--; return new Response('busy', { status: 503 }); }
    let body = BODIES[url];
    if (!body) return new Response('missing', { status: 404 });
    if (corrupt > 0) { corrupt--; body = Buffer.from(body); body[0] ^= 1; }
    const from = !ignoreRange && range ? Number(range.match(/bytes=(\d+)-/)[1]) : 0;
    return new Response(body.subarray(from), { status: from ? 206 : 200 });
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

  it('keeps files already on disk with the right hash and downloads nothing', async () => {
    const dir = tmp();
    mkdirSync(path.join(dir, 'embed'), { recursive: true }); mkdirSync(path.join(dir, 'nli'), { recursive: true });
    writeFileSync(path.join(dir, 'embed/m.onnx'), A); writeFileSync(path.join(dir, 'nli/t.json'), B);
    const s = server();
    const { d } = await run({ dir, manifest: manifest(), fetch: s.fetch });
    expect(d.status().state).toBe('ready');
    expect(s.seen).toEqual([]);
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

  it('starts over when the server ignores the Range request', async () => {
    const dir = tmp();
    mkdirSync(path.join(dir, 'embed'), { recursive: true });
    writeFileSync(path.join(dir, 'embed/m.onnx.part'), A.subarray(0, 2000));
    const { d } = await run({ dir, manifest: manifest(), fetch: server({ ignoreRange: true }).fetch });
    expect(d.status().state).toBe('ready');
    expect(readFileSync(path.join(dir, 'embed/m.onnx'))).toEqual(A);
  });

  it('retries with growing waits after errors and a hash mismatch, and never keeps a file that fails its hash', async () => {
    const dir = tmp();
    const { d, sleeps } = await run({ dir, manifest: manifest(), fetch: server({ fail: 2, corrupt: 1 }).fetch, backoffMs: 1000 });
    expect(d.status().state).toBe('ready');
    expect(sleeps.slice(0, 3)).toEqual([1000, 2000, 4000]);
    expect(readFileSync(path.join(dir, 'embed/m.onnx'))).toEqual(A);
  });

  it('fails without keeping a file when every attempt fails its hash', async () => {
    const dir = tmp();
    const { d } = await run({ dir, manifest: manifest(), fetch: server({ corrupt: 99 }).fetch, retries: 3 });
    expect(d.status()).toMatchObject({ state: 'failed' });
    expect(existsSync(path.join(dir, 'embed/m.onnx'))).toBe(false);
    expect(modelsLabel(d.status())).toBe('Local models: download failed. Quorum tries again later; until then every check goes to Claude.');
  });

  it('fails before any request when a file has no hash pinned', async () => {
    const s = server();
    const { d } = await run({ dir: tmp(), manifest: manifest({ 'x.json': { sha256: '', size: 1 } }), fetch: s.fetch });
    expect(d.status()).toMatchObject({ state: 'failed', why: 'no SHA-256 pinned for embed/x.json' });
    expect(s.seen).toEqual([]);
  });

  it('waits while Low Power Mode is on and downloads once it is off', async () => {
    const answers = [{ ok: false, why: 'Low Power Mode is on' }, { ok: false, why: 'Low Power Mode is on' }];
    const states = [];
    const s = server();
    const { d, sleeps } = await run({ dir: tmp(), manifest: manifest(), fetch: s.fetch, waitMs: 60000, conditions: async () => answers.shift() ?? { ok: true }, onChange: (st) => states.push(st.state) });
    expect(states).toContain('waiting');
    expect(sleeps.filter((ms) => ms === 60000)).toHaveLength(2);
    expect(d.status().state).toBe('ready');
  });

  it('downloads nothing while the decision layer is off', async () => {
    const s = server();
    const d = createModelDownload({ dir: tmp(), manifest: manifest(), fetch: s.fetch, supported: true, enabled: false });
    await d.start();
    expect(d.status().state).toBe('off');
    expect(s.seen).toEqual([]);
    // nothing calls the decider until the contradiction agent is wired to it, so main must not download yet
    expect(DECIDER_ON).toBe(false);
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
    expect(modelsLabel({ state: 'waiting', why: 'Low Power Mode is on' })).toBe('Local models: paused while Low Power Mode is on');
    expect(lowPowerFromPmset('System-wide power settings:\n lowpowermode         1\n')).toBe(true);
    expect(lowPowerFromPmset(' lowpowermode         0\n')).toBe(false);
    expect(lowPowerFromPmset('')).toBe(false);
  });
});
