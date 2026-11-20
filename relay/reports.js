// Issue reports a person sends from the app (POST /v1/reports, migration 0046). The app shows the person everything
// that goes out (title, description, diagnostics, the log lines they kept, the screenshots they kept) and posts it here
// with no session; a signed-in Cloud app may add its bearer token when the person leaves their account attached, and
// then the row records the caller's account and workspace. The relay checks the shape again, clamps every string,
// drops unknown fields, accepts at most 5 screenshots of at most 2 MB each and only PNG or JPEG by their first bytes,
// and replaces the install id with the same HMAC error reports use (ERROR_REPORT_SALT). Screenshots go to the private
// issue-reports bucket; nothing goes to GitHub. Without the salt nothing is stored and the app still gets 202. The body
// is at most 8 MB, refused on its Content-Length before it is read, and at most 2 bodies are read at once (503 with
// Retry-After past that), so reports cannot crowd out audio and sync in this process. Rate limited per install (10 an
// hour), per address (30 an hour) and in total (100 stored an hour). Reports are deleted within 90 days, and screenshots
// a crash left without a row within a day, by createReportPurge.
// The admin Reports page reads screenshots through POST /v1/platform/report-screenshots, which signs links for 5 minutes
// after the database confirms the owner's passkey session.
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { bearer, RelayError } from './lib/auth.js';
import { readJson } from './summary.js';
import { clientAddress, corsHeaders, createLimiter, json } from './platform.js';
import { hashInstall } from './errors.js';

export const BUCKET = 'issue-reports';
export const MAX_SHOTS = 5;
export const MAX_SHOT_BYTES = 2 * 1024 * 1024;
// the whole JSON body, screenshots as base64 included; the app keeps the screenshots together under 5 MB
export const MAX_REPORT_BODY = 8 * 1024 * 1024;
// report bodies read at the same time; one more answers 503
export const MAX_IN_FLIGHT = 2;
// reports stored an hour across every install and address
export const GLOBAL_PER_HOUR = 100;
export const SIGNED_URL_SECONDS = 300;
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUN_ID = /^[\w.:-]{1,80}$/;
const EDITIONS = ['local', 'cloud'];
// the longest each string may be; the app sends at most these, and anything longer is cut here
export const LIMITS = { version: 40, os: 120, view: 120, title: 200, description: 8000, line: 500, lines: 60 };

const bad = (message) => new RelayError('bad_request', message, 400);
const text = (v, max, name) => {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw bad(`${name} must be a string.`);
  return v.slice(0, max);
};

// the image's type from its first bytes, or null: PNG starts 89 50 4E 47 0D 0A 1A 0A, JPEG starts FF D8 FF
export function imageType(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return { mime: 'image/png', ext: 'png' };
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  return null;
}

// one screenshot as the app sends it (base64, optionally a data: URL) to bytes and a type read from those bytes
function cleanShot(s, i) {
  const raw = typeof s === 'string' ? s : s?.data;
  if (typeof raw !== 'string' || !raw) throw bad(`Screenshot ${i + 1} is empty.`);
  const b64 = raw.replace(/^data:[\w/+.-]+;base64,/, '');
  if (!/^[A-Za-z0-9+/=\s]+$/.test(b64)) throw bad(`Screenshot ${i + 1} is not base64.`);
  const bytes = Buffer.from(b64, 'base64');
  if (!bytes.length) throw bad(`Screenshot ${i + 1} is empty.`);
  if (bytes.length > MAX_SHOT_BYTES) throw new RelayError('bad_request', `Screenshot ${i + 1} is over 2 MB.`, 413);
  const type = imageType(bytes);
  if (!type) throw bad(`Screenshot ${i + 1} is not a PNG or JPEG image.`);
  return { bytes, ...type };
}

// the report as the database wants it, or a 400. `now` bounds the client time: a time ahead of the relay's clock is
// read as now.
export function cleanIssueReport(b, now = Date.now()) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad('The body must be a JSON object.');
  const install = String(b.install ?? '').trim().toLowerCase();
  if (!UUID4.test(install)) throw bad('install must be a UUID v4.');
  if (!EDITIONS.includes(b.edition)) throw bad('edition is local or cloud.');
  const at = typeof b.at === 'string' ? Date.parse(b.at) : NaN;
  if (Number.isNaN(at)) throw bad('at must be an ISO time.');
  if (b.logLines !== undefined && !Array.isArray(b.logLines)) throw bad('logLines must be a list.');
  if (b.screenshots !== undefined && !Array.isArray(b.screenshots)) throw bad('screenshots must be a list.');
  const shots = b.screenshots ?? [];
  if (shots.length > MAX_SHOTS) throw bad(`At most ${MAX_SHOTS} screenshots.`);
  const runId = typeof b.runId === 'string' && RUN_ID.test(b.runId.trim()) ? b.runId.trim() : null;
  const title = text(b.title, LIMITS.title, 'title').trim();
  const description = text(b.description, LIMITS.description, 'description').trim();
  if (!title && !description) throw bad('A report needs a title or a description.');
  return {
    install,
    edition: b.edition,
    version: text(b.version, LIMITS.version, 'version').trim(),
    os: text(b.os, LIMITS.os, 'os').trim(),
    view: text(b.view, LIMITS.view, 'view').trim(),
    title,
    description,
    logLines: (b.logLines ?? []).slice(-LIMITS.lines).map((l, i) => text(l, LIMITS.line, `logLines[${i}]`)),
    runId,
    screenshots: shots.map(cleanShot),
    at: new Date(Math.min(at, now)).toISOString(),
  };
}

// the row issue_report_record takes; the raw install id is left out here, before anything leaves this process
export const storedIssueReport = (id, r, installHash, account, paths) => ({
  id, install_hash: installHash, user_id: account?.userId ?? null, workspace_id: account?.workspaceId ?? null, edition: r.edition, version: r.version, os: r.os,
  view: r.view, title: r.title, description: r.description, log_lines: r.logLines, run_id: r.runId, screenshots: paths, at: r.at,
});

// the account behind an optional bearer token, and its oldest live workspace. A missing, expired or unknown token
// leaves both null and the report is still stored, anonymously.
export async function reporterAccount({ anon, db }, token) {
  if (!token) return null;
  try {
    const { data, error } = await anon.auth.getUser(token);
    if (error || !data?.user) return null;
    const m = await db.from('members').select('workspace_id').eq('user_id', data.user.id).is('deleted_at', null).order('created_at', { ascending: true }).limit(1).maybeSingle();
    return { userId: data.user.id, workspaceId: m.error ? null : (m.data?.workspace_id ?? null) };
  } catch { return null; }
}

export function reportStore(db) {
  const bucket = () => db.storage.from(BUCKET);
  return {
    async upload(path, bytes, mime) {
      const { error } = await bucket().upload(path, bytes, { contentType: mime, upsert: false });
      if (error) throw new RelayError('server', 'A screenshot could not be stored.', 500);
    },
    async remove(paths) {
      if (!paths.length) return true;
      const { error } = await bucket().remove(paths);
      return !error;
    },
    // one page of the bucket's top-level folders (a folder is a report id), by name
    async folders(offset, limit) {
      const { data, error } = await bucket().list('', { limit, offset, sortBy: { column: 'name', order: 'asc' } });
      if (error) throw new Error('The bucket could not be listed');
      return (data ?? []).filter((e) => !e.id).map((e) => e.name);
    },
    // the objects in one report's folder with their upload time
    async files(folder) {
      const { data, error } = await bucket().list(folder, { limit: 20 });
      if (error) throw new Error('A folder could not be listed');
      return (data ?? []).filter((e) => e.id).map((e) => ({ path: `${folder}/${e.name}`, createdAt: e.created_at ?? null }));
    },
    async record(row) {
      const { data, error } = await db.rpc('issue_report_record', { report: row });
      if (error) throw new RelayError('server', 'The report could not be stored.', 500);
      return data;
    },
  };
}

export function reportsRoute({ clients, config, log = () => {}, store = reportStore(clients.db), now = Date.now, newId = randomUUID, maxInFlight = MAX_IN_FLIGHT, installLimit = createLimiter({ max: 10, now }), addressLimit = createLimiter({ max: 30, now }), globalLimit = createLimiter({ max: GLOBAL_PER_HOUR, now }) }) {
  let warned = false;
  let inFlight = 0;
  let capped = false;
  return async function handleReports(req, res) {
    let counted = false;
    try {
      if (req.method !== 'POST') throw new RelayError('bad_request', 'POST only.', 405);
      const length = Number(req.headers?.['content-length']);
      if (Number.isFinite(length) && length > MAX_REPORT_BODY) { req.resume?.(); throw new RelayError('bad_request', 'The report is too large. Remove a screenshot and try again.', 413); }
      if (inFlight >= maxInFlight) { req.resume?.(); return json(res, 503, { ok: false, error: 'The server is busy. Try again in a minute.' }, { 'retry-after': '30' }); }
      inFlight += 1; counted = true;
      if (!addressLimit.allow(clientAddress(req))) throw new RelayError('rate_limit', 'Too many reports from this connection. Try again in an hour.', 429);
      const r = cleanIssueReport(await readJson(req, MAX_REPORT_BODY), now());
      if (!installLimit.allow(r.install)) throw new RelayError('rate_limit', 'Too many reports from this install. Try again in an hour.', 429);
      if (!globalLimit.allow('all')) {
        if (!capped) { capped = true; log('reports_global_cap', { perHour: GLOBAL_PER_HOUR }); }
        throw new RelayError('rate_limit', 'Reports are paused for now. Try again in an hour.', 429);
      }
      capped = false;
      const salt = config.errors?.salt;
      if (!salt) {
        if (!warned) { warned = true; log('reports_no_salt', { message: 'ERROR_REPORT_SALT is not set; issue reports are accepted and dropped' }); }
        return json(res, 202, { ok: true });
      }
      const account = await reporterAccount(clients, bearer(req.headers?.authorization));
      const id = newId();
      const paths = [];
      try {
        for (const [i, s] of r.screenshots.entries()) {
          const p = `${id}/${i + 1}.${s.ext}`;
          await store.upload(p, s.bytes, s.mime);
          paths.push(p);
        }
        await store.record(storedIssueReport(id, r, hashInstall(salt, r.install), account, paths));
      } catch (err) {
        // nothing half stored: the screenshots of a report whose row failed are removed again
        await store.remove(paths).catch(() => false);
        throw err;
      }
      log('issue_reported', { edition: r.edition, version: r.version, view: r.view, screenshots: paths.length, lines: r.logLines.length, signedIn: !!account });
      json(res, 202, { ok: true, id });
    } catch (err) {
      const status = err instanceof RelayError ? err.status : 500;
      log('issue_report_failed', { status, message: err.message });
      json(res, status, { ok: false, error: err instanceof RelayError ? err.message : 'Something went wrong. Try again.' });
    } finally {
      if (counted) inFlight -= 1;
    }
  };
}

// a client that calls the project as the owner, with the passkey session header the owner-only functions read
// (migration 0017), so the database makes the same check it makes for the admin app's own calls
export const ownerClient = (config, token, passkey) => createClient(config.supabaseUrl, config.supabaseAnonKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { headers: { authorization: `Bearer ${token}`, ...(passkey ? { 'x-quorum-passkey': passkey } : {}) } },
});

// short-lived links to one report's screenshots for the admin Reports page. admin_issue_report runs as the caller and
// refuses anyone but the platform owner with a live passkey session; only then does the service role sign the links.
export function reportShotsRoute({ clients, config, log = () => {}, asOwner = (token, passkey) => ownerClient(config, token, passkey) }) {
  return async function handleReportShots(req, res) {
    const cors = corsHeaders(req.headers.origin, config.corsOrigins);
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    try {
      if (req.method !== 'POST') throw new RelayError('bad_request', 'POST only.', 405);
      const token = bearer(req.headers.authorization);
      if (!token) throw new RelayError('unauthorized', 'Sign in first.', 401);
      const b = await readJson(req, 4 * 1024);
      const id = String(b.id ?? '').trim().toLowerCase();
      if (!UUID.test(id)) throw bad('id must be a report id.');
      const { data, error } = await asOwner(token, req.headers['x-quorum-passkey'] ?? null).rpc('admin_issue_report', { report_id: id });
      if (error) throw new RelayError('forbidden', /does not exist/i.test(error.message ?? '') ? 'That report does not exist.' : 'Only the platform owner can do that.', /does not exist/i.test(error.message ?? '') ? 404 : 403);
      const paths = (Array.isArray(data?.screenshots) ? data.screenshots : []).filter((p) => typeof p === 'string' && p.startsWith(`${id}/`));
      if (!paths.length) return json(res, 200, { ok: true, urls: [] }, cors);
      const signed = await clients.db.storage.from(BUCKET).createSignedUrls(paths, SIGNED_URL_SECONDS);
      if (signed.error) throw new RelayError('server', 'The screenshots could not be read.', 500);
      json(res, 200, { ok: true, urls: (signed.data ?? []).map((s) => ({ path: s.path, url: s.signedUrl ?? null })) }, cors);
    } catch (err) {
      const status = err instanceof RelayError ? err.status : 500;
      log('report_shots_failed', { status, message: err.message });
      json(res, status, { ok: false, error: err instanceof RelayError ? err.message : 'Something went wrong. Try again.' }, cors);
    }
  };
}

export const PURGE_EVERY_MS = 60 * 60 * 1000;

// the hourly sweep for the 90-day promise: the expired rows with their screenshot keys, the objects deleted through the
// Storage API, then the rows whose objects are gone. Then the screenshots a relay that stopped between upload and row
// left behind: a page of the bucket's folders a run (the next run takes the next page, then starts over), the ones with
// no row, and their objects once every one is older than a day. A failure is logged and the next tick tries again.
export const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;
export function createReportPurge({ db, log = () => {}, everyMs = PURGE_EVERY_MS, store = reportStore(db), now = Date.now, page = 500 }) {
  let timer = null;
  let offset = 0;
  async function orphans() {
    const listed = await store.folders(offset, page);
    offset = listed.length < page ? 0 : offset + page;
    const folders = listed.filter((f) => UUID.test(f));
    if (!folders.length) return 0;
    const { data, error } = await db.rpc('issue_reports_missing', { ids: folders });
    if (error) throw new Error(error.message || 'issue_reports_missing failed');
    let removed = 0;
    for (const id of data ?? []) {
      const files = await store.files(String(id));
      if (!files.length || files.some((f) => !f.createdAt || now() - Date.parse(f.createdAt) < ORPHAN_AGE_MS)) continue;
      if (await store.remove(files.map((f) => f.path))) removed += files.length;
    }
    return removed;
  }
  async function run() {
    try {
      const { data, error } = await db.rpc('issue_reports_expired', { max_rows: 200 });
      if (error) throw new Error(error.message || 'issue_reports_expired failed');
      const done = [];
      let failed = 0;
      for (const r of data ?? []) {
        if (await store.remove(Array.isArray(r.screenshots) ? r.screenshots : [])) done.push(r.id); else failed += 1;
      }
      if (done.length) {
        const del = await db.rpc('issue_reports_delete', { ids: done });
        if (del.error) throw new Error(del.error.message || 'issue_reports_delete failed');
      }
      const orphaned = await orphans();
      if (done.length || failed || orphaned) log('reports_purged', { reports: done.length, failed, orphaned });
      return { reports: done.length, failed, orphaned };
    } catch (err) { log('reports_purge_failed', { message: err.message }); return null; }
  }
  return {
    run,
    start() { if (timer) return; run(); timer = setInterval(run, everyMs); timer.unref?.(); },
    stop() { clearInterval(timer); timer = null; },
  };
}
