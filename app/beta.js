// The beta gate: while Quorum is in early beta, an install needs an access code before it does anything. The code is
// checked by the relay (POST /v1/beta/check) and kept in settings with an anonymous machine id; once a day the
// install reports code, machine id and version (POST /v1/beta/heartbeat) so active installs can be counted. The gate
// shows whenever no accepted code is stored, in both editions, including installs that onboarded before it existed.
// Pure Node: the main process registers it; the tests call it with fake fetch and timers.
import { randomUUID } from 'node:crypto';

export const DEFAULT_RELAY = 'https://relay.quorum.watch';
export const LOCAL_RELAY = 'http://127.0.0.1:8787';
export const HEARTBEAT_EVERY = 24 * 60 * 60 * 1000;
const CODE = /^[A-Z0-9]{4}-?[A-Z0-9]{4}$/;

// the build-time switch: QUORUM_BETA_GATE in the environment wins (0, false, off turn it off), then the packaged
// package.json's quorumBetaGate, and the gate is on when neither says otherwise
export function gateOn({ env = process.env, pkg = {} } = {}) {
  const v = String(env.QUORUM_BETA_GATE ?? '').trim().toLowerCase();
  if (v) return !['0', 'false', 'off', 'no'].includes(v);
  return pkg.quorumBetaGate !== false;
}

// where the relay is reached over HTTP: QUORUM_RELAY_URL (ws or http form) wins, a copy on the local Supabase stack
// talks to a relay on this Mac, everything else to Quorum's
export function relayHttp({ env = process.env, source = 'production' } = {}) {
  const u = String(env.QUORUM_RELAY_URL ?? '').trim().replace(/\/+$/, '');
  if (u) return u.replace(/^ws(s?):\/\//, 'http$1://');
  return source === 'local' ? LOCAL_RELAY : DEFAULT_RELAY;
}

export const normalizeCode = (code) => String(code ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().replace(/^(.{4})(.{4})$/, '$1-$2');

// what the renderer sees: whether the gate stands, the accepted code and plan, and the id this install reports under
export function betaState(settings, on) {
  const b = settings.beta ?? {};
  return { gate: on === true && !b.code, on: on === true, code: b.code ?? null, plan: b.plan ?? null, acceptedAt: b.acceptedAt ?? null, machineId: settings.machineId ?? null, lastHeartbeatAt: b.lastHeartbeatAt ?? null };
}

// how long until the next heartbeat is due: at once when none was sent, otherwise a day after the last one
export const nextHeartbeatIn = (lastAt, now = Date.now()) => (lastAt ? Math.max(0, lastAt + HEARTBEAT_EVERY - now) : 0);

export function createBeta({ settings, saveSettings = () => {}, on = true, edition = 'local', version = '0.0.0', relay = DEFAULT_RELAY, email = () => null, fetchImpl = globalThis.fetch, log = () => {}, now = Date.now, timers = { set: setTimeout, clear: clearTimeout } }) {
  const relayOf = () => (typeof relay === 'function' ? relay() : relay);
  const machineId = () => {
    if (!settings.machineId) { settings.machineId = randomUUID(); saveSettings(); }
    return settings.machineId;
  };
  const post = async (path, body) => {
    const res = await fetchImpl(`${relayOf()}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok && json.ok === undefined) throw new Error(json.error || json.reason || `The relay answered ${res.status}`);
    return json;
  };
  const status = () => betaState(settings, on);

  // the code the person typed: the relay says whether it is good and which plan it carries; an accepted code is kept
  async function check(code, mail = null) {
    const c = normalizeCode(code);
    if (!CODE.test(c)) return { ok: false, reason: 'Enter the 8-character code, like ABCD-EFGH.' };
    try {
      const r = await post('/v1/beta/check', { code: c, email: mail || email() || undefined, machineId: machineId(), edition, version });
      if (r.ok !== true) return { ok: false, reason: r.reason || r.error || 'That code was not accepted.' };
      settings.beta = { ...(settings.beta ?? {}), code: c, plan: r.plan ?? 'free', acceptedAt: new Date(now()).toISOString() };
      saveSettings();
      log('beta', 'code accepted', r.plan ?? 'free');
      return { ok: true, plan: settings.beta.plan };
    } catch (err) {
      log('beta check', err?.message ?? err);
      return { ok: false, reason: /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(String(err?.message)) ? 'Quorum could not reach the server. Check your connection and try again.' : String(err?.message || 'That code could not be checked.') };
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

  let timer = null;
  let stopped = false;
  const tick = async () => {
    timer = null;
    if (stopped) return;
    await heartbeat();
    if (!stopped) arm(HEARTBEAT_EVERY);
  };
  const arm = (ms) => { timer = timers.set(tick, ms); timer?.unref?.(); };
  // the schedule: the first beat waits for a day after the last recorded one, so a relaunch within the day sends nothing
  function start() {
    stopped = false;
    if (!on) return;
    arm(nextHeartbeatIn(settings.beta?.lastHeartbeatAt ?? null, now()));
  }
  function stop() { stopped = true; if (timer) timers.clear(timer); timer = null; }

  const handlers = {
    'beta-status': () => status(),
    'beta-check': async (code, mail) => { const r = await check(code, mail); if (r.ok) start(); return { ...r, status: status() }; },
  };
  return { status, check, heartbeat, start, stop, machineId, handlers };
}

export function registerBeta({ ipcMain, settings, saveSettings, on, edition, version, relay, email, log }) {
  const beta = createBeta({ settings, saveSettings, on, edition, version, relay, email, log });
  for (const [name, fn] of Object.entries(beta.handlers)) ipcMain.handle(name, (_e, ...a) => fn(...a));
  beta.start();
  const s = beta.status();
  log('beta', on ? (s.gate ? 'gate up, no code yet' : `code accepted (${s.plan})`) : 'gate off');
  return beta;
}
