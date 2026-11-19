// ee/account.js, migration 0047: Delete my data's hosted half, and the signed-out state that says the account on this
// Mac was deleted on the server.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ client: null }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => fake.client }));

const USER = { id: 'u-1', email: 'person@example.com' };
function makeClient({ session = { user: USER }, getUser = { error: null }, gone = false } = {}) {
  const calls = [];
  const c = {
    calls,
    session,
    auth: {
      getSession: async () => ({ data: { session: c.session } }),
      getUser: async () => getUser,
      signOut: async () => { calls.push(['signOut']); c.session = null; },
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
    rpc: async (name, args) => { calls.push([name, args]); return name === 'account_gone' ? { data: gone, error: null } : { data: name === 'pending_invites' || name === 'domain_workspaces' ? [] : { ok: true }, error: null }; },
    from: () => ({ select: () => ({ is: async () => ({ data: [], error: null }), eq() { return this; }, order() { return this; } }) }),
  };
  return c;
}

let createAccount;
beforeEach(async () => {
  process.env.QUORUM_SUPABASE_URL = 'http://127.0.0.1:1';
  process.env.QUORUM_SUPABASE_ANON_KEY = 'test-anon';
  ({ createAccount } = await import('../ee/account.js'));
});
afterEach(() => { delete process.env.QUORUM_SUPABASE_URL; delete process.env.QUORUM_SUPABASE_ANON_KEY; });

const open = () => { const a = createAccount({ settings: {}, saveSettings: () => {} }); return a; };

describe('account-data-delete', () => {
  it('asks for the signed-in email, then deletes the hosted data and signs out', async () => {
    fake.client = makeClient();
    const a = open();
    await a.refresh();
    expect(a.state().signedIn).toBe(true);
    expect(await a.handlers['account-data-delete']('someone@example.com')).toEqual({ error: 'Type your email address to confirm.' });
    expect(fake.client.calls.some(([n]) => n === 'delete_my_data')).toBe(false);
    expect(await a.handlers['account-data-delete'](' Person@Example.com ')).toEqual({ ok: true });
    expect(fake.client.calls.map(([n]) => n)).toEqual(expect.arrayContaining(['delete_my_data', 'signOut']));
    expect(a.state().signedIn).toBe(false);
    a.stop();
  });
});

describe('a deleted account', () => {
  it('says so once the session ends and the server has no such user', async () => {
    fake.client = makeClient({ gone: true });
    const a = open();
    await a.refresh();
    fake.client.session = null;
    await a.refresh();
    expect(fake.client.calls).toContainEqual(['account_gone', { uid: 'u-1' }]);
    expect(a.state()).toMatchObject({ signedIn: false, accountGone: 'person@example.com' });
    a.stop();
  });

  it('stays a plain sign-out when the account still exists', async () => {
    fake.client = makeClient({ gone: false });
    const a = open();
    await a.refresh();
    fake.client.session = null;
    await a.refresh();
    expect(a.state()).toMatchObject({ signedIn: false, accountGone: null });
    a.stop();
  });

  it('catches a token that is still valid for a user the server no longer has', async () => {
    fake.client = makeClient({ gone: true, getUser: { error: { code: 'user_not_found', message: 'User from sub claim in JWT does not exist' } } });
    const a = open();
    await a.refresh();
    expect(a.state()).toMatchObject({ signedIn: false, accountGone: 'person@example.com' });
    expect(fake.client.calls).toContainEqual(['signOut']);
    a.stop();
  });
});
