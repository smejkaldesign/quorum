import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { periodStart, remainingSeconds, sessionBudget } from '../lib/allowance.js';

describe('allowance math', () => {
  it('gives one seat 20 hours', () => assert.equal(remainingSeconds({ seats: 1 }), 20 * 3600));
  it('pools seats and packs, less what ran on managed keys', () => {
    assert.equal(remainingSeconds({ seats: 2, hourPacks: 1, usedHours: 25.5 }), (60 - 25.5) * 3600);
  });
  it('never goes below zero', () => assert.equal(remainingSeconds({ seats: 1, usedHours: 99 }), 0));
  it('treats junk as zero', () => assert.equal(remainingSeconds({ seats: 'x', hourPacks: null, usedHours: undefined }), 0));
  it('reports the first of the month in UTC', () => assert.equal(periodStart(new Date('2026-11-08T16:00:00Z')), '2026-11-01T00:00:00.000Z'));
  it('caps a counted session at the hours left, an uncounted one at 4 hours', () => {
    assert.equal(sessionBudget({ counted: true, remaining: 600, maxSessionSeconds: 14400 }), 600);
    assert.equal(sessionBudget({ counted: true, remaining: 99999, maxSessionSeconds: 14400 }), 14400);
    assert.equal(sessionBudget({ counted: false, remaining: 0, maxSessionSeconds: 14400 }), 14400);
  });
});
