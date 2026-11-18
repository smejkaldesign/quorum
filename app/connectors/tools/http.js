// One provider request with the person's token: a timeout, a plain message when the provider cannot be reached, and a
// short wait and retry when it limits requests. A wait longer than maxWait is reported instead of waited out. Errors
// never carry the token or the request headers.
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class ProviderError extends Error {
  constructor(message, { code = null, status = null } = {}) { super(message); this.code = code; this.status = status; }
}

// how long the provider asks us to wait, in ms, or null when the answer is not a rate limit. Slack and Notion answer
// 429 with Retry-After; GitHub answers 403 or 429 with x-ratelimit-remaining 0 and the reset time
export function rateLimitWait(r, now = Date.now()) {
  const h = (k) => r.headers?.get?.(k) ?? null;
  const exhausted = h('x-ratelimit-remaining') === '0';
  if (r.status !== 429 && !(r.status === 403 && exhausted)) return null;
  const after = h('retry-after');
  if (after !== null && Number.isFinite(Number(after))) return Math.max(0, Number(after)) * 1000;
  const reset = Number(h('x-ratelimit-reset'));
  if (exhausted && Number.isFinite(reset) && reset > 0) return Math.max(0, reset * 1000 - now);
  return 1000;
}

export async function request(name, url, init, { fetchImpl = fetch, wait = sleep, retries = 2, maxWait = 15000, timeout = 20000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let r;
    try { r = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeout) }); }
    catch { throw new ProviderError(`${name} could not be reached. Check the connection and try again.`, { code: 'network' }); }
    const ms = rateLimitWait(r);
    if (ms === null) return r;
    if (attempt >= retries || ms > maxWait) {
      throw new ProviderError(`${name} is limiting requests right now. Try again in about ${Math.max(1, Math.ceil(ms / 1000))} seconds.`, { code: 'rate_limited', status: r.status });
    }
    await wait(ms);
  }
}

export async function readJson(r) { try { return await r.json(); } catch { return null; } }
