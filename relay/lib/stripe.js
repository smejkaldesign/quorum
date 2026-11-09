// Stripe over plain fetch: form-encoded requests, the webhook signature check, and the mapping from a subscription to
// the workspace columns. No SDK, so the relay's dependency list stays at two.
import { createHmac, timingSafeEqual } from 'node:crypto';

// nested objects become Stripe's bracket form: { a: { b: 1 } } -> a[b]=1; arrays index the same way
export function formBody(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') formBody(v, key, out); else out.append(key, String(v));
  }
  return out;
}

export async function stripeFetch(path, { key, method = 'POST', body = null, fetchImpl = fetch, idempotencyKey = null } = {}) {
  const headers = { authorization: `Bearer ${key}`, 'stripe-version': '2025-09-30.clover' };
  if (body) headers['content-type'] = 'application/x-www-form-urlencoded';
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  const res = await fetchImpl(`https://api.stripe.com${path}`, { method, headers, body: body ? formBody(body).toString() : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) { const err = new Error(json?.error?.message || `Stripe answered ${res.status}`); err.status = res.status; err.code = json?.error?.code; throw err; }
  return json;
}

// Stripe-Signature: t=<unix>,v1=<hmac>; the payload is the raw body. Rejects an old timestamp so a captured event cannot be replayed
export function verifyStripeSignature(payload, header, secret, { now = Date.now(), toleranceSec = 300 } = {}) {
  const parts = Object.fromEntries(String(header ?? '').split(',').map((p) => p.split('=')).filter((p) => p.length === 2));
  const t = Number(parts.t);
  if (!t || !parts.v1 || !secret) return false;
  if (Math.abs(now / 1000 - t) > toleranceSec) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(parts.v1);
  return a.length === b.length && timingSafeEqual(a, b);
}

// seats and packs from the subscription's items; the plan from its status. A subscription that ended sends the
// workspace back to free with nothing included
export function subscriptionPatch(sub, { seatPrice, packPrice }) {
  const items = sub?.items?.data ?? [];
  const qty = (price) => items.filter((i) => i.price?.id === price || i.price?.lookup_key === price).reduce((n, i) => n + (Number(i.quantity) || 0), 0);
  const live = ['active', 'trialing', 'past_due'].includes(sub?.status);
  const periodEnd = items[0]?.current_period_end ?? sub?.current_period_end ?? null;
  return {
    plan: live ? 'paid' : 'free',
    seats: live ? Math.max(1, qty(seatPrice)) : 0,
    seats_included: live ? Math.max(1, qty(seatPrice)) : 0,
    hour_packs: live ? qty(packPrice) : 0,
    billing_status: sub?.status ?? null,
    current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
    stripe_subscription_id: sub?.id ?? null,
    stripe_customer_id: typeof sub?.customer === 'string' ? sub.customer : sub?.customer?.id ?? null,
  };
}

// the workspace a subscription belongs to: its metadata first, then the subscription id already on a row
export const subscriptionWorkspace = (sub) => sub?.metadata?.workspace_id || null;
