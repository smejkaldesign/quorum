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
import { SyncError } from './http.js';
import { PROVIDERS } from './providers/index.js';
import { syncAttachment } from './run.js';
import { clientFor, refreshAccess, revokeGrant } from './tokens.js';

const MAX_BACKOFF_S = 6 * 3600;
export const backoffSeconds = (failures, base = 300) => Math.min(base * 2 ** Math.max(0, failures), MAX_BACKOFF_S);
const rowOf = (data) => (Array.isArray(data) ? data[0] ?? null : data ?? null);

export function createKbSyncWorker({ db, config, fetchImpl = fetch, log = () => {}, now = () => new Date(), sleep, providers = PROVIDERS, settings = {} }) {
  const s = { tickMs: 60000, intervalSeconds: 900, concurrency: 4, perWorkspace: 2, claim: 20, leaseSeconds: 900, ...config?.kbSync, ...settings };
  // access tokens for their lifetime, per grant, so a run does not refresh (and a rotating provider does not rotate)
  // more often than the token expires
  const access = new Map();
  const refreshing = new Map();
  let timer = null, running = null, stopped = true;

  const rpc = async (name, args) => {
    const { data, error } = await db.rpc(name, args);
    if (error) throw Object.assign(new Error(`${name} failed`), { code: 'db', detail: error.code ?? null });
    return data;
  };

  async function accessToken(attachment) {
    const row = rowOf(await rpc('kb_sync_token', { attachment_id: attachment.id }));
    if (!row?.refresh_token) throw new SyncError('Attach it again to keep it in sync.', 'auth');
    const cached = access.get(row.grant_id);
    if (cached && cached.expiresAt - now().getTime() > 120000) return { token: cached.accessToken, grantId: row.grant_id };
    // one refresh per grant at a time: a rotated refresh token works once, so a second concurrent refresh would fail
    if (!refreshing.has(row.grant_id)) {
      refreshing.set(row.grant_id, (async () => {
        try {
          const t = await refreshAccess({ provider: row.provider, client: clientFor(config, row), refreshToken: row.refresh_token, fetchImpl, now: () => now().getTime() });
          if (t.refreshToken) await rpc('kb_sync_token_store', { grant_id: row.grant_id, token: t.refreshToken });
          access.set(row.grant_id, { accessToken: t.accessToken, expiresAt: t.expiresAt });
          return t.accessToken;
        } finally { refreshing.delete(row.grant_id); }
      })());
    }
    try { return { token: await refreshing.get(row.grant_id), grantId: row.grant_id }; }
    catch (err) { err.grantId = row.grant_id; throw err; }
  }

  const finish = (a, args) => rpc('kb_sync_finish', { attachment_id: a.id, ok: false, message: null, cur: null, note_count: null, retry_seconds: s.intervalSeconds, needs_auth: false, ...args });

  // removed upstream: an attached file or folder that is gone takes its notes out of the KB
  async function dropNotes(a) {
    const at = now().toISOString();
    const { data, error } = await db.from('notes').select('id, frontmatter').eq('kb_id', a.kb_id).is('deleted_at', null);
    if (error) return 0;
    const ids = (data ?? []).filter((n) => n.frontmatter?.kb_attachment === a.id).map((n) => n.id);
    if (ids.length) await db.from('notes').update({ deleted_at: at, updated_at: at }).in('id', ids);
    return ids.length;
  }

  async function runOne(a) {
    const provider = providers[a.provider];
    let grantId = null;
    try {
      if (!provider) throw new SyncError('That connector cannot sync folders yet.', 'provider');
      const t = await accessToken(a);
      grantId = t.grantId;
      const r = await syncAttachment({ db, attachment: a, provider, token: t.token, fetchImpl, sleep, now, log });
      if (r.stop) {
        // a stop after some files were written still reports what happened, and tries again later
        if (r.stop.code === 'auth') return refused(a, grantId, r.stop, r);
        await finish(a, { ok: false, message: r.stop.message, cur: r.cursor, note_count: r.noteCount, retry_seconds: Math.round((r.stop.retryAfterMs ?? backoffSeconds(a.failures ?? 0) * 1000) / 1000) });
        return { id: a.id, ok: false, code: r.stop.code };
      }
      const note = r.skipped.length ? `${r.skipped.length} ${r.skipped.length === 1 ? 'file was' : 'files were'} skipped. ${r.skipped[0].path}: ${r.skipped[0].reason}` : null;
      await finish(a, { ok: true, message: note, cur: r.cursor, note_count: r.noteCount, retry_seconds: s.intervalSeconds });
      return { id: a.id, ok: true, written: r.written, removed: r.removed };
    } catch (err) {
      const code = err?.code ?? 'server';
      log('kb_sync_failed', { attachment: a.id, provider: a.provider, code, status: err?.status ?? null });
      try {
        if (code === 'auth') return await refused(a, grantId ?? err.grantId ?? null, err);
        if (code === 'gone') {
          const n = await dropNotes(a);
          await finish(a, { ok: false, message: err.message, cur: {}, note_count: 0, retry_seconds: MAX_BACKOFF_S });
          return { id: a.id, ok: false, code, removed: n };
        }
        const retry = code === 'limited' && err.retryAfterMs ? Math.round(err.retryAfterMs / 1000) : backoffSeconds(a.failures ?? 0);
        const message = err instanceof SyncError ? err.message : 'The sync failed. It runs again later.';
        await finish(a, { ok: false, message, retry_seconds: code === 'config' ? MAX_BACKOFF_S : retry });
      } catch (e) { log('kb_sync_report_failed', { attachment: a.id, code: e?.code ?? 'server' }); }
      return { id: a.id, ok: false, code };
    }
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
      // a grant the provider would not confirm stays queued for the next tick. It cannot sync in the meantime:
      // kb_sync_token skips ended grants
      if (ok) { try { await rpc('kb_sync_revoked', { grant_id: g.grant_id }); n++; } catch (err) { log('kb_sync_revoked_failed', { code: err.code }); } }
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
    let rows;
    try { rows = (await rpc('kb_sync_claim', { max_rows: s.claim, lease_seconds: s.leaseSeconds, per_workspace: s.perWorkspace })) ?? []; }
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
