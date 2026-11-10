import { describe, expect, it } from 'vitest';
import { OAUTH_LOOPBACK, parseOAuthReturn } from '../ee/account.js';

describe('parseOAuthReturn', () => {
  it('reads the code from the installed app deep link', () => {
    expect(parseOAuthReturn('quorum://auth/callback?code=abc-123')).toEqual({ code: 'abc-123' });
  });
  it('reads the code from the development loopback', () => {
    expect(parseOAuthReturn(`${OAUTH_LOOPBACK}?code=xyz`)).toEqual({ code: 'xyz' });
  });
  it('ignores other links', () => {
    expect(parseOAuthReturn('quorum://note/foo.md')).toBeNull();
    expect(parseOAuthReturn('not a url')).toBeNull();
  });
  it('turns the refused sign-up into the invite-only message', () => {
    const r = parseOAuthReturn('quorum://auth/callback?error=server_error&error_code=unexpected_failure&error_description=Database+error+saving+new+user');
    expect(r.error).toMatch(/invite-only/);
  });
  it('passes a plain provider message through and hides odd ones', () => {
    expect(parseOAuthReturn('quorum://auth/callback?error_description=Access+denied+by+user').error).toBe('Access denied by user');
    expect(parseOAuthReturn('quorum://auth/callback?error_description=%3Cscript%3E').error).toMatch(/did not complete/);
    expect(parseOAuthReturn('quorum://auth/callback').error).toMatch(/did not complete/);
  });
});
