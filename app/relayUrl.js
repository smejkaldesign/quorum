// Where Quorum's relay is: the addresses the Cloud edition's speech and notes calls use (ee/relay.js) and the beta gate
// in both editions (beta.js). Outside ee/ so the Local edition can reach it without crossing the edition boundary.

export const DEFAULT_RELAY = 'wss://relay.quorum.watch';
// the relay's own Railway address: the same service, reached when the custom domain cannot be (certificate, DNS)
export const FALLBACK_RELAY = 'wss://relay-production-e257.up.railway.app';
export const LOCAL_RELAY = 'ws://127.0.0.1:8787';

// QUORUM_RELAY_URL wins; a copy on the local Supabase stack talks to a relay on this Mac; everything else to Quorum's
export function relayUrl({ env = process.env, source = 'production' } = {}) {
  const u = String(env.QUORUM_RELAY_URL ?? '').trim();
  if (u) return u.replace(/\/+$/, '');
  return source === 'local' ? LOCAL_RELAY : DEFAULT_RELAY;
}
// every address to try, in order; only a connection-level failure moves to the next one
export function relayUrls(opts = {}) {
  const first = relayUrl(opts);
  return first === DEFAULT_RELAY ? [DEFAULT_RELAY, FALLBACK_RELAY] : [first];
}
// a failure before the relay answered (DNS, TLS, refused socket), as opposed to a refusal the relay sent
export const unreachable = (err) => /could not be reached|did not answer|fetch failed|ECONNREFUSED|ENOTFOUND|certificate|CERT_|EPROTO|ETIMEDOUT/i.test(String(err?.message ?? err?.cause?.message ?? err));
// the same address for plain HTTP calls (notes, billing, the beta gate)
export const httpUrl = (url) => String(url).replace(/^ws(s?):\/\//, 'http$1://').replace(/\/+$/, '');
