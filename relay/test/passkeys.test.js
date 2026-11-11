import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SESSION_HOURS, createChallenges, hashToken, newToken } from '../passkeys.js';

describe('passkey sessions', () => {
  it('tokens are long, unique and stored only as their hash', () => {
    const a = newToken(); const b = newToken();
    assert.ok(a.length >= 40);
    assert.notEqual(a, b);
    assert.match(hashToken(a), /^[0-9a-f]{64}$/);
    assert.equal(hashToken(a), hashToken(a));
    assert.notEqual(hashToken(a), hashToken(b));
    assert.equal(SESSION_HOURS, 12);
  });
  it('a challenge is handed out once and forgotten after five minutes', () => {
    let t = 0;
    const c = createChallenges({ now: () => t });
    c.put('u1', 'login', 'abc');
    assert.equal(c.take('u1', 'register'), null);
    assert.equal(c.take('u1', 'login'), 'abc');
    assert.equal(c.take('u1', 'login'), null);
    c.put('u1', 'login', 'def');
    t = 5 * 60 * 1000 + 1;
    assert.equal(c.take('u1', 'login'), null);
  });
});
