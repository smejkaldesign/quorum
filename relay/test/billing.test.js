import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { checkoutBody, eventPatch, handleCheckout, handleWebhook } from '../billing.js';
import { requirePlan, RelayError } from '../lib/auth.js';
import { formBody, subscriptionPatch, verifyStripeSignature } from '../lib/stripe.js';
import { baseTables, fakeAnon, fakeDb, TOKEN, USER, WS } from './helpers.js';

const PRICES = { seatPrice: 'price_seat', packPrice: 'price_pack' };
const sign = (payload, secret, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`;
const sub = (over = {}) => ({ id: 'sub_1', status: 'active', customer: 'cus_1', metadata: { workspace_id: WS }, items: { data: [{ id: 'si_1', price: { id: 'price_seat' }, quantity: 3, current_period_end: 1800000000 }, { id: 'si_2', price: { id: 'price_pack' }, quantity: 2 }] }, ...over });

// a request and a response the handlers can use without a socket
function fakeReq({ method = 'POST', body = '', headers = {} } = {}) {
  const listeners = {};
  const req = { method, headers, url: '/', on: (ev, fn) => { listeners[ev] = fn; return req; }, destroy() {} };
  setTimeout(() => { if (body) listeners.data?.(Buffer.from(body)); listeners.end?.(); }, 0);
  return req;
}
function fakeRes() {
  const res = { status: 0, body: '', headersSent: false, writeHead(s) { this.status = s; this.headersSent = true; }, end(b) { this.body = String(b ?? ''); this.done?.(); } };
  res.finished = new Promise((r) => { res.done = r; });
  return res;
}
// fakeDb plus update(): records the patch and the filter it was applied with
function dbWithUpdate(tables) {
  const db = fakeDb({ tables });
  const updates = [];
  const from = db.from;
  db.from = (table) => {
    const b = from(table);
    b.update = (patch) => { const u = { table, patch, where: {} }; updates.push(u); const q = { eq(k, v) { u.where[k] = v; return q; }, then: (res, rej) => Promise.resolve({ data: null, error: null }).then(res, rej) }; return q; };
    const sel = b.select; b.select = (...a) => { sel(...a); b.count = (tables[table] ?? []).length; return b; };
    return b;
  };
  db.updates = updates;
  return db;
}

describe('stripe helpers', () => {
  it('encodes nested objects in bracket form', () => {
    assert.equal(formBody({ mode: 'subscription', line_items: [{ price: 'p', quantity: 2 }], metadata: { workspace_id: 'w' } }).toString(), 'mode=subscription&line_items%5B0%5D%5Bprice%5D=p&line_items%5B0%5D%5Bquantity%5D=2&metadata%5Bworkspace_id%5D=w');
  });
  it('accepts a fresh signed payload and refuses a wrong secret, a stale timestamp, or a missing header', () => {
    const payload = '{"id":"evt_1"}';
    assert.equal(verifyStripeSignature(payload, sign(payload, 'whsec'), 'whsec'), true);
    assert.equal(verifyStripeSignature(payload, sign(payload, 'other'), 'whsec'), false);
    assert.equal(verifyStripeSignature(payload, sign(payload, 'whsec', 1000), 'whsec'), false);
    assert.equal(verifyStripeSignature(payload, undefined, 'whsec'), false);
    const t = Math.floor(Date.now() / 1000);
    assert.equal(verifyStripeSignature(payload, `${sign(payload, 'whsec', t)},v1=${'0'.repeat(64)}`, 'whsec'), true);
    assert.equal(verifyStripeSignature(payload, `t=${t},v1=${'0'.repeat(64)},${sign(payload, 'whsec', t).split(',')[1]}`, 'whsec'), true);
  });
  it('maps a live subscription to paid with its seats and packs, and an ended one back to free', () => {
    assert.deepEqual(subscriptionPatch(sub(), PRICES), { plan: 'paid', seats: 3, seats_included: 3, hour_packs: 2, billing_status: 'active', current_period_end: '2027-01-15T08:00:00.000Z', stripe_subscription_id: 'sub_1', stripe_customer_id: 'cus_1' });
    assert.equal(subscriptionPatch(sub({ status: 'past_due' }), PRICES).plan, 'paid');
    const ended = subscriptionPatch(sub({ status: 'canceled' }), PRICES);
    assert.equal(ended.plan, 'free'); assert.equal(ended.seats, 1); assert.equal(ended.seats_included, 0); assert.equal(ended.hour_packs, 0);
  });
});

describe('events to workspace patches', () => {
  it('stores the customer and subscription ids when checkout completes', () => {
    const e = { type: 'checkout.session.completed', data: { object: { mode: 'subscription', customer: 'cus_9', subscription: 'sub_9', metadata: { workspace_id: WS } } } };
    assert.deepEqual(eventPatch(e, PRICES), { workspaceId: WS, patch: { stripe_customer_id: 'cus_9', stripe_subscription_id: 'sub_9' } });
  });
  it('clears everything on deletion and ignores events it does not act on', () => {
    const d = eventPatch({ type: 'customer.subscription.deleted', data: { object: sub({ status: 'canceled' }) } }, PRICES);
    assert.equal(d.workspaceId, WS); assert.equal(d.patch.plan, 'free'); assert.equal(d.patch.seats, 1); assert.equal(d.patch.stripe_subscription_id, null); assert.equal(d.patch.hour_packs, 0);
    assert.equal(eventPatch({ type: 'invoice.paid', data: { object: {} } }, PRICES), null);
  });
});

describe('the paywall', () => {
  it('refuses the free plan with 402 unless the route accepts any plan', async () => {
    const free = fakeDb({ tables: { ...baseTables(), workspaces: [{ id: WS, plan: 'free', deleted_at: null }] } });
    await assert.rejects(requirePlan(free, WS), (e) => e instanceof RelayError && e.status === 402 && e.code === 'plan');
    assert.equal(await requirePlan(free, WS, true), 'free');
    assert.equal(await requirePlan(fakeDb({ tables: baseTables() }), WS), 'paid');
    for (const plan of ['cloud', 'internal']) assert.equal(await requirePlan(fakeDb({ tables: { ...baseTables(), workspaces: [{ id: WS, plan, deleted_at: null }] } }), WS), plan);
  });
});

describe('checkout', () => {
  const config = { stripe: { key: 'sk_test', seatPrice: 'price_seat', packPrice: 'price_pack', returnUrl: 'https://quorum.watch' } };
  const anon = fakeAnon({ [TOKEN]: { id: USER, email: 'ana@example.com' } });
  it('builds a subscription checkout with adjustable seats and the workspace in the metadata', () => {
    const b = checkoutBody({ workspace: { id: WS, stripe_customer_id: null }, user: { email: 'ana@example.com' }, seats: 4, prices: PRICES, returnUrl: 'https://quorum.watch' });
    assert.equal(b.mode, 'subscription'); assert.equal(b.line_items[0].quantity, 4); assert.equal(b.line_items[0].price, 'price_seat');
    assert.equal(b.subscription_data.metadata.workspace_id, WS); assert.equal(b.customer_email, 'ana@example.com');
    assert.equal('customer_creation' in b, false);
    assert.equal(checkoutBody({ workspace: { id: WS, stripe_customer_id: 'cus_1' }, user: {}, seats: 1, prices: PRICES, returnUrl: 'x' }).customer, 'cus_1');
  });
  it('lets an admin on the free plan start checkout and returns the Stripe url', async () => {
    const tables = { ...baseTables(), members: [{ workspace_id: WS, user_id: USER, role: 'owner', deleted_at: null }], workspaces: [{ id: WS, name: 'W', plan: 'free', seats: 1, hour_packs: 0, deleted_at: null }] };
    const db = dbWithUpdate(tables);
    let posted;
    const fetchImpl = async (url, init) => { posted = { url, body: init.body }; return new Response(JSON.stringify({ id: 'cs_1', url: 'https://checkout.stripe.com/c/cs_1' }), { status: 200 }); };
    const res = fakeRes();
    await handleCheckout(fakeReq({ body: JSON.stringify({ workspaceId: WS, seats: 2 }), headers: { authorization: `Bearer ${TOKEN}` } }), res, { clients: { anon, db }, config, fetchImpl });
    await res.finished;
    assert.equal(res.status, 200); assert.deepEqual(JSON.parse(res.body), { url: 'https://checkout.stripe.com/c/cs_1' });
    assert.equal(posted.url, 'https://api.stripe.com/v1/checkout/sessions'); assert.match(posted.body, /line_items%5B0%5D%5Bquantity%5D=2/);
  });
  it('refuses a member, and a workspace that already subscribed', async () => {
    const db = dbWithUpdate({ ...baseTables(), workspaces: [{ id: WS, name: 'W', plan: 'free', seats: 1, hour_packs: 0, deleted_at: null }] });
    const res = fakeRes();
    await handleCheckout(fakeReq({ body: JSON.stringify({ workspaceId: WS }), headers: { authorization: `Bearer ${TOKEN}` } }), res, { clients: { anon, db }, config, fetchImpl: async () => { throw new Error('no call'); } });
    await res.finished;
    assert.equal(res.status, 403);
    const db2 = dbWithUpdate({ ...baseTables(), members: [{ workspace_id: WS, user_id: USER, role: 'admin', deleted_at: null }], workspaces: [{ id: WS, name: 'W', plan: 'paid', seats: 2, hour_packs: 0, stripe_subscription_id: 'sub_1', deleted_at: null }] });
    const res2 = fakeRes();
    await handleCheckout(fakeReq({ body: JSON.stringify({ workspaceId: WS }), headers: { authorization: `Bearer ${TOKEN}` } }), res2, { clients: { anon, db: db2 }, config, fetchImpl: async () => { throw new Error('no call'); } });
    await res2.finished;
    assert.equal(res2.status, 409);
  });
});

describe('the webhook', () => {
  const config = { stripe: { key: 'sk', webhookSecret: 'whsec_1', seatPrice: 'price_seat', packPrice: 'price_pack' } };
  it('applies a signed subscription update to the workspace row', async () => {
    const db = dbWithUpdate(baseTables());
    const payload = JSON.stringify({ type: 'customer.subscription.updated', data: { object: sub() } });
    const res = fakeRes();
    await handleWebhook(fakeReq({ body: payload, headers: { 'stripe-signature': sign(payload, 'whsec_1') } }), res, { clients: { db }, config });
    await res.finished;
    assert.equal(res.status, 200);
    assert.equal(db.updates.length, 1);
    assert.deepEqual(db.updates[0].where, { id: WS });
    assert.equal(db.updates[0].patch.plan, 'paid'); assert.equal(db.updates[0].patch.seats, 3); assert.equal(db.updates[0].patch.hour_packs, 2);
  });
  it('leaves a hand-set plan alone and still writes seats and packs', async () => {
    const db = dbWithUpdate({ ...baseTables(), workspaces: [{ id: WS, plan: 'internal', seats: 1, hour_packs: 0, deleted_at: null }] });
    const payload = JSON.stringify({ type: 'customer.subscription.deleted', data: { object: sub({ status: 'canceled' }) } });
    const res = fakeRes();
    await handleWebhook(fakeReq({ body: payload, headers: { 'stripe-signature': sign(payload, 'whsec_1') } }), res, { clients: { db }, config });
    await res.finished;
    assert.equal(res.status, 200);
    assert.equal('plan' in db.updates[0].patch, false); assert.equal(db.updates[0].patch.seats, 1); assert.equal(db.updates[0].patch.hour_packs, 0);
  });
  it('rejects a bad signature without touching the database', async () => {
    const db = dbWithUpdate(baseTables());
    const payload = JSON.stringify({ type: 'customer.subscription.updated', data: { object: sub() } });
    const res = fakeRes();
    await handleWebhook(fakeReq({ body: payload, headers: { 'stripe-signature': sign(payload, 'wrong') } }), res, { clients: { db }, config });
    await res.finished;
    assert.equal(res.status, 400); assert.equal(db.updates.length, 0);
  });
});
