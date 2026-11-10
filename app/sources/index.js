// Meeting sources wired to the app: the Sources page's IPC, Keychain-backed tokens, one MCP client per connected
// source, background import jobs with progress, and a timer that keeps connected sources in sync while Quorum runs.
// Edition-agnostic: a Local user connects Granola on their own account exactly like a Cloud user.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BY_ID, SOURCES, publicManifest } from './catalog.js';
import * as granola from './granola.js';
import { createJobs } from './jobs.js';
import { createMcp } from './mcp.js';
import { connect as oauthConnect, discover, refresh as oauthRefresh } from './oauth.js';
import { createTokenStore } from './tokens.js';

const ADAPTERS = { granola };
const SYNC_EVERY = 30 * 60 * 1000;

// ids already in the vault: every markdown note under the meetings folder that names a granola_id or source_id
export function scanExisting(root) {
  const ids = new Set();
  if (!root || !existsSync(root)) return ids;
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 3 && !e.name.startsWith('.')) walk(p, depth + 1); continue; }
      if (!e.name.endsWith('.md')) continue;
      let head = '';
      try { head = readFileSync(p, 'utf8').slice(0, 2000); } catch { continue; }
      if (!head.startsWith('---')) continue;
      for (const m of head.matchAll(/^(?:granola_id|source_id):\s*(\S+)\s*$/gm)) ids.add(m[1]);
    }
  };
  walk(root, 0);
  return ids;
}

export function createSources({ settings, saveSettings, toUI = () => {}, log = () => {}, meetingsDir, openExternal, openFresh = null, afterWrite = () => {}, store = createTokenStore(), version = '0' }) {
  const conf = () => (settings.sources ??= {});
  const stateOf = (id) => (conf()[id] ??= { method: BY_ID[id]?.recommended ?? 'connect', connected: false, syncNotes: true, lastSyncAt: null, imported: 0 });
  const jobs = createJobs({ emit: (job) => toUI('source-job', job) });
  const clients = {};
  const metaCache = {};

  // the bearer for a source: the saved token, refreshed when it is within a minute of expiring
  const tokenFor = async (id, force = false) => {
    const t = await store.tokens.get(id);
    if (!t) return null;
    const stale = force || (t.expiresAt && t.expiresAt - Date.now() < 60000);
    if (!stale || !t.refreshToken) return t.accessToken;
    const src = BY_ID[id];
    metaCache[src.url] ??= await discover(src.url);
    const client = await store.clients.get(metaCache[src.url].issuer);
    if (!client) return t.accessToken;
    try {
      const fresh = await oauthRefresh(metaCache[src.url], client, t.refreshToken);
      await store.tokens.set(id, fresh);
      return fresh.accessToken;
    } catch (err) { log('sources refresh', id, err.message); return t.accessToken; }
  };
  const mcpFor = (id) => {
    const src = BY_ID[id];
    clients[id] ??= createMcp({ url: src.url, token: () => tokenFor(id), onUnauthorized: () => tokenFor(id, true), clientInfo: { name: 'Quorum', version } });
    return clients[id];
  };

  const folderFor = (id) => { const root = meetingsDir(); return root ? path.join(root, BY_ID[id].folder) : null; };
  const countNotes = (dir) => { try { return readdirSync(dir).filter((f) => f.endsWith('.md')).length; } catch { return 0; } };

  const writeNote = (dir) => async (name, text, m) => {
    mkdirSync(dir, { recursive: true });
    let file = path.join(dir, name);
    // a second meeting with the same title on the same day keeps the first file and gets the id in its own name
    if (existsSync(file) && !readFileSync(file, 'utf8').includes(m.id)) file = path.join(dir, name.replace(/\.md$/, `-${m.id.slice(0, 8)}.md`));
    writeFileSync(file, text);
    afterWrite(file);
    return file;
  };

  const runSync = (id, label = 'Importing') => jobs.run(id, label, async (progress) => {
    const src = BY_ID[id];
    const s0 = stateOf(id);
    const dropIfUnknown = async (err) => { if (/No Granola account|no .* account for this sign-in/i.test(err?.message ?? '')) { await store.tokens.set(id, null); s0.connected = false; saveSettings(); delete clients[id]; } throw err; };
    const dir = folderFor(id);
    if (!dir) throw new Error('Pick a meeting notes folder in Settings › Memory first.');
    const s = stateOf(id);
    const existing = scanExisting(meetingsDir());
    progress({ message: 'Checking Granola', total: null });
    const result = await ADAPTERS[src.adapter].sync({ mcp: mcpFor(id), existing, since: s.since ?? undefined, write: writeNote(dir), progress }).catch(dropIfUnknown);
    s.lastSyncAt = new Date().toISOString();
    s.imported = (s.imported ?? 0) + result.imported;
    saveSettings();
    log('sources', id, `listed ${result.listed}, imported ${result.imported}, skipped ${result.skipped}, failed ${result.failed.length}`);
    if (result.failed.length) progress({ failed: result.failed });
    if (result.imported) toUI('log', `${src.name}: ${result.imported} ${result.imported === 1 ? 'meeting' : 'meetings'} added to your notes.`);
    return result;
  });

  const list = () => SOURCES.map((src) => {
    const s = stateOf(src.id);
    const dir = folderFor(src.id);
    return { ...publicManifest(src), method: s.method, connected: !!s.connected, syncNotes: s.syncNotes !== false, freshNext: !!s.freshNext, account: s.account ?? null, lastSyncAt: s.lastSyncAt, imported: s.imported ?? 0, folderPath: dir, notes: dir ? countNotes(dir) : 0, job: jobs.snapshot(src.id) };
  });

  const fail = (err, fallback) => { log('sources', err?.message ?? err); return { error: err?.message && !/[{};]|ECONN|ENOTFOUND|fetch failed/i.test(err.message) ? err.message : fallback }; };

  const handlers = {
    'sources-list': () => list(),
    // Settings tab: sync on or off; off keeps the connection and the folder but imports nothing until it is on again
    'source-set-option': (id, patch = {}) => { if (!BY_ID[id]) return { error: 'Unknown source.' }; const s = stateOf(id); if (typeof patch.syncNotes === 'boolean') s.syncNotes = patch.syncNotes; saveSettings(); return { ok: true }; },
    'source-set-method': (id, method) => { const src = BY_ID[id]; if (!src || !src.methods.includes(method)) return { error: 'Unknown method.' }; stateOf(id).method = method; saveSettings(); return { ok: true }; },
    // the browser flow; when it lands the first import starts on its own and the card shows progress
    // fresh: the default browser's session would be reused (that is how a wrong account gets connected twice), so the
    // sign-in opens in a window Quorum owns with a throwaway session (main.js openFresh); the link also goes to the UI
    'source-connect': async (id, opts = {}) => {
      const src = BY_ID[id];
      if (!src || src.kind !== 'mcp') return { error: 'Unknown source.' };
      const s = stateOf(id);
      const open = (opts.fresh || s.freshNext) && openFresh
        ? async (url) => { log('sources', id, 'sign-in in a fresh window'); toUI('source-auth-link', { id, url, opened: 'window' }); await openFresh(url, src.name); }
        : async (url) => { log('sources', id, 'sign-in in the default browser'); await openExternal(url); };
      try {
        // the sign-in has to be an account the service knows, or nothing is kept; the browser tab learns the outcome too
        const verify = ADAPTERS[src.adapter].verify ? (tokens) => ADAPTERS[src.adapter].verify(createMcp({ url: src.url, token: async () => tokens.accessToken, clientInfo: { name: 'Quorum', version } })) : null;
        const { meta, tokens } = await oauthConnect({ resourceUrl: src.url, open, clients: store.clients, verify, name: src.name });
        metaCache[src.url] = meta;
        await store.tokens.set(id, tokens);
        s.connected = true; s.method = 'connect'; s.connectedAt = new Date().toISOString(); s.freshNext = false; s.account = tokens.email ?? null; saveSettings();
        delete clients[id];
        runSync(id, 'Importing').catch(() => {});
        return { ok: true };
      } catch (err) { if (err.code === 'wrong-account') { s.freshNext = true; saveSettings(); log('sources', id, 'sign-in refused:', err.message); return { error: err.message, wrongAccount: true }; } return fail(err, `Quorum could not connect to ${src.name}. Check your connection and try again.`); }
    },
    'source-disconnect': async (id) => {
      if (!BY_ID[id]) return { error: 'Unknown source.' };
      await store.tokens.set(id, null);
      delete clients[id];
      const s = stateOf(id); s.connected = false; saveSettings();
      return { ok: true };
    },
    'source-sync': async (id) => {
      if (!BY_ID[id]) return { error: 'Unknown source.' };
      if (!stateOf(id).connected) return { error: 'Connect first.' };
      if (stateOf(id).syncNotes === false) return { error: 'Sync is off for this connector. Turn it on under Settings.' };
      runSync(id, 'Syncing').catch(() => {});
      return { ok: true };
    },
    'source-open-folder': (id) => folderFor(id),
  };

  // connected sources sync on a timer; a run that fails is logged and tried again next time
  const tick = () => { for (const src of SOURCES) if (stateOf(src.id).connected && stateOf(src.id).syncNotes !== false && !jobs.running(src.id)) runSync(src.id, 'Syncing').catch(() => {}); };
  const timer = setInterval(tick, SYNC_EVERY); timer.unref?.();
  setTimeout(tick, 20000).unref?.();

  return { handlers, list, runSync, jobs, stop: () => clearInterval(timer) };
}

export function registerSources({ ipcMain, ...deps }) {
  const s = createSources(deps);
  for (const [name, fn] of Object.entries(s.handlers)) ipcMain.handle(name, (_e, ...a) => fn(...a));
  return s;
}
