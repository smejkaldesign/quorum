// Feature flags for every install (GET /v1/flags): the switch per key from public_flags() (migration 0021), read with
// the anon key and held in memory for a minute so a fleet of installs costs the project one query a minute. Flags
// are not secret, so any origin may read them and no session is needed.
import { json } from './platform.js';

export const FLAGS_TTL_MS = 60 * 1000;
const OPEN = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600' };

// rows from the function into { key: enabled }; anything malformed is skipped
export const shapeFlags = (rows) => Object.fromEntries((Array.isArray(rows) ? rows : []).filter((r) => r && typeof r.key === 'string').map((r) => [r.key, r.enabled === true]));
// { key: parent } for the flags that need another one
export const shapeRequires = (rows) => Object.fromEntries((Array.isArray(rows) ? rows : []).filter((r) => r && typeof r.key === 'string' && typeof r.requires === 'string' && r.requires).map((r) => [r.key, r.requires]));

// get() answers the flags, or null when the project has never answered. A failure is remembered for one TTL, so a
// project that is down is asked at most once a minute; a stale answer is served meanwhile when there is one.
export function createFlagsCache({ anon, now = Date.now, ttl = FLAGS_TTL_MS, log = () => {} } = {}) {
  let cached = null;
  let at = 0;
  let checked = false;
  let pending = null;
  async function load() {
    try {
      const { data, error } = await anon.rpc('public_flags');
      if (error) throw new Error(error.message || 'public_flags failed');
      cached = { flags: shapeFlags(data), requires: shapeRequires(data) };
    } catch (err) {
      log('flags_failed', { message: err?.message });
    } finally {
      at = now();
      checked = true;
    }
    return cached;
  }
  return {
    async get() {
      if (checked && now() - at < ttl) return cached;
      if (!pending) pending = load().finally(() => { pending = null; });
      return pending;
    },
    reset() { cached = null; at = 0; checked = false; },
  };
}

export function flagsRoute({ clients, log = () => {}, now = Date.now, ttl = FLAGS_TTL_MS }) {
  const cache = createFlagsCache({ anon: clients.anon, now, ttl, log });
  return async function handleFlags(req, res) {
    if (req.method === 'OPTIONS') { res.writeHead(204, OPEN); return res.end(); }
    if (req.method !== 'GET') return json(res, 405, { error: 'GET only.' }, OPEN);
    const answer = await cache.get();
    // no answer yet: say so, so an install keeps its cached flags instead of reading an empty set as every flag off
    if (!answer) return json(res, 503, { error: 'The flags could not be read. Try again in a minute.' }, { ...OPEN, 'cache-control': 'no-store' });
    json(res, 200, answer, { ...OPEN, 'cache-control': 'public, max-age=60' });
  };
}
