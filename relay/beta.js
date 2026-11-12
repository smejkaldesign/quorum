// The beta gate for every install, both editions. The app asks once with its access code (POST /v1/beta/check) and
// then reports a heartbeat (POST /v1/beta/heartbeat) carrying only the code, a machine id and the app version. The
// relay reads and writes access_codes and beta_installs with the service role; nothing here needs a session. A free
// code admits one Mac; a cloud code admits the Mac the matching account signs in on, the sign-in itself still
// redeems the code (migration 0009). Both routes are public and rate limited by address like the request intake.
import { RelayError } from './lib/auth.js';
import { readJson } from './summary.js';
import { clientAddress, corsHeaders, createLimiter } from './platform.js';

const CODE = /^[A-Z2-9]{8}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const EDITIONS = ['local', 'cloud'];

const json = (res, status, body, extra = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...extra }); res.end(JSON.stringify(body)); };

// the request as the store wants it: the code normalized, the machine id and version bounded, the edition one of two
export function cleanCheck(b = {}) {
  const code = String(b.code ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (!CODE.test(code)) throw new RelayError('bad_request', 'That is not an access code.', 400);
  const machineId = String(b.machineId ?? '').trim().slice(0, 120);
  if (!machineId) throw new RelayError('bad_request', 'The machine id is missing.', 400);
  const edition = String(b.edition ?? '').trim().toLowerCase();
  if (!EDITIONS.includes(edition)) throw new RelayError('bad_request', 'The edition is local or cloud.', 400);
  const version = String(b.version ?? '').trim().slice(0, 40) || null;
  const email = String(b.email ?? '').trim().toLowerCase();
  return { code, machineId, edition, version, email: EMAIL.test(email) ? email : null };
}

// the decision, with no database in sight: a code row, the installs already on it, and what the app sent
export function betaDecision({ row, installs = [], machineId, edition, email, now = Date.now() }) {
  if (!row) return { ok: false, reason: 'unknown', message: 'That access code is not valid.' };
  if (row.revoked_at) return { ok: false, reason: 'revoked', message: 'That access code was revoked.' };
  if (new Date(row.expires_at).getTime() <= now) return { ok: false, reason: 'expired', message: 'That access code has expired. Ask for a new one.' };
  if (email && row.email !== email) return { ok: false, reason: 'email', message: 'That access code was issued to a different email address.' };
  const mine = installs.some((i) => i.machine_id === machineId);
  const others = installs.filter((i) => i.machine_id !== machineId);
  // a free code is good for one Mac; a cloud code follows the account, so a second Mac is fine
  if (row.plan !== 'cloud' && !mine && others.length) return { ok: false, reason: 'used', message: 'That access code is already in use on another Mac.' };
  return { ok: true, plan: row.plan === 'cloud' ? 'cloud' : 'free' };
}

// the two reads and two writes, on the service role client; tests pass a stand-in
export function betaStore(db) {
  return {
    async code(code) {
      const { data, error } = await db.from('access_codes').select('id, email, plan, expires_at, revoked_at, redeemed_at').eq('code', code).order('issued_at', { ascending: false }).limit(1).maybeSingle();
      if (error) throw new RelayError('server', 'The code could not be checked. Try again.', 500);
      return data;
    },
    async installs(codeId) {
      const { data, error } = await db.from('beta_installs').select('machine_id, edition').eq('code_id', codeId);
      if (error) throw new RelayError('server', 'The code could not be checked. Try again.', 500);
      return data ?? [];
    },
    async upsert({ codeId, email, machineId, edition, version }) {
      const { error } = await db.from('beta_installs').upsert({ code_id: codeId, email, machine_id: machineId, edition, app_version: version, last_seen: new Date().toISOString() }, { onConflict: 'code_id,machine_id' });
      if (error) throw new RelayError('server', 'The install could not be recorded. Try again.', 500);
    },
    async touch({ codeId, machineId, version }) {
      const { data, error } = await db.from('beta_installs').update({ last_seen: new Date().toISOString(), ...(version ? { app_version: version } : {}) }).eq('code_id', codeId).eq('machine_id', machineId).select('id');
      if (error) throw new RelayError('server', 'The heartbeat could not be recorded.', 500);
      return (data ?? []).length > 0;
    },
  };
}

const limiter = createLimiter({ max: 30 });

export async function handleBetaCheck(req, res, { clients, config, log = () => {}, store = betaStore(clients.db) }) {
  const cors = corsHeaders(req.headers.origin, config.corsOrigins);
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  try {
    if (req.method !== 'POST') throw new RelayError('bad_request', 'POST only.', 405);
    if (!limiter.allow(clientAddress(req))) throw new RelayError('rate_limit', 'Too many attempts from this connection. Try again in an hour.', 429);
    const c = cleanCheck(await readJson(req, 16 * 1024));
    const row = await store.code(c.code);
    const installs = row ? await store.installs(row.id) : [];
    const d = betaDecision({ row, installs, machineId: c.machineId, edition: c.edition, email: c.email });
    if (!d.ok) { log('beta_refused', { reason: d.reason, edition: c.edition }); return json(res, 200, { ok: false, reason: d.reason, error: d.message }, cors); }
    await store.upsert({ codeId: row.id, email: c.email ?? row.email, machineId: c.machineId, edition: c.edition, version: c.version });
    log('beta_admitted', { plan: d.plan, edition: c.edition, version: c.version });
    json(res, 200, { ok: true, plan: d.plan }, cors);
  } catch (err) {
    const status = err instanceof RelayError ? err.status : 500;
    log('beta_check_failed', { status, message: err.message });
    json(res, status, { ok: false, reason: err.code ?? 'server', error: err instanceof RelayError ? err.message : 'Something went wrong. Try again.' }, cors);
  }
}

export async function handleBetaHeartbeat(req, res, { clients, config, log = () => {}, store = betaStore(clients.db) }) {
  const cors = corsHeaders(req.headers.origin, config.corsOrigins);
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  try {
    if (req.method !== 'POST') throw new RelayError('bad_request', 'POST only.', 405);
    if (!limiter.allow(clientAddress(req))) throw new RelayError('rate_limit', 'Too many attempts from this connection. Try again in an hour.', 429);
    const b = await readJson(req, 16 * 1024);
    const code = String(b.code ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    const machineId = String(b.machineId ?? '').trim().slice(0, 120);
    const version = String(b.version ?? '').trim().slice(0, 40) || null;
    if (!CODE.test(code) || !machineId) throw new RelayError('bad_request', 'The code or the machine id is missing.', 400);
    const row = await store.code(code);
    const seen = row ? await store.touch({ codeId: row.id, machineId, version }) : false;
    json(res, 200, { ok: seen }, cors);
  } catch (err) {
    const status = err instanceof RelayError ? err.status : 500;
    log('beta_heartbeat_failed', { status, message: err.message });
    json(res, status, { ok: false, error: err instanceof RelayError ? err.message : 'Something went wrong. Try again.' }, cors);
  }
}
