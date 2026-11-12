// Feature flags: the switches the platform owner flips in the admin app (migration 0021), read by every install,
// both editions, from the relay (GET /v1/flags) on launch and every hour. Four sources, in order of precedence:
// QUORUM_FLAGS in the environment (a dev override), the relay's last answer, the copy cached in settings from an
// earlier run, and the defaults built into this file. Pure Node: the main process registers it; the tests call it
// with fake fetch and timers. Outside ee/ so the Local edition reads the same flags.
import { httpUrl, relayUrls, unreachable } from './relayUrl.js';

export const REFRESH_EVERY = 60 * 60 * 1000;

// every flag the app reads, with the value it holds before the relay answers. Keys match the seed rows in 0021.
export const DEFAULTS = Object.freeze({
  'meeting-capture': false,
  'live-assist': false,
  'manual-listen': true,
});

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
export const cleanFlags = (obj) => Object.fromEntries(Object.entries(obj && typeof obj === 'object' ? obj : {}).filter(([k, v]) => typeof k === 'string' && typeof v === 'boolean'));

// every known key with its value and where that value came from
export function resolveFlags({ defaults = DEFAULTS, cache = {}, relay = null, env = {} } = {}) {
  const out = {};
  const envFlags = parseEnvFlags(env.QUORUM_FLAGS);
  const keys = new Set([...Object.keys(defaults), ...Object.keys(cache), ...Object.keys(relay ?? {}), ...Object.keys(envFlags)]);
  for (const key of keys) {
    if (key in envFlags) out[key] = { enabled: envFlags[key], source: 'env' };
    else if (relay && key in relay) out[key] = { enabled: relay[key], source: 'relay' };
    else if (key in cache) out[key] = { enabled: cache[key], source: 'cache' };
    else out[key] = { enabled: defaults[key] === true, source: 'defaults' };
  }
  return out;
}

export function createFlags({ settings, saveSettings = () => {}, source = () => 'production', env = process.env, fetchImpl = globalThis.fetch, log = () => {}, now = Date.now, timers = { set: setTimeout, clear: clearTimeout }, emit = () => {}, defaults = DEFAULTS, refreshEvery = REFRESH_EVERY }) {
  let relay = null;
  const cache = () => cleanFlags(settings.flags?.cache);
  const all = () => resolveFlags({ defaults, cache: cache(), relay, env });
  const get = (key) => all()[key]?.enabled === true;
  const state = () => ({ flags: all(), fetchedAt: settings.flags?.fetchedAt ?? null, source: (typeof source === 'function' ? source() : source) ?? 'production' });

  // one GET, the public relay then its fallback on a connection-level failure; a failure keeps what we had
  async function refresh() {
    const urls = relayUrls({ env, source: (typeof source === 'function' ? source() : source) ?? 'production' });
    try {
      let res = null;
      for (const url of urls) {
        try { res = await fetchImpl(`${httpUrl(url)}/v1/flags`, { method: 'GET', headers: { accept: 'application/json' } }); break; }
        catch (err) { if (unreachable(err) && url !== urls[urls.length - 1]) continue; throw err; }
      }
      if (!res.ok) throw new Error(`The relay answered ${res.status}`);
      const body = await res.json();
      relay = cleanFlags(body?.flags);
      settings.flags = { cache: relay, fetchedAt: now() };
      saveSettings();
      emit(state());
      return { ok: true, flags: all() };
    } catch (err) {
      log('flags refresh', err?.message ?? err);
      return { ok: false, flags: all(), error: unreachable(err) ? 'Quorum could not reach the server.' : String(err?.message || 'The flags could not be read.') };
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
    'flags-refresh': async () => { await refresh(); return state(); },
  };
  return { get, all, state, refresh, start, stop, handlers };
}

// one line at startup saying where each flag's value came from; values are not secrets, keys are stable
export const describeFlags = (flags) => Object.entries(flags).map(([k, v]) => `${k}=${v.enabled ? 'on' : 'off'} (${v.source})`).join(', ');

export function registerFlags({ ipcMain, settings, saveSettings, source, log, emit }) {
  const flags = createFlags({ settings, saveSettings, source, log, emit });
  for (const [name, fn] of Object.entries(flags.handlers)) ipcMain.handle(name, (_e, ...a) => fn(...a));
  log('flags', describeFlags(flags.all()));
  flags.start();
  return flags;
}
