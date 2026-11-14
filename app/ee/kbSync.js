// Connector folder sync into a knowledge base (Cloud edition; docs/specs/workspace-knowledge.md, "Sources inside a KB"
// and "Where sync runs"; migration 0032; the worker is relay/kbSync/). A KB admin attaches a Google Drive folder or
// file, or a GitHub repository (or a folder in one), to a KB folder, and the relay keeps it in sync in the background,
// with no Mac open. The Mac only sets it up: it picks the item, sends the admin's refresh token to the relay once
// (POST /v1/kb-sync/attach, with the Supabase session), and shows the status the worker reports. The notes reach every
// reader through pull sync. Sync now for files picked on the Mac stays in ee/kbDrive.js.
//
// Tokens. Google Drive uses the grant the Mac already holds (Google issues one per person and client), so the relay is
// told it is shared: the relay never revokes it, and disconnecting Google Drive in Settings, Connections ends the
// relay's copy too. GitHub gets a sign-in of its own for the relay: the GitHub App rotates refresh tokens, so the Mac
// and the relay cannot share one. That token goes to the relay and is not kept on the Mac. Settings, Connections lists
// it as "GitHub (synced folders)" while the relay holds it (kb-sync-grants), and its Disconnect ends it there: the
// relay revokes its token with GitHub and the synced folders that used it are paused or removed, as the person picks.
// Disconnecting the Mac's own GitHub connection leaves the relay's grant alone.
//
// Attach. Each attach carries an id made here (attach_id, migration 0033); the relay answers the same id with the
// attachment it already made. An attach whose answer never came (a timeout after the request was sent) is looked up in
// the KB's list by that id before it is reported as failed, and only a failure before the request left (no address,
// refused, a connect timeout) moves on to the relay's fallback address.
//
// IPC API (preload exposes each as window.quorum.<camelName>). Every handler resolves to { error } on a refusal.
//
//   kb-sync-list              (kbId)                                  -> { attachments: Attachment[] }
//   kb-sync-attach-drive      ({ kbId, folderId? })                   -> { attachment } | { canceled: true }
//   kb-sync-attach-github     ({ kbId, folderId?, url, branch? })      -> { attachment } | { canceled: true }
//   kb-sync-cancel            ()                                      -> { canceled }   ends a picker or a sign-in still waiting
//   kb-sync-pause             ({ id, paused })                        -> { attachment }
//   kb-sync-now               ({ id })                                -> { attachment }
//   kb-sync-remove            ({ id })                                -> { removed }    notes taken out of the KB
//   kb-sync-grants            ()                                      -> { grants: Grant[] }   the relay's grants for this person
//   kb-sync-grant-disconnect  ({ provider, mode: 'pause' | 'remove' }) -> { paused, removed }
//
//   Attachment  the 0032 row as admins see it: id, kb_id, folder_id, provider, remote_id, remote_kind, options, name,
//               url, status, paused_by, error, note_count, last_synced_at, next_run_at, connected, account,
//               attached_by_email, attach_id
//   Grant       { provider, account, created_at, shared_with_mac, attachments: { id, name, kb_id, kb_name, status }[] }
import { plain } from './account.js';
import { randomUUID } from 'node:crypto';
import { parseGithubUrl, resolveTree } from './githubUrl.js';
import { kbSession } from './knowledgeBases.js';
import { relayFetch as defaultRelayFetch } from '../relayUrl.js';
import { awaitPicker, cancelPicker } from '../sources/drive.js';
import { cancelLoopback } from '../sources/oauth.js';

export const DRIVE_FOLDER = 'application/vnd.google-apps.folder';
const NOT_CONNECTED = 'Connect Google Drive in Settings, Connections first.';
const NOT_AVAILABLE = 'Syncing from Google Drive is not available in this build yet.';
const missingFn = (err) => err?.code === 'PGRST202' || /could not find the function/i.test(String(err?.message));
const NO_REFRESH = 'GitHub did not issue a refresh token, so the relay could not keep this in sync. Ask the person who runs the GitHub App to turn on expiring user tokens.';

// the repository, branch and folder from an address. A /tree/ part is split into the branch and the folder against the
// repository's branches (ee/githubUrl.js, as the import does); request(url) reads GitHub with the new sign-in, so a
// private repository resolves too
export async function githubTarget(url, branch, request) {
  const g = parseGithubUrl(url, branch);
  if (g.error) return g;
  const t = await resolveTree({ owner: g.owner, repo: g.repo, tree: g.tree, branch: g.branch }, request);
  if (t.error) return { error: t.error };
  return { id: `${g.owner}/${g.repo}`, url: g.url, branch: t.branch, path: t.path, name: t.path ? `${g.owner}/${g.repo}/${t.path}` : `${g.owner}/${g.repo}` };
}

// a failure that may have come after the request reached the relay: a timeout waiting for the answer, a reset socket.
// Those are no reason to try the fallback address; the attach is looked up instead
const SENT_CODES = new Set(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE']);
export const mayHaveArrived = (err) => err?.name === 'TimeoutError' || err?.name === 'AbortError' || SENT_CODES.has(err?.code) || SENT_CODES.has(err?.cause?.code);
const NOT_CONFIRMED = 'The relay did not confirm the attach. If it does not show in the list in a minute, try again.';

export function createKbSync({ account, accounts, signIn, cancelSignIn = cancelLoopback, picker = null, pick = awaitPicker, cancelPick = cancelPicker, open = async () => {}, relayFetch = null, fetch: get = globalThis.fetch, newId = () => randomUUID(), timeoutMs = 30000, log = () => {} }) {
  const relay = relayFetch ?? ((route, init) => defaultRelayFetch(route, init, { source: () => account.envStatus?.().config ?? 'production', fetchImpl: get }));
  const { ready, ws, rpc, findKb } = kbSession({ account, log, tag: 'kb-sync' });
  const driveAccount = () => accounts.list().find((a) => a.id === 'google-drive') ?? null;

  const adminKb = async (kbId, folderId) => {
    if (!kbId || typeof kbId !== 'string') return { error: 'Pick the knowledge base first.' };
    const kb = await findKb(kbId);
    if (!kb) return { error: 'That knowledge base no longer exists.' };
    if (kb.role !== 'admin') return { error: 'Only the knowledge base\'s admins can sync folders into it.' };
    if (folderId && !(kb.folders ?? []).some((f) => f.id === folderId)) return { error: 'That folder is not in this knowledge base.' };
    return { kb };
  };

  // the attach call: the session token in the header, the refresh token and the attach id in the body. The relay's
  // refusals are sentences for the page. A failure that may have come after the request arrived is not tried at the
  // fallback address (relayFetch moves on only when an address could not be reached); the KB's list is read for the
  // attach id instead
  const attach = async (body) => {
    const { data: { session } = {} } = await account.client().auth.getSession();
    if (!session?.access_token) throw Object.assign(new Error('You are signed out. Sign in again.'), { code: 'SYNC' });
    const attachId = newId();
    let res;
    try {
      res = await relay('/v1/kb-sync/attach', {
        method: 'POST', headers: { authorization: `Bearer ${session.access_token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, attach_id: attachId }), signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (!mayHaveArrived(err)) throw Object.assign(new Error('Quorum\'s relay could not be reached. Check the connection and try again.'), { code: 'SYNC' });
      log('kb-sync', 'attach not confirmed; reading the list');
      const list = await rpc('kb_attachments_list', { kb_id: body.kb_id }).catch(() => []);
      const made = (list ?? []).find((x) => x.attach_id === attachId);
      if (made) return { attachment: made };
      throw Object.assign(new Error(NOT_CONFIRMED), { code: 'SYNC' });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data?.error || 'The folder could not be attached. Try again.'), { code: 'SYNC' });
    return { attachment: data.attachment ?? null };
  };

  const guarded = (fallback, fn) => async (req = {}) => {
    const no = ready(); if (no) return no;
    try { return await fn(req ?? {}); } catch (err) {
      log('kb-sync', err?.message ?? err);
      return { error: err?.code === 'SYNC' ? err.message : plain(err, fallback) };
    }
  };

  const handlers = {
    'kb-sync-list': guarded('The synced folders could not be read.', async (kbId) => {
      if (!kbId || typeof kbId !== 'string') return { error: 'Pick the knowledge base first.' };
      return { attachments: (await rpc('kb_attachments_list', { kb_id: kbId })) ?? [] };
    }),
    'kb-sync-attach-drive': guarded('The Google Drive item could not be attached.', async (req) => {
      const a = await adminKb(req.kbId, req.folderId); if (a.error) return a;
      const d = driveAccount();
      if (!d?.connected) return { error: NOT_CONNECTED };
      if (!picker?.apiKey || !picker?.appId) return { error: NOT_AVAILABLE };
      const accessToken = await accounts.accessToken('google-drive');
      if (!accessToken) return { error: NOT_CONNECTED };
      const picked = await pick({ apiKey: picker.apiKey, appId: picker.appId, accessToken, open, folders: true });
      const item = picked?.files?.[0];
      if (picked?.canceled || !item) return { canceled: true };
      const refreshToken = await accounts.refreshToken('google-drive');
      if (!refreshToken) return { error: NOT_CONNECTED };
      const folder = item.mimeType === DRIVE_FOLDER;
      return attach({
        kb_id: a.kb.id, folder_id: req.folderId ?? null, provider: 'google-drive', refresh_token: refreshToken, shared_with_mac: true, account: d.account ?? null,
        remote: { id: item.id, kind: folder ? 'folder' : 'file', name: item.name || 'Untitled', url: folder ? `https://drive.google.com/drive/folders/${item.id}` : `https://drive.google.com/open?id=${item.id}` },
      });
    }),
    'kb-sync-attach-github': guarded('The repository could not be attached.', async (req) => {
      const g = parseGithubUrl(req.url, req.branch);
      if (g.error) return g;
      const a = await adminKb(req.kbId, req.folderId); if (a.error) return a;
      // a sign-in of its own, so the relay holds a grant the Mac never uses; Cancel (or closing the panel) ends it
      let tokens;
      try { tokens = await signIn('github'); } catch (err) { if (err?.code === 'canceled') return { canceled: true }; throw Object.assign(new Error(err?.message ?? 'The GitHub sign-in did not finish.'), { code: 'SYNC' }); }
      if (!tokens?.refreshToken) return { error: NO_REFRESH };
      const t = await githubTarget(req.url, req.branch, (u) => get(u, { headers: { authorization: `Bearer ${tokens.accessToken}`, accept: 'application/vnd.github+json', 'user-agent': 'Quorum' }, signal: AbortSignal.timeout(20000) }));
      if (t.error) return t;
      return attach({
        kb_id: a.kb.id, folder_id: req.folderId ?? null, provider: 'github', refresh_token: tokens.refreshToken, shared_with_mac: false, account: tokens.account ?? null,
        remote: { id: t.id, kind: 'folder', name: t.name, url: t.url, branch: t.branch, path: t.path },
      });
    }),
    'kb-sync-cancel': async () => { const picker = cancelPick(); const signin = cancelSignIn(); return { canceled: picker || signin }; },
    'kb-sync-pause': guarded('The sync could not be changed.', async (req) => ({ attachment: await rpc('kb_attachment_pause', { id: req.id, paused: req.paused !== false }) })),
    'kb-sync-now': guarded('The sync could not be started.', async (req) => ({ attachment: await rpc('kb_attachment_sync_now', { id: req.id }) })),
    'kb-sync-remove': guarded('The synced folder could not be removed.', async (req) => ({ removed: (await rpc('kb_attachment_remove', { id: req.id })) ?? 0 })),
    // the relay's grants for this person; a database without 0033 has none to show
    'kb-sync-grants': guarded('The synced-folder connections could not be read.', async () => {
      try { return { grants: (await rpc('kb_sync_my_grants', { workspace_id: ws() })) ?? [] }; } catch (err) { if (missingFn(err)) return { grants: [] }; throw err; }
    }),
    'kb-sync-grant-disconnect': guarded('The connection could not be disconnected.', async (req) => {
      if (!['google-drive', 'github'].includes(req.provider)) return { error: 'That connection is not one the relay holds.' };
      if (!['pause', 'remove'].includes(req.mode)) return { error: 'Pick whether to pause or remove the synced folders.' };
      return (await rpc('kb_sync_grant_disconnect', { workspace_id: ws(), provider: req.provider, mode: req.mode })) ?? { paused: 0, removed: 0 };
    }),
  };

  // Disconnect of Google Drive in Settings: the Mac revokes the grant the relay shares, so the relay's copy ends too.
  // Best effort; a signed-out app has no grant to end. GitHub's relay grant is its own and has its own Disconnect
  async function disconnected(provider) {
    if (provider !== 'google-drive' || ready()) return 0;
    try { return (await rpc('kb_sync_disconnect', { workspace_id: ws(), provider })) ?? 0; } catch (err) { log('kb-sync', 'grant not ended', err?.message ?? err); return 0; }
  }

  return { handlers, disconnected };
}

export function registerKbSync({ ipcMain, ...deps }) {
  const s = createKbSync(deps);
  for (const [name, fn] of Object.entries(s.handlers)) ipcMain.handle(name, (_e, ...a) => fn(...a));
  return s;
}
