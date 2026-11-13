// The beta gate: while Quorum is in early beta, an install needs an access code before it does anything. The code is
// checked by the relay (POST /v1/beta/check) and kept in settings with an anonymous machine id; once a day the
// install reports code, machine id and version (POST /v1/beta/heartbeat) so active installs can be counted. The gate
// shows whenever no accepted code is stored, in both editions, including installs that onboarded before it existed.
// Pure Node: the main process registers it; the tests call it with fake fetch and timers.
import { randomUUID } from 'node:crypto';
import { CODE, LENGTH_MESSAGE, definiteRefusal, normalizeCode } from './betaCode.js';
import { relayFetch, unreachable } from './relayUrl.js';

export const HEARTBEAT_EVERY = 24 * 60 * 60 * 1000;
export { normalizeCode };

// the build-time switch: QUORUM_BETA_GATE in the environment wins (0, false, off turn it off; 1 turns it on in a
// development copy to test it), a development copy skips the gate otherwise, then the packaged package.json's
// quorumBetaGate, and the gate is on when none of these says otherwise
export function gateOn({ env = process.env, pkg = {}, development = false } = {}) {
  const v = String(env.QUORUM_BETA_GATE ?? '').trim().toLowerCase();
  if (v) return !['0', 'false', 'off', 'no'].includes(v);
  if (development) return false;
  return pkg.quorumBetaGate !== false;
}

// what the renderer sees: whether the gate stands, the accepted code, its plan and the email it was issued to (Cloud
// edition only), and the id this install reports under
export function betaState(settings, on) {
  const b = settings.beta ?? {};
  return { gate: on === true && !b.code, on: on === true, code: b.code ?? null, plan: b.plan ?? null, email: b.email ?? null, acceptedAt: b.acceptedAt ?? null, machineId: settings.machineId ?? null, lastHeartbeatAt: b.lastHeartbeatAt ?? null };
}

// the sentence shown when a code for one person was entered while another account was signed in on this Mac
export const switchedMessage = (from, to) => `You were signed in as ${from}. Quorum signed you out so you can sign in as ${to}, the email this code was issued to.`;

// how long until the next heartbeat is due: at once when none was sent, otherwise a day after the last one
export const nextHeartbeatIn = (lastAt, now = Date.now()) => (lastAt ? Math.max(0, lastAt + HEARTBEAT_EVERY - now) : 0);

// `source` is which Supabase config the account runs on (relayUrl.js): a copy on the local stack talks to a relay on
// this Mac, everything else to Quorum's, with its fallback address tried on a connection-level failure
export const CHECK_TIMEOUT = 15000;
export const OFFLINE = 'Quorum could not reach the server. Try again.';

// `account` (Cloud edition only) is { email(), signOut() }: the signed-in account's email or null, and a local sign-out.
// In the Cloud edition the account is the identity. A signed-in account passed the sign-up gate on auth.users
// (migrations 0009, 0018), so no code is asked of it; without one, the code leads to sign-in as the email it was
// issued to, and an account of another email that is signed in when the code is entered is signed out first
export function createBeta({ settings, saveSettings = () => {}, account = null, on = true, edition = 'local', version = '0.0.0', source = () => 'production', env = process.env, fetchImpl = globalThis.fetch, log = () => {}, now = Date.now, timers = { set: setTimeout, clear: clearTimeout }, timeout = CHECK_TIMEOUT }) {
  const machineId = () => {
    if (!settings.machineId) { settings.machineId = randomUUID(); saveSettings(); }
    return settings.machineId;
  };
  const post = async (path, body, ms = null) => {
    const signal = ms && typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(ms) : undefined;
    const res = await relayFetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...(signal ? { signal } : {}) }, { env, source, fetchImpl });
    const json = await res.json().catch(() => ({}));
    if (!res.ok && json.ok === undefined) throw new Error(json.error || json.reason || `The relay answered ${res.status}`);
    return json;
  };
  const status = () => betaState(settings, on);
  const accountEmail = async () => {
    if (!account) return null;
    try { const e = await account.email(); return e ? String(e).toLowerCase() : null; } catch (err) { log('beta account', err?.message ?? err); return null; }
  };
  // the renderer's reading: the gate stands down for a signed-in Cloud account
  async function gateStatus() {
    const s = status();
    if (!s.gate || !account) return s;
    return (await accountEmail()) ? { ...s, gate: false, signedIn: true } : s;
  }

  // the code the person typed, and nothing else: the relay says whether it is good and which plan it carries; an
  // accepted code is kept. `reason` is the sentence to show; `refused` is true when the code itself was turned down
  // (so the screen clears it) and false when the relay could not be reached or answered with an error
  async function check(code) {
    const c = normalizeCode(code);
    if (!CODE.test(c)) return { ok: false, refused: true, reason: LENGTH_MESSAGE };
    try {
      const r = await post('/v1/beta/check', { code: c, machineId: machineId(), edition, version }, timeout);
      if (r.ok !== true) return { ok: false, refused: definiteRefusal(r.reason), reason: r.error || r.reason || 'That code was not accepted.' };
      const email = edition === 'cloud' && typeof r.email === 'string' && r.email ? r.email.toLowerCase() : null;
      settings.beta = { ...(settings.beta ?? {}), code: c, plan: r.plan ?? 'free', email, acceptedAt: new Date(now()).toISOString() };
      saveSettings();
      log('beta', 'code accepted', r.plan ?? 'free');
      // a code is one person's: an account of another email signed in on this Mac is signed out before going on
      let notice = null;
      const current = email ? await accountEmail() : null;
      if (current && current !== email) {
        try { await account.signOut(); } catch (err) { log('beta sign-out', err?.message ?? err); }
        notice = switchedMessage(current, email);
        log('beta', 'signed out a different account for the code email');
      }
      return { ok: true, plan: settings.beta.plan, email, notice };
    } catch (err) {
      log('beta check', err?.message ?? err);
      const offline = unreachable(err) || err?.name === 'TimeoutError' || err?.name === 'AbortError';
      return { ok: false, refused: false, reason: offline ? OFFLINE : String(err?.message || 'That code could not be checked.') };
    }
  }

  // once per launch and once a day while running; nothing is sent before a code was accepted
  async function heartbeat() {
    if (!on || !settings.beta?.code) return { ok: false, skipped: true };
    try {
      const r = await post('/v1/beta/heartbeat', { code: settings.beta.code, machineId: machineId(), version, edition });
      settings.beta = { ...settings.beta, lastHeartbeatAt: now() };
      saveSettings();
      return { ok: r.ok === true };
    } catch (err) { log('beta heartbeat', err?.message ?? err); return { ok: false }; }
  }

  // one timer at a time: arm() clears whatever is pending, so start() can be called again without a second cycle
  let timer = null;
  let stopped = false;
  const clear = () => { if (timer) timers.clear(timer); timer = null; };
  const tick = async () => {
    timer = null;
    if (stopped) return;
    await heartbeat();
    if (!stopped && !timer) arm(HEARTBEAT_EVERY);
  };
  const arm = (ms) => { clear(); timer = timers.set(tick, ms); timer?.unref?.(); };
  // the schedule: the first beat waits for a day after the last recorded one, so a relaunch within the day sends nothing
  function start() {
    stopped = false;
    if (!on) return;
    arm(nextHeartbeatIn(settings.beta?.lastHeartbeatAt ?? null, now()));
  }
  function stop() { stopped = true; clear(); }

  const handlers = {
    'beta-status': () => gateStatus(),
    'beta-check': async (code) => { const r = await check(code); if (r.ok) start(); return { ...r, status: status() }; },
  };
  return { status, gateStatus, check, heartbeat, start, stop, machineId, handlers };
}

export function registerBeta({ ipcMain, settings, saveSettings, account = null, on, edition, version, source, log }) {
  const beta = createBeta({ settings, saveSettings, account, on, edition, version, source, log });
  for (const [name, fn] of Object.entries(beta.handlers)) ipcMain.handle(name, (_e, ...a) => fn(...a));
  beta.start();
  const s = beta.status();
  log('beta', on ? (s.gate ? 'gate up, no code yet' : `code accepted (${s.plan})`) : 'gate off');
  return beta;
}
