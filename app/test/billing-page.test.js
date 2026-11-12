import { describe, expect, it } from 'vitest';
import { INCLUDED_HOURS, PACK, PRICING, SEAT_PRICE, hasService, teamBilling, usageSummary } from '../ee/src/plan.ts';

describe('usage against the allowance', () => {
  it('counts seats and packs at the included hours each', () => {
    expect(usageSummary({ seats: 3, hourPacks: 1, managedHours: 24.2 })).toEqual({ cap: 80, used: 24.2, percent: 30, remaining: 55.8, overBy: 0 });
    expect(usageSummary({ seats: 1, hourPacks: 0, managedHours: 0 })).toEqual({ cap: INCLUDED_HOURS, used: 0, percent: 0, remaining: INCLUDED_HOURS, overBy: 0 });
  });

  it('caps the meter at 100 and says how far over the workspace went', () => {
    const s = usageSummary({ seats: 1, hourPacks: 0, managedHours: 25 });
    expect(s.percent).toBe(100);
    expect(s.overBy).toBe(5);
    expect(s.remaining).toBe(0);
  });

  it('treats a workspace without seats as fully used once anything was transcribed', () => {
    expect(usageSummary({ seats: 0, hourPacks: 0, managedHours: 0 }).percent).toBe(0);
    expect(usageSummary({ seats: 0, hourPacks: 0, managedHours: 0.5 }).percent).toBe(100);
    expect(usageSummary({ seats: -2, hourPacks: 0, managedHours: 0 }).cap).toBe(0);
  });
});

describe('team billing', () => {
  it('charges the seat price per seat on a paid plan and nothing on a comped one', () => {
    expect(teamBilling({ plan: 'paid', seats: 4, members: 3 })).toEqual({ seats: 4, members: 3, spare: 1, short: 0, perSeat: SEAT_PRICE, monthly: 4 * SEAT_PRICE });
    expect(teamBilling({ plan: 'cloud', seats: 2, members: 5 })).toEqual({ seats: 2, members: 5, spare: 0, short: 3, perSeat: 0, monthly: 0 });
  });
});

describe('the pricing table', () => {
  it('names the two plans with the seat price, the included hours and the pack price', () => {
    expect(PRICING.map((p) => p.id)).toEqual(['free', 'cloud']);
    expect(PRICING[1].price).toBe(`$${SEAT_PRICE}`);
    expect(PRICING[1].lines.join(' ')).toContain(`${INCLUDED_HOURS} managed hours per seat`);
    expect(PRICING[1].lines.join(' ')).toContain(`$${PACK.price} packs`);
    expect(PRICING[0].price).toBe('Free');
  });

  it('knows which plans carry Cloud service', () => {
    for (const p of ['paid', 'cloud', 'internal']) expect(hasService(p)).toBe(true);
    expect(hasService('free')).toBe(false);
  });
});
