// the rows the platform RPCs return, shaped for the pages, and the small pure rules the pages share. Nothing here
// touches the network, so test/shape.test.ts covers it directly.
export type Plan = 'free' | 'cloud' | 'internal' | 'paid';
export type Role = 'owner' | 'admin' | 'member';
export type RequestStatus = 'pending' | 'invited' | 'declined';
export type CodeStatus = 'open' | 'claimed' | 'redeemed' | 'revoked' | 'expired';
export type CodePlan = 'free' | 'cloud';

export type Workspace = { id: string; name: string; domain: string | null; plan: Plan; seatsIncluded: number; notes: string | null; members: number; createdAt: string; lastActivity: string | null };
export type Member = { userId: string; email: string | null; name: string | null; role: Role; joinedAt: string };
export type Usage = { period: string; hours: number; managedHours: number; calls: number; steps: { role: string; calls: number; hours: number; managedHours: number }[] };
export type PlanDraft = { plan: Plan; seatsIncluded: number; notes: string };
export type AccessRequest = {
  id: string; email: string; name: string | null; note: string | null; source: string; status: RequestStatus; createdAt: string; decidedAt: string | null; adminNote: string | null; hasAccount: boolean;
  signedInAt: string | null; installed: boolean;
  code: { id: string; code: string; plan: CodePlan; expiresAt: string; redeemedAt: string | null; revokedAt: string | null; status: CodeStatus } | null;
};
export type Install = { id: string; codeId: string; email: string | null; plan: CodePlan; machineId: string; edition: 'local' | 'cloud'; appVersion: string | null; firstSeen: string; lastSeen: string };
export type User = { userId: string; email: string; createdAt: string; lastSignInAt: string | null; workspaces: number; owner: boolean };
export type Overview = { users: number; workspaces: number; paidWorkspaces: number; members: number; codesOpen: number; requestsPending: number; managedHoursMonth: number; monthStart: string };
export type AuditRow = { id: string; actor: string | null; action: string; targetWorkspace: string | null; detail: Record<string, unknown>; createdAt: string };
// a feature flag (migration 0021): one switch every install reads through the relay, plus the owner's own notes on it
export type Flag = { id: string; key: string; name: string; description: string; enabled: boolean; tags: string[]; requires: string | null; createdAt: string; updatedAt: string };

export const PLANS: readonly Plan[] = ['free', 'cloud', 'internal', 'paid'];
export const PLAN_LABEL: Record<Plan, string> = { free: 'Free', cloud: 'Cloud', internal: 'Internal', paid: 'Paid' };
export const ROLE_LABEL: Record<Role, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' };
export const CODE_PLAN_LABEL: Record<CodePlan, string> = { free: 'Free', cloud: 'Cloud' };
export const codePlan = (v: unknown): CodePlan => (v === 'cloud' ? 'cloud' : 'free');
// where a request came from, as the row says it, and the plan that source suggests for the approve dialog
export const sourceLabel = (source: string): string => ({ admin: 'Added by you', hero: 'From the site: hero', 'pricing-free': 'From the site: Free card', 'pricing-cloud': 'From the site: Cloud card' })[source] ?? 'From the site';
export const sourcePlan = (source: string): CodePlan => (source === 'pricing-cloud' ? 'cloud' : 'free');
export const CODE_LABEL: Record<CodeStatus, string> = { open: 'Open', claimed: 'Claimed', redeemed: 'Used', revoked: 'Revoked', expired: 'Expired' };
export const REQUEST_LABEL: Record<RequestStatus, string> = { pending: 'Pending', invited: 'Invited', declined: 'Declined' };
export const NOTES_MAX = 500;

// what an Access row offers in place: a pending request is approved or declined; a live code (open or claimed) is
// sent, copied, moved between plans or revoked; anything used, declined, revoked or expired has no actions, its badges
// say what happened. A used code's plan can still move, from the notes dialog.
export type RowActions = { approve: boolean; decline: boolean; send: boolean; copy: boolean; convert: CodePlan | null; revoke: boolean };
export function rowActions(r: Pick<AccessRequest, 'status' | 'code'>): RowActions {
  const live = r.status === 'invited' && !!r.code && (r.code.status === 'open' || r.code.status === 'claimed');
  return {
    approve: r.status === 'pending',
    decline: r.status === 'pending',
    send: live,
    copy: live,
    convert: live ? (r.code!.plan === 'cloud' ? 'free' : 'cloud') : null,
    revoke: live,
  };
}
// how many notes a row carries: the person's own message and the owner's note
export const noteCount = (r: Pick<AccessRequest, 'note' | 'adminNote'>): number => (r.note ? 1 : 0) + (r.adminNote ? 1 : 0);
export const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export const DAYS_CHOICES = [30, 90, 365] as const;

const num = (v: unknown) => Number(v) || 0;
const str = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));

export const formatCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4, 8)}`;

export function codeStatus(c: { redeemedAt: string | null; revokedAt: string | null; expiresAt: string; claimedAt?: string | null }, now = Date.now()): CodeStatus {
  if (c.redeemedAt) return 'redeemed';
  if (c.revokedAt) return 'revoked';
  if (new Date(c.expiresAt).getTime() <= now) return 'expired';
  if (c.claimedAt) return 'claimed';
  return 'open';
}

export const shapeWorkspace = (r: Record<string, unknown>): Workspace => ({
  id: String(r.id), name: String(r.name ?? ''), domain: str(r.domain), plan: (r.plan as Plan) ?? 'free', seatsIncluded: num(r.seats_included), notes: str(r.notes),
  members: num(r.members), createdAt: String(r.created_at), lastActivity: str(r.last_activity),
});
export const shapeMember = (m: Record<string, unknown>): Member => ({ userId: String(m.user_id), email: str(m.email), name: str(m.name), role: (m.role as Role) ?? 'member', joinedAt: String(m.joined_at) });

// one row per step from platform_usage, folded into the period's totals: speech carries hours, summary and notes are model calls
export function shapeUsage(rows: Record<string, unknown>[] | null, period: string): Usage {
  const steps = (rows ?? []).map((r) => ({ role: String(r.role), calls: num(r.calls), hours: num(r.hours), managedHours: num(r.managed_hours) }));
  const sum = (k: 'hours' | 'managedHours') => Math.round(steps.reduce((n, s) => n + s[k], 0) * 100) / 100;
  return { period, hours: sum('hours'), managedHours: sum('managedHours'), calls: steps.filter((s) => s.role !== 'speech').reduce((n, s) => n + s.calls, 0), steps };
}

// the first moment of the current calendar month, UTC, the period the relay and the usage RPC share
export const periodStart = (now = new Date()) => { const d = new Date(now); d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0); return d.toISOString(); };

export function shapeRequest(r: Record<string, unknown>, now = Date.now()): AccessRequest {
  const code = r.code_id && r.code ? { id: String(r.code_id), code: String(r.code), plan: codePlan(r.code_plan), expiresAt: String(r.code_expires_at), redeemedAt: str(r.code_redeemed_at), revokedAt: str(r.code_revoked_at) } : null;
  return {
    id: String(r.id), email: String(r.email), name: str(r.name), note: str(r.note), source: String(r.source ?? 'site'), status: (r.status as RequestStatus) ?? 'pending',
    createdAt: String(r.created_at), decidedAt: str(r.decided_at), adminNote: str(r.admin_note), hasAccount: r.has_account === true, signedInAt: str(r.signed_in_at), installed: r.installed === true,
    code: code ? { ...code, status: codeStatus(code, now) } : null,
  };
}
// the code platform_invite_request returns, onto the request it came from
export const requestWithCode = (r: AccessRequest, issued: Record<string, unknown>, now = Date.now()): AccessRequest => {
  const code = { id: String(issued.id), code: String(issued.code), plan: codePlan(issued.plan), expiresAt: String(issued.expires_at), redeemedAt: null, revokedAt: null };
  return { ...r, status: 'invited', decidedAt: new Date(now).toISOString(), code: { ...code, status: codeStatus(code, now) } };
};

// an install is active when its last heartbeat is within a week
export const ACTIVE_DAYS = 7;
export const installActive = (lastSeen: string, now = Date.now()): boolean => now - new Date(lastSeen).getTime() < ACTIVE_DAYS * 86400000;
export const shapeInstall = (i: Record<string, unknown>): Install => ({
  id: String(i.id), codeId: String(i.code_id), email: str(i.email), plan: codePlan(i.plan), machineId: String(i.machine_id), edition: i.edition === 'cloud' ? 'cloud' : 'local',
  appVersion: str(i.app_version), firstSeen: String(i.first_seen), lastSeen: String(i.last_seen),
});
export const shapeUser = (u: Record<string, unknown>): User => ({ userId: String(u.user_id), email: String(u.email ?? ''), createdAt: String(u.created_at), lastSignInAt: str(u.last_sign_in_at), workspaces: num(u.workspaces), owner: u.owner === true });
export const shapeOverview = (o: Record<string, unknown>): Overview => ({
  users: num(o.users), workspaces: num(o.workspaces), paidWorkspaces: num(o.paid_workspaces), members: num(o.members), codesOpen: num(o.codes_open), requestsPending: num(o.requests_pending),
  managedHoursMonth: num(o.managed_hours_month), monthStart: String(o.month_start ?? periodStart()),
});
export const shapeFlag = (f: Record<string, unknown>): Flag => ({
  id: String(f.id), key: String(f.key), name: String(f.name ?? f.key), description: String(f.description ?? ''), enabled: f.enabled === true,
  tags: Array.isArray(f.tags) ? f.tags.map(String).filter(Boolean) : [], requires: typeof f.requires === 'string' && f.requires ? f.requires : null, createdAt: String(f.created_at), updatedAt: String(f.updated_at ?? f.created_at),
});
// the key a name suggests, in the shape the database accepts: lowercase letters, digits and single hyphens
export const FLAG_KEY = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
export const flagKeyFrom = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
// "a, b ,c" into ['a', 'b', 'c'], each tag lowercased and bounded, duplicates dropped
export const parseTags = (text: string): string[] => Array.from(new Set(text.split(',').map((t) => t.trim().toLowerCase().slice(0, 40)).filter(Boolean)));
export const NAME_MAX = 80;
export const DESCRIPTION_MAX = 500;
export const KEY_MAX = 60;
export const TAGS_MAX = 20;
// the New flag and Edit flag forms, cleaned
export function validateFlagForm(input: { name: string; key: string; description: string; tags: string }): { draft: { name: string; key: string; description: string; tags: string[] } } | { error: string } {
  const name = String(input.name ?? '').trim();
  if (!name) return { error: 'Give the flag a name.' };
  if (name.length > NAME_MAX) return { error: `The name is at most ${NAME_MAX} characters.` };
  const key = String(input.key ?? '').trim().toLowerCase();
  if (!FLAG_KEY.test(key) || key.length > KEY_MAX) return { error: 'A key is lowercase letters, digits and hyphens, like dark-mode.' };
  const description = String(input.description ?? '').trim();
  if (description.length > DESCRIPTION_MAX) return { error: `The description is at most ${DESCRIPTION_MAX} characters.` };
  const tags = parseTags(String(input.tags ?? ''));
  if (tags.length > TAGS_MAX) return { error: `A flag has at most ${TAGS_MAX} tags.` };
  return { draft: { name, key, description, tags } };
}
// a flag whose parent is off reads off on every install, whatever its own switch says
export const blockedBy = (f: Flag, list: Flag[]): string | null => (f.requires && list.find((p) => p.key === f.requires)?.enabled !== true ? f.requires : null);
// the list the page shows: a search over name, key and tags, and the Enabled or Disabled filter
export const filterFlags = (list: Flag[], q: string, status: 'all' | 'enabled' | 'disabled'): Flag[] => {
  const needle = q.trim().toLowerCase();
  return list.filter((f) => (status === 'all' || (status === 'enabled') === f.enabled) && (!needle || f.name.toLowerCase().includes(needle) || f.key.includes(needle) || f.tags.some((t) => t.includes(needle))));
};
export const shapeAudit = (a: Record<string, unknown>): AuditRow => ({ id: String(a.id), actor: str(a.actor), action: String(a.action), targetWorkspace: str(a.target_workspace), detail: (a.detail && typeof a.detail === 'object' ? a.detail : {}) as Record<string, unknown>, createdAt: String(a.created_at) });

// the Set plan form, cleaned: a known plan, a whole seat count of zero or more, notes trimmed and bounded
export function validatePlanForm(input: { plan: string; seatsIncluded: string | number; notes: string }): { draft: PlanDraft } | { error: string } {
  if (!(PLANS as readonly string[]).includes(input.plan)) return { error: 'Pick a plan.' };
  const seatsText = String(input.seatsIncluded ?? '').trim();
  if (!/^\d+$/.test(seatsText)) return { error: 'Seats included is a whole number, zero or more.' };
  const seatsIncluded = Number(seatsText);
  if (seatsIncluded > 10000) return { error: 'Seats included is too large.' };
  const notes = String(input.notes ?? '').trim();
  if (notes.length > NOTES_MAX) return { error: `Notes are at most ${NOTES_MAX} characters.` };
  return { draft: { plan: input.plan as Plan, seatsIncluded, notes } };
}

// the Last activity column: the newest note or meeting change, or that nothing synced yet
export const activityLabel = (iso: string | null, now = Date.now()): string => {
  if (!iso) return 'No activity';
  const days = Math.floor(Math.max(0, now - new Date(iso).getTime()) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days} days ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};
export const onDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '');
export const hours = (h: number) => (h >= 10 ? Math.round(h).toString() : (Math.round(h * 10) / 10).toString());

// what an audit row says, in one line
export function auditLine(a: AuditRow): string {
  const d = a.detail;
  const email = typeof d.email === 'string' ? d.email : null;
  switch (a.action) {
    case 'issue_access_code': return `Issued an access code for ${email ?? 'someone'}`;
    case 'revoke_access_code': return `Revoked the access code for ${email ?? 'someone'}`;
    case 'invite_request': return `Approved the access request from ${email ?? 'someone'}${d.plan === 'cloud' ? ' for Cloud' : ''}`;
    case 'set_code_plan': return `Moved ${email ?? 'someone'} to the ${d.plan === 'cloud' ? 'Cloud' : 'Free'} plan`;
    case 'decline_request': return `Declined the access request from ${email ?? 'someone'}`;
    case 'flag_set': return `Turned the ${String(d.key ?? 'flag')} flag ${d.enabled === true ? 'on' : 'off'}`;
    case 'flag_create': return `Created the ${String(d.key ?? 'flag')} flag`;
    case 'flag_update': return `Edited the ${String(d.key ?? 'flag')} flag`;
    case 'flag_requires': return d.requires ? `Made the ${String(d.key ?? 'flag')} flag need ${String(d.requires)}` : `The ${String(d.key ?? 'flag')} flag no longer needs another`;
    case 'set_plan': {
      const after = (d.after ?? {}) as Record<string, unknown>; const before = (d.before ?? {}) as Record<string, unknown>;
      return `Set the plan to ${PLAN_LABEL[after.plan as Plan] ?? after.plan ?? '?'} with ${num(after.seats_included)} seats included (was ${PLAN_LABEL[before.plan as Plan] ?? before.plan ?? '?'}, ${num(before.seats_included)})`;
    }
    default: return a.action.replace(/_/g, ' ');
  }
}

// an error from Supabase or the relay as one plain sentence
export function plain(err: unknown, fallback = 'Something went wrong. Try again.'): string {
  const e = err as { message?: string; code?: string } | null;
  const msg = String(e?.message ?? err ?? '').trim();
  if (/rate limit|too many/i.test(msg)) return 'Too many emails were sent. Wait an hour and try again.';
  if (/Signups not allowed|access code is needed/i.test(msg)) return 'That email has no account here. The admin app is for the platform owner only.';
  if (/expired|invalid|otp/i.test(msg) && /token|otp|code/i.test(msg)) return 'That code is wrong or has expired. Ask for a new one.';
  if (/fetch failed|network|Failed to fetch|ECONNREFUSED|timeout/i.test(msg)) return 'The server could not be reached. Check your connection.';
  if (/JWT|session|signed out/i.test(msg)) return 'You are signed out. Sign in again.';
  if (/Only the platform owner/i.test(msg)) return 'Only the platform owner can do that.';
  // the RPCs raise plain sentences on purpose; anything that reads like one is shown as is
  if (msg && msg.length < 140 && /^[A-Z][^{}<>]*[a-z.]$/.test(msg)) return msg.endsWith('.') ? msg : `${msg}.`;
  return fallback;
}
