import { HOURS_PER_PACK, HOURS_PER_SEAT } from './config.js';

// the workspace pool for one calendar month: 20 hours a seat plus 20 a pack, less what already ran on Quorum's keys.
// usedHours is the sum of workspace_usage.managed_hours across the workspace for the period. Returns whole seconds, never negative.
export function remainingSeconds({ seats = 1, hourPacks = 0, usedHours = 0 } = {}) {
  const allowed = (Math.max(0, Number(seats) || 0) * HOURS_PER_SEAT + Math.max(0, Number(hourPacks) || 0) * HOURS_PER_PACK) * 3600;
  const used = Math.max(0, Number(usedHours) || 0) * 3600;
  return Math.max(0, Math.round(allowed - used));
}

// the first day of the month a timestamp falls in, UTC, as the view's period column reports it
export function periodStart(now = new Date()) {
  const d = new Date(now);
  d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

// how many seconds one connection may still carry: the session cap, and the allowance when the hours count
export function sessionBudget({ counted, remaining, maxSessionSeconds }) {
  return counted ? Math.min(maxSessionSeconds, remaining) : maxSessionSeconds;
}
