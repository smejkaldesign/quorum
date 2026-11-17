// The background download of the decision layer's models. The installer leaves them out; main starts this after launch
// and it fetches each file in decide/models.json from its pinned revision over HTTPS into Quorum's data folder.
//   - every file has a pinned SHA-256; a file with none stops the download before any request
//   - a file is kept only when its SHA-256 matches; a complete download that does not match is deleted, and that file
//     stays failed until the next launch, so a bad mirror never costs one download after another
//   - after a file verifies it writes its size and modified time to .verified.json, so a later launch trusts an
//     unchanged file without reading 124 MB again in main (the engine still hashes before it loads, decide/models.js)
//   - a partial file (.part) resumes with a Range request; a server that ignores the range sends the whole file again
//   - failed attempts wait 5 s, 10 s, 20 s and so on up to 5 minutes; after the last one it tries again an hour later
//   - while conditions() says no (Low Power Mode is on), it waits and checks again every 5 minutes, also mid-file
// All of it is asynchronous file and network work, so the app never waits on it. Until every file is on disk and
// verified, T1 stays off and every pair goes to Claude (decide/index.js). macOS gives Node and Electron no way to tell a
// metered or Low Data connection, so the download does not check for one.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { MANIFEST, hashFile } from './models.js';

const MB = 1024 * 1024;
// an error with a code for the status line; the message, which can name a path, stays in the log
export const failure = (code, message) => Object.assign(new Error(message), { code });
// where a model file may come from after redirects: Hugging Face and its CDN hosts, over HTTPS only
export const allowedHost = (url) => { try { const u = new URL(url); return u.protocol === 'https:' && /(^|\.)(huggingface\.co|hf\.co)$/.test(u.hostname); } catch { return false; } };
// onnxruntime-node ships a macOS binary for Apple silicon only
export const modelsSupported = (platform = process.platform, arch = process.arch) => platform === 'darwin' && arch === 'arm64';
export const fileUrl = (m, file) => `https://huggingface.co/${m.repo}/resolve/${m.revision}/${file}`;
export const lowPowerFromPmset = (out) => /^\s*lowpowermode\s+1\s*$/m.test(String(out ?? ''));
// the conditions on a Mac: no download while Low Power Mode is on (pmset -g reports it)
export const macConditions = () => new Promise((resolve) => execFile('/usr/bin/pmset', ['-g'], { timeout: 5000 }, (err, out) => resolve(!err && lowPowerFromPmset(out) ? { ok: false, why: 'Low Power Mode is on' } : { ok: true })));

// the status line Settings > Memory shows
export function modelsLabel(s) {
  switch (s?.state) {
    case 'off': return 'Local models: off';
    case 'unsupported': return 'Local models: not available on this Mac';
    case 'checking': return 'Local models: checking the downloaded files';
    case 'downloading': return `Local models: downloading, ${Math.floor((s.doneBytes ?? 0) / MB)} of ${Math.floor((s.totalBytes ?? 0) / MB)} MB`;
    case 'waiting': return `Local models: paused while ${s.why ?? 'the Mac saves power'}`;
    case 'ready': return 'Local models: ready';
    case 'failed': return 'Local models: download failed. Quorum tries again later; until then every check goes to Claude.';
    default: return 'Local models: not downloaded yet';
  }
}

// enabled: decide/index.js DECIDER_ON; while it is false start() downloads nothing
export function createModelDownload({ dir, manifest = MANIFEST, fetch = globalThis.fetch, supported = modelsSupported(), enabled = true, conditions = async () => ({ ok: true }),
  retries = 6, backoffMs = 5000, maxBackoffMs = 5 * 60 * 1000, waitMs = 5 * 60 * 1000, retryLaterMs = 60 * 60 * 1000, checkEvery = 8 * MB,
  hash = hashFile, sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); }), setTimer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; }, clearTimer = clearTimeout,
  onChange = () => {}, log = () => {} }) {
  const files = Object.entries(manifest).flatMap(([id, m]) => Object.entries(m.files).map(([file, f]) => ({ id, file, url: fileUrl(m, file), sha256: f?.sha256 ?? '', size: f?.size ?? 0, dest: path.join(dir, id, file) })));
  const totalBytes = files.reduce((a, f) => a + f.size, 0);
  let st = { state: !enabled ? 'off' : supported ? 'idle' : 'unsupported', doneBytes: 0, totalBytes, why: null };
  let running = null;
  // stop() is final for this download: no retry, no later start
  let stopped = false;
  let later = null;
  const stampFile = path.join(dir, '.verified.json');
  const stampOf = (f) => { const st = statSync(f.dest); return `${st.size}:${st.mtimeMs}:${f.sha256}`; };
  const stamps = () => { try { return JSON.parse(readFileSync(stampFile, 'utf8')); } catch { return {}; } };
  const stamp = (f) => { const all = stamps(); all[`${f.id}/${f.file}`] = stampOf(f); writeFileSync(stampFile, JSON.stringify(all)); };
  // files whose complete download failed its hash in this run of the app
  const blocked = new Set();
  let emitted = 0;
  const status = () => ({ ...st, label: modelsLabel(st) });
  // progress goes out at most twice a second; a change of state goes out at once
  const set = (patch, now = true) => { st = { ...st, ...patch }; const t = Date.now(); if (now || t - emitted > 500) { emitted = t; onChange(status()); } };
  const check = async () => { try { return (await conditions()) ?? { ok: true }; } catch { return { ok: true }; } };
  // waits while the conditions say no. Answers false when the download was stopped
  const clear = async () => {
    for (;;) {
      if (stopped) return false;
      const c = await check();
      if (c.ok !== false) return true;
      set({ state: 'waiting', why: c.why ?? null });
      await sleep(waitMs);
    }
  };

  // one file into place. Answers false when it paused (the .part stays for the next attempt)
  async function one(f, base) {
    if (!f.url.startsWith('https://')) throw new Error('model files download over HTTPS only');
    const part = `${f.dest}.part`;
    mkdirSync(path.dirname(f.dest), { recursive: true });
    let have = existsSync(part) ? statSync(part).size : 0;
    if (have >= f.size) { await rm(part, { force: true }); have = 0; }
    let h = createHash('sha256');
    if (have) await new Promise((resolve, reject) => createReadStream(part).on('data', (c) => h.update(c)).on('end', resolve).on('error', reject));
    const ctl = new AbortController();
    const res = await fetch(f.url, { headers: have ? { Range: `bytes=${have}-` } : {}, signal: ctl.signal, redirect: 'follow' });
    if (!allowedHost(res.url || f.url)) { await res.body?.cancel().catch(() => {}); throw failure('host_refused', `${f.id}/${f.file}: redirected to ${res.url}`); }
    if (!res.ok) throw new Error(`${f.id}/${f.file}: the server answered ${res.status}`);
    if (have && res.status !== 206) { h = createHash('sha256'); have = 0; }
    const fh = await open(part, have ? 'a' : 'w');
    let got = have;
    let since = 0;
    let paused = false;
    set({ state: 'downloading', why: null, doneBytes: base + got });
    try {
      for await (const chunk of res.body) {
        const b = Buffer.from(chunk);
        got += b.length;
        if (got > f.size) throw new Error(`${f.id}/${f.file}: larger than its pinned size`);
        h.update(b);
        await fh.write(b);
        since += b.length;
        set({ doneBytes: base + got }, false);
        if (since >= checkEvery) {
          since = 0;
          if (stopped || (await check()).ok === false) { paused = true; ctl.abort(); break; }
        }
      }
    } finally { await fh.close(); }
    if (paused) return false;
    if (h.digest('hex') !== f.sha256) { await rm(part, { force: true }); throw failure('hash_mismatch', `${f.id}/${f.file}: SHA-256 does not match the pinned hash`); }
    await rename(part, f.dest);
    stamp(f);
    return true;
  }

  async function run() {
    if (!enabled || stopped) return;
    if (!supported) { set({ state: 'unsupported' }); return; }
    const unpinned = files.find((f) => !/^[0-9a-f]{64}$/.test(f.sha256));
    if (unpinned) { set({ state: 'failed', why: `no SHA-256 pinned for ${unpinned.id}/${unpinned.file}` }); return; }
    set({ state: 'checking', why: null, doneBytes: 0 });
    let done = 0;
    const todo = [];
    const known = stamps();
    for (const f of files) {
      let good = false;
      if (existsSync(f.dest)) {
        good = known[`${f.id}/${f.file}`] === stampOf(f);
        if (!good && (await hash(f.dest)) === f.sha256) { good = true; stamp(f); }
      }
      if (good) done += f.size; else todo.push(f);
    }
    set({ doneBytes: done });
    if (todo.some((f) => blocked.has(f.dest))) { set({ state: 'failed', why: 'hash_mismatch' }); return; }
    for (const f of todo) {
      let attempt = 0;
      for (;;) {
        if (!(await clear())) return;
        try {
          if (await one(f, done)) break;
        } catch (e) {
          attempt++;
          log('models', 'download failed', f.id, f.file, attempt, String(e?.message ?? e));
          if (e?.code === 'hash_mismatch') { blocked.add(f.dest); set({ state: 'failed', why: 'hash_mismatch' }); return; }
          if (attempt >= retries) {
            set({ state: 'failed', why: e?.code ?? String(e?.message ?? e) });
            later = setTimer(() => { later = null; start(); }, retryLaterMs);
            return;
          }
          await sleep(Math.min(maxBackoffMs, backoffMs * 2 ** (attempt - 1)));
        }
      }
      done += f.size;
      set({ doneBytes: done });
    }
    set({ state: 'ready', doneBytes: totalBytes, why: null });
    log('models', 'ready', dir);
  }

  function start() {
    running ??= run().catch((e) => { set({ state: 'failed', why: String(e?.message ?? e) }); }).finally(() => { running = null; });
    return running;
  }
  const stop = () => { stopped = true; if (later !== null) { clearTimer(later); later = null; } };
  return { start, stop, status };
}
