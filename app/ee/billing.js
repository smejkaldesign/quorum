// Billing (Cloud edition): what the workspace pays for, read through workspace_billing, and the Stripe pages opened
// from the app through the relay (relay/billing.js). The app never holds a Stripe key; the relay signs every call with
// the user's own session token, and Stripe's pages open in the browser.
import { plain } from './account.js';
import { httpUrl, relayUrls, unreachable } from './relay.js';

export const shapeBilling = (r = {}) => ({
  plan: r.plan ?? 'free', seats: Number(r.seats) || 0, seatsIncluded: Number(r.seats_included) || 0, hourPacks: Number(r.hour_packs) || 0, members: Number(r.members) || 0,
  status: r.billing_status ?? null, periodEnd: r.current_period_end ?? null, subscribed: r.subscribed === true,
});
// the plan is the paywall switch: free has no Cloud service; paid came from Stripe; cloud and internal were set by hand
export const hasService = (plan) => ['paid', 'cloud', 'internal'].includes(plan);

export function createBilling({ account, log = () => {}, openExternal = async () => {}, fetchImpl = globalThis.fetch }) {
  const fail = (err, fallback) => { log('billing', err?.message ?? err); return { error: plain(err, fallback) }; };
  const ready = (admin = false) => {
    if (!account.client()) return { error: 'Hosted accounts are not set up in this build.' };
    const s = account.state();
    if (!s.signedIn) return { error: 'Sign in first.' };
    if (!s.workspace) return { error: 'Pick a workspace first.' };
    if (admin && s.workspace.role === 'member') return { error: 'Only owners and admins can manage billing.' };
    return null;
  };
  const relayPost = async (path, body) => {
    const { data: { session } = {} } = await account.client().auth.getSession();
    if (!session?.access_token) throw new Error('You are signed out. Sign in again.');
    const urls = relayUrls({ source: account.envStatus?.().config });
    let res = null;
    for (const url of urls) {
      try {
        res = await fetchImpl(`${httpUrl(url)}${path}`, {
          method: 'POST', headers: { authorization: `Bearer ${session.access_token}`, 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId: account.state().workspace.id, ...body }),
        });
        break;
      } catch (err) { if (unreachable(err) && url !== urls[urls.length - 1]) continue; throw err; }
    }
    const json = await res.json().catch(() => ({}));
    // the relay answers with sentences meant for people; plain() passes those through under a P0 code
    if (!res.ok) { const e = new Error(json.error || 'Billing is unavailable right now.'); e.code = 'P0001'; throw e; }
    return json;
  };
  const handlers = {
    'billing-status': async () => {
      const no = ready(); if (no) return no;
      try {
        const { data, error } = await account.client().rpc('workspace_billing', { workspace_id: account.state().workspace.id });
        if (error) return fail(error, 'Billing could not be read.');
        return { billing: shapeBilling(data ?? {}) };
      } catch (err) { return fail(err, 'Billing could not be read.'); }
    },
    'billing-checkout': async (seats) => {
      const no = ready(true); if (no) return no;
      try { const { url } = await relayPost('/v1/billing/checkout', { seats: Number(seats) || undefined }); await openExternal(url); return { ok: true }; }
      catch (err) { return fail(err, 'Checkout could not be opened.'); }
    },
    'billing-portal': async () => {
      const no = ready(true); if (no) return no;
      try { const { url } = await relayPost('/v1/billing/portal', {}); await openExternal(url); return { ok: true }; }
      catch (err) { return fail(err, 'Billing could not be opened.'); }
    },
    'billing-packs': async (packs) => {
      const no = ready(true); if (no) return no;
      try { const r = await relayPost('/v1/billing/packs', { packs: Math.max(0, Math.trunc(Number(packs) || 0)) }); return { packs: r.packs, remainingSeconds: r.remainingSeconds }; }
      catch (err) { return fail(err, 'The hour packs could not be changed.'); }
    },
  };
  return { handlers };
}

export function registerBilling({ ipcMain, account, log, openExternal }) {
  const b = createBilling({ account, log, openExternal });
  for (const [name, fn] of Object.entries(b.handlers)) ipcMain.handle(name, (_e, ...a) => fn(...a));
  return b;
}
