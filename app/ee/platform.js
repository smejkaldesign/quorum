// the platform owner's page (Settings › Admin › Platform), hosted edition: every workspace, its members, usage this
// period and the plan, through the owner-only RPCs of migration 0008. The owner reads nothing from the tables
// directly; a caller without the role gets the RPC's own refusal.
import { plain } from './account.js';

export const PLANS = ['free', 'cloud', 'internal', 'paid'];

export const shapeWorkspace = (r) => ({
  id: r.id, name: r.name, domain: r.domain ?? null, plan: r.plan, seatsIncluded: Number(r.seats_included) || 0, notes: r.notes ?? null,
  members: Number(r.members) || 0, createdAt: r.created_at, lastActivity: r.last_activity ?? null,
});
// an access code row as the Platform page shows it; status is one word the list can filter and color by
export const formatCode = (code) => `${String(code ?? '').slice(0, 4)}-${String(code ?? '').slice(4, 8)}`;
export function codeStatus(a, now = Date.now()) {
  if (a.redeemedAt) return 'redeemed';
  if (a.revokedAt) return 'revoked';
  if (new Date(a.expiresAt).getTime() <= now) return 'expired';
  if (a.claimedAt) return 'claimed';
  return 'open';
}
export const shapeAccessCode = (r) => {
  const a = { id: r.id, email: r.email, code: r.code, note: r.note ?? null, issuedAt: r.issued_at, expiresAt: r.expires_at, claimedAt: r.claimed_at ?? null, redeemedAt: r.redeemed_at ?? null, revokedAt: r.revoked_at ?? null, redeemedEmail: r.redeemed_email ?? null };
  return { ...a, status: codeStatus(a) };
};
export const shapeMember = (m) => ({ userId: m.user_id, email: m.email ?? null, name: m.name ?? null, role: m.role, joinedAt: m.joined_at });

// one row per step from platform_usage, folded into the period's totals: speech carries hours, summary and notes are model calls
export function shapeUsage(rows, period) {
  const steps = (rows ?? []).map((r) => ({ role: r.role, calls: Number(r.calls) || 0, hours: Number(r.hours) || 0, managedHours: Number(r.managed_hours) || 0 }));
  const sum = (k) => Math.round(steps.reduce((n, s) => n + s[k], 0) * 100) / 100;
  return { period, hours: sum('hours'), managedHours: sum('managedHours'), calls: steps.filter((s) => s.role !== 'speech').reduce((n, s) => n + s.calls, 0), steps };
}

// the first moment of the current calendar month, UTC, the same period the relay and the Voice typing page use
export const periodStart = (now = new Date()) => { const d = new Date(now); d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0); return d.toISOString(); };

export function createPlatform({ account, log = () => {} }) {
  const fail = (err, fallback) => { log('platform', err?.message ?? err); return { error: plain(err, fallback) }; };
  const ready = () => {
    if (!account.client()) return { error: 'Hosted accounts are not set up in this build.' };
    const s = account.state();
    if (!s.signedIn) return { error: 'Sign in first.' };
    if (!s.platformOwner) return { error: 'Only the platform owner can do that.' };
    return null;
  };
  const handlers = {
    'platform-workspaces': async () => {
      const no = ready(); if (no) return no;
      try {
        const { data, error } = await account.client().rpc('platform_workspaces');
        if (error) return fail(error);
        return { workspaces: (data ?? []).map(shapeWorkspace) };
      } catch (err) { return fail(err); }
    },
    'platform-members': async (workspaceId) => {
      const no = ready(); if (no) return no;
      try {
        const { data, error } = await account.client().rpc('platform_workspace_members', { workspace_id: String(workspaceId ?? '') });
        if (error) return fail(error);
        return { members: (data ?? []).map(shapeMember) };
      } catch (err) { return fail(err); }
    },
    'platform-usage': async (workspaceId) => {
      const no = ready(); if (no) return no;
      const period = periodStart();
      try {
        const { data, error } = await account.client().rpc('platform_usage', { workspace_id: String(workspaceId ?? ''), period_start: period });
        if (error) return fail(error);
        return { usage: shapeUsage(data, period) };
      } catch (err) { return fail(err); }
    },
    // access codes (migration 0009): the owner issues one per email, sees every code and its state, revokes an open one
    'platform-access-codes': async () => {
      const no = ready(); if (no) return no;
      try {
        const { data, error } = await account.client().rpc('platform_access_codes');
        if (error) return fail(error);
        return { codes: (data ?? []).map(shapeAccessCode) };
      } catch (err) { return fail(err); }
    },
    'platform-issue-access-code': async (email, note, days = 30) => {
      const no = ready(); if (no) return no;
      try {
        const { data, error } = await account.client().rpc('platform_issue_access_code', { email: String(email ?? '').trim().toLowerCase(), note: String(note ?? '').trim() || null, days: Math.min(365, Math.max(1, Math.trunc(Number(days) || 30))) });
        if (error) return fail(error, 'The code could not be issued.');
        return { code: shapeAccessCode(data ?? {}) };
      } catch (err) { return fail(err, 'The code could not be issued.'); }
    },
    'platform-revoke-access-code': async (id) => {
      const no = ready(); if (no) return no;
      try {
        const { error } = await account.client().rpc('platform_revoke_access_code', { id: String(id ?? '') });
        if (error) return fail(error, 'The code could not be revoked.');
        return { ok: true };
      } catch (err) { return fail(err, 'The code could not be revoked.'); }
    },
    // the RPC validates the plan and the seat count and raises plain sentences; the renderer checked the same before sending
    'platform-set-plan': async (workspaceId, draft = {}) => {
      const no = ready(); if (no) return no;
      try {
        const { data, error } = await account.client().rpc('platform_set_plan', {
          workspace_id: String(workspaceId ?? ''), plan: String(draft.plan ?? ''), seats_included: Math.max(0, Math.trunc(Number(draft.seatsIncluded) || 0)), notes: String(draft.notes ?? '').trim() || null,
        });
        if (error) return fail(error, 'The plan could not be saved.');
        return { plan: { plan: data?.plan, seatsIncluded: Number(data?.seats_included) || 0, notes: data?.notes ?? null } };
      } catch (err) { return fail(err, 'The plan could not be saved.'); }
    },
  };
  return { handlers };
}

export function registerPlatform({ ipcMain, account, log }) {
  const p = createPlatform({ account, log });
  for (const [name, fn] of Object.entries(p.handlers)) ipcMain.handle(name, (_e, ...a) => fn(...a));
  return p;
}
