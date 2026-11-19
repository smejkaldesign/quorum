import { describe, expect, it } from 'vitest';
import { REPEAT_MS, failsEveryTime } from '../src/crash';

describe('failsEveryTime', () => {
  it('is false for a first crash, with no reload yet', () => { expect(failsEveryTime(null, 1000)).toBe(false); });
  it('is true when the view fails again right after Reload view', () => { expect(failsEveryTime(1000, 1040)).toBe(true); });
  it('is false when the view drew fine for a while after the reload', () => { expect(failsEveryTime(1000, 1000 + REPEAT_MS)).toBe(false); });
});
