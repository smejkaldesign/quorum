import { describe, expect, it } from 'vitest';
import { createBilling, hasService, shapeBilling } from '../ee/billing.js';

const account = (over = {}) => ({ client: () => ({ rpc: async () => ({ data: { plan: 'paid', seats: 2, seats_included: 2, hour_packs: 1, members: 3, billing_status: 'active', current_period_end: '2026-12-01T00:00:00Z', subscribed: true }, error: null }), auth: { getSession: async () => ({ data: { session: { access_token: 'tok' } } }) } }), state: () => ({ signedIn: true, workspace: { id: 'ws1', role: 'owner' }, ...over }), envStatus: () => ({ config: 'production' }) });

describe('billing in the app', () => {
  it('shapes the workspace_billing row and knows which plans carry Cloud service', () => {
    expect(shapeBilling({ plan: 'paid', seats: '2', hour_packs: 1, members: 3, subscribed: true })).toMatchObject({ plan: 'paid', seats: 2, hourPacks: 1, members: 3, subscribed: true, seatsIncluded: 0 });
    expect(['paid', 'cloud', 'internal'].every(hasService)).toBe(true);
    expect(hasService('free')).toBe(false);
  });
  it('reads billing through the RPC and opens checkout through the relay with the session token', async () => {
    const opened = []; let posted;
    const fetchImpl = async (url, init) => { posted = { url, init }; return new Response(JSON.stringify({ url: 'https://checkout.stripe.com/c/x' }), { status: 200 }); };
    const b = createBilling({ account: account(), openExternal: async (u) => { opened.push(u); }, fetchImpl });
    expect((await b.handlers['billing-status']()).billing).toMatchObject({ plan: 'paid', seats: 2, hourPacks: 1 });
    expect(await b.handlers['billing-checkout'](4)).toEqual({ ok: true });
    expect(opened).toEqual(['https://checkout.stripe.com/c/x']);
    expect(posted.url).toBe('https://relay.quorum.watch/v1/billing/checkout');
    expect(posted.init.headers.authorization).toBe('Bearer tok');
    expect(JSON.parse(posted.init.body)).toEqual({ workspaceId: 'ws1', seats: 4 });
  });
  it('refuses members, and passes the relay\'s sentence through on a refusal', async () => {
    const member = createBilling({ account: account({ workspace: { id: 'ws1', role: 'member' } }) });
    expect(await member.handlers['billing-portal']()).toEqual({ error: 'Only owners and admins can manage billing.' });
    const refused = createBilling({ account: account(), fetchImpl: async () => new Response(JSON.stringify({ error: 'This workspace already has a subscription. Open Manage billing instead.', code: 'billing' }), { status: 409 }) });
    expect((await refused.handlers['billing-checkout']()).error).toMatch(/already has a subscription/);
  });
});
