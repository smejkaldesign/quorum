// The KB sync worker (docs/specs/workspace-knowledge.md, "Where sync runs"; migration 0032). A loop in the relay
// process, or in its own Railway service through relay/kbSyncWorker.js. Every tick it:
//   1. revokes ended grants with their providers (kb_sync_revocations, then kb_sync_revoked),
//   2. claims the attachments that are due under a lease (kb_sync_claim; a second relay instance skips leased rows, and
//      no workspace has more than perWorkspace runs at once across instances),
//   3. runs them at most `concurrency` at a time: refresh the access token, list and read the remote item, write the
//      notes (run.js), and report the result (kb_sync_finish), which admins see as status, last synced and last error.
// One attachment's failure never stops the others. A rate limit waits for the provider's Retry-After within a run and
// otherwise moves the attachment's next try out; repeated failures back off up to six hours. A refused grant ends it
// (kb_sync_grant_refused) and the attachments wait for an admin to attach them again. No model is called anywhere.
// Tokens never reach the log: it carries attachment ids, providers, counts and HTTP statuses.
//
// Safety. The worker never removes notes because the remote item could not be read: an item that is gone, or that the
// grant lost access to, keeps its notes and asks an admin to look (only Remove takes the notes out). A run holds its
// lease with a heartbeat and stops writing the moment the lease is lost (the attachment was removed, paused or taken
// over); notes a run wrote for a removed attachment are taken out at the end of the run and by an hourly sweep. A
// refresh takes the grant's lock first (kb_sync_refresh_lock, shared with the attach route), stores a rotated refresh
// token before using the access token, and keeps a token it could not store in memory and tries the store again, so a
// single-use refresh token is never lost.
import { SyncError } from './http.js';
import { PROVIDERS } from './providers/index.js';
import { syncAttachment } from './run.js';
import { randomUUID } from 'node:crypto';
import { clientFor, refreshAccess, revokeGrant } from './tokens.js';

const MAX_BACKOFF_S = 6 * 3600;
export const backoffSeconds = (failures, base = 300) => Math.min(base * 2 ** Math.max(0, failures), MAX_BACKOFF_S);
const rowOf = (data) => (Array.isArray(data) ? data[0] ?? null : data ?? null);

export const GONE_TWICE = 'Two syncs in a row could not find this item, or its admin lost access to it. Its notes stay until an admin removes it.';
const sleepFor = (ms) => new Promise((r) => setTimeout(r, ms));

// the grant's refresh lock, tried a few times over a few seconds. false: someone else is refreshing it
export async function lockGrant(rpc, grantId, owner, { tries = 5, waitMs = 1000, sleep = sleepFor, seconds = 120 } = {}) {
  for (let i = 0; i < tries; i++) {
    if (await rpc('kb_sync_refresh_lock', { grant_id: grantId, owner, lock_seconds: seconds })) return true;
    if (i < tries - 1) await sleep(waitMs);
  }
  return false;
}

export function createKbSyncWorker({ db, config, fetchImpl = fetch, log = () => {}, now = () => new Date(), sleep, providers = PROVIDERS, settings = {}, owner = `kbsync-${randomUUID()}` }) {
  const s = { tickMs: 60000, intervalSeconds: 900, concurrency: 4, perWorkspace: 2, claim: 20, leaseSeconds: 900, heartbeatMs: 120000, renewEveryMs: 15000, sweepMs: 3600000, lockWaitMs: 1000, ...config?.kbSync, ...settings };
  const wait = sleep ?? sleepFor;
  // access tokens for their lifetime, per grant, so a run does not refresh (and a rotating provider does not rotate)
  // more often than the token expires
  const access = new Map();
  const refreshing = new Map();
  // rotated refresh tokens the database did not take yet, per grant; the next refresh stores and uses them first
  const unstored = new Map();
  let timer = null, running = null, stopped = true, lastSweep = 0;

  const rpc = async (name, args) => {
    const { data, error } = await db.rpc(name, args);
    if (error) throw Object.assign(new Error(`${name} failed`), { code: 'db', detail: error.code ?? null });
    return data;
  };
  const storeToken = async (grantId, token) => {
    for (let i = 0; i < 3; i++) {
      try { await rpc('kb_sync_token_store', { grant_id: grantId, token }); unstored.delete(grantId); return true; }
      catch { if (i < 2) await wait(500 * (i + 1)); }
    }
    unstored.set(grantId, token);
    log('kb_sync_token_store_failed', { grant: grantId });
    return false;
  };

  async function refreshGrant(row) {
    if (!(await lockGrant(rpc, row.grant_id, owner, { sleep: wait, waitMs: s.lockWaitMs }))) throw new SyncError('Another sync is refreshing this connection. It runs again shortly.', 'network');
    let release = true;
    try {
      // read again under the lock: another process may have rotated it a moment ago
      const fresh = rowOf(await rpc('kb_sync_token', { attachment_id: row.attachment_id })) ?? row;
      let refreshToken = fresh.refresh_token;
      const pending = unstored.get(row.grant_id);
      if (pending) {
        // a rotated token from an earlier refresh is the live one; it goes in before anything else
        if (!(await storeToken(row.grant_id, pending))) { release = false; throw new SyncError('The connection could not be saved. The sync runs again shortly.', 'network'); }
        refreshToken = pending;
      }
      const t = await refreshAccess({ provider: fresh.provider, client: clientFor(config, fresh), refreshToken, fetchImpl, now: () => now().getTime() });
      // a rotated refresh token is stored before the access token is used; one the store refused is kept and the
      // lock is left to expire, so no other process refreshes with the spent token meanwhile
      if (t.refreshToken && !(await storeToken(row.grant_id, t.refreshToken))) { release = false; throw new SyncError('The connection could not be saved. The sync runs again shortly.', 'network'); }
      access.set(row.grant_id, { accessToken: t.accessToken, expiresAt: t.expiresAt });
      return t.accessToken;
    } finally {
      if (release) await rpc('kb_sync_refresh_unlock', { grant_id: row.grant_id, owner }).catch(() => {});
    }
  }

  async function accessToken(attachment) {
    const row = rowOf(await rpc('kb_sync_token', { attachment_id: attachment.id }));
    if (!row?.refresh_token) throw new SyncError('Attach it again to keep it in sync.', 'auth');
    const cached = access.get(row.grant_id);
    if (cached && cached.expiresAt - now().getTime() > 120000) return { token: cached.accessToken, grantId: row.grant_id };
    // in this process one refresh per grant runs at a time; across processes the grant's lock does the same
    if (!refreshing.has(row.grant_id)) {
      refreshing.set(row.grant_id, refreshGrant({ ...row, attachment_id: attachment.id }).finally(() => refreshing.delete(row.grant_id)));
    }
    try { return { token: await refreshing.get(row.grant_id), grantId: row.grant_id }; }
    catch (err) { err.grantId = row.grant_id; throw err; }
  }

  // false: the run lost its lease and its report is dropped
  const finish = async (a, args) => {
    const kept = await rpc('kb_sync_finish', { attachment_id: a.id, ok: false, message: null, cur: null, note_count: null, retry_seconds: s.intervalSeconds, needs_auth: false, owner, ...args });
    if (kept === false) await lost(a);
    return kept;
  };
  // the attachment was removed (or taken over) during the run: notes this run wrote for a removed one leave the KB
  const lost = async (a) => {
    log('kb_sync_lease_lost', { attachment: a.id });
    try { await rpc('kb_sync_strays', { attachment_id: a.id }); } catch (err) { log('kb_sync_strays_failed', { code: err.code }); }
  };

  // the lease: renewed by a heartbeat during the run, and checked (at most every renewEveryMs) before each write
  function leaseOf(a) {
    let ok = true, last = Date.now();
    const renew = async () => {
      if (!ok) return false;
      try { ok = (await rpc('kb_sync_renew', { attachment_id: a.id, owner, lease_seconds: s.leaseSeconds })) === true; } catch { ok = false; }
      last = Date.now();
      return ok;
    };
    const beat = setInterval(() => { renew(); }, s.heartbeatMs);
    beat.unref?.();
    return {
      guard: async () => {
        if (ok && Date.now() - last >= s.renewEveryMs) await renew();
        if (!ok) throw new SyncError('The sync stopped: this synced folder was removed, paused or taken over.', 'lease');
      },
      end: () => clearInterval(beat),
    };
  }

  async function runOne(a) {
    const provider = providers[a.provider];
    let grantId = null;
    const lease = leaseOf(a);
    try {
      if (!provider) throw new SyncError('That connector cannot sync folders yet.', 'provider');
      const t = await accessToken(a);
      grantId = t.grantId;
      const r = await syncAttachment({ db, attachment: a, provider, token: t.token, fetchImpl, sleep, now, log, guard: lease.guard });
      if (r.stop) {
        // a stop after some files were written still reports what happened, and tries again later
        if (r.stop.code === 'auth') return refused(a, grantId, r.stop, r);
        await finish(a, { ok: false, message: r.stop.message, cur: r.cursor, note_count: r.noteCount, retry_seconds: Math.round((r.stop.retryAfterMs ?? backoffSeconds(a.failures ?? 0) * 1000) / 1000) });
        return { id: a.id, ok: false, code: r.stop.code };
      }
      const note = r.skipped.length ? `${r.skipped.length} ${r.skipped.length === 1 ? 'file was' : 'files were'} skipped. ${r.skipped[0].path}: ${r.skipped[0].reason}` : null;
      const kept = await finish(a, { ok: true, message: note, cur: r.cursor, note_count: r.noteCount, retry_seconds: s.intervalSeconds });
      return { id: a.id, ok: kept !== false, written: r.written, removed: r.removed };
    } catch (err) {
      const code = err?.code ?? 'server';
      log('kb_sync_failed', { attachment: a.id, provider: a.provider, code, status: err?.status ?? null });
      try {
        if (code === 'lease') { await lost(a); return { id: a.id, ok: false, code }; }
        if (code === 'auth') return await refused(a, grantId ?? err.grantId ?? null, err);
        if (code === 'gone' || code === 'access') {
          // never a reason to remove notes: the item may be back, or its access restored. The second run in a row that
          // finds it gone says so plainly; an admin decides with Remove
          const cursor = a.cursor && typeof a.cursor === 'object' ? a.cursor : {};
          const times = (Number(cursor.gone) || 0) + 1;
          await finish(a, { ok: false, message: times >= 2 ? GONE_TWICE : err.message, cur: { ...cursor, gone: times }, retry_seconds: times >= 2 ? MAX_BACKOFF_S : s.intervalSeconds });
          return { id: a.id, ok: false, code, gone: times };
        }
        const retry = code === 'limited' && err.retryAfterMs ? Math.round(err.retryAfterMs / 1000) : backoffSeconds(a.failures ?? 0);
        const message = err instanceof SyncError ? err.message : 'The sync failed. It runs again later.';
        await finish(a, { ok: false, message, retry_seconds: code === 'config' ? MAX_BACKOFF_S : retry });
      } catch (e) { log('kb_sync_report_failed', { attachment: a.id, code: e?.code ?? 'server' }); }
      return { id: a.id, ok: false, code };
    } finally { lease.end(); }
  }

  async function refused(a, grantId, err, r = null) {
    if (grantId) { access.delete(grantId); await rpc('kb_sync_grant_refused', { grant_id: grantId }); }
    await finish(a, { ok: false, needs_auth: true, message: err.message, cur: r?.cursor ?? null, note_count: r?.noteCount ?? null, retry_seconds: MAX_BACKOFF_S });
    return { id: a.id, ok: false, code: 'auth' };
  }

  async function revocations() {
    let rows;
    try { rows = (await rpc('kb_sync_revocations', { max_rows: 20 })) ?? []; } catch (err) { log('kb_sync_revocations_failed', { code: err.code }); return 0; }
    let n = 0;
    for (const g of rows) {
      const ok = await revokeGrant({ provider: g.provider, client: clientFor(config, g), refreshToken: g.refresh_token, fetchImpl });
      access.delete(g.grant_id);
      unstored.delete(g.grant_id);
      try {
        if (ok) { await rpc('kb_sync_revoked', { grant_id: g.grant_id }); n++; }
        // not confirmed: tried again later with backoff; after the last try the secret is deleted anyway and the row
        // records that the provider revoke failed. Ended grants never sync meanwhile (kb_sync_token skips them)
        else if (await rpc('kb_sync_revoke_failed', { grant_id: g.grant_id, max_attempts: 5 })) log('kb_sync_revoke_gave_up', { provider: g.provider });
      } catch (err) { log('kb_sync_revoked_failed', { code: err.code }); }
      log('kb_sync_revoke', { provider: g.provider, ok });
    }
    return n;
  }

  // a simple pool: at most `concurrency` runs at once, each one's failure contained
  async function pool(rows) {
    const out = [];
    let i = 0;
    const lane = async () => { while (i < rows.length) { const a = rows[i++]; out.push(await runOne(a)); } };
    await Promise.all(Array.from({ length: Math.min(s.concurrency, rows.length) }, lane));
    return out;
  }

  async function tick() {
    await revocations();
    if (Date.now() - lastSweep >= s.sweepMs) {
      lastSweep = Date.now();
      try { const n = await rpc('kb_sync_strays', {}); if (n) log('kb_sync_strays', { removed: n }); } catch (err) { log('kb_sync_strays_failed', { code: err.code }); }
    }
    let rows;
    try { rows = (await rpc('kb_sync_claim', { max_rows: s.claim, lease_seconds: s.leaseSeconds, per_workspace: s.perWorkspace, owner })) ?? []; }
    catch (err) { log('kb_sync_claim_failed', { code: err.code }); return []; }
    if (!rows.length) return [];
    const results = await pool(rows);
    log('kb_sync_tick', { claimed: rows.length, ok: results.filter((r) => r.ok).length });
    return results;
  }

  const once = () => { if (!running) running = tick().finally(() => { running = null; }); return running; };
  const schedule = (ms) => { if (stopped) return; clearTimeout(timer); timer = setTimeout(async () => { try { await once(); } catch (err) { log('kb_sync_tick_failed', { code: err?.code ?? 'server' }); } schedule(s.tickMs); }, ms); timer.unref?.(); };
  return {
    tick: once,
    start() { if (!stopped) return; stopped = false; schedule(5000); log('kb_sync_started', { concurrency: s.concurrency, perWorkspace: s.perWorkspace }); },
    stop() { stopped = true; clearTimeout(timer); return running ?? Promise.resolve(); },
    // run soon after an attach, instead of waiting for the next tick
    poke() { if (!stopped) schedule(1000); },
  };
}
