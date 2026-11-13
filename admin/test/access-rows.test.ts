import { describe, expect, it } from 'vitest';
import { type AccessRequest, noteCount, rowActions } from '../src/shape';

const code = (status: NonNullable<AccessRequest['code']>['status'], plan: 'free' | 'cloud' = 'free') =>
  ({ id: 'c1', code: 'ABCDEFGH', plan, expiresAt: '2026-12-01T00:00:00Z', redeemedAt: null, revokedAt: null, status });

describe('the actions an Access row shows', () => {
  it('a pending request is approved or declined, nothing else', () => {
    expect(rowActions({ status: 'pending', code: null })).toEqual({ approve: true, decline: true, send: false, copy: false, convert: null, revoke: false });
  });

  it('a live free code is sent, copied, converted to Cloud or revoked', () => {
    expect(rowActions({ status: 'invited', code: code('open') })).toEqual({ approve: false, decline: false, send: true, copy: true, convert: 'cloud', revoke: true });
    expect(rowActions({ status: 'invited', code: code('claimed') }).send).toBe(true);
  });

  it('a live cloud code moves to Free', () => {
    expect(rowActions({ status: 'invited', code: code('open', 'cloud') }).convert).toBe('free');
  });

  it('used, revoked, expired and declined rows have no actions', () => {
    const none = { approve: false, decline: false, send: false, copy: false, convert: null, revoke: false };
    expect(rowActions({ status: 'invited', code: code('redeemed') })).toEqual(none);
    expect(rowActions({ status: 'invited', code: code('revoked') })).toEqual(none);
    expect(rowActions({ status: 'invited', code: code('expired') })).toEqual(none);
    expect(rowActions({ status: 'declined', code: null })).toEqual(none);
  });
});

describe('the note count on the row', () => {
  it('counts the message and the owner note', () => {
    expect(noteCount({ note: null, adminNote: null })).toBe(0);
    expect(noteCount({ note: 'Test', adminNote: null })).toBe(1);
    expect(noteCount({ note: 'Test', adminNote: 'mine' })).toBe(2);
  });
});
