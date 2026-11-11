import { describe, expect, it } from 'vitest';
import { PLANS, PLAN_LABEL, activityLabel, auditLine, codeStatus, formatCode, periodStart, plain, requestWithCode, shapeOverview, shapeRequest, shapeUsage, shapeUser, shapeWorkspace, validatePlanForm } from '../src/shape';

describe('rows from the platform RPCs', () => {
  it('turns a platform_workspaces row into the table row, with counts as numbers and nulls kept', () => {
    const w = shapeWorkspace({ id: '01W', name: 'Smoke Co', domain: null, plan: 'free', seats_included: '5', notes: null, members: '2', created_at: '2026-11-01T00:00:00Z', last_activity: null });
    expect(w).toEqual({ id: '01W', name: 'Smoke Co', domain: null, plan: 'free', seatsIncluded: 5, notes: null, members: 2, createdAt: '2026-11-01T00:00:00Z', lastActivity: null });
  });
  it('folds usage rows into the period totals, counting model calls without speech', () => {
    const u = shapeUsage([{ role: 'speech', calls: '3', hours: '1.5', managed_hours: '1.0' }, { role: 'summary', calls: '4', hours: 0, managed_hours: 0 }, { role: 'notes', calls: 2, hours: 0, managed_hours: 0 }], '2026-11-01T00:00:00.000Z');
    expect(u).toMatchObject({ hours: 1.5, managedHours: 1, calls: 6 });
    expect(u.steps).toHaveLength(3);
    expect(periodStart(new Date('2026-11-17T09:30:00Z'))).toBe('2026-11-01T00:00:00.000Z');
  });
  it('shapes a request with the code it became and the code state at that moment', () => {
    const now = new Date('2026-11-09T00:00:00Z').getTime();
    const base = { id: 'r1', email: 'x@example.com', name: 'X', note: 'why', source: 'site', status: 'invited', created_at: '2026-11-01T00:00:00Z', decided_at: '2026-11-02T00:00:00Z', admin_note: null, has_account: false };
    const open = shapeRequest({ ...base, code_id: 'c1', code: 'K7PQ2MX9', code_expires_at: '2026-12-01T00:00:00Z', code_redeemed_at: null, code_revoked_at: null }, now);
    expect(open.code).toMatchObject({ id: 'c1', code: 'K7PQ2MX9', status: 'open' });
    expect(shapeRequest({ ...base, code_id: 'c1', code: 'K7PQ2MX9', code_expires_at: '2026-12-01T00:00:00Z', code_redeemed_at: '2026-11-03T00:00:00Z', code_revoked_at: null }, now).code?.status).toBe('redeemed');
    expect(shapeRequest({ ...base, code_id: 'c1', code: 'K7PQ2MX9', code_expires_at: '2026-11-08T00:00:00Z', code_redeemed_at: null, code_revoked_at: null }, now).code?.status).toBe('expired');
    expect(shapeRequest({ ...base, status: 'pending', code_id: null, code: null }, now)).toMatchObject({ status: 'pending', code: null, hasAccount: false });
    const invited = requestWithCode(shapeRequest({ ...base, status: 'pending', code_id: null, code: null }, now), { id: 'c2', code: 'ABCD2345', expires_at: '2026-12-09T00:00:00Z' }, now);
    expect(invited).toMatchObject({ status: 'invited', code: { id: 'c2', code: 'ABCD2345', status: 'open' } });
  });
  it('derives one code status word per row', () => {
    const now = new Date('2026-11-09T00:00:00Z').getTime();
    const c = { expiresAt: '2026-12-01T00:00:00Z', redeemedAt: null, revokedAt: null };
    expect(codeStatus(c, now)).toBe('open');
    expect(codeStatus({ ...c, claimedAt: '2026-11-08T00:00:00Z' }, now)).toBe('claimed');
    expect(codeStatus({ ...c, revokedAt: '2026-11-08T00:00:00Z' }, now)).toBe('revoked');
    expect(formatCode('K7PQ2MX9')).toBe('K7PQ-2MX9');
  });
  it('shapes users and the overview', () => {
    expect(shapeUser({ user_id: 'u1', email: 'a@example.com', created_at: 'c', last_sign_in_at: null, workspaces: '2', owner: true })).toEqual({ userId: 'u1', email: 'a@example.com', createdAt: 'c', lastSignInAt: null, workspaces: 2, owner: true });
    expect(shapeOverview({ users: '3', workspaces: 1, paid_workspaces: 0, members: 2, codes_open: 1, requests_pending: 4, managed_hours_month: '0.03', month_start: '2026-11-01T00:00:00+00:00' })).toMatchObject({ users: 3, requestsPending: 4, managedHoursMonth: 0.03 });
  });
});

describe('the Set plan form', () => {
  it('knows the plans the migration allows, each with a label, and refuses bad seat counts and long notes', () => {
    expect([...PLANS].sort()).toEqual(['cloud', 'free', 'internal', 'paid']);
    for (const p of PLANS) expect(PLAN_LABEL[p]).toBeTruthy();
    expect(validatePlanForm({ plan: 'cloud', seatsIncluded: ' 5 ', notes: ' x ' })).toEqual({ draft: { plan: 'cloud', seatsIncluded: 5, notes: 'x' } });
    expect(validatePlanForm({ plan: 'gold', seatsIncluded: '1', notes: '' })).toHaveProperty('error');
    expect(validatePlanForm({ plan: 'cloud', seatsIncluded: '-1', notes: '' })).toHaveProperty('error');
    expect(validatePlanForm({ plan: 'cloud', seatsIncluded: '20000', notes: '' })).toHaveProperty('error');
    expect(validatePlanForm({ plan: 'cloud', seatsIncluded: '1', notes: 'x'.repeat(501) })).toHaveProperty('error');
  });
  it('labels activity relative to today', () => {
    const now = new Date('2026-11-17T12:00:00Z').getTime();
    expect(activityLabel(null, now)).toBe('No activity');
    expect(activityLabel('2026-11-17T09:00:00Z', now)).toBe('Today');
    expect(activityLabel('2026-11-16T09:00:00Z', now)).toBe('Yesterday');
    expect(activityLabel('2026-11-10T09:00:00Z', now)).toBe('7 days ago');
  });
});

describe('words for people', () => {
  it('writes one line per audit action', () => {
    const row = (action: string, detail: Record<string, unknown>) => ({ id: 'a', actor: null, action, targetWorkspace: null, detail, createdAt: 'c' });
    expect(auditLine(row('invite_request', { email: 'x@example.com' }))).toBe('Approved the access request from x@example.com');
    expect(auditLine(row('set_plan', { before: { plan: 'free', seats_included: 0 }, after: { plan: 'cloud', seats_included: 3 } }))).toBe('Set the plan to Cloud with 3 seats included (was Free, 0)');
    expect(auditLine(row('something_new', {}))).toBe('something new');
  });
  it('turns errors into one plain sentence', () => {
    expect(plain({ message: 'Only the platform owner can do that' })).toBe('Only the platform owner can do that.');
    expect(plain({ message: 'That request is not pending' })).toBe('That request is not pending.');
    expect(plain({ message: 'Failed to fetch' })).toMatch(/could not be reached/);
    expect(plain({ message: 'Signups not allowed for otp' })).toMatch(/no account here/);
    expect(plain({ message: 'relation "x" does not exist {code 42P01}' })).toBe('Something went wrong. Try again.');
  });
});
