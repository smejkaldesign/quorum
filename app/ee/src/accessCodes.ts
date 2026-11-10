import type { AccessCodeStatus } from '../../src/quorum';

// how the Platform page shows an access code: XXXX-XXXX, and one word per state
export const formatCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4, 8)}`;
export const STATUS_LABEL: Record<AccessCodeStatus, string> = { open: 'Open', claimed: 'Claimed', redeemed: 'Used', revoked: 'Revoked', expired: 'Expired' };
export const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
