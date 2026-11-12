import { useEffect, useState } from 'react';
import type { AccountState, Billing, BillingCard as Card, WorkspaceUsage } from '../../src/quorum';
import { Row } from '../../src/controls';
import { IconClock, IconLock, IconPeople, IconScale } from '../../src/icons';
import { AccountCard, EE_MARKER, useAccount } from './Account';
import { billingApi } from './accountMock';
import { INCLUDED_HOURS, PACK, PLAN_LABEL, PRICING, SEAT_PRICE, hasService, teamBilling, usageSummary } from './plan';
import { hours } from './WorkspaceVoice';

const api = billingApi();
const onDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const monthOf = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
export { hasService };

// Settings › Admin › Billing: the plan with seats and packs, the card on file, usage this month against the
// allowance, team billing once a team is on, and the pricing table with the self-serve switch to Cloud. Owners and
// admins act; members read
export function BillingPage() {
  const a = useAccount();
  if (!a) return null;
  if (!a.signedIn || !a.workspace) return <AccountCard account={a} />;
  return <BillingBody account={a} />;
}

function BillingBody({ account }: { account: AccountState }) {
  const ws = account.workspace!;
  const canManage = ws.role !== 'member';
  const [b, setB] = useState<Billing | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const load = () => api.billingStatus().then((r) => { if (r.error) setError(r.error); else if (r.billing) setB(r.billing); });
  useEffect(() => { load(); }, [ws.id]);
  const run = async (key: string, fn: () => Promise<{ error?: string }>) => { setBusy(key); setError(''); const r = await fn(); setBusy(null); if (r.error) setError(r.error); else load(); };
  const checkout = () => run('checkout', () => api.billingCheckout(Math.max(1, b?.members ?? 1)));
  if (!b) return <div data-ee={EE_MARKER}><h3>Plan</h3><div className="set-card"><p className="set-hint">{error || 'Loading…'}</p></div></div>;
  // the plan is the switch for the whole page: with service the card and the team line show, and Cloud is current
  const service = hasService(b.plan);
  return (
    <div data-ee={EE_MARKER}>
      <PlanCard b={b} service={service} canManage={canManage} busy={busy} error={error} run={run} onCheckout={checkout} />
      {service && canManage && <CardOnFile subscribed={b.subscribed} busy={busy} onPortal={() => run('portal', () => api.billingPortal())} />}
      <UsageCard b={b} wsId={ws.id} />
      {ws.teamEnabled && <TeamCard b={b} name={ws.name} />}
      <PricingTable current={service ? 'cloud' : 'free'} comped={service && b.plan !== 'paid'} canManage={canManage} busy={busy} onSwitch={checkout} />
    </div>
  );
}

function PlanCard({ b, service, canManage, busy, error, run, onCheckout }: { b: Billing; service: boolean; canManage: boolean; busy: string | null; error: string; run: (key: string, fn: () => Promise<{ error?: string }>) => Promise<void>; onCheckout: () => void }) {
  const allowance = (b.seats + b.hourPacks) * INCLUDED_HOURS;
  const packs = (n: number) => run('packs', () => api.billingPacks(Math.max(0, n)));
  return (
    <>
      <h3>Plan</h3>
      <div className="set-card">
        <Row icon={<IconScale width={18} height={18} />} title={`${PLAN_LABEL[b.plan as keyof typeof PLAN_LABEL] ?? b.plan} plan`}
          desc={!service ? `Quorum Cloud is $${SEAT_PRICE} per seat a month with ${INCLUDED_HOURS} hours of managed transcription each. Sync, team knowledge and managed transcription start with a subscription.`
            : b.plan === 'paid' ? `${b.status === 'past_due' ? 'Payment is past due. ' : ''}${b.periodEnd ? `Renews ${onDate(b.periodEnd)}.` : ''}` : 'Set by Quorum. Nothing to pay here.'}>
          {canManage && !service && <button className="pill primary" disabled={!!busy} onClick={onCheckout}>{busy === 'checkout' ? 'Opening…' : 'Switch to Cloud'}</button>}
          {canManage && b.subscribed && <button className="pill" disabled={!!busy} onClick={() => run('portal', () => api.billingPortal())}>{busy === 'portal' ? 'Opening…' : 'Manage billing'}</button>}
        </Row>
        {service && (
          <>
            <Row icon={<IconPeople width={18} height={18} />} title="Seats" desc={`${b.members} ${b.members === 1 ? 'member' : 'members'} on ${b.seats} ${b.seats === 1 ? 'seat' : 'seats'}${b.members > b.seats && b.plan === 'paid' ? '. Add seats in Manage billing.' : ''}`}>
              <span className="muted">{b.plan === 'paid' ? `$${SEAT_PRICE} each` : 'included'}</span>
            </Row>
            <Row icon={<IconClock width={18} height={18} />} title="Transcription hours" desc={`${allowance} managed hours a month: ${b.seats} × ${INCLUDED_HOURS} from seats${b.hourPacks ? ` and ${b.hourPacks} × ${PACK.hours} from packs` : ''}. Packs are $${PACK.price} each.`}>
              {canManage && b.subscribed ? (
                <span className="set-stepper" aria-label="Hour packs">
                  <button className="pill small-pill" disabled={!!busy || b.hourPacks === 0} onClick={() => packs(b.hourPacks - 1)} aria-label="Remove a pack">−</button>
                  <strong>{b.hourPacks}</strong>
                  <button className="pill small-pill" disabled={!!busy} onClick={() => packs(b.hourPacks + 1)} aria-label="Add a pack">+</button>
                </span>
              ) : <span className="muted">{b.hourPacks} {b.hourPacks === 1 ? 'pack' : 'packs'}</span>}
            </Row>
          </>
        )}
        {error && <p className="set-error">{error}</p>}
      </div>
      {!canManage && !service && <p className="set-note">Ask an owner or admin of this workspace to switch it to Cloud.</p>}
    </>
  );
}

// brand and last four from the relay; the portal is where a card is changed, since Quorum never sees card numbers
function CardOnFile({ subscribed, busy, onPortal }: { subscribed: boolean; busy: string | null; onPortal: () => void }) {
  const [card, setCard] = useState<Card | undefined>(undefined);
  const [error, setError] = useState('');
  useEffect(() => { let live = true; api.billingCard().then((r) => { if (!live) return; if (r.error) setError(r.error); else setCard(r.card ?? null); }).catch(() => { if (live) setCard(null); }); return () => { live = false; }; }, [subscribed]);
  const label = card === undefined ? 'Reading the card on file…' : card ? `${brandName(card.brand)} ending in ${card.last4}, expires ${String(card.expMonth).padStart(2, '0')}/${card.expYear}` : error || 'No card on file yet. Add one in Manage cards.';
  return (
    <>
      <h3>Payment</h3>
      <div className="set-card">
        <Row icon={<IconLock width={18} height={18} />} title="Card on file" desc={label}>
          {subscribed && <button className="pill" disabled={!!busy} onClick={onPortal}>{busy === 'portal' ? 'Opening…' : 'Manage cards'}</button>}
        </Row>
      </div>
    </>
  );
}
const brandName = (b: string) => ({ visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express', discover: 'Discover' } as Record<string, string>)[b] ?? (b ? b[0].toUpperCase() + b.slice(1) : 'Card');

// managed hours used this month, per seat, against seats plus packs
function UsageCard({ b, wsId }: { b: Billing; wsId: string }) {
  const [usage, setUsage] = useState<WorkspaceUsage | null | undefined>(undefined);
  useEffect(() => { let live = true; api.workspaceUsage().then((r) => { if (live) setUsage(r.usage ?? null); }).catch(() => { if (live) setUsage(null); }); return () => { live = false; }; }, [wsId]);
  const sum = usageSummary({ seats: b.seats, hourPacks: b.hourPacks, managedHours: usage?.managedHours ?? 0 });
  const seats = (usage?.seats ?? []).slice().sort((x, y) => y.managedHours - x.managedHours);
  return (
    <>
      <h3>Usage this month</h3>
      <div className="set-card">
        <Row icon={<IconClock width={18} height={18} />} title={usage === undefined ? 'Reading usage…' : `${hours(sum.used)} of ${sum.cap} managed hours`}
          desc={usage ? `${monthOf(usage.period)}. ${hours(usage.hours)} hours transcribed in all, ${hours(sum.used)} on Quorum's models.${sum.overBy ? ` ${hours(sum.overBy)} hours over the allowance; add a pack or a seat.` : ''}` : usage === null ? 'Usage could not be read right now.' : ''}>
          <span className="bill-meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={sum.percent} aria-label="Managed hours used"><i style={{ width: `${sum.percent}%` }} className={sum.overBy ? 'over' : sum.percent >= 80 ? 'warn' : ''} /></span>
        </Row>
        {seats.map((s) => (
          <div key={s.userId} className="bill-seat"><span>{s.name || s.email || 'A member'}</span><em>{hours(s.managedHours)} h managed · {hours(s.hours)} h in all</em></div>
        ))}
      </div>
    </>
  );
}

// the team's line: every member needs a seat; spare seats and members without one are both said plainly
function TeamCard({ b, name }: { b: Billing; name: string }) {
  const t = teamBilling({ plan: b.plan, seats: b.seats, members: b.members });
  return (
    <>
      <h3>Team billing</h3>
      <div className="set-card">
        <Row icon={<IconPeople width={18} height={18} />} title={`${name}: ${t.members} ${t.members === 1 ? 'member' : 'members'}, ${t.seats} ${t.seats === 1 ? 'seat' : 'seats'}`}
          desc={t.short ? `${t.short} ${t.short === 1 ? 'member has' : 'members have'} no seat yet. Add seats in Manage billing.` : t.spare ? `${t.spare} spare ${t.spare === 1 ? 'seat' : 'seats'} for the next people you invite.` : 'Every member has a seat.'}>
          <span className="muted">{t.perSeat ? `$${t.perSeat} × ${t.seats} = $${t.monthly} a month` : 'included'}</span>
        </Row>
      </div>
    </>
  );
}

// Free and Cloud side by side, the current one marked; the switch is the same checkout the plan card opens. A plan
// Quorum set by hand (cloud, internal) has Cloud service without a price, and the column says so
function PricingTable({ current, comped, canManage, busy, onSwitch }: { current: 'free' | 'cloud'; comped: boolean; canManage: boolean; busy: string | null; onSwitch: () => void }) {
  return (
    <>
      <h3>Plans</h3>
      <div className="bill-plans">
        {PRICING.map((p) => (
          <div key={p.id} className={`bill-plan ${p.id === current ? 'on' : ''}`}>
            <div className="bill-plan-head"><strong>{p.name}</strong>{p.id === current && <em className="stub">Current</em>}</div>
            {p.id === 'cloud' && comped
              ? <p className="bill-price"><span>Set by Quorum</span><small>nothing to pay here</small></p>
              : <p className="bill-price"><span>{p.price}</span>{p.per && <small>{p.per}</small>}</p>}
            <ul>{p.lines.map((l) => <li key={l}>{l}</li>)}</ul>
            {p.id === 'cloud' && current === 'free' && (canManage
              ? <button className="pill primary" disabled={!!busy} onClick={onSwitch}>{busy === 'checkout' ? 'Opening…' : 'Switch to Cloud'}</button>
              : <span className="muted">Ask an owner or admin to switch.</span>)}
          </div>
        ))}
      </div>
    </>
  );
}
