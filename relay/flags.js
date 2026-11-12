// Feature flags for every install (GET /v1/flags): the switch per key from public_flags() (migration 0021), read with
// the anon key and held in memory for a minute so a fleet of installs costs the project one query a minute. Flags
// are not secret, so any origin may read them and no session is needed.
import { json } from './platform.js';

export const FLAGS_TTL_MS = 60 * 1000;
const OPEN = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600', 'cache-control': 'public, max-age=60' };

// rows from the function into { key: enabled }; anything malformed is skipped
export const shapeFlags = (rows) => Object.fromEntries((Array.isArray(rows) ? rows : []).filter((r) => r && typeof r.key === 'string').map((r) => [r.key, r.enabled === true]));

export function createFlagsCache({ anon, now = Date.now, ttl = FLAGS_TTL_MS, log = () => {} } = {}) {
  let cached = null;
  let at = 0;
  let pending = null;
  async function load() {
    const { data, error } = await anon.rpc('public_flags');
    if (error) throw new Error(error.message || 'public_flags failed');
    cached = shapeFlags(data);
    at = now();
    return cached;
  }
  return {
    async get() {
      if (cached && now() - at < ttl) return cached;
      if (!pending) pending = load().finally(() => { pending = null; });
      try { return await pending; } catch (err) {
        log('flags_failed', { message: err?.message });
        // a stale answer beats none; a first failure answers the empty set so installs fall back to their defaults
        return cached ?? {};
      }
    },
    reset() { cached = null; at = 0; },
  };
}

export function flagsRoute({ clients, log = () => {}, now = Date.now, ttl = FLAGS_TTL_MS }) {
  const cache = createFlagsCache({ anon: clients.anon, now, ttl, log });
  return async function handleFlags(req, res) {
    if (req.method === 'OPTIONS') { res.writeHead(204, OPEN); return res.end(); }
    if (req.method !== 'GET') return json(res, 405, { error: 'GET only.' }, OPEN);
    const flags = await cache.get();
    json(res, 200, { flags }, OPEN);
  };
}
