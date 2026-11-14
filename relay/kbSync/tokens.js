// Refreshing and revoking the grants the sync worker holds (migration 0032, kb_sync_grants). The refresh token comes
// from Vault through kb_sync_token and goes to the provider and nowhere else; access tokens live in memory for their
// lifetime only. Which client pair refreshes a grant: Quorum's own app (the relay's GOOGLE_CLIENT_* and GITHUB_APP_*
// settings, the same apps the Mac signs in with) or the workspace's own OAuth client from its org-mode connector.
import { OAUTH_PROVIDERS } from '../oauth.js';
import { SyncError } from './http.js';

const form = (o) => new URLSearchParams(Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''))).toString();
const NAME = { 'google-drive': 'Google Drive', github: 'GitHub' };
const CONFIG_KEY = { 'google-drive': 'google', github: 'github' };

export function clientFor(config, row) {
  if (row.client === 'workspace') return { clientId: row.client_id ?? null, clientSecret: row.client_secret ?? null };
  const c = config.oauth?.[CONFIG_KEY[row.provider]];
  return { clientId: c?.clientId ?? null, clientSecret: c?.clientSecret ?? null };
}

const GRANTS = {
  'google-drive': {
    refresh: (c, refreshToken) => ({ url: 'https://oauth2.googleapis.com/token', init: { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form({ client_id: c.clientId, client_secret: c.clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken }) } }),
    // Google revokes a grant from any of its tokens, so the refresh token is enough
    revoke: async (c, refreshToken, fetchImpl) => fetchImpl('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ token: refreshToken }), signal: AbortSignal.timeout(20000) }),
  },
  github: {
    refresh: (c, refreshToken) => OAUTH_PROVIDERS.github.token(c, { grant: 'refresh', refreshToken }),
    // GitHub deletes the grant from an access token, so the revoke refreshes once first
    revoke: async (c, refreshToken, fetchImpl) => {
      const t = await refreshAccess({ provider: 'github', client: c, refreshToken, fetchImpl });
      const { url, init } = OAUTH_PROVIDERS.github.revoke(c, t.accessToken);
      return fetchImpl(url, { ...init, signal: AbortSignal.timeout(20000) });
    },
  },
};

// a fresh access token. A refused grant (invalid_grant, a revoked app) is an auth error; the caller ends the grant.
// refreshToken in the answer is the rotated one when the provider rotates (GitHub), else null
export async function refreshAccess({ provider, client, refreshToken, fetchImpl = fetch, now = Date.now }) {
  const g = GRANTS[provider];
  if (!g) throw new SyncError('That connector cannot sync folders yet.', 'provider');
  if (!client?.clientId || !client?.clientSecret) throw new SyncError(`${NAME[provider]} is not set up on this relay.`, 'config');
  if (!refreshToken) throw new SyncError(`${NAME[provider]} needs to be attached again.`, 'auth');
  const { url, init } = g.refresh(client, refreshToken);
  let r;
  try { r = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(20000) }); }
  catch { throw new SyncError(`${NAME[provider]} could not be reached. The sync runs again later.`, 'network'); }
  const t = await r.json().catch(() => null);
  if (r.status === 429 || r.status >= 500) throw new SyncError(`${NAME[provider]} could not refresh the sign-in right now. The sync runs again later.`, 'network', { status: r.status });
  if (!r.ok || !t?.access_token || t.error) throw new SyncError(`${NAME[provider]} no longer accepts this connection. Attach it again to keep it in sync.`, 'auth', { status: r.status });
  return { accessToken: t.access_token, refreshToken: t.refresh_token && t.refresh_token !== refreshToken ? t.refresh_token : null, expiresAt: t.expires_in ? now() + Number(t.expires_in) * 1000 : now() + 3600 * 1000 };
}

// revoke with the provider. true when the provider confirmed it or had already forgotten the grant
export async function revokeGrant({ provider, client, refreshToken, fetchImpl = fetch }) {
  const g = GRANTS[provider];
  if (!g || !client?.clientId || !client?.clientSecret) return false;
  try {
    const r = await g.revoke(client, refreshToken, fetchImpl);
    return [200, 204, 400, 404].includes(r.status);
  } catch (err) {
    // a grant the provider already refuses cannot be refreshed for the revoke, and counts as revoked
    return err?.code === 'auth';
  }
}
