import { useEffect, useState } from 'react';
import type { Billing } from '../../src/quorum';
import { Row } from '../../src/controls';
import { IconClock, IconPeople, IconScale } from '../../src/icons';
import { AccountCard, EE_MARKER, useAccount } from './Account';
import { billingApi } from './accountMock';
import { PLAN_LABEL } from './plan';
import { INCLUDED_HOURS, PACK, SEAT_PRICE } from './WorkspaceVoice';

const api = billingApi();
const onDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
export const hasService = (plan: string) => ['paid', 'cloud', 'internal'].includes(plan);

// Settings › Admin › General: the plan, seats and hour packs, and the Stripe pages for the admins. A workspace on the
// free plan sees why nothing syncs yet and one button to start
export function BillingPage() {
  const a = useAccount();
  if (!a) return null;
  if (!a.signedIn || !a.workspace) return <AccountCard account={a} />;
  return <BillingCard canManage={a.workspace.role !== 'member'} />;
}

function BillingCard({ canManage }: { canManage: boolean }) {
  const [b, setB] = useState<Billing | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const load = () => api.billingStatus().then((r) => { if (r.error) setError(r.error); else if (r.billing) setB(r.billing); });
  useEffect(() => { load(); }, []);
  const run = async (key: string, fn: () => Promise<{ error?: string }>) => { setBusy(key); setError(''); const r = await fn(); setBusy(null); if (r.error) setError(r.error); else load(); };
  const packs = async (n: number) => run('packs', () => api.billingPacks(Math.max(0, n)));
  if (!b) return <div data-ee={EE_MARKER}><h3>Billing</h3><div className="set-card"><p className="set-hint">{error || 'Loading…'}</p></div></div>;
  const service = hasService(b.plan);
  const hours = (b.seats + b.hourPacks) * INCLUDED_HOURS;
  return (
    <div data-ee={EE_MARKER}>
      <h3>Billing</h3>
      <div className="set-card">
        <Row icon={<IconScale width={18} height={18} />} title={`${PLAN_LABEL[b.plan as keyof typeof PLAN_LABEL] ?? b.plan} plan`}
          desc={!service ? `Quorum Cloud is $${SEAT_PRICE} per seat a month with ${INCLUDED_HOURS} hours of managed transcription each. Sync and managed transcription start with a subscription.`
            : b.plan === 'paid' ? `${b.status === 'past_due' ? 'Payment is past due. ' : ''}${b.periodEnd ? `Renews ${onDate(b.periodEnd)}.` : ''}` : 'Set by Quorum. Nothing to pay here.'}>
          {canManage && !service && <button className="pill primary" disabled={!!busy} onClick={() => run('checkout', () => api.billingCheckout(Math.max(1, b.members)))}>{busy === 'checkout' ? 'Opening…' : 'Start Quorum Cloud'}</button>}
          {canManage && b.subscribed && <button className="pill" disabled={!!busy} onClick={() => run('portal', () => api.billingPortal())}>{busy === 'portal' ? 'Opening…' : 'Manage billing'}</button>}
        </Row>
        {service && (
          <>
            <Row icon={<IconPeople width={18} height={18} />} title="Seats" desc={`${b.members} ${b.members === 1 ? 'member' : 'members'} on ${b.seats} ${b.seats === 1 ? 'seat' : 'seats'}${b.members > b.seats && b.plan === 'paid' ? '. Add seats in Manage billing.' : ''}`}>
              <span className="muted">{b.plan === 'paid' ? `$${SEAT_PRICE} each` : 'included'}</span>
            </Row>
            <Row icon={<IconClock width={18} height={18} />} title="Transcription hours" desc={`${hours} managed hours a month: ${b.seats} × ${INCLUDED_HOURS} from seats${b.hourPacks ? ` and ${b.hourPacks} × ${PACK.hours} from packs` : ''}. Packs are $${PACK.price} each.`}>
              {canManage && b.subscribed ? (
                <span className="set-stepper" aria-label="Hour packs">
                  <button className="pill small-pill" disabled={!!busy || b.hourPacks === 0} onClick={() => packs(b.hourPacks - 1)} aria-label="Remove a pack">−</button>
                  <strong>{b.hourPacks} {b.hourPacks === 1 ? 'pack' : 'packs'}</strong>
                  <button className="pill small-pill" disabled={!!busy} onClick={() => packs(b.hourPacks + 1)} aria-label="Add a pack">+</button>
                </span>
              ) : <span className="muted">{b.hourPacks} {b.hourPacks === 1 ? 'pack' : 'packs'}</span>}
            </Row>
          </>
        )}
        {error && <p className="set-error">{error}</p>}
      </div>
      {!canManage && !service && <p className="set-note">Ask an owner or admin of this workspace to start the subscription.</p>}
    </div>
  );
}
