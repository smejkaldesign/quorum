import type { ReactNode } from 'react';

// Celune's Badge with the desktop app's .ac-status colors: pending and claimed in amber, open in the brand blue,
// redeemed and paid in green, declined, expired and revoked muted.
export type BadgeTone = 'pending' | 'open' | 'good' | 'off' | 'danger';

export function Badge({ tone = 'off', children }: { tone?: BadgeTone; children: ReactNode }) {
  return <em className={`badge ${tone}`}>{children}</em>;
}
