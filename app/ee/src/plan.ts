import type { Plan } from '../../src/quorum';

// the plans a workspace can be on (migration 0008): free is the default, paid after checkout, cloud and internal set by
// the platform owner from the admin app. The Billing page shows the label; the plan itself changes only there or
// through the Stripe webhook
export const PLAN_LABEL: Record<Plan, string> = { free: 'Free', cloud: 'Cloud', internal: 'Internal', paid: 'Paid' };
