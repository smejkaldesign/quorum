// Billing for Quorum Cloud: Stripe Checkout and the billing portal opened from the app, hour packs added to the
// subscription, and the webhook that writes plan, seats and packs onto the workspace. Only admins start checkout or
// change packs; any member may read. Stripe is reached over fetch (lib/stripe.js); the webhook is verified by signature.
import { allowance, authorize, bearer, RelayError } from './lib/auth.js';
import { stripeFetch, subscriptionPatch, subscriptionWorkspace, verifyStripeSignature } from './lib/stripe.js';
import { readJson } from './summary.js';

const ADMIN = new Set(['owner', 'admin']);

function requireStripe(config) {
  if (!config.stripe?.key || !config.stripe?.seatPrice) throw new RelayError('billing', 'Billing is not set up on this relay.', 503);
}

const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const failJson = (res, err, log, what) => {
  const status = err instanceof RelayError ? err.status : (err.status >= 400 && err.status < 500 ? 400 : 500);
  log(`${what}_failed`, { status, message: err.message });
  json(res, status, { error: err instanceof RelayError ? err.message : 'Billing is unavailable right now.', code: err.code ?? 'server' });
};

async function workspaceRow(db, workspaceId) {
  const { data, error } = await db.from('workspaces').select('id, name, plan, seats, hour_packs, stripe_customer_id, stripe_subscription_id').eq('id', workspaceId).is('deleted_at', null).maybeSingle();
  if (error || !data) throw new RelayError('server', 'The workspace could not be read.', 500);
  return data;
}

// the admin's email on the Stripe customer, the workspace id in every object's metadata so the webhook can find the row
export function checkoutBody({ workspace, user, seats, prices, returnUrl }) {
  const body = {
    mode: 'subscription',
    client_reference_id: workspace.id,
    success_url: `${returnUrl}/billing/done?workspace=${encodeURIComponent(workspace.id)}`,
    cancel_url: `${returnUrl}/billing/cancelled`,
    allow_promotion_codes: true,
    line_items: [{ price: prices.seatPrice, quantity: Math.max(1, seats), adjustable_quantity: { enabled: true, minimum: 1, maximum: 500 } }],
    subscription_data: { metadata: { workspace_id: workspace.id } },
    metadata: { workspace_id: workspace.id },
  };
  if (workspace.stripe_customer_id) { body.customer = workspace.stripe_customer_id; body.customer_update = { address: 'auto', name: 'auto' }; }
  else body.customer_email = user.email ?? undefined;
  return body;
}

export async function handleCheckout(req, res, { clients, config, log = () => {}, fetchImpl = fetch }) {
  try {
    if (req.method !== 'POST') throw new RelayError('bad_request', 'POST only.', 405);
    requireStripe(config);
    const b = await readJson(req, 64 * 1024);
    const user = await authorize(clients, { token: bearer(req.headers.authorization), workspaceId: String(b.workspaceId ?? ''), anyPlan: true });
    if (!ADMIN.has(user.role)) throw new RelayError('forbidden', 'Only owners and admins can manage billing.', 403);
    const workspace = await workspaceRow(clients.db, b.workspaceId);
    if (workspace.stripe_subscription_id) throw new RelayError('billing', 'This workspace already has a subscription. Open Manage billing instead.', 409);
    const { count } = await clients.db.from('members').select('user_id', { count: 'exact', head: true }).eq('workspace_id', workspace.id).is('deleted_at', null);
    const seats = Math.min(500, Math.max(1, Math.trunc(Number(b.seats) || count || 1)));
    const session = await stripeFetch('/v1/checkout/sessions', { key: config.stripe.key, fetchImpl, body: checkoutBody({ workspace, user, seats, prices: config.stripe, returnUrl: config.stripe.returnUrl }) });
    log('checkout_started', { workspaceId: workspace.id, seats });
    json(res, 200, { url: session.url });
  } catch (err) { failJson(res, err, log, 'checkout'); }
}

export async function handlePortal(req, res, { clients, config, log = () => {}, fetchImpl = fetch }) {
  try {
    if (req.method !== 'POST') throw new RelayError('bad_request', 'POST only.', 405);
    requireStripe(config);
    const b = await readJson(req, 64 * 1024);
    const user = await authorize(clients, { token: bearer(req.headers.authorization), workspaceId: String(b.workspaceId ?? ''), anyPlan: true });
    if (!ADMIN.has(user.role)) throw new RelayError('forbidden', 'Only owners and admins can manage billing.', 403);
    const workspace = await workspaceRow(clients.db, b.workspaceId);
    if (!workspace.stripe_customer_id) throw new RelayError('billing', 'This workspace has no billing account yet. Start a subscription first.', 409);
    const session = await stripeFetch('/v1/billing_portal/sessions', { key: config.stripe.key, fetchImpl, body: { customer: workspace.stripe_customer_id, return_url: `${config.stripe.returnUrl}/billing/done?workspace=${encodeURIComponent(workspace.id)}` } });
    json(res, 200, { url: session.url });
  } catch (err) { failJson(res, err, log, 'portal'); }
}

// packs ride on the subscription as a second item on the pack price; quantity 0 removes the item. The workspace row is
// updated at once so the allowance grows without waiting for the webhook, which confirms the same numbers
export async function handlePacks(req, res, { clients, config, log = () => {}, fetchImpl = fetch }) {
  try {
    if (req.method !== 'POST') throw new RelayError('bad_request', 'POST only.', 405);
    requireStripe(config);
    if (!config.stripe.packPrice) throw new RelayError('billing', 'Hour packs are not set up on this relay.', 503);
    const b = await readJson(req, 64 * 1024);
    const user = await authorize(clients, { token: bearer(req.headers.authorization), workspaceId: String(b.workspaceId ?? '') });
    if (!ADMIN.has(user.role)) throw new RelayError('forbidden', 'Only owners and admins can change hour packs.', 403);
    const packs = Math.min(100, Math.max(0, Math.trunc(Number(b.packs))));
    if (!Number.isFinite(Number(b.packs))) throw new RelayError('bad_request', 'Send the number of packs.', 400);
    const workspace = await workspaceRow(clients.db, b.workspaceId);
    if (!workspace.stripe_subscription_id) throw new RelayError('billing', 'Hour packs need a subscription first.', 409);
    const sub = await stripeFetch(`/v1/subscriptions/${workspace.stripe_subscription_id}`, { key: config.stripe.key, fetchImpl, method: 'GET' });
    const item = (sub.items?.data ?? []).find((i) => i.price?.id === config.stripe.packPrice);
    if (item && packs === 0) await stripeFetch(`/v1/subscription_items/${item.id}`, { key: config.stripe.key, fetchImpl, method: 'DELETE', body: { proration_behavior: 'create_prorations' } });
    else if (item) await stripeFetch(`/v1/subscription_items/${item.id}`, { key: config.stripe.key, fetchImpl, body: { quantity: packs, proration_behavior: 'create_prorations' } });
    else if (packs > 0) await stripeFetch('/v1/subscription_items', { key: config.stripe.key, fetchImpl, body: { subscription: sub.id, price: config.stripe.packPrice, quantity: packs, proration_behavior: 'create_prorations' } });
    const { error } = await clients.db.from('workspaces').update({ hour_packs: packs }).eq('id', workspace.id);
    if (error) throw new RelayError('server', 'The packs were bought but the workspace could not be updated; it catches up with the next webhook.', 500);
    const a = await allowance(clients.db, workspace.id);
    log('packs_set', { workspaceId: workspace.id, packs });
    json(res, 200, { packs, remainingSeconds: a.remaining });
  } catch (err) { failJson(res, err, log, 'packs'); }
}

// the raw body is needed for the signature, so this one does not use readJson
const readRaw = (req, limit = 1024 * 1024) => new Promise((resolve, reject) => {
  let size = 0; const chunks = [];
  req.on('data', (c) => { size += c.length; if (size > limit) { reject(new RelayError('bad_request', 'The request is too large.', 413)); req.destroy(); return; } chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

// what one event does to the workspace row; null when the event is not one the relay acts on
export function eventPatch(event, prices) {
  const type = event?.type ?? '';
  const obj = event?.data?.object ?? {};
  if (type === 'checkout.session.completed' && obj.mode === 'subscription') {
    const workspaceId = obj.metadata?.workspace_id || obj.client_reference_id;
    if (!workspaceId) return null;
    return { workspaceId, patch: { stripe_customer_id: typeof obj.customer === 'string' ? obj.customer : obj.customer?.id ?? null, stripe_subscription_id: typeof obj.subscription === 'string' ? obj.subscription : obj.subscription?.id ?? null } };
  }
  if (/^customer\.subscription\.(created|updated|deleted)$/.test(type)) {
    const patch = subscriptionPatch(obj, prices);
    if (type === 'customer.subscription.deleted') Object.assign(patch, { plan: 'free', seats: 1, seats_included: 0, hour_packs: 0, stripe_subscription_id: null });
    return { workspaceId: subscriptionWorkspace(obj), subscriptionId: obj.id, patch };
  }
  return null;
}

export async function handleWebhook(req, res, { clients, config, log = () => {} }) {
  try {
    if (req.method !== 'POST') throw new RelayError('bad_request', 'POST only.', 405);
    if (!config.stripe?.webhookSecret) throw new RelayError('billing', 'Billing is not set up on this relay.', 503);
    const raw = await readRaw(req);
    if (!verifyStripeSignature(raw, req.headers['stripe-signature'], config.stripe.webhookSecret)) throw new RelayError('unauthorized', 'Bad signature.', 400);
    let event; try { event = JSON.parse(raw); } catch { throw new RelayError('bad_request', 'The body must be JSON.', 400); }
    const change = eventPatch(event, config.stripe);
    if (!change) { log('webhook_ignored', { type: event?.type }); return json(res, 200, { received: true }); }
    // a plan the platform owner set by hand (cloud, internal) stays whatever Stripe says
    if (change.patch.plan) {
      let sel = clients.db.from('workspaces').select('plan');
      sel = change.workspaceId ? sel.eq('id', change.workspaceId) : sel.eq('stripe_subscription_id', change.subscriptionId);
      const { data: cur } = await sel.maybeSingle();
      if (cur && ['cloud', 'internal'].includes(cur.plan)) delete change.patch.plan;
    }
    // a subscription without workspace metadata is matched by the id checkout already stored
    let q = clients.db.from('workspaces').update(change.patch);
    q = change.workspaceId ? q.eq('id', change.workspaceId) : q.eq('stripe_subscription_id', change.subscriptionId);
    const { error } = await q;
    if (error) throw new RelayError('server', 'The workspace could not be updated.', 500);
    log('webhook_applied', { type: event.type, workspaceId: change.workspaceId ?? null, plan: change.patch.plan ?? null, seats: change.patch.seats ?? null, packs: change.patch.hour_packs ?? null });
    json(res, 200, { received: true });
  } catch (err) { failJson(res, err, log, 'webhook'); }
}
