// Provider calls for the sync worker: a timeout on every call, and a rate limit answered by waiting (Retry-After, or
// 1, 2, 4 seconds) up to a few times before the run gives up and is tried again later. Tokens go in the request only;
// errors carry a sentence and a code, never a header or a body.

export class SyncError extends Error {
  // code: auth (the grant is refused), limited (rate limited after retries), gone (the item is gone upstream),
  // network, provider (any other refusal)
  constructor(message, code, { retryAfterMs = null, status = null } = {}) { super(message); this.code = code; this.retryAfterMs = retryAfterMs; this.status = status; }
}

const sleepFor = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_WAIT_MS = 30000;

// how long the provider asks to wait: Retry-After in seconds or as a date, a rate limit reset time, else 1, 2, 4 seconds
export function waitFor(r, attempt, now = Date.now) {
  const h = r.headers?.get?.('retry-after');
  if (h) {
    const s = Number(h);
    if (Number.isFinite(s)) return Math.max(0, s * 1000);
    const at = Date.parse(h);
    if (!Number.isNaN(at)) return Math.max(0, at - now());
  }
  const reset = Number(r.headers?.get?.('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0 && r.headers?.get?.('x-ratelimit-remaining') === '0') return Math.max(0, reset * 1000 - now());
  return Math.min(1000 * 2 ** attempt, MAX_WAIT_MS);
}

// fetch with retries on a rate limit. limited(r) says whether a non-2xx answer is a rate limit (each provider marks
// its own); every other answer is returned for the caller to read
export async function call(fetchImpl, url, init, { limited, label, retries = 3, sleep = sleepFor, timeoutMs = 30000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let r;
    try { r = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) }); }
    catch { throw new SyncError(`${label} could not be reached. The sync runs again later.`, 'network'); }
    if (r.ok || !(await limited(r))) return r;
    const wait = waitFor(r, attempt);
    // a wait longer than half a minute ends the run, and the next try is scheduled after it
    if (attempt >= retries || wait > MAX_WAIT_MS) throw new SyncError(`${label} is limiting requests. The sync runs again later.`, 'limited', { retryAfterMs: Math.max(wait, 60000), status: r.status });
    await sleep(wait);
  }
}

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export async function readText(r) {
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_FILE_BYTES) throw new SyncError('The file is larger than 5 MB.', 'size');
  return buf.toString('utf8').replace(/^\uFEFF/, '');
}
