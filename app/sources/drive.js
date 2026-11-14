// Google Drive with the drive.file scope (docs/specs/workspace-knowledge.md, "Google verification cost"). drive.file
// lets Quorum read only the files a person picks with the Google Picker, so the picker is the one way files reach
// Quorum. Two parts, both pure Node so vitest runs them against fakes:
//
// 1. The picker page. Google Picker runs only in a browser page with an http(s) origin, an API key and the person's
//    OAuth access token. This process serves that page once on the loopback (http://127.0.0.1:47833/picker/<nonce>)
//    and opens it in the person's browser. The page loads Google's Picker script, and when the person picks or cancels
//    it posts the picked file ids back to the same loopback address and the server closes. The access token goes from
//    the Keychain to that page and to Google only; no Quorum server sees it. Picking grants drive.file access to each
//    picked file for Quorum's Google client (the app id is the Google Cloud project number).
// 2. Reading a picked file: its metadata, then a Google Doc exported as markdown (plain text when the export refuses
//    markdown), or a markdown or text file downloaded as it is.
import { randomBytes } from 'node:crypto';
import http from 'node:http';

export const PICKER_PORT = 47833;
export const PICKER_ORIGIN = `http://127.0.0.1:${PICKER_PORT}`;
export const PICKER_API_KEY_ENV = 'QUORUM_GOOGLE_PICKER_API_KEY';
export const PICKER_APP_ID_ENV = 'QUORUM_GOOGLE_PICKER_APP_ID';
export const GOOGLE_DOC = 'application/vnd.google-apps.document';
const FOLDER = 'application/vnd.google-apps.folder';
// what the picker offers and what a sync reads: Google Docs, markdown and plain text
export const PICKABLE = [GOOGLE_DOC, 'text/markdown', 'text/x-markdown', 'text/plain'];
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_POST_BYTES = 256 * 1024;
const MAX_PICKS = 50;
const API = 'https://www.googleapis.com/drive/v3/files';

// the Picker's API key and app id: the shell, the repo's .env files, then the packaged package.json
// (quorumOAuth.googlePicker). The app id defaults to the project number at the front of the Google client id
export function pickerConfig({ lookup = () => null, packaged = null, clientId = null } = {}) {
  const from = packaged?.quorumOAuth?.googlePicker ?? {};
  const project = /^(\d+)-/.exec(String(clientId ?? ''))?.[1] ?? null;
  return { apiKey: lookup(PICKER_API_KEY_ENV) || from.apiKey || null, appId: lookup(PICKER_APP_ID_ENV) || from.appId || project };
}

// a value placed inside the page's script: JSON with every character that could end the script tag escaped
const inScript = (v) => JSON.stringify(v).replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

// folders: the KB folder sync mode (ee/kbSync.js), where one folder or one file is picked for the relay to keep in sync
export function pickerPage({ apiKey, appId, accessToken, nonce, folders = false }) {
  const cfg = inScript({ apiKey, appId, token: accessToken, done: `/picker/${nonce}/done`, alive: `/picker/${nonce}/alive`, mimeTypes: (folders ? [FOLDER, ...PICKABLE] : PICKABLE).join(','), max: folders ? 1 : MAX_PICKS, folders, title: folders ? 'Choose a folder or file to sync' : 'Choose files for Quorum' });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="strict-origin-when-cross-origin"><title>Choose files for Quorum</title>
<style>html,body{height:100%;margin:0}body{background:#0b0b0c;color:#f2f2f3;font:16px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text",Helvetica,Arial,sans-serif;display:grid;place-items:center;text-align:center}
main{max-width:520px;padding:24px}h1{font:400 34px/1.15 "New York",ui-serif,Georgia,serif;margin:0 0 12px}p{margin:0;color:rgba(242,242,243,.85)}
</style></head>
<body><main><h1 id="title">Opening Google Drive</h1><p id="body">Pick the Google Docs, markdown or text files to add to the knowledge base.</p></main>
<script>
const CFG = ${cfg};
// the app gives up on a page that stops answering; while this tab is open it says it is still here
const alive = setInterval(() => { fetch(CFG.alive, { method: 'POST' }).catch(() => {}); }, 20000);
const say = (t, b) => { document.getElementById('title').textContent = t; document.getElementById('body').textContent = b; };
let sent = false;
async function send(payload) {
  if (sent) return; sent = true; clearInterval(alive);
  try { await fetch(CFG.done, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }); } catch (e) { say('Quorum did not answer', 'Go back to Quorum and try again.'); return; }
  if (payload.action === 'picked') say(payload.docs.length === 1 ? 'One file sent to Quorum' : payload.docs.length + ' files sent to Quorum', 'You can close this tab and go back to Quorum.');
  else say('Nothing was picked', 'You can close this tab and go back to Quorum.');
}
function show() {
  const view = new google.picker.DocsView(google.picker.ViewId.DOCS).setMimeTypes(CFG.mimeTypes).setIncludeFolders(true).setSelectFolderEnabled(CFG.folders).setMode(google.picker.DocsViewMode.LIST);
  const builder = new google.picker.PickerBuilder()
    .setDeveloperKey(CFG.apiKey).setAppId(CFG.appId).setOAuthToken(CFG.token).setOrigin(location.origin)
    .addView(view).enableFeature(google.picker.Feature.SUPPORT_DRIVES);
  if (!CFG.folders) builder.enableFeature(google.picker.Feature.MULTISELECT_ENABLED);
  const picker = builder
    .setMaxItems(CFG.max).setTitle(CFG.title)
    .setCallback((data) => {
      const action = data[google.picker.Response.ACTION];
      if (action === google.picker.Action.PICKED) send({ action: 'picked', docs: (data[google.picker.Response.DOCUMENTS] || []).map((d) => ({ id: d[google.picker.Document.ID], name: d[google.picker.Document.NAME], mimeType: d[google.picker.Document.MIME_TYPE] })) });
      else if (action === google.picker.Action.CANCEL) send({ action: 'cancel' });
    }).build();
  picker.setVisible(true);
}
window.onPickerApi = () => gapi.load('picker', { callback: show, onerror: () => say('Google Drive did not load', 'Check the connection, then go back to Quorum and try again.') });
</script>
<script async defer src="https://apis.google.com/js/api.js" onload="onPickerApi()" onerror="say('Google Drive did not load', 'Check the connection, then go back to Quorum and try again.')"></script>
</body></html>`;
}

// the picked files as the app keeps them: an id Drive would accept, a name, and the type the picker reported
const cleanPicks = (docs) => (Array.isArray(docs) ? docs : []).slice(0, MAX_PICKS).flatMap((d) => {
  const id = String(d?.id ?? '');
  if (!/^[\w-]{10,200}$/.test(id)) return [];
  return [{ id, name: String(d?.name ?? '').slice(0, 300) || null, mimeType: String(d?.mimeType ?? '') || null }];
});

// serves the picker page and waits for the person: resolves with { files } or { canceled: true }. Only a POST from the
// page's own origin with the right nonce counts. The wait ends as canceled when cancelPicker() is called, when a new
// pick starts, when the page has not been opened or has not said it is alive for idleMs (the tab was closed), or after
// maxMs in all
let pending = null;
export const cancelPicker = () => { const p = pending; pending = null; p?.(); return !!p; };
export function awaitPicker({ apiKey, appId, accessToken, open, folders = false, port = PICKER_PORT, idleMs = 2 * 60 * 1000, maxMs = 30 * 60 * 1000 } = {}) {
  pending?.();
  const nonce = randomBytes(18).toString('base64url');
  const origin = `http://127.0.0.1:${port}`;
  return new Promise((resolve, reject) => {
    let done = false;
    let idle = null;
    const stillThere = () => { clearTimeout(idle); idle = setTimeout(() => finish(() => resolve({ canceled: true })), idleMs); idle.unref?.(); };
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, origin);
      if (req.method === 'GET' && u.pathname === `/picker/${nonce}`) {
        stillThere();
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' });
        res.end(pickerPage({ apiKey, appId, accessToken, nonce, folders }));
        return;
      }
      if (req.method === 'POST' && u.pathname === `/picker/${nonce}/alive` && req.headers.origin === origin) {
        stillThere();
        res.writeHead(204); res.end();
        return;
      }
      if (req.method === 'POST' && u.pathname === `/picker/${nonce}/done` && req.headers.origin === origin) {
        const parts = [];
        let size = 0;
        req.on('data', (c) => { size += c.length; if (size > MAX_POST_BYTES) { res.writeHead(413); res.end(); req.destroy(); return; } parts.push(c); });
        req.on('end', () => {
          if (size > MAX_POST_BYTES) return;
          let body = null;
          try { body = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { res.writeHead(400); res.end(); return; }
          res.writeHead(204); res.end();
          finish(() => resolve(body?.action === 'picked' ? { files: cleanPicks(body.docs) } : { canceled: true }));
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    const finish = (fn) => {
      if (done) return;
      done = true; clearTimeout(timer); clearTimeout(idle);
      server.close(); server.closeAllConnections?.();
      if (pending === cancel) pending = null;
      fn();
    };
    const cancel = () => finish(() => resolve({ canceled: true }));
    pending = cancel;
    const timer = setTimeout(() => finish(() => resolve({ canceled: true })), maxMs);
    timer.unref?.();
    stillThere();
    server.on('error', (err) => finish(() => reject(err.code === 'EADDRINUSE' ? new Error('Another Google Drive picker is open. Finish it or try again in a minute.') : err)));
    server.listen(port, '127.0.0.1', async () => {
      try { await open(`${origin}/picker/${nonce}`); } catch (err) { finish(() => reject(new Error(`The browser did not open: ${err?.message ?? err}`))); }
    });
  });
}

export class DriveError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

export const LIMITED = 'Google Drive is limiting requests. Try again in a few minutes.';
const RATE_REASONS = new Set(['userRateLimitExceeded', 'rateLimitExceeded', 'dailyLimitExceeded', 'quotaExceeded', 'sharingRateLimitExceeded']);
const RETRIES = 3;
const MAX_WAIT_MS = 30000;
const sleepFor = (ms) => new Promise((r) => setTimeout(r, ms));

// the reason Drive gives in an error body (error.errors[0].reason, or error.status)
const reasonOf = async (r) => { try { const b = await r.clone().json(); return b?.error?.errors?.[0]?.reason ?? b?.error?.status ?? null; } catch { return null; } };
// how long Drive asks to wait: Retry-After in seconds or as a date, else 1, 2, 4 seconds
const waitFor = (r, attempt) => {
  const h = r.headers?.get?.('retry-after');
  const secs = h && /^\d+$/.test(h.trim()) ? Number(h) * 1000 : h ? Date.parse(h) - Date.now() : NaN;
  return Math.min(MAX_WAIT_MS, Number.isFinite(secs) && secs >= 0 ? secs : 1000 * 2 ** attempt);
};

// one Drive request: retried with backoff while Drive says it is limiting requests (429, or 403 with a rate limit
// reason), then refused with LIMITED. Any other answer comes back as it is, with its error reason
async function driveGet(url, token, { fetchImpl = fetch, sleep = sleepFor } = {}) {
  for (let attempt = 0; ; attempt++) {
    let r;
    try { r = await fetchImpl(url, { headers: { authorization: `Bearer ${token}`, accept: '*/*' }, signal: AbortSignal.timeout(30000) }); }
    catch { throw new DriveError('Google Drive could not be reached. Check the connection and try again.', 'network'); }
    if (r.ok) return { r, reason: null };
    const reason = r.status === 403 || r.status === 429 ? await reasonOf(r) : null;
    const limited = r.status === 429 || (r.status === 403 && RATE_REASONS.has(reason));
    if (!limited) return { r, reason };
    if (attempt >= RETRIES) throw new DriveError(LIMITED, 'limited');
    await sleep(waitFor(r, attempt));
  }
}

const failure = ({ r, reason }) => {
  if (r.status === 401) return new DriveError('Google Drive needs to be connected again in Settings, Connections.', 'reauth');
  if (r.status === 403 && reason === 'exportSizeLimitExceeded') return new DriveError('The document is too large for Google Drive to export.', 'size');
  if (r.status === 404 || r.status === 403) return new DriveError('Your Google account cannot open this file. Add it again from Google Drive, or remove it.', 'gone');
  return new DriveError(`Google Drive answered ${r.status}. Try again in a moment.`, 'drive');
};

// the file's metadata; a file in the trash or of a type Quorum does not read is refused with a sentence.
// opts: { sleep } for the rate limit backoff
export async function driveFile(token, id, fetchImpl = fetch, opts = {}) {
  const u = `${API}/${encodeURIComponent(id)}?fields=id,name,mimeType,modifiedTime,webViewLink,trashed,size&supportsAllDrives=true`;
  const a = await driveGet(u, token, { fetchImpl, ...opts });
  if (!a.r.ok) throw failure(a);
  const m = await a.r.json().catch(() => null);
  if (!m?.id) throw new DriveError('Google Drive sent an answer Quorum could not read. Try again.', 'drive');
  if (m.trashed) throw new DriveError('The file is in the Google Drive trash.', 'trashed');
  if (!pickable(m)) throw new DriveError('Only Google Docs, markdown and text files are added.', 'type');
  if (Number(m.size) > MAX_FILE_BYTES) throw new DriveError('The file is larger than 5 MB.', 'size');
  return { id: m.id, name: m.name ?? 'Untitled', mimeType: m.mimeType, modifiedTime: m.modifiedTime ?? null, url: m.webViewLink ?? null };
}

export const pickable = (m) => PICKABLE.includes(m?.mimeType) || /\.(md|markdown|txt)$/i.test(String(m?.name ?? ''));

const readText = async (r) => {
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_FILE_BYTES) throw new DriveError('The file is larger than 5 MB.', 'size');
  return buf.toString('utf8').replace(/^\uFEFF/, '');
};

// the file's text: a Google Doc exported as markdown, or as plain text when Drive will not export it as markdown; any
// other picked file downloaded as it is. Returns { text, format: 'markdown' | 'text' }
export async function driveText(token, meta, fetchImpl = fetch, opts = {}) {
  const get = (u) => driveGet(u, token, { fetchImpl, ...opts });
  if (meta.mimeType === GOOGLE_DOC) {
    const id = encodeURIComponent(meta.id);
    const md = await get(`${API}/${id}/export?mimeType=${encodeURIComponent('text/markdown')}`);
    if (md.r.ok) return { text: await readText(md.r), format: 'markdown' };
    // 400 is an export format Drive does not offer for this document; anything else is the file or the token
    if (md.r.status !== 400) throw failure(md);
    const txt = await get(`${API}/${id}/export?mimeType=${encodeURIComponent('text/plain')}`);
    if (!txt.r.ok) throw failure(txt);
    return { text: await readText(txt.r), format: 'text' };
  }
  const a = await get(`${API}/${encodeURIComponent(meta.id)}?alt=media&supportsAllDrives=true`);
  if (!a.r.ok) throw failure(a);
  return { text: await readText(a.r), format: /\.txt$/i.test(meta.name) || meta.mimeType === 'text/plain' ? 'text' : 'markdown' };
}
