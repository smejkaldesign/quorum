// The fetch the model download uses in main: Electron's net.request, so the macOS proxy and PAC settings apply. Electron's
// net.fetch hides redirects (an empty url on the response) and fails with redirect: 'manual', so this follows each
// redirect itself, and only to a host allowedHost() accepts. Answers what decide/download.js reads of a Response: ok,
// status, url (where the last redirect led) and body (async iterable, with cancel()).
import { allowedHost, failure } from './download.js';

export const MAX_REDIRECTS = 5;

export const netFetch = (net) => (url, { headers = {}, signal = null } = {}) => new Promise((resolve, reject) => {
  let at = url;
  let hops = 0;
  const req = net.request({ url, redirect: 'manual' });
  for (const [k, v] of Object.entries(headers)) req.setHeader(k, v);
  const stop = (e) => { req.abort(); reject(e); };
  signal?.addEventListener('abort', () => req.abort(), { once: true });
  req.on('redirect', (_status, _method, to) => {
    const next = new URL(to, at).href;
    if (!allowedHost(next)) return stop(failure('host_refused', `redirected to ${new URL(next).hostname}`));
    if (++hops > MAX_REDIRECTS) return stop(failure('host_refused', 'too many redirects'));
    at = next;
    req.followRedirect();
  });
  req.on('response', (res) => {
    res.cancel = async () => { req.abort(); res.destroy?.(); };
    resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, url: at, body: res });
  });
  req.on('error', reject);
  req.end();
});
