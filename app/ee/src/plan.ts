import type { Plan, PlanDraft } from '../../src/quorum';

// the plans the owner may set by hand (migration 0008): free is the default, cloud pays, internal is Quorum's own, paid
// is the value the first schema used and stays selectable so an old row can be shown and saved as is
export const PLANS: readonly Plan[] = ['free', 'cloud', 'internal', 'paid'];
export const PLAN_LABEL: Record<Plan, string> = { free: 'Free', cloud: 'Cloud', internal: 'Internal', paid: 'Paid' };
export const NOTES_MAX = 500;

// the Set plan form, cleaned: a known plan, a whole seat count of zero or more, notes trimmed and bounded. Returns the
// draft to send or the one sentence to show under the form
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

// what the table shows in the Last activity column: the newest note or meeting change, or that nothing synced yet
export const activityLabel = (iso: string | null, now = Date.now()): string => {
  if (!iso) return 'No activity';
  const days = Math.floor(Math.max(0, now - new Date(iso).getTime()) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days} days ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};
