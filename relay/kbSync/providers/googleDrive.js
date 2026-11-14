// Google Drive for the sync worker: one attached file, or an attached folder with its subfolders. What the grant can
// read decides what syncs: with Quorum's drive.file grant that is what the admin picked; a workspace's own OAuth client
// with a broader Drive scope reads every file in the folder. Google Docs come as markdown (plain text when Drive cannot
// export markdown); markdown and text files come as they are. Change detection is Drive's modifiedTime, which the
// note keeps as kb_source_modified, the same key app/ee/kbDrive.js uses, so a file attached on the Mac and in a synced
// folder is one note.
import { call, readText, SyncError } from '../http.js';

const API = 'https://www.googleapis.com/drive/v3/files';
const FOLDER = 'application/vnd.google-apps.folder';
const GOOGLE_DOC = 'application/vnd.google-apps.document';
const TEXT_TYPES = new Set([GOOGLE_DOC, 'text/markdown', 'text/x-markdown', 'text/plain']);
const RATE_REASONS = new Set(['userRateLimitExceeded', 'rateLimitExceeded', 'dailyLimitExceeded', 'quotaExceeded', 'sharingRateLimitExceeded']);
const FIELDS = 'id,name,mimeType,modifiedTime,webViewLink,trashed,size';
export const MAX_FILES = 2000;
const MAX_DEPTH = 8;

const syncable = (m) => TEXT_TYPES.has(m?.mimeType) || /\.(md|markdown|txt)$/i.test(String(m?.name ?? ''));
const limited = async (r) => {
  if (r.status === 429) return true;
  if (r.status !== 403) return false;
  try { const b = await r.clone().json(); return RATE_REASONS.has(b?.error?.errors?.[0]?.reason ?? b?.error?.status); } catch { return false; }
};
// the reason Drive gives for a refusal (error.errors[0].reason)
const reasonOf = async (r) => { try { const b = await r.clone().json(); return b?.error?.errors?.[0]?.reason ?? null; } catch { return null; } };
// Drive's answers that mean this item is gone for this grant: not found, or no permission on this file. Any other 403
// is no proof of that, so it is a plain refusal
const GONE_REASONS = new Set(['notFound', 'insufficientFilePermissions', 'appNotAuthorizedToFile']);
const failure = async (r) => {
  if (r.status === 401) return new SyncError('Google Drive no longer accepts this connection. Attach it again to keep it in sync.', 'auth', { status: r.status });
  if (r.status === 404) return new SyncError('The item is no longer in Google Drive, or the admin who attached it lost access.', 'gone', { status: r.status });
  if (r.status === 403 && GONE_REASONS.has(await reasonOf(r))) return new SyncError('The admin who attached this cannot read it in Google Drive any more.', 'gone', { status: r.status });
  return new SyncError('Google Drive refused the request. The sync runs again later.', 'provider', { status: r.status });
};
const shape = (m, segs) => ({ remoteId: m.id, name: m.name ?? 'Untitled', segs, mimeType: m.mimeType, modified: m.modifiedTime ?? null, url: m.webViewLink ?? null, size: Number(m.size) || 0 });

export const googleDrive = {
  id: 'google-drive',
  where: 'Google Drive',
  sourceOf: (file) => `google-drive:${file.remoteId}`,
  unchanged: (note, file) => !!file.modified && note.frontmatter?.kb_source_modified === file.modified,

  // the files to sync, each with its folder segments under the attachment. complete says the listing is whole, so a
  // note whose file is not in it was removed upstream
  async list({ token, attachment, fetchImpl, sleep }) {
    const get = (url) => call(fetchImpl, url, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } }, { limited, label: 'Google Drive', sleep });
    const read = async (r) => { if (!r.ok) throw await failure(r); const b = await r.json().catch(() => null); if (!b) throw new SyncError('Google Drive sent an answer Quorum could not read.', 'provider'); return b; };
    const root = await read(await get(`${API}/${encodeURIComponent(attachment.remote_id)}?fields=${FIELDS}&supportsAllDrives=true`));
    if (root.trashed) throw new SyncError('The item is in the Google Drive trash.', 'gone');
    if (attachment.remote_kind === 'file') {
      if (!syncable(root)) throw new SyncError('Only Google Docs, markdown and text files sync.', 'provider');
      return { files: [shape(root, [])], complete: true, cursor: { modified: root.modifiedTime ?? null } };
    }
    if (root.mimeType !== FOLDER) throw new SyncError('That item is not a folder in Google Drive.', 'provider');
    const files = [];
    let complete = true;
    const queue = [{ id: root.id, segs: [] }];
    while (queue.length) {
      const { id, segs } = queue.shift();
      let pageToken = null;
      do {
        const q = encodeURIComponent(`'${id.replace(/'/g, "\\'")}' in parents and trashed = false`);
        const page = await read(await get(`${API}?q=${q}&fields=nextPageToken,files(${FIELDS})&pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`));
        for (const m of page.files ?? []) {
          if (m.mimeType === FOLDER) { if (segs.length < MAX_DEPTH) queue.push({ id: m.id, segs: [...segs, m.name ?? 'Untitled'] }); else complete = false; continue; }
          if (!syncable(m)) continue;
          if (files.length >= MAX_FILES) { complete = false; break; }
          files.push(shape(m, segs));
        }
        pageToken = files.length >= MAX_FILES ? null : page.nextPageToken ?? null;
      } while (pageToken);
    }
    return { files, complete, cursor: { listed: files.length } };
  },

  async read({ token, file, fetchImpl, sleep }) {
    const get = (url) => call(fetchImpl, url, { headers: { authorization: `Bearer ${token}`, accept: '*/*' } }, { limited, label: 'Google Drive', sleep });
    if (file.size > 5 * 1024 * 1024) throw new SyncError('The file is larger than 5 MB.', 'size');
    const id = encodeURIComponent(file.remoteId);
    if (file.mimeType === GOOGLE_DOC) {
      const md = await get(`${API}/${id}/export?mimeType=${encodeURIComponent('text/markdown')}`);
      if (md.ok) return readText(md);
      // 400 is an export format Drive does not offer for this document; anything else is the file or the token
      if (md.status !== 400) throw await failure(md);
      const txt = await get(`${API}/${id}/export?mimeType=${encodeURIComponent('text/plain')}`);
      if (!txt.ok) throw await failure(txt);
      return readText(txt);
    }
    const a = await get(`${API}/${id}?alt=media&supportsAllDrives=true`);
    if (!a.ok) throw await failure(a);
    return readText(a);
  },
};
