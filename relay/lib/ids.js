import { randomBytes } from 'node:crypto';

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

// Crockford base32 ULID, the same shape the app and the schema use (app/ee/sync.js)
export function ulid(time = Date.now()) {
  let t = '';
  for (let i = 0; i < 10; i++) { t = B32[time % 32] + t; time = Math.floor(time / 32); }
  let r = '';
  for (const b of randomBytes(16)) r += B32[b & 31];
  return t + r;
}
