// Page crash reports from every install, both editions (POST /v1/errors, migration 0045). The app catches a page that
// fails to render, scrubs the report and posts it here with no session; a signed-in Cloud app may add its bearer
// token, and then the event records the caller's workspace. The relay checks the shape again, clamps every string,
// drops unknown fields, and replaces the install id with an HMAC-SHA256 of it keyed by ERROR_REPORT_SALT before
// anything is written, so the raw id is never stored. Without the salt nothing is stored and the app still gets 202,
// so it does not retry. Rate limited per install (30 an hour) and per address (120 an hour).
import { createHmac } from 'node:crypto';
import { bearer, RelayError } from './lib/auth.js';
import { readJson } from './summary.js';
import { clientAddress, createLimiter, json } from './platform.js';

export const MAX_ERROR_BODY = 32 * 1024;
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FINGERPRINT = /^[0-9a-f]{64}$/i;
const EDITIONS = ['local', 'cloud'];
const KINDS = ['render', 'main', 'renderer-gone'];
// the longest each string may be; the app sends at most these, and anything longer is cut here
export const LIMITS = { version: 40, os: 120, view: 120, message: 500, stack: 8000, componentStack: 4000 };

const bad = (message) => new RelayError('bad_request', message, 400);
const text = (v, max, name) => {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw bad(`${name} must be a string.`);
  return v.slice(0, max);
};

// the report as the database wants it, or a 400. `now` bounds the client time: a time ahead of the relay's clock is
// read as now.
export function cleanReport(b, now = Date.now()) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad('The body must be a JSON object.');
  const install = String(b.install ?? '').trim().toLowerCase();
  if (!UUID4.test(install)) throw bad('install must be a UUID v4.');
  if (!EDITIONS.includes(b.edition)) throw bad('edition is local or cloud.');
  if (!KINDS.includes(b.kind)) throw bad('kind is render, main or renderer-gone.');
  const fingerprint = String(b.fingerprint ?? '').trim().toLowerCase();
  if (!FINGERPRINT.test(fingerprint)) throw bad('fingerprint must be 64 hex characters.');
  if (b.repeat !== undefined && typeof b.repeat !== 'boolean') throw bad('repeat must be true or false.');
  const at = typeof b.at === 'string' ? Date.parse(b.at) : NaN;
  if (Number.isNaN(at)) throw bad('at must be an ISO time.');
  return {
    install,
    fingerprint,
    edition: b.edition,
    kind: b.kind,
    repeat: b.repeat === true,
    version: text(b.version, LIMITS.version, 'version').trim(),
    os: text(b.os, LIMITS.os, 'os').trim(),
    view: text(b.view, LIMITS.view, 'view').trim(),
    message: text(b.message, LIMITS.message, 'message'),
    stack: text(b.stack, LIMITS.stack, 'stack'),
    componentStack: text(b.componentStack, LIMITS.componentStack, 'componentStack'),
    at: new Date(Math.min(at, now)).toISOString(),
  };
}

// the install id as stored: an HMAC keyed by the relay's salt, so the same Mac counts once and cannot be named
export const hashInstall = (salt, install) => createHmac('sha256', salt).update(install).digest('hex');

// the row error_report_record takes; the raw install id is left out here, before anything leaves this process
export const storedReport = (r, installHash, workspaceId) => ({
  fingerprint: r.fingerprint, install_hash: installHash, workspace_id: workspaceId, edition: r.edition, version: r.version, os: r.os,
  view: r.view, kind: r.kind, repeat: r.repeat, message: r.message, stack: r.stack, component_stack: r.componentStack, at: r.at,
});

// the workspace behind an optional bearer token: the caller's oldest live membership. A missing, expired or unknown
// token leaves it null and the report is still stored.
export async function reporterWorkspace({ anon, db }, token) {
  if (!token) return null;
  try {
    const { data, error } = await anon.auth.getUser(token);
    if (error || !data?.user) return null;
    const m = await db.from('members').select('workspace_id').eq('user_id', data.user.id).is('deleted_at', null).order('created_at', { ascending: true }).limit(1).maybeSingle();
    return m.error ? null : (m.data?.workspace_id ?? null);
  } catch { return null; }
}

export function errorStore(db) {
  return {
    async record(row) {
      const { data, error } = await db.rpc('error_report_record', { report: row });
      if (error) throw new RelayError('server', 'The report could not be stored.', 500);
      return data;
    },
  };
}

export function errorsRoute({ clients, config, log = () => {}, store = errorStore(clients.db), now = Date.now, installLimit = createLimiter({ max: 30, now }), addressLimit = createLimiter({ max: 120, now }) }) {
  let warned = false;
  return async function handleErrors(req, res) {
    try {
      if (req.method !== 'POST') throw new RelayError('bad_request', 'POST only.', 405);
      if (!addressLimit.allow(clientAddress(req))) throw new RelayError('rate_limit', 'Too many reports from this connection. Try again in an hour.', 429);
      const r = cleanReport(await readJson(req, MAX_ERROR_BODY), now());
      if (!installLimit.allow(r.install)) throw new RelayError('rate_limit', 'Too many reports from this install. Try again in an hour.', 429);
      const salt = config.errors?.salt;
      if (!salt) {
        if (!warned) { warned = true; log('errors_no_salt', { message: 'ERROR_REPORT_SALT is not set; error reports are accepted and dropped' }); }
        return json(res, 202, { ok: true });
      }
      const workspaceId = await reporterWorkspace(clients, bearer(req.headers?.authorization));
      const out = await store.record(storedReport(r, hashInstall(salt, r.install), workspaceId));
      log('error_reported', { kind: r.kind, edition: r.edition, version: r.version, view: r.view, repeat: r.repeat, signedIn: !!workspaceId, reopened: out?.reopened === true });
      json(res, 202, { ok: true });
    } catch (err) {
      const status = err instanceof RelayError ? err.status : 500;
      log('error_report_failed', { status, message: err.message });
      json(res, status, { ok: false, error: err instanceof RelayError ? err.message : 'Something went wrong. Try again.' });
    }
  };
}
