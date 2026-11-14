// POST /v1/kb-sync/attach (Cloud edition, a signed-in KB admin): attach a remote folder or file to a KB folder for
// background sync, and hand the relay the admin's refresh token for it. This is the one time the token travels: the app
// sends it here over TLS, the relay refreshes it once with the provider to prove it works (keeping the rotated token
// when the provider rotates), and kb_sync_attach stores it in Vault. The answer is the attachment as admins see it; the
// token is never returned, and the log carries the provider, the kind and the outcome only.
//
// Body: { kb_id, folder_id?, provider: 'google-drive' | 'github', remote: { id, kind: 'folder' | 'file', name, url?,
// branch?, path? }, refresh_token?, client?: 'quorum' | 'workspace', shared_with_mac?, account? }. With no
// refresh_token the caller's live grant for the provider is used.
import { bearer, requirePlan, RelayError, verifyToken } from '../lib/auth.js';
import { clientAddress, createLimiter } from '../platform.js';
import { readJson } from '../summary.js';
import { clientFor, refreshAccess } from './tokens.js';

const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
const str = (v, max) => { const s = String(v ?? '').trim(); if (s.length > max) throw new RelayError('bad_request', 'The request has a value that is too long.', 400); return s; };
// the database refusals are plain sentences written for the page; anything else is a server fault
const plainDb = (error) => (/^[A-Z][^\n]{3,200}$/.test(String(error?.message ?? '')) && error?.code === 'P0001' ? error.message : null);

export function cleanAttach(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new RelayError('bad_request', 'The body must be a JSON object.', 400);
  const provider = str(raw.provider, 40).toLowerCase();
  if (!['google-drive', 'github'].includes(provider)) throw new RelayError('bad_request', 'That connector cannot sync folders yet.', 400);
  const r = raw.remote && typeof raw.remote === 'object' ? raw.remote : {};
  const kind = str(r.kind, 10);
  if (!['folder', 'file'].includes(kind)) throw new RelayError('bad_request', 'Pick a folder or a file.', 400);
  const remote = { id: str(r.id, 300), kind, name: str(r.name, 200), url: str(r.url, 2000) || null, branch: str(r.branch, 200) || null, path: str(r.path, 500) || null };
  if (!remote.id) throw new RelayError('bad_request', 'Pick what to sync.', 400);
  const client = str(raw.client || 'quorum', 20);
  if (!['quorum', 'workspace'].includes(client)) throw new RelayError('bad_request', 'Unknown OAuth client.', 400);
  return {
    kbId: str(raw.kb_id, 40), folderId: str(raw.folder_id, 40) || null, provider, remote, client,
    refreshToken: str(raw.refresh_token, 4096) || null, sharedWithMac: raw.shared_with_mac === true, account: str(raw.account, 320) || null,
  };
}

const limiter = createLimiter({ max: 60, windowMs: 10 * 60 * 1000 });

export async function handleKbSyncAttach(req, res, { clients, config, log = () => {}, fetchImpl = fetch, worker = null, limit = limiter }) {
  try {
    if (req.method !== 'POST') throw new RelayError('bad_request', 'POST only.', 405);
    if (!limit.allow(clientAddress(req))) throw new RelayError('rate_limit', 'Too many requests from this connection. Try again in a few minutes.', 429);
    const user = await verifyToken(clients.anon, bearer(req.headers.authorization));
    const b = cleanAttach(await readJson(req, 16 * 1024));
    const { data: kb, error: kbErr } = await clients.db.from('knowledge_bases').select('id, workspace_id').eq('id', b.kbId).maybeSingle();
    if (kbErr) throw new RelayError('server', 'The knowledge base could not be read.', 500);
    if (!kb) throw new RelayError('bad_request', 'That knowledge base no longer exists.', 404);
    await requirePlan(clients.db, kb.workspace_id);

    let token = b.refreshToken;
    if (token) {
      // prove the token works before it is stored, with the client that issued it
      let client = clientFor(config, { provider: b.provider, client: 'quorum' });
      if (b.client === 'workspace') {
        const { data, error } = await clients.db.rpc('relay_workspace_oauth_client', { workspace_id: kb.workspace_id, provider: b.provider });
        const row = Array.isArray(data) ? data[0] : data;
        if (error || !row?.client_id) throw new RelayError('connector', 'The workspace has no OAuth client for this connector.', 400);
        client = { clientId: row.client_id, clientSecret: row.client_secret };
      }
      try {
        const t = await refreshAccess({ provider: b.provider, client, refreshToken: token, fetchImpl });
        if (t.refreshToken) token = t.refreshToken;
      } catch (err) {
        log('kb_sync_attach_refused', { provider: b.provider, code: err.code ?? 'server' });
        throw new RelayError('connector', err.code === 'config' ? err.message : 'The provider did not accept the sign-in. Connect the account again and retry.', err.code === 'config' ? 503 : 400);
      }
    }
    const options = b.provider === 'github' ? { branch: b.remote.branch, path: b.remote.path } : {};
    const { data, error } = await clients.db.rpc('kb_sync_attach', {
      uid: user.userId, kb_id: b.kbId, folder_id: b.folderId, provider: b.provider, remote_id: b.remote.id, remote_kind: b.remote.kind,
      options, name: b.remote.name || b.remote.id, url: b.remote.url, token, client: b.client, shared_with_mac: b.sharedWithMac, account: b.account,
    });
    if (error) {
      const msg = plainDb(error);
      log('kb_sync_attach_failed', { provider: b.provider, kind: b.remote.kind, refused: !!msg });
      throw msg ? new RelayError('forbidden', msg, 400) : new RelayError('server', 'The folder could not be attached. Try again.', 500);
    }
    log('kb_sync_attach', { provider: b.provider, kind: b.remote.kind, token: !!token });
    worker?.poke();
    json(res, 200, { attachment: data });
  } catch (err) {
    const status = err instanceof RelayError ? err.status : 500;
    if (!(err instanceof RelayError)) log('kb_sync_attach_error', { code: 'server' });
    json(res, status, { error: err instanceof RelayError ? err.message : 'Syncing is unavailable right now.', code: err.code ?? 'server' });
  }
}
