import { describe, expect, it } from 'vitest';
import { canAdmin, resolvePage, workspacePages, WORKSPACE_PAGES } from '../src/settingsNav.ts';
import { PLANS as MAIN_PLANS, codeStatus, formatCode, periodStart, shapeAccessCode, shapeMember, shapeUsage, shapeWorkspace } from '../ee/platform.js';
import { STATUS_LABEL, formatCode as uiFormatCode } from '../ee/src/accessCodes.ts';
import { PLANS, PLAN_LABEL, activityLabel, validatePlanForm } from '../ee/src/plan.ts';

describe('the Platform page in the Admin nav', () => {
  it('is listed last, only in a hosted Cloud build and only for the platform owner', () => {
    expect(WORKSPACE_PAGES[WORKSPACE_PAGES.length - 1]).toBe('platform');
    expect(workspacePages('cloud', true, true)).toEqual(['general', 'knowledge', 'members', 'org-connectors', 'org-voice', 'platform']);
    expect(workspacePages('cloud', true, false)).toEqual(['general', 'knowledge', 'members', 'org-connectors', 'org-voice']);
    expect(workspacePages('cloud', true)).not.toContain('platform');
    expect(workspacePages('cloud', false, true)).not.toContain('platform');
    expect(workspacePages('cloud', null, true)).not.toContain('platform');
    expect(workspacePages('local', true, true)).not.toContain('platform');
  });

  it('opens the Admin button for the platform owner even as a workspace member', () => {
    expect(canAdmin('cloud', 'member', true)).toBe(true);
    expect(canAdmin('cloud', 'member', false)).toBe(false);
    expect(canAdmin('cloud', 'member')).toBe(false);
  });

  it('sends a remembered Platform page back to Preferences once the role is gone', () => {
    expect(resolvePage('platform', true, true)).toBe('platform');
    expect(resolvePage('platform', true, false)).toBe('preferences');
    expect(resolvePage('platform', true)).toBe('preferences');
    expect(resolvePage('platform', false, true)).toBe('preferences');
    expect(resolvePage('org-voice', true, false)).toBe('org-voice');
  });
});

describe('shaping the RPC rows for the table', () => {
  it('turns a platform_workspaces row into the table row, with counts as numbers and nulls kept', () => {
    const row = shapeWorkspace({ id: '01SM0KEW0RKSPACE0000000001', name: 'Smoke Co', domain: null, plan: 'free', seats_included: '5', notes: null, members: '3', created_at: '2026-01-02T00:00:00.000Z', last_activity: null });
    expect(row).toEqual({ id: '01SM0KEW0RKSPACE0000000001', name: 'Smoke Co', domain: null, plan: 'free', seatsIncluded: 5, notes: null, members: 3, createdAt: '2026-01-02T00:00:00.000Z', lastActivity: null });
    expect(shapeWorkspace({ id: 'x', name: 'y', plan: 'cloud', created_at: 'c', last_activity: 'l', domain: 'example.com' })).toMatchObject({ domain: 'example.com', seatsIncluded: 0, members: 0, lastActivity: 'l' });
  });

  it('turns a member row into the Members shape', () => {
    expect(shapeMember({ user_id: 'u', email: 'a@example.com', name: null, role: 'admin', joined_at: 'j' })).toEqual({ userId: 'u', email: 'a@example.com', name: null, role: 'admin', joinedAt: 'j' });
  });

  it('folds usage rows into totals: speech carries hours, the other steps are model calls', () => {
    const u = shapeUsage([{ role: 'notes', calls: '2', hours: '0.00', managed_hours: '0.00' }, { role: 'speech', calls: '3', hours: '1.50', managed_hours: '1.00' }, { role: 'summary', calls: '4', hours: '0', managed_hours: '0' }], '2026-11-01T00:00:00.000Z');
    expect(u.period).toBe('2026-11-01T00:00:00.000Z');
    expect(u.hours).toBe(1.5);
    expect(u.managedHours).toBe(1);
    expect(u.calls).toBe(6);
    expect(u.steps.map((s) => s.role)).toEqual(['notes', 'speech', 'summary']);
    expect(shapeUsage(null, 'p')).toEqual({ period: 'p', hours: 0, managedHours: 0, calls: 0, steps: [] });
  });

  it('starts the period on the first of the current month, UTC', () => {
    expect(periodStart(new Date('2026-11-17T15:04:05Z'))).toBe('2026-11-01T00:00:00.000Z');
    expect(periodStart(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01-01T00:00:00.000Z');
  });

  it('labels last activity by age and never shows a raw null', () => {
    const now = new Date('2026-11-17T12:00:00Z').getTime();
    expect(activityLabel(null, now)).toBe('No activity');
    expect(activityLabel('2026-11-17T09:00:00Z', now)).toBe('Today');
    expect(activityLabel('2026-11-16T09:00:00Z', now)).toBe('Yesterday');
    expect(activityLabel('2026-11-10T09:00:00Z', now)).toBe('7 days ago');
    expect(activityLabel('2026-01-10T09:00:00Z', now)).toMatch(/2026/);
  });
});

describe('the Set plan form', () => {
  it('knows the same plans as the main process and the migration, each with a label', () => {
    expect([...PLANS]).toEqual(MAIN_PLANS);
    expect([...PLANS].sort()).toEqual(['cloud', 'free', 'internal', 'paid']);
    for (const p of PLANS) expect(PLAN_LABEL[p].length).toBeGreaterThan(0);
  });

  it('accepts a known plan, a whole seat count and trimmed notes', () => {
    expect(validatePlanForm({ plan: 'cloud', seatsIncluded: ' 5 ', notes: '  trial  ' })).toEqual({ draft: { plan: 'cloud', seatsIncluded: 5, notes: 'trial' } });
    expect(validatePlanForm({ plan: 'free', seatsIncluded: 0, notes: '' })).toEqual({ draft: { plan: 'free', seatsIncluded: 0, notes: '' } });
  });

  it('refuses an unknown plan, a negative, fractional or non-numeric seat count, and notes over the limit', () => {
    expect(validatePlanForm({ plan: 'gold', seatsIncluded: 1, notes: '' })).toEqual({ error: 'Pick a plan.' });
    expect(validatePlanForm({ plan: 'cloud', seatsIncluded: '-1', notes: '' })).toHaveProperty('error');
    expect(validatePlanForm({ plan: 'cloud', seatsIncluded: '1.5', notes: '' })).toHaveProperty('error');
    expect(validatePlanForm({ plan: 'cloud', seatsIncluded: 'five', notes: '' })).toHaveProperty('error');
    expect(validatePlanForm({ plan: 'cloud', seatsIncluded: '', notes: '' })).toHaveProperty('error');
    expect(validatePlanForm({ plan: 'cloud', seatsIncluded: '20000', notes: '' })).toHaveProperty('error');
    expect(validatePlanForm({ plan: 'cloud', seatsIncluded: '1', notes: 'x'.repeat(501) })).toHaveProperty('error');
  });
});

describe('access codes', () => {
  const base = { id: 'a1', email: 'x@example.com', code: 'K7PQ2MX9', note: null, issued_at: '2026-11-01T00:00:00Z', expires_at: '2026-12-01T00:00:00Z' };
  const now = new Date('2026-11-09T00:00:00Z').getTime();
  it('derives one status word per row, used and revoked first, then expiry, then a claim', () => {
    expect(codeStatus(shapeAccessCode(base), now)).toBe('open');
    expect(codeStatus(shapeAccessCode({ ...base, claimed_at: '2026-11-08T23:00:00Z' }), now)).toBe('claimed');
    expect(codeStatus(shapeAccessCode({ ...base, claimed_at: '2026-11-08T23:00:00Z', redeemed_at: '2026-11-08T23:10:00Z' }), now)).toBe('redeemed');
    expect(codeStatus(shapeAccessCode({ ...base, revoked_at: '2026-11-02T00:00:00Z' }), now)).toBe('revoked');
    expect(codeStatus(shapeAccessCode({ ...base, expires_at: '2026-11-08T00:00:00Z' }), now)).toBe('expired');
    expect(codeStatus(shapeAccessCode({ ...base, expires_at: '2026-11-08T00:00:00Z', redeemed_at: '2026-11-07T00:00:00Z' }), now)).toBe('redeemed');
  });
  it('shows a code as XXXX-XXXX in both the main process and the page, with a label for every status', () => {
    expect(formatCode('K7PQ2MX9')).toBe('K7PQ-2MX9');
    expect(uiFormatCode('K7PQ2MX9')).toBe('K7PQ-2MX9');
    for (const s of ['open', 'claimed', 'redeemed', 'revoked', 'expired']) expect(STATUS_LABEL[s]).toBeTruthy();
  });
  it('keeps the redeemer email and the shaped fields', () => {
    const a = shapeAccessCode({ ...base, redeemed_at: '2026-11-08T00:00:00Z', redeemed_email: 'x@example.com' });
    expect(a).toMatchObject({ id: 'a1', email: 'x@example.com', code: 'K7PQ2MX9', redeemedEmail: 'x@example.com', status: 'redeemed' });
  });
});
