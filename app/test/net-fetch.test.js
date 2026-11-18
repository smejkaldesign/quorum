// netFetch (decide/netFetch.js): the fetch the model download uses in main, over Electron's net.request so the macOS
// proxy and PAC settings apply. Each redirect is checked against the allowed hosts before it is followed. A fake net
// module stands in for Electron's.
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { netFetch } from '../decide/netFetch.js';

// a fake net.request: hops lists the redirect targets in order, then the response comes with body
function fakeNet({ hops = [], status = 200, body = 'ok' } = {}) {
  const made = [];
  const net = {
    request(opts) {
      const req = new EventEmitter();
      const r = { opts, headers: {}, followed: [], aborted: false };
      made.push(r);
      req.setHeader = (k, v) => { r.headers[k] = v; };
      req.followRedirect = () => { r.followed.push(hops[r.followed.length]); next(); };
      req.abort = () => { r.aborted = true; };
      const next = () => setImmediate(() => {
        if (r.followed.length < hops.length) return req.emit('redirect', 302, 'GET', hops[r.followed.length], {});
        const res = Readable.from([Buffer.from(body)]);
        res.statusCode = status;
        res.headers = { 'content-length': String(body.length) };
        req.emit('response', res);
      });
      req.end = next;
      return req;
    },
  };
  return { net, made };
}
const text = async (res) => { let s = ''; for await (const c of res.body) s += c; return s; };

describe('netFetch', () => {
  it('follows redirects to Hugging Face hosts and reports where it ended', async () => {
    const { net, made } = fakeNet({ hops: ['https://cdn-lfs-us-1.hf.co/x?sig=1'], body: 'model' });
    const res = await netFetch(net)('https://huggingface.co/org/m/resolve/r/f.onnx', { headers: { Range: 'bytes=5-', 'User-Agent': 'Quorum/1.0.0' } });
    expect(res).toMatchObject({ ok: true, status: 200, url: 'https://cdn-lfs-us-1.hf.co/x?sig=1' });
    expect(await text(res)).toBe('model');
    expect(made[0].opts).toMatchObject({ url: 'https://huggingface.co/org/m/resolve/r/f.onnx', redirect: 'manual' });
    expect(made[0].headers).toEqual({ Range: 'bytes=5-', 'User-Agent': 'Quorum/1.0.0' });
  });

  it('refuses a redirect to any other host or to http without following it', async () => {
    for (const to of ['https://evil.example/x', 'http://cdn-lfs.hf.co/x', 'https://hf.co.evil.example/x']) {
      const { net, made } = fakeNet({ hops: [to] });
      await expect(netFetch(net)('https://huggingface.co/org/m/resolve/r/f.onnx')).rejects.toMatchObject({ code: 'host_refused' });
      expect(made[0].followed).toEqual([]);
      expect(made[0].aborted).toBe(true);
    }
  });

  it('aborts the request when the signal fires', async () => {
    const { net, made } = fakeNet({ body: 'x'.repeat(10) });
    const ctl = new AbortController();
    const res = await netFetch(net)('https://huggingface.co/a', { signal: ctl.signal });
    ctl.abort();
    expect(made[0].aborted).toBe(true);
    await res.body.cancel();
  });
});
