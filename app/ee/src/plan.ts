import type { Plan } from '../../src/quorum';

// the plans a workspace can be on (migration 0008): free is the default, paid after checkout, cloud and internal set by
// the platform owner from the admin app. The Billing page shows the label; the plan itself changes only there or
// through the Stripe webhook
export const PLAN_LABEL: Record<Plan, string> = { free: 'Free', cloud: 'Cloud', internal: 'Internal', paid: 'Paid' };

export const SEAT_PRICE = 8;
export const INCLUDED_HOURS = 20;
export const PACK = { hours: 20, price: 5 };

// the two columns of the Billing page's pricing table, the same lines as quorum.watch's pricing cards
export const PRICING: { id: 'free' | 'cloud'; name: string; price: string; per: string; lines: string[] }[] = [
  { id: 'free', name: 'Open source', price: 'Free', per: '', lines: [
    'Capture and on-device transcription for Zoom, Meet and Teams',
    'Notes as plain markdown in your Agent OS folder',
    'Claude Code sign-in, your own API key, or a local model',
    'Import existing notes through the CLI and MCP server',
  ] },
  { id: 'cloud', name: 'Cloud', price: `$${SEAT_PRICE}`, per: '/seat per month', lines: [
    'Built in highest quality and accuracy voice-to-text models',
    'Starter Agent OS, built and maintained for you',
    'Sync across Macs and the web',
    'Team knowledge with members and invites',
    'Hosted models and transcription, no API keys to manage',
    `${INCLUDED_HOURS} managed hours per seat each month, more in $${PACK.price} packs`,
  ] },
];

// the plan is the paywall switch: free has no Cloud service; paid came from Stripe; cloud and internal were set by hand
export const hasService = (plan: string) => ['paid', 'cloud', 'internal'].includes(plan);

// usage this month against the allowance: seats and packs each carry INCLUDED_HOURS of managed transcription. percent
// is capped at 100 for the meter; overBy says how far past the cap the workspace went
export function usageSummary({ seats, hourPacks, managedHours }: { seats: number; hourPacks: number; managedHours: number }) {
  const cap = Math.max(0, (Number(seats) || 0) + (Number(hourPacks) || 0)) * INCLUDED_HOURS;
  const used = Math.max(0, Number(managedHours) || 0);
  const percent = cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : used > 0 ? 100 : 0;
  return { cap, used, percent, remaining: Math.max(0, cap - used), overBy: Math.max(0, used - cap) };
}

// what a team pays: every member needs a seat; seats beyond the members are spare, members beyond the seats are short
export function teamBilling({ plan, seats, members }: { plan: string; seats: number; members: number }) {
  const s = Math.max(0, Number(seats) || 0), m = Math.max(0, Number(members) || 0);
  const perSeat = plan === 'paid' ? SEAT_PRICE : 0;
  return { seats: s, members: m, spare: Math.max(0, s - m), short: Math.max(0, m - s), perSeat, monthly: perSeat * s };
}
