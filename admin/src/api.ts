// everything the pages ask for, against the platform owner's own session: the Supabase project through its
// owner-only RPCs, and the relay for the one thing a browser page cannot do itself, sending the code email.
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { token } from './session';
import { type AccessRequest, type AuditRow, type Member, type Overview, type PlanDraft, type Usage, type User, type Workspace, periodStart, plain, requestWithCode, shapeAudit, shapeMember, shapeOverview, shapeRequest, shapeUser, shapeUsage, shapeWorkspace } from './shape';

export const CONFIG = __QUORUM_SUPABASE__;
export const RELAY_URL = __RELAY_URL__;
export const configured = !!(CONFIG.url && CONFIG.key);
export const host = configured ? new URL(CONFIG.url).host : null;

// every request to the project carries the passkey session token (migration 0017 reads it as a request header), so
// the owner-only functions answer only while the passkey sign-in is live
let client: SupabaseClient | null = null;
export function supabase(): SupabaseClient {
  if (!client) {
    client = createClient(CONFIG.url, CONFIG.key, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'quorum-admin' },
      global: { fetch: (input, init) => { const headers = new Headers(init?.headers); const t = token.get(); if (t) headers.set('x-quorum-passkey', t); return fetch(input, { ...init, headers }); } },
    });
  }
  return client;
}

export type OwnerStatus = { owner: boolean; passkeys: number; session: boolean };

type Result<T> = { ok: true; value: T } | { ok: false; error: string };
const ok = <T,>(value: T): Result<T> => ({ ok: true, value });
const no = <T,>(err: unknown, fallback?: string): Result<T> => ({ ok: false, error: plain(err, fallback) });
async function rpc<T>(name: string, args: Record<string, unknown> | undefined, shape: (data: unknown) => T, fallback?: string): Promise<Result<T>> {
  try {
    const { data, error } = await supabase().rpc(name, args);
    if (error) return no(error, fallback);
    return ok(shape(data));
  } catch (err) { return no(err, fallback); }
}
const rows = (d: unknown) => (Array.isArray(d) ? (d as Record<string, unknown>[]) : []);

export const auth = {
  session: async (): Promise<Session | null> => (await supabase().auth.getSession()).data.session,
  onChange: (cb: (s: Session | null) => void) => supabase().auth.onAuthStateChange((_e, s) => cb(s)).data.subscription.unsubscribe,
  // the admin app never creates an account: a stranger's email gets the same refusal the project gives it
  sendCode: async (email: string): Promise<Result<true>> => {
    try { const { error } = await supabase().auth.signInWithOtp({ email, options: { shouldCreateUser: false } }); return error ? no(error, 'The code could not be sent. Try again in a minute.') : ok(true); } catch (err) { return no(err); }
  },
  verify: async (email: string, token: string): Promise<Result<true>> => {
    try { const { error } = await supabase().auth.verifyOtp({ email, token, type: 'email' }); return error ? no(error, 'That code is wrong or has expired. Ask for a new one.') : ok(true); } catch (err) { return no(err); }
  },
  signOut: async () => { token.clear(); try { await supabase().auth.signOut({ scope: 'local' }); } catch {} },
  // owner or not, how many passkeys, and whether the token this tab holds still opens a session
  ownerStatus: (): Promise<Result<OwnerStatus>> => rpc('platform_owner_status', undefined, (d) => { const o = (d ?? {}) as Record<string, unknown>; return { owner: o.owner === true, passkeys: Number(o.passkeys) || 0, session: o.session === true }; }),
};

export const api = {
  overview: (): Promise<Result<Overview>> => rpc('platform_overview', undefined, (d) => shapeOverview((d ?? {}) as Record<string, unknown>)),
  requests: (): Promise<Result<AccessRequest[]>> => rpc('platform_access_requests', undefined, (d) => rows(d).map((r) => shapeRequest(r))),
  addRequest: (email: string, name: string, note: string): Promise<Result<{ id: string; already: boolean }>> =>
    rpc('platform_add_request', { email: email.trim().toLowerCase(), name: name.trim() || null, note: note.trim() || null }, (d) => { const o = (d ?? {}) as Record<string, unknown>; return { id: String(o.id), already: o.already === true }; }, 'The person could not be added.'),
  invite: (r: AccessRequest, days: number, note: string): Promise<Result<AccessRequest>> =>
    rpc('platform_invite_request', { id: r.id, days, note: note.trim() || null }, (d) => requestWithCode(r, (d ?? {}) as Record<string, unknown>), 'The request could not be approved.'),
  decline: (id: string, note: string): Promise<Result<true>> => rpc('platform_decline_request', { id, note: note.trim() || null }, () => true, 'The request could not be declined.'),
  revokeCode: (codeId: string): Promise<Result<true>> => rpc('platform_revoke_access_code', { id: codeId }, () => true, 'The code could not be revoked.'),
  workspaces: (): Promise<Result<Workspace[]>> => rpc('platform_workspaces', undefined, (d) => rows(d).map(shapeWorkspace)),
  members: (workspaceId: string): Promise<Result<Member[]>> => rpc('platform_workspace_members', { workspace_id: workspaceId }, (d) => rows(d).map(shapeMember)),
  usage: (workspaceId: string): Promise<Result<Usage>> => { const period = periodStart(); return rpc('platform_usage', { workspace_id: workspaceId, period_start: period }, (d) => shapeUsage(rows(d), period)); },
  setPlan: (workspaceId: string, draft: PlanDraft): Promise<Result<{ plan: string; seatsIncluded: number; notes: string | null }>> =>
    rpc('platform_set_plan', { workspace_id: workspaceId, plan: draft.plan, seats_included: draft.seatsIncluded, notes: draft.notes || null }, (d) => { const o = (d ?? {}) as Record<string, unknown>; return { plan: String(o.plan), seatsIncluded: Number(o.seats_included) || 0, notes: (o.notes as string | null) ?? null }; }, 'The plan could not be saved.'),
  users: (): Promise<Result<User[]>> => rpc('platform_users', undefined, (d) => rows(d).map(shapeUser)),
  audit: async (limit = 100): Promise<Result<AuditRow[]>> => {
    try {
      const { data, error } = await supabase().from('platform_audit').select('id, actor, action, target_workspace, detail, created_at').order('created_at', { ascending: false }).limit(limit);
      if (error) return no(error);
      return ok(rows(data).map(shapeAudit));
    } catch (err) { return no(err); }
  },
  // the code email goes out through the relay, which checks the owner's session itself
  sendCodeEmail: async (r: AccessRequest): Promise<Result<true>> => {
    if (!r.code) return { ok: false, error: 'This request has no code yet.' };
    try {
      const session = await auth.session();
      if (!session) return { ok: false, error: 'You are signed out. Sign in again.' };
      const res = await fetch(`${RELAY_URL}/v1/platform/send-code`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.access_token}` }, body: JSON.stringify({ email: r.email, name: r.name, code: r.code.code, expiresAt: r.code.expiresAt }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: String(body.error ?? 'The email could not be sent.') };
      return ok(true);
    } catch (err) { return no(err, 'The relay could not be reached.'); }
  },
  relayHealth: async (): Promise<Result<{ engine: string; billing: boolean; mail: boolean; notes: boolean; zoom: boolean }>> => {
    try {
      const res = await fetch(`${RELAY_URL}/healthz`);
      const b = await res.json();
      return ok({ engine: String(b.engine ?? ''), billing: b.billing === true, mail: b.mail === true, notes: b.notes === true, zoom: b.connect?.zoom === true });
    } catch (err) { return no(err, 'The relay did not answer.'); }
  },
};
