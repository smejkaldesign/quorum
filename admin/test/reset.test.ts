import { describe, expect, it } from 'vitest';
import { resetRefusal, resetTypedMatches, shapeReset } from '../src/reset';

describe('Reset user answers', () => {
  it('reads a refusal with the workspace names', () => {
    const o = shapeReset({ ok: false, reason: 'shared', workspaces: ['Acme', 'Beta'] });
    expect(o).toEqual({ ok: false, reason: 'shared', workspaces: ['Acme', 'Beta'] });
    if (!o.ok) expect(resetRefusal(o)).toBe('This account owns Acme, Beta, which other people use. Its owner hands it to someone else or deletes it first.');
    const b = shapeReset({ ok: false, reason: 'billing', workspaces: ['Paying'] });
    if (!b.ok) expect(resetRefusal(b)).toMatch(/^Paying still has a live subscription/);
  });
  it('reads a reset with and without the new code', () => {
    expect(shapeReset({ ok: true, email: 'p@example.com', workspaces: ['Solo'], invite: { code: 'ABCD2345', plan: 'cloud', id: '01C' } }))
      .toEqual({ ok: true, email: 'p@example.com', workspaces: ['Solo'], invite: { code: 'ABCD2345', plan: 'cloud' } });
    expect(shapeReset({ ok: true, email: 'p@example.com', workspaces: [], invite: null })).toMatchObject({ invite: null });
  });
  it('matches the typed email without case or spaces', () => {
    expect(resetTypedMatches(' P@Example.com ', 'p@example.com')).toBe(true);
    expect(resetTypedMatches('q@example.com', 'p@example.com')).toBe(false);
    expect(resetTypedMatches('', '')).toBe(false);
  });
});
