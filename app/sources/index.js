// Meeting sources wired to the app: the Sources page's IPC, Keychain-backed tokens, one MCP client per connected
// source, background import jobs with progress, and a timer that keeps connected sources in sync while Quorum runs.
// Edition-agnostic: a Local user connects Granola on their own account exactly like a Cloud user.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BY_ID, SOURCES, publicManifest } from './catalog.js';
import { setFrontmatterKey } from '../frontmatter.js';
import { adapterFor } from './adapters.js';
import { createJobs } from './jobs.js';
import { countTranscripts, syncTranscripts } from './transcripts.js';
import { createMcp } from './mcp.js';
import { connect as oauthConnect, discover, refresh as oauthRefresh } from './oauth.js';
import { createTokenStore } from './tokens.js';
import { detectRunners, runnersWithSource } from './runners.js';
import { SCHEDULES, dueFor, runImport } from './agent-import.js';

const SYNC_EVERY = 30 * 60 * 1000;

// ids already in the vault: every markdown note under the meetings folder that names a granola_id or source_id
export function scanExisting(root) {
  const ids = new Set();
  if (!root || !existsSync(root)) return ids;
  const walk = (dir, depth) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 3 && !e.name.startsWith('.')) walk(p, depth + 1); continue; }
      if (!e.name.endsWith('.md')) continue;
      let head;
      try { head = readFileSync(p, 'utf8').slice(0, 2000); } catch { continue; }
      if (!head.startsWith('---')) continue;
      for (const m of head.matchAll(/^(?:granola_id|source_id):\s*(\S+)\s*$/gm)) ids.add(m[1]);
    }
  };
  walk(root, 0);
  return ids;
}

export function createSources({ settings, saveSettings, toUI = () => {}, log = () => {}, meetingsDir, openExternal, openFresh = null, afterWrite = () => {}, keepKeys = (_prev, next) => next, store = createTokenStore(), version = '0', agentRuntime = null, detect = detectRunners }) {
  const conf = () => (settings.sources ??= {});
  const stateOf = (id) => (conf()[id] ??= { method: BY_ID[id]?.recommended ?? 'connect', connected: false, syncNotes: true, syncTranscripts: false, lastSyncAt: null, imported: 0 });
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

  // the runners on this Mac that already have a source's MCP server. Detection shells out, so it runs in the background
  // into a cache (at start, then once a minute while something asks); list() only ever reads the cache
  let runnersAt = 0, runnersCache = [], detecting = null;
  const refreshRunners = () => { if (detecting) return detecting; detecting = Promise.resolve().then(() => detect()).then((r) => { runnersCache = r ?? []; }, () => { runnersCache = []; }).finally(() => { runnersAt = Date.now(); detecting = null; }); return detecting; };
  const runners = () => { if (Date.now() - runnersAt > 60000) refreshRunners(); return runnersCache; };
  if (agentRuntime) refreshRunners();
  const agentInfo = (src) => {
    if (!agentRuntime) return null;
    const s = stateOf(src.id);
    const found = runnersWithSource(src, runners()).map((r) => ({
      id: r.id, name: r.name, server: r.server, installed: r.installed, project: r.project ?? null,
      // Claude Code and Codex get the quorum server for the run; Antigravity has to carry it in its own config
      writable: r.installed && (r.id !== 'antigravity' || r.hasQuorum),
      note: !r.installed ? `${r.name} has ${src.name} configured but is not on PATH` : r.id === 'antigravity' && !r.hasQuorum ? 'Add the quorum MCP server to Antigravity first' : null,
    }));
    return { runners: found, schedule: SCHEDULES.includes(s.agentSchedule) ? s.agentSchedule : 'off', runner: s.agentRunner ?? found.find((r) => r.writable)?.id ?? null, lastRunAt: s.agentLastRunAt ?? null, lastResult: s.agentLastResult ?? null };
  };
  const runAgentImport = (id, runnerId) => {
    const src = BY_ID[id];
    const info = agentInfo(src);
    const r = info?.runners.find((x) => x.id === (runnerId ?? info.runner));
    if (!r) return Promise.resolve({ error: 'No agent on this Mac has this source connected.' });
    if (!r.writable) return Promise.resolve({ error: r.note ?? `${r.name} cannot write notes back yet.` });
    const dir = folderFor(id);
    if (!dir) return Promise.resolve({ error: 'Pick a meeting notes folder in Settings › Memory first.' });
    return jobs.run(id, `Importing through ${r.name}`, async (progress) => {
      const s = stateOf(id);
      progress({ message: `${r.name} is reading ${src.name}. This spends your ${r.name} tokens.`, total: null });
      // a project-scoped server is reachable only from its project folder; the listing narrows to new meetings only once a run has caught up
      const result = await runImport({ runnerId: r.id, server: r.server, source: src, since: s.agentCaughtUp ? s.agentLastRunAt ?? null : null, quorum: agentRuntime, dir, cwd: r.project ?? null });
      s.agentRunner = r.id; s.agentLastRunAt = new Date().toISOString(); s.agentCaughtUp = !!result.caughtUp;
      s.agentLastResult = `${result.imported} imported, ${result.skipped} skipped`;
      saveSettings();
      log('sources', id, `agent import through ${r.id}: ${s.agentLastResult}`);
      if (result.imported) toUI('log', `${src.name}: ${result.imported} ${result.imported === 1 ? 'meeting' : 'meetings'} added to your notes through ${r.name}.`);
      return { listed: result.listed, imported: result.imported, skipped: result.skipped, failed: [] };
    });
  };
  const countNotes = (dir) => { try { return readdirSync(dir).filter((f) => f.endsWith('.md')).length; } catch { return 0; } };

  // the note carries the account it came from (source_account), so a team workspace can ask once per account whether
  // its meetings are shared. A re-import of a note already on disk keeps what keepKeys keeps of it (main.js: the
  // share choice, the confidential mark and the guardrail keys)
  const writeNote = (dir, id) => async (name, text, m) => {
    mkdirSync(dir, { recursive: true });
    let file = path.join(dir, name);
    // a second meeting with the same title on the same day keeps the first file and gets the id in its own name
    let prev = existsSync(file) ? readFileSync(file, 'utf8') : null;
    if (prev !== null && !prev.includes(m.id)) { file = path.join(dir, name.replace(/\.md$/, `-${m.id.slice(0, 8)}.md`)); prev = existsSync(file) ? readFileSync(file, 'utf8') : null; }
    const acct = stateOf(id).account;
    const own = acct && !/[\r\n]/.test(acct) ? setFrontmatterKey(text, 'source_account', JSON.stringify(String(acct))) : text;
    writeFileSync(file, keepKeys(prev, own));
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
    const adapter = adapterFor(src);
    const result = await adapter.sync({ mcp: mcpFor(id), existing, since: s.since ?? undefined, write: writeNote(dir, id), progress }).catch(dropIfUnknown);
    // extras run after the notes, so a failing transcript never costs a note
    if (s.syncTranscripts && adapter.transcript) {
      const t = await syncTranscripts({ adapter, mcp: mcpFor(id), dir, source: id, progress, afterWrite });
      result.transcripts = t;
      result.failed.push(...t.failed);
      log('sources', id, `transcripts: checked ${t.checked}, saved ${t.saved}, failed ${t.failed.length}`);
    }
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
    return { ...publicManifest(src), method: s.method, connected: !!s.connected, syncNotes: s.syncNotes !== false, syncTranscripts: !!s.syncTranscripts, transcripts: dir ? countTranscripts(dir) : 0, freshNext: !!s.freshNext, account: s.account ?? null, lastSyncAt: s.lastSyncAt, imported: s.imported ?? 0, folderPath: dir, notes: dir ? countNotes(dir) : 0, job: jobs.snapshot(src.id), agent: agentInfo(src) };
  });

  const fail = (err, fallback) => { log('sources', err?.message ?? err); return { error: err?.message && !/[{};]|ECONN|ENOTFOUND|fetch failed/i.test(err.message) ? err.message : fallback }; };

  const handlers = {
    'sources-list': () => list(),
    // Settings tab: sync on or off; off keeps the connection and the folder but imports nothing until it is on again
    'source-set-option': (id, patch = {}) => { if (!BY_ID[id]) return { error: 'Unknown source.' }; const s = stateOf(id); if (SCHEDULES.includes(patch.agentSchedule)) s.agentSchedule = patch.agentSchedule; if (typeof patch.agentRunner === 'string') s.agentRunner = patch.agentRunner; if (typeof patch.syncNotes === 'boolean') s.syncNotes = patch.syncNotes; if (typeof patch.syncTranscripts === 'boolean') s.syncTranscripts = patch.syncTranscripts; saveSettings(); return { ok: true }; },
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
        const verify = adapterFor(src).verify ? (tokens) => adapterFor(src).verify(createMcp({ url: src.url, token: async () => tokens.accessToken, clientInfo: { name: 'Quorum', version } })) : null;
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
    // the fallback: the person's own agent imports through the source's MCP server it already has
    'source-agent-import': async (id, runnerId = null) => { if (!BY_ID[id]) return { error: 'Unknown source.' }; if (jobs.running(id)) return { error: 'An import is already running.' }; const r = runAgentImport(id, runnerId); if (r && typeof r.then === 'function') { const first = await Promise.race([r, new Promise((res) => setTimeout(() => res(null), 50))]); if (first?.error) return first; r.catch(() => {}); } return { ok: true }; },
  };

  // connected sources sync on a timer; a run that fails is logged and tried again next time
  const tick = () => {
    for (const src of SOURCES) {
      const s = stateOf(src.id);
      if (s.connected && s.syncNotes !== false && !jobs.running(src.id)) runSync(src.id, 'Syncing').catch(() => {});
      // a scheduled agent import runs on the person's tokens, so only on the schedule they picked, only while Quorum is open
      else if (!s.connected && dueFor(s.agentSchedule, s.agentLastRunAt) && !jobs.running(src.id)) Promise.resolve(runAgentImport(src.id, s.agentRunner)).catch(() => {});
    }
  };
  const timer = setInterval(tick, SYNC_EVERY); timer.unref?.();
  setTimeout(tick, 20000).unref?.();

  return { handlers, list, runSync, jobs, stop: () => clearInterval(timer) };
}

export function registerSources({ ipcMain, ...deps }) {
  const s = createSources(deps);
  for (const [name, fn] of Object.entries(s.handlers)) ipcMain.handle(name, (_e, ...a) => fn(...a));
  return s;
}
