// Connector folder sync into a knowledge base (Cloud edition; docs/specs/workspace-knowledge.md, "Sources inside a KB"
// and "Where sync runs"; migration 0032; the worker is relay/kbSync/). A KB admin attaches a Google Drive folder or
// file, or a GitHub repository (or a folder in one), to a KB folder, and the relay keeps it in sync in the background,
// with no Mac open. The Mac only sets it up: it picks the item, sends the admin's refresh token to the relay once
// (POST /v1/kb-sync/attach, with the Supabase session), and shows the status the worker reports. The notes reach every
// reader through pull sync. Sync now for files picked on the Mac stays in ee/kbDrive.js.
//
// Tokens. Google Drive uses the grant the Mac already holds (Google issues one per person and client), so the relay is
// told it is shared and revokes it only on Disconnect. GitHub gets a sign-in of its own for the relay: the GitHub App
// rotates refresh tokens, so the Mac and the relay cannot share one. That token goes to the relay and is not kept on the
// Mac. Disconnecting Google Drive or GitHub in Settings ends the relay's grant for it in this workspace.
//
// IPC API (preload exposes each as window.quorum.<camelName>). Every handler resolves to { error } on a refusal.
//
//   kb-sync-list          (kbId)                                  -> { attachments: Attachment[] }
//   kb-sync-attach-drive  ({ kbId, folderId? })                   -> { attachment } | { canceled: true }
//   kb-sync-attach-github ({ kbId, folderId?, url, branch? })      -> { attachment }
//   kb-sync-cancel        ()                                      -> { canceled }   ends a picker that is still waiting
//   kb-sync-pause         ({ id, paused })                        -> { attachment }
//   kb-sync-now           ({ id })                                -> { attachment }
//   kb-sync-remove        ({ id })                                -> { removed }    notes taken out of the KB
//
//   Attachment  the 0032 row as admins see it: id, kb_id, folder_id, provider, remote_id, remote_kind, options, name,
//               url, status, error, note_count, last_synced_at, next_run_at, connected, account, attached_by_email
import { plain } from './account.js';
import { parseGithubUrl } from './kbImport.js';
import { kbSession } from './knowledgeBases.js';
import { httpUrl, relayUrls, unreachable } from './relay.js';
import { awaitPicker, cancelPicker } from '../sources/drive.js';

export const DRIVE_FOLDER = 'application/vnd.google-apps.folder';
const NOT_CONNECTED = 'Connect Google Drive in Settings, Connections first.';
const NOT_AVAILABLE = 'Syncing from Google Drive is not available in this build yet.';
const NO_REFRESH = 'GitHub did not issue a refresh token, so the relay could not keep this in sync. Ask the person who runs the GitHub App to turn on expiring user tokens.';

// the repository, branch and folder from an address. A /tree/ part without a separate branch reads its first segment
// as the branch and the rest as the folder; a branch name with a slash goes in the branch field
export function githubTarget(url, branch) {
  const g = parseGithubUrl(url, branch);
  if (g.error) return g;
  let b = g.branch;
  let folder = null;
  if (g.tree && b) {
    if (g.tree !== b && !g.tree.startsWith(`${b}/`)) return { error: 'The branch does not match the branch in the address.' };
    folder = g.tree === b ? null : g.tree.slice(b.length + 1);
  } else if (g.tree) {
    const [first, ...rest] = g.tree.split('/');
    b = first;
    folder = rest.join('/') || null;
  }
  return { id: `${g.owner}/${g.repo}`, url: g.url, branch: b, path: folder, name: folder ? `${g.owner}/${g.repo}/${folder}` : `${g.owner}/${g.repo}` };
}

export function createKbSync({ account, accounts, refreshTokenOf, signIn, picker = null, pick = awaitPicker, cancelPick = cancelPicker, open = async () => {}, fetch: get = globalThis.fetch, log = () => {} }) {
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

  // the attach call: the session token in the header, the refresh token in the body, the first relay address that
  // answers. The relay's refusals are sentences for the page
  const attach = async (body) => {
    const { data: { session } = {} } = await account.client().auth.getSession();
    if (!session?.access_token) throw Object.assign(new Error('You are signed out. Sign in again.'), { code: 'SYNC' });
    const urls = relayUrls({ source: account.envStatus?.().config });
    let res = null;
    for (const url of urls) {
      try {
        res = await get(`${httpUrl(url)}/v1/kb-sync/attach`, { method: 'POST', headers: { authorization: `Bearer ${session.access_token}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
        break;
      } catch (err) {
        if (unreachable(err) && url !== urls[urls.length - 1]) continue;
        throw Object.assign(new Error('Quorum\'s relay could not be reached. Check the connection and try again.'), { code: 'SYNC' });
      }
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
      const refreshToken = await refreshTokenOf('google-drive');
      if (!refreshToken) return { error: NOT_CONNECTED };
      const folder = item.mimeType === DRIVE_FOLDER;
      return attach({
        kb_id: a.kb.id, folder_id: req.folderId ?? null, provider: 'google-drive', refresh_token: refreshToken, shared_with_mac: true, account: d.account ?? null,
        remote: { id: item.id, kind: folder ? 'folder' : 'file', name: item.name || 'Untitled', url: folder ? `https://drive.google.com/drive/folders/${item.id}` : `https://drive.google.com/open?id=${item.id}` },
      });
    }),
    'kb-sync-attach-github': guarded('The repository could not be attached.', async (req) => {
      const t = githubTarget(req.url, req.branch);
      if (t.error) return t;
      const a = await adminKb(req.kbId, req.folderId); if (a.error) return a;
      // a sign-in of its own, so the relay holds a grant the Mac never uses
      const tokens = await signIn('github');
      if (!tokens?.refreshToken) return { error: NO_REFRESH };
      return attach({
        kb_id: a.kb.id, folder_id: req.folderId ?? null, provider: 'github', refresh_token: tokens.refreshToken, shared_with_mac: false, account: tokens.account ?? null,
        remote: { id: t.id, kind: 'folder', name: t.name, url: t.url, branch: t.branch, path: t.path },
      });
    }),
    'kb-sync-cancel': async () => ({ canceled: cancelPick() }),
    'kb-sync-pause': guarded('The sync could not be changed.', async (req) => ({ attachment: await rpc('kb_attachment_pause', { id: req.id, paused: req.paused !== false }) })),
    'kb-sync-now': guarded('The sync could not be started.', async (req) => ({ attachment: await rpc('kb_attachment_sync_now', { id: req.id }) })),
    'kb-sync-remove': guarded('The synced folder could not be removed.', async (req) => ({ removed: (await rpc('kb_attachment_remove', { id: req.id })) ?? 0 })),
  };

  // Disconnect in Settings: the relay's grant for that provider in this workspace ends too. Best effort; a database
  // without 0032 or a signed-out app has no grant to end
  async function disconnected(provider) {
    if (!['google-drive', 'github'].includes(provider) || ready()) return 0;
    try { return (await rpc('kb_sync_disconnect', { workspace_id: ws(), provider })) ?? 0; } catch (err) { log('kb-sync', 'grant not ended', err?.message ?? err); return 0; }
  }

  return { handlers, disconnected };
}

export function registerKbSync({ ipcMain, ...deps }) {
  const s = createKbSync(deps);
  for (const [name, fn] of Object.entries(s.handlers)) ipcMain.handle(name, (_e, ...a) => fn(...a));
  return s;
}
