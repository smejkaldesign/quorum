import { describe, expect, it } from 'vitest';
import { calendarWindow, normalizeDays } from '../calendarWindow.js';

const at = (s) => new Date(`${s}T10:00:00`);

describe('calendar window', () => {
  it('reads a number of days as is, between 1 and 5', () => {
    expect(calendarWindow(3, at('2026-11-18'))).toEqual({ days: 3, from: null, until: null });
    expect(calendarWindow(14).days).toBe(5);
    expect(calendarWindow(undefined).days).toBe(1);
  });
  it('runs a weekday to the end of Friday', () => {
    const mon = calendarWindow('week', at('2026-11-16'));
    expect(mon).toMatchObject({ days: 4, from: null });
    expect(mon.until.toDateString()).toBe(new Date('2026-11-21T00:00:00').toDateString());
    const fri = calendarWindow('week', at('2026-11-20'));
    expect(fri.days).toBe(0);
    expect(fri.until.toDateString()).toBe(new Date('2026-11-21T00:00:00').toDateString());
  });
  it('shows the coming Monday to Friday on a weekend', () => {
    const sat = calendarWindow('week', at('2026-11-14'));
    expect(sat.days).toBe(6);
    expect(sat.from.toDateString()).toBe(new Date('2026-11-16T00:00:00').toDateString());
    const sun = calendarWindow('week', at('2026-11-15'));
    expect(sun.days).toBe(5);
    expect(sun.from.toDateString()).toBe(new Date('2026-11-16T00:00:00').toDateString());
    expect(sat.until.toDateString()).toBe(new Date('2026-11-21T00:00:00').toDateString());
  });
  it('keeps week or a day count between 1 and 5', () => {
    expect(normalizeDays('week')).toBe('week');
    expect(normalizeDays(7)).toBe(5);
    expect(normalizeDays('x')).toBe(1);
  });
});
