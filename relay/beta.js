// The beta gate for every install, both editions. The app asks once with its access code (POST /v1/beta/check) and
// then reports a heartbeat (POST /v1/beta/heartbeat) carrying only the code, a machine id and the app version. The
// relay reads and writes access_codes and beta_installs with the service role; nothing here needs a session. In the
// open-source edition a code is held by the first Mac that enters it and stays bound to that Mac. In the Cloud
// edition the account is the identity: the code is not tied to a Mac, and the Cloud sign-in redeems it by the
// account email, one account per code (migrations 0009, 0018). Both routes are public, rate limited per machine (per
// address when the body carries none).
import { RelayError } from './lib/auth.js';
import { readJson } from './summary.js';
import { CODE, EMAIL, clientAddress, corsHeaders, createLimiter, json } from './platform.js';

const EDITIONS = ['local', 'cloud'];

// the pieces both routes read the same way
export const cleanCode = (v) => { const code = String(v ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase(); if (!CODE.test(code)) throw new RelayError('bad_request', 'That is not an access code.', 400); return code; };
export const cleanMachine = (v) => { const id = String(v ?? '').trim().slice(0, 120); if (!id) throw new RelayError('bad_request', 'The machine id is missing.', 400); return id; };
export const cleanVersion = (v) => String(v ?? '').trim().slice(0, 40) || null;

// the check request as the store wants it: the edition one of two, the email kept only when it is one
export function cleanCheck(b = {}) {
  const code = cleanCode(b.code);
  const machineId = cleanMachine(b.machineId);
  const edition = String(b.edition ?? '').trim().toLowerCase();
  if (!EDITIONS.includes(edition)) throw new RelayError('bad_request', 'The edition is local or cloud.', 400);
  const email = String(b.email ?? '').trim().toLowerCase();
  return { code, machineId, edition, version: cleanVersion(b.version), email: EMAIL.test(email) ? email : null };
}
export const cleanHeartbeat = (b = {}) => ({ code: cleanCode(b.code), machineId: cleanMachine(b.machineId), version: cleanVersion(b.version) });

// whether this Mac already holds the code: the redeeming Mac of a free code, or any install row for it
export const boundTo = (row, installs, machineId) => (row?.redeemed_machine_id && row.redeemed_machine_id === machineId) || installs.some((i) => i.machine_id === machineId);

const USED = 'That access code is already in use on another Mac.';

// the decision, with no database in sight: a code row, the installs already on it, and what the app sent. Expiry
// counts at first use only; a Mac the code is already bound to stays admitted. Revocation always counts.
export function betaDecision({ row, installs = [], machineId, edition, now = Date.now() }) {
  if (!row) return { ok: false, reason: 'unknown', message: 'That access code is not valid.' };
  if (row.revoked_at) return { ok: false, reason: 'revoked', message: 'That access code was revoked.' };
  const plan = row.plan === 'cloud' ? 'cloud' : 'free';
  const expired = new Date(row.expires_at).getTime() <= now;
  // the Cloud edition: the account sign-in is the identity, so the code is not tied to a Mac. A live code, or one an
  // account already redeemed, is admitted on any Mac; the sign-up trigger (auth_user_gate, migration 0018) keeps one
  // account per code. Any email an older build sends is ignored.
  if (edition === 'cloud') {
    if (expired && !row.redeemed_at) return { ok: false, reason: 'expired', message: 'That access code has expired. Ask for a new one.' };
    return { ok: true, plan, bind: false };
  }
  // the open-source edition: one code, one Mac. The first Mac holds it and the same Mac checking again is admitted;
  // expiry counts at first use only
  const bound = boundTo(row, installs, machineId);
  if (!bound && expired) return { ok: false, reason: 'expired', message: 'That access code has expired. Ask for a new one.' };
  if (!bound && (row.redeemed_machine_id || installs.some((i) => i.edition !== 'cloud'))) return { ok: false, reason: 'used', message: USED };
  return { ok: true, plan, bind: !row.redeemed_machine_id };
}

// what a heartbeat may do: touch a known install of a live code; a revoked code is refused, an expired one too
// unless this Mac already holds it
export function heartbeatDecision({ row, installs = [], machineId, now = Date.now() }) {
  if (!row) return { ok: false, reason: 'unknown' };
  if (row.revoked_at) return { ok: false, reason: 'revoked' };
  const bound = boundTo(row, installs, machineId);
  if (!bound) return { ok: false, reason: 'unknown' };
  if (new Date(row.expires_at).getTime() <= now && !installs.some((i) => i.machine_id === machineId) && row.redeemed_machine_id !== machineId) return { ok: false, reason: 'expired' };
  return { ok: true };
}

// the reads and writes, on the service role client; tests pass a stand-in
export function betaStore(db) {
  return {
    async code(code) {
      const { data, error } = await db.from('access_codes').select('id, email, plan, expires_at, revoked_at, redeemed_at, redeemed_machine_id').eq('code', code).order('issued_at', { ascending: false }).limit(1).maybeSingle();
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
    // a free code is held by its first Mac. The update only lands while no Mac holds the code, so two Macs racing for
    // it cannot both win; the loser reads the row back and is told the code is in use. True when this Mac holds it.
    async redeemLocal({ codeId, machineId }) {
      const { data, error } = await db.from('access_codes').update({ redeemed_at: new Date().toISOString(), redeemed_machine_id: machineId }).eq('id', codeId).is('redeemed_machine_id', null).select('id');
      if (error) throw new RelayError('server', 'The install could not be recorded. Try again.', 500);
      if ((data ?? []).length > 0) return true;
      const again = await db.from('access_codes').select('redeemed_machine_id').eq('id', codeId).maybeSingle();
      if (again.error) throw new RelayError('server', 'The install could not be recorded. Try again.', 500);
      return again.data?.redeemed_machine_id === machineId;
    },
    async touch({ codeId, machineId, version }) {
      const { data, error } = await db.from('beta_installs').update({ last_seen: new Date().toISOString(), ...(version ? { app_version: version } : {}) }).eq('code_id', codeId).eq('machine_id', machineId).select('id');
      if (error) throw new RelayError('server', 'The heartbeat could not be recorded.', 500);
      return (data ?? []).length > 0;
    },
  };
}

// a code check is rare, a heartbeat routine; each has its own bucket, keyed by the Mac when the body names one
const checkLimiter = createLimiter({ max: 30 });
const heartbeatLimiter = createLimiter({ max: 600 });
const limitKey = (req, b) => String(b?.machineId ?? '').trim().slice(0, 120) || clientAddress(req);

const refuse = (res, err, cors, log, what) => {
  const status = err instanceof RelayError ? err.status : 500;
  log(`${what}_failed`, { status, message: err.message });
  json(res, status, { ok: false, reason: err.code ?? 'server', error: err instanceof RelayError ? err.message : 'Something went wrong. Try again.' }, cors);
};

export async function handleBetaCheck(req, res, { clients, config, log = () => {}, store = betaStore(clients.db) }) {
  const cors = corsHeaders(req.headers.origin, config.corsOrigins);
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  try {
    if (req.method !== 'POST') throw new RelayError('bad_request', 'POST only.', 405);
    const b = await readJson(req, 16 * 1024);
    if (!checkLimiter.allow(limitKey(req, b))) throw new RelayError('rate_limit', 'Too many attempts. Try again in an hour.', 429);
    const c = cleanCheck(b);
    const row = await store.code(c.code);
    const installs = row ? await store.installs(row.id) : [];
    const d = betaDecision({ row, installs, machineId: c.machineId, edition: c.edition });
    if (!d.ok) { log('beta_refused', { reason: d.reason, edition: c.edition }); return json(res, 200, { ok: false, reason: d.reason, error: d.message }, cors); }
    // bind before recording the install, so a Mac that lost the race leaves no row behind
    if (d.bind && !(await store.redeemLocal({ codeId: row.id, machineId: c.machineId }))) {
      log('beta_refused', { reason: 'used', edition: c.edition, race: true });
      return json(res, 200, { ok: false, reason: 'used', error: USED }, cors);
    }
    await store.upsert({ codeId: row.id, email: row.email, machineId: c.machineId, edition: c.edition, version: c.version });
    log('beta_admitted', { plan: d.plan, edition: c.edition, version: c.version, bound: d.bind });
    json(res, 200, { ok: true, plan: d.plan }, cors);
  } catch (err) { refuse(res, err, cors, log, 'beta_check'); }
}

export async function handleBetaHeartbeat(req, res, { clients, config, log = () => {}, store = betaStore(clients.db) }) {
  const cors = corsHeaders(req.headers.origin, config.corsOrigins);
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  try {
    if (req.method !== 'POST') throw new RelayError('bad_request', 'POST only.', 405);
    const b = await readJson(req, 16 * 1024);
    if (!heartbeatLimiter.allow(limitKey(req, b))) throw new RelayError('rate_limit', 'Too many heartbeats. Slow down.', 429);
    const h = cleanHeartbeat(b);
    const row = await store.code(h.code);
    const installs = row ? await store.installs(row.id) : [];
    const d = heartbeatDecision({ row, installs, machineId: h.machineId });
    if (!d.ok) return json(res, 200, { ok: false, reason: d.reason }, cors);
    const seen = await store.touch({ codeId: row.id, machineId: h.machineId, version: h.version });
    json(res, 200, seen ? { ok: true } : { ok: false, reason: 'unknown' }, cors);
  } catch (err) { refuse(res, err, cors, log, 'beta_heartbeat'); }
}
