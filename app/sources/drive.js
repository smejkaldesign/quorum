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

export function pickerPage({ apiKey, appId, accessToken, nonce }) {
  const cfg = inScript({ apiKey, appId, token: accessToken, done: `/picker/${nonce}/done`, mimeTypes: PICKABLE.join(','), max: MAX_PICKS });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="strict-origin-when-cross-origin"><title>Choose files for Quorum</title>
<style>html,body{height:100%;margin:0}body{background:#0b0b0c;color:#f2f2f3;font:16px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text",Helvetica,Arial,sans-serif;display:grid;place-items:center;text-align:center}
main{max-width:520px;padding:24px}h1{font:400 34px/1.15 "New York",ui-serif,Georgia,serif;margin:0 0 12px}p{margin:0;color:rgba(242,242,243,.85)}
button{margin-top:24px;height:40px;padding:0 18px;border-radius:999px;border:0;background:#fff;color:#0b2a4d;font:500 14px/1 inherit;cursor:pointer}</style></head>
<body><main><h1 id="title">Opening Google Drive</h1><p id="body">Pick the Google Docs, markdown or text files to add to the knowledge base.</p><button id="again" hidden>Open the picker again</button></main>
<script>
const CFG = ${cfg};
const say = (t, b) => { document.getElementById('title').textContent = t; document.getElementById('body').textContent = b; };
let sent = false;
async function send(payload) {
  if (sent) return; sent = true;
  try { await fetch(CFG.done, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }); } catch (e) { say('Quorum did not answer', 'Go back to Quorum and try again.'); return; }
  if (payload.action === 'picked') say(payload.docs.length === 1 ? 'One file sent to Quorum' : payload.docs.length + ' files sent to Quorum', 'You can close this tab and go back to Quorum.');
  else say('Nothing was picked', 'You can close this tab and go back to Quorum.');
}
function show() {
  const view = new google.picker.DocsView(google.picker.ViewId.DOCS).setMimeTypes(CFG.mimeTypes).setIncludeFolders(true).setSelectFolderEnabled(false).setMode(google.picker.DocsViewMode.LIST);
  const picker = new google.picker.PickerBuilder()
    .setDeveloperKey(CFG.apiKey).setAppId(CFG.appId).setOAuthToken(CFG.token).setOrigin(location.origin)
    .addView(view).enableFeature(google.picker.Feature.MULTISELECT_ENABLED).enableFeature(google.picker.Feature.SUPPORT_DRIVES)
    .setMaxItems(CFG.max).setTitle('Choose files for Quorum')
    .setCallback((data) => {
      const action = data[google.picker.Response.ACTION];
      if (action === google.picker.Action.PICKED) send({ action: 'picked', docs: (data[google.picker.Response.DOCUMENTS] || []).map((d) => ({ id: d[google.picker.Document.ID], name: d[google.picker.Document.NAME], mimeType: d[google.picker.Document.MIME_TYPE], url: d[google.picker.Document.URL] })) });
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
  return [{ id, name: String(d?.name ?? '').slice(0, 300) || null, mimeType: String(d?.mimeType ?? '') || null, url: /^https:\/\/(docs|drive)\.google\.com\//.test(String(d?.url ?? '')) ? d.url : null }];
});

// serves the picker page and waits for the person: resolves with { files } or { canceled: true }. Starting a new pick
// cancels one still waiting. Only a POST from the page's own origin with the right nonce counts
let pending = null;
export function awaitPicker({ apiKey, appId, accessToken, open, port = PICKER_PORT, timeoutMs = 10 * 60 * 1000 } = {}) {
  pending?.();
  const nonce = randomBytes(18).toString('base64url');
  const origin = `http://127.0.0.1:${port}`;
  return new Promise((resolve, reject) => {
    let done = false;
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, origin);
      if (req.method === 'GET' && u.pathname === `/picker/${nonce}`) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' });
        res.end(pickerPage({ apiKey, appId, accessToken, nonce }));
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
    const finish = (fn) => { if (done) return; done = true; clearTimeout(timer); server.close(); if (pending === cancel) pending = null; fn(); };
    const cancel = () => finish(() => resolve({ canceled: true }));
    pending = cancel;
    const timer = setTimeout(() => finish(() => resolve({ canceled: true })), timeoutMs);
    timer.unref?.();
    server.on('error', (err) => finish(() => reject(err.code === 'EADDRINUSE' ? new Error('Another Google Drive picker is open. Finish it or try again in a minute.') : err)));
    server.listen(port, '127.0.0.1', async () => {
      try { await open(`${origin}/picker/${nonce}`); } catch (err) { finish(() => reject(new Error(`The browser did not open: ${err?.message ?? err}`))); }
    });
  });
}

class DriveError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

const driveFetch = async (fetchImpl, url, token) => {
  try { return await fetchImpl(url, { headers: { authorization: `Bearer ${token}`, accept: '*/*' }, signal: AbortSignal.timeout(30000) }); }
  catch { throw new DriveError('Google Drive could not be reached. Check the connection and try again.', 'network'); }
};
const failure = (r) => {
  if (r.status === 401) return new DriveError('Google Drive needs to be connected again in Settings, Connections.', 'reauth');
  if (r.status === 404 || r.status === 403) return new DriveError('Quorum can no longer open this file. Add it again from Google Drive.', 'gone');
  if (r.status === 429) return new DriveError('Google Drive is limiting requests. Try again in a minute.', 'limited');
  return new DriveError(`Google Drive answered ${r.status}. Try again in a moment.`, 'drive');
};

// the file's metadata; a file in the trash or of a type Quorum does not read is refused with a sentence
export async function driveFile(token, id, fetchImpl = fetch) {
  const u = `${API}/${encodeURIComponent(id)}?fields=id,name,mimeType,modifiedTime,webViewLink,trashed,size&supportsAllDrives=true`;
  const r = await driveFetch(fetchImpl, u, token);
  if (!r.ok) throw failure(r);
  const m = await r.json().catch(() => null);
  if (!m?.id) throw new DriveError('Google Drive sent an answer Quorum could not read. Try again.', 'drive');
  if (m.trashed) throw new DriveError('The file is in the Google Drive trash.', 'trashed');
  if (!pickable(m)) throw new DriveError('Only Google Docs, markdown and text files are added.', 'type');
  if (Number(m.size) > MAX_FILE_BYTES) throw new DriveError('The file is larger than 5 MB.', 'size');
  return { id: m.id, name: m.name ?? 'Untitled', mimeType: m.mimeType, modifiedTime: m.modifiedTime ?? null, url: m.webViewLink ?? null };
}

// Drive refuses to export a document past its export limit with 403 exportSizeLimitExceeded
const exportFailure = async (r) => {
  if (r.status !== 403) return failure(r);
  const reason = await r.json().then((b) => b?.error?.errors?.[0]?.reason ?? null).catch(() => null);
  return reason === 'exportSizeLimitExceeded' ? new DriveError('The document is too large for Google Drive to export.', 'size') : failure(r);
};

export const pickable = (m) => PICKABLE.includes(m?.mimeType) || /\.(md|markdown|txt)$/i.test(String(m?.name ?? ''));

const readText = async (r) => {
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_FILE_BYTES) throw new DriveError('The file is larger than 5 MB.', 'size');
  return buf.toString('utf8').replace(/^\uFEFF/, '');
};

// the file's text: a Google Doc exported as markdown, or as plain text when Drive will not export it as markdown; any
// other picked file downloaded as it is. Returns { text, format: 'markdown' | 'text' }
export async function driveText(token, meta, fetchImpl = fetch) {
  if (meta.mimeType === GOOGLE_DOC) {
    const id = encodeURIComponent(meta.id);
    const md = await driveFetch(fetchImpl, `${API}/${id}/export?mimeType=${encodeURIComponent('text/markdown')}`, token);
    if (md.ok) return { text: await readText(md), format: 'markdown' };
    // 400 is an export format Drive does not offer for this document; anything else is the file or the token
    if (md.status !== 400) throw await exportFailure(md);
    const txt = await driveFetch(fetchImpl, `${API}/${id}/export?mimeType=${encodeURIComponent('text/plain')}`, token);
    if (!txt.ok) throw await exportFailure(txt);
    return { text: await readText(txt), format: 'text' };
  }
  const r = await driveFetch(fetchImpl, `${API}/${encodeURIComponent(meta.id)}?alt=media&supportsAllDrives=true`, token);
  if (!r.ok) throw failure(r);
  return { text: await readText(r), format: /\.txt$/i.test(meta.name) || meta.mimeType === 'text/plain' ? 'text' : 'markdown' };
}
