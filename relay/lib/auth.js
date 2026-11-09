// who is calling and what their workspace allows: the token checked against Supabase Auth, membership with the
// service role, the admin's voice overrides, and the connector key for a step when the organization set one.
import { createClient } from '@supabase/supabase-js';
import { periodStart, remainingSeconds } from './allowance.js';
import { config } from './config.js';

export class RelayError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

export function makeClients(c = config) {
  const opts = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
  return {
    anon: createClient(c.supabaseUrl, c.supabaseAnonKey, opts),
    db: createClient(c.supabaseUrl, c.supabaseServiceRoleKey, opts),
  };
}

export const bearer = (header) => { const m = /^Bearer\s+(\S+)$/i.exec(String(header ?? '')); return m ? m[1] : null; };

// the session behind a token, or a refusal. auth.getUser asks the project, so a revoked session is refused too.
export async function verifyToken(anon, token) {
  if (!token) throw new RelayError('unauthorized', 'Sign in first.', 401);
  const { data, error } = await anon.auth.getUser(token);
  if (error || !data?.user) throw new RelayError('unauthorized', 'You are signed out. Sign in again.', 401);
  return { userId: data.user.id, email: data.user.email ?? null };
}

export async function requireMember(db, workspaceId, userId) {
  const { data, error } = await db.from('members').select('role').eq('workspace_id', workspaceId).eq('user_id', userId).is('deleted_at', null).maybeSingle();
  if (error) throw new RelayError('server', 'The workspace could not be read.', 500);
  if (!data) throw new RelayError('forbidden', 'You are not a member of that workspace.', 403);
  return data.role;
}

export async function voiceSettings(db, workspaceId) {
  const { data, error } = await db.from('workspace_settings').select('voice').eq('workspace_id', workspaceId).maybeSingle();
  if (error) throw new RelayError('server', 'The workspace settings could not be read.', 500);
  return data?.voice && typeof data.voice === 'object' ? data.voice : {};
}

// the connector's provider, base URL and decrypted key through the service-role RPC; the key goes to the engine and nowhere else
export async function connectorSecret(db, connectorId, step) {
  const { data, error } = await db.rpc('relay_connector_secret', { connector_id: connectorId });
  const row = Array.isArray(data) ? data[0] : data;
  if (error || !row) throw new RelayError('connector', `The organization's ${step} connector could not be read.`, 500);
  if (!(row.roles ?? []).includes(step)) throw new RelayError('connector', `The organization's connector does not serve ${step}.`, 400);
  return { provider: row.provider, baseUrl: row.base_url ?? null, secret: row.secret, workspaceId: row.workspace_id };
}

// seconds left in the workspace pool this month: seats and packs from the workspace, hours on Quorum's keys from the view
export async function allowance(db, workspaceId, now = new Date()) {
  const [ws, usage] = await Promise.all([
    db.from('workspaces').select('seats, hour_packs, plan').eq('id', workspaceId).is('deleted_at', null).maybeSingle(),
    db.from('workspace_usage').select('managed_hours').eq('workspace_id', workspaceId).gte('period', periodStart(now)),
  ]);
  if (ws.error || usage.error || !ws.data) throw new RelayError('server', 'The workspace allowance could not be read.', 500);
  const usedHours = (usage.data ?? []).reduce((n, r) => n + (Number(r.managed_hours) || 0), 0);
  return { seats: ws.data.seats, hourPacks: ws.data.hour_packs ?? 0, usedHours, plan: ws.data.plan, remaining: remainingSeconds({ seats: ws.data.seats, hourPacks: ws.data.hour_packs ?? 0, usedHours }) };
}

// everything one request needs in one pass: the caller, their membership, the voice overrides and the allowance
export async function authorize({ anon, db }, { token, workspaceId, anyPlan = false }) {
  if (!workspaceId) throw new RelayError('bad_request', 'Pick a workspace first.', 400);
  const user = await verifyToken(anon, token);
  const role = await requireMember(db, workspaceId, user.userId);
  const plan = await requirePlan(db, workspaceId, anyPlan);
  const voice = await voiceSettings(db, workspaceId);
  return { ...user, role, plan, voice };
}

// the paywall: a workspace on the free plan has no Cloud service until it subscribes (or the owner sets cloud/internal)
export async function requirePlan(db, workspaceId, anyPlan = false) {
  const { data, error } = await db.from('workspaces').select('plan').eq('id', workspaceId).is('deleted_at', null).maybeSingle();
  if (error) throw new RelayError('server', 'The workspace could not be read.', 500);
  if (!data) throw new RelayError('forbidden', 'That workspace no longer exists.', 403);
  if (!anyPlan && data.plan === 'free') throw new RelayError('plan', 'This workspace has no Quorum Cloud subscription yet.', 402);
  return data.plan;
}
