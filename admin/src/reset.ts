// Reset user (migration 0047, platform_reset_user): the answer as the Users page shows it. A refusal names the
// workspaces that hold the reset back; a reset names the workspaces that went with the account, and with a reinvite
// carries the new access code for the same email.
import { type CodePlan, codePlan } from './shape';

export type ResetOutcome =
  | { ok: true; email: string; workspaces: string[]; invite: { code: string; plan: CodePlan } | null }
  | { ok: false; reason: 'shared' | 'billing'; workspaces: string[] };

const names = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

export function shapeReset(d: Record<string, unknown>): ResetOutcome {
  if (d.ok !== true) return { ok: false, reason: d.reason === 'billing' ? 'billing' : 'shared', workspaces: names(d.workspaces) };
  const invite = d.invite && typeof d.invite === 'object' ? (d.invite as Record<string, unknown>) : null;
  return { ok: true, email: String(d.email ?? ''), workspaces: names(d.workspaces), invite: invite?.code ? { code: String(invite.code), plan: codePlan(invite.plan) } : null };
}

// the sentence for a refusal, with the workspace names
export function resetRefusal(o: Extract<ResetOutcome, { ok: false }>): string {
  const list = o.workspaces.join(', ');
  return o.reason === 'billing'
    ? `${list} still has a live subscription. Cancel it under Billing first, then reset the account.`
    : `This account owns ${list}, which other people use. Its owner hands it to someone else or deletes it first.`;
}

// the typed value has to be the account's email; case and spaces around it are ignored
export const resetTypedMatches = (typed: string, email: string) => !!email && typed.trim().toLowerCase() === email.trim().toLowerCase();
