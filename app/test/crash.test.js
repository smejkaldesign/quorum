import { describe, expect, it } from 'vitest';
import { REPEAT_MS, crashKind, failsEveryTime } from '../src/crash';

describe('failsEveryTime', () => {
  it('is false for a first crash, with no reload yet', () => { expect(failsEveryTime(null, 1000)).toBe(false); });
  it('is true when the view fails again right after Reload view', () => { expect(failsEveryTime(1000, 1040)).toBe(true); });
  it('is false when the view drew fine for a while after the reload', () => { expect(failsEveryTime(1000, 1000 + REPEAT_MS)).toBe(false); });
});

describe('crashKind', () => {
  const STALE = 'Failed to fetch dynamically imported module: app://quorum/assets/Connectors-abc.js';
  it('names a stale bundle on its first crash', () => { expect(crashKind(STALE, null, 1000)).toBe('stale'); });
  it('keeps a stale bundle stale when it fails again right after Reload view', () => { expect(crashKind(STALE, 1000, 1040)).toBe('stale'); });
  it('names a repeat for any other error that fails again right after Reload view', () => { expect(crashKind('x is undefined', 1000, 1040)).toBe('repeat'); });
  it('names a first crash once', () => { expect(crashKind('x is undefined', null, 1000)).toBe('once'); });
});
