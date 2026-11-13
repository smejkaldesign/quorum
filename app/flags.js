// Feature flags: the switches the platform owner flips in the admin app (migration 0021), read by every install,
// both editions, from the relay (GET /v1/flags) on launch and every hour. Four sources, in order of precedence:
// QUORUM_FLAGS in the environment (a dev override), the relay's last answer, the copy cached in settings from an
// earlier run, and the defaults built into this file. Pure Node: the main process registers it; the tests call it
// with fake fetch and timers. Outside ee/ so the Local edition reads the same flags.
import { relayFetch, unreachable } from './relayUrl.js';

export const REFRESH_EVERY = 60 * 60 * 1000;

// every flag the app reads, with the value it holds before the relay answers. Keys match the seed rows in 0021.
export const DEFAULTS = Object.freeze({
  'meeting-capture': false,
  'live-assist': false,
  'manual-listen': true,
  'screen-context': true,
  dictation: false,
});
// the parent each flag needs, as 0021 seeds it; the relay's answer adds or replaces entries. A flag whose parent is
// off reads as off, whatever its own switch says
// (0021, 0022 and 0023). Every notetaker surface needs manual listening, so turning listening off turns them all off
export const REQUIRES = Object.freeze({ 'screen-context': 'manual-listen', 'meeting-capture': 'manual-listen', 'live-assist': 'manual-listen', dictation: 'manual-listen' });

// QUORUM_FLAGS="meeting-capture=1,live-assist=0": one assignment per flag; 1, true, on and yes turn it on, 0, false,
// off and no turn it off; anything else is ignored. A bare key means on.
export function parseEnvFlags(text) {
  const out = {};
  for (const part of String(text ?? '').split(',')) {
    const [k, v = '1'] = part.split('=').map((s) => s.trim().toLowerCase());
    if (!k) continue;
    if (['1', 'true', 'on', 'yes'].includes(v)) out[k] = true;
    else if (['0', 'false', 'off', 'no'].includes(v)) out[k] = false;
  }
  return out;
}

// the switches from a relay answer or a cache, booleans only
export const cleanFlags = (obj) => Object.fromEntries(Object.entries(obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {}).filter(([k, v]) => typeof k === 'string' && typeof v === 'boolean'));

// a relay body the app accepts: `flags` is an object with at least one key and every value a boolean. Anything else
// (an empty set, an error page, a value of another type) counts as a failed read, so the cache is never emptied
export function acceptFlagsBody(body) {
  const f = body?.flags;
  if (!f || typeof f !== 'object' || Array.isArray(f)) return null;
  const entries = Object.entries(f);
  if (entries.length === 0 || entries.some(([, v]) => typeof v !== 'boolean')) return null;
  return Object.fromEntries(entries);
}

// { key: parent } with string values only, a flag never its own parent
export const cleanRequires = (obj) => Object.fromEntries(Object.entries(obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {}).filter(([k, v]) => typeof v === 'string' && v && v !== k));

// every known key with its value and where that value came from. `enabled` is the effective value: a flag whose
// parent (requires) is off reads off and names the parent in `blockedBy`; `own` is its own switch
export function resolveFlags({ defaults = DEFAULTS, cache = {}, relay = null, env = {}, requires = REQUIRES } = {}) {
  const own = {};
  const envFlags = parseEnvFlags(env.QUORUM_FLAGS);
  const keys = new Set([...Object.keys(defaults), ...Object.keys(cache), ...Object.keys(relay ?? {}), ...Object.keys(envFlags)]);
  for (const key of keys) {
    if (key in envFlags) own[key] = { enabled: envFlags[key], source: 'env' };
    else if (relay && key in relay) own[key] = { enabled: relay[key], source: 'relay' };
    else if (key in cache) own[key] = { enabled: cache[key], source: 'cache' };
    else own[key] = { enabled: defaults[key] === true, source: 'defaults' };
  }
  // walk up the parents; a missing parent counts as off, and a loop stops after one pass over the keys
  const offParent = (key) => {
    const seen = new Set([key]);
    for (let p = requires[key]; p; p = requires[p]) {
      if (seen.has(p)) return null;
      seen.add(p);
      if (own[p]?.enabled !== true) return p;
    }
    return null;
  };
  const out = {};
  for (const [key, v] of Object.entries(own)) {
    const blockedBy = v.enabled ? offParent(key) : null;
    out[key] = blockedBy ? { enabled: false, source: v.source, own: true, blockedBy, requires: requires[key] } : { ...v, ...(requires[key] ? { requires: requires[key] } : {}) };
  }
  return out;
}

export function createFlags({ settings, saveSettings = () => {}, source = () => 'production', env = process.env, fetchImpl = globalThis.fetch, log = () => {}, now = Date.now, timers = { set: setTimeout, clear: clearTimeout }, emit = () => {}, defaults = DEFAULTS, refreshEvery = REFRESH_EVERY }) {
  let relay = null;
  let relayRequires = null;
  let lastError = null;
  const cache = () => cleanFlags(settings.flags?.cache);
  const requires = () => ({ ...REQUIRES, ...cleanRequires(relayRequires ?? settings.flags?.requires) });
  const all = () => resolveFlags({ defaults, cache: cache(), relay, env, requires: requires() });
  const get = (key) => all()[key]?.enabled === true;
  const state = () => ({ flags: all(), fetchedAt: settings.flags?.fetchedAt ?? null, source: (typeof source === 'function' ? source() : source) ?? 'production', error: lastError });

  // one GET, the public relay then its fallback on a connection-level failure; a failure keeps what we had
  async function refresh() {
    try {
      // QUORUM_FLAGS_RELAY points only the flag read at another relay, so a development copy on the local stack follows
      // the flags set in the hosted admin app while its other relay calls stay on this Mac
      const flagsEnv = env.QUORUM_FLAGS_RELAY ? { ...env, QUORUM_RELAY_URL: env.QUORUM_FLAGS_RELAY } : env;
      const res = await relayFetch('/v1/flags', { method: 'GET', headers: { accept: 'application/json' } }, { env: flagsEnv, source, fetchImpl });
      if (!res.ok) throw new Error(`The relay answered ${res.status}`);
      const body = await res.json().catch(() => null);
      const accepted = acceptFlagsBody(body);
      if (!accepted) throw new Error('The relay sent no flags.');
      relay = accepted;
      relayRequires = cleanRequires(body.requires);
      lastError = null;
      settings.flags = { cache: accepted, requires: relayRequires, fetchedAt: now() };
      saveSettings();
      emit(state());
      return { ok: true, flags: all() };
    } catch (err) {
      log('flags refresh', err?.message ?? err);
      lastError = unreachable(err) ? 'Quorum could not reach the server.' : String(err?.message || 'The flags could not be read.');
      emit(state());
      return { ok: false, flags: all(), error: lastError };
    }
  }

  let timer = null;
  let stopped = false;
  const clear = () => { if (timer) timers.clear(timer); timer = null; };
  const tick = async () => { timer = null; if (stopped) return; await refresh(); if (!stopped && !timer) arm(refreshEvery); };
  const arm = (ms) => { clear(); timer = timers.set(tick, ms); timer?.unref?.(); };
  function start() { stopped = false; arm(0); }
  function stop() { stopped = true; clear(); }

  const handlers = {
    flags: () => state(),
    // the state with ok and the reason a read failed; the cached values and the last good read time stay
    'flags-refresh': async () => { const r = await refresh(); return { ...state(), ok: r.ok, error: r.ok ? null : r.error }; },
  };
  return { get, all, state, refresh, start, stop, handlers };
}

// one line at startup saying where each flag's value came from; values are not secrets, keys are stable
export const describeFlags = (flags) => Object.entries(flags).map(([k, v]) => `${k}=${v.enabled ? 'on' : 'off'} (${v.source}${v.blockedBy ? `, needs ${v.blockedBy}` : ''})`).join(', ');

export function registerFlags({ ipcMain, settings, saveSettings, source, log, emit }) {
  const flags = createFlags({ settings, saveSettings, source, log, emit });
  for (const [name, fn] of Object.entries(flags.handlers)) ipcMain.handle(name, (_e, ...a) => fn(...a));
  log('flags', describeFlags(flags.all()));
  flags.start();
  return flags;
}
