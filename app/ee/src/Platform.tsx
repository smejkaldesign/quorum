import { useEffect, useState } from 'react';
import type { Member, Plan, PlatformUsage, PlatformWorkspace, Role } from '../../src/quorum';
import { IconChevron } from '../../src/icons';
import { AccountCard, EE_MARKER, useAccount } from './Account';
import { platformApi } from './accountMock';
import { hours } from './WorkspaceVoice';
import { NOTES_MAX, PLAN_LABEL, PLANS, activityLabel, validatePlanForm } from './plan';

const api = platformApi();
const ROLE: Record<Role, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' };
const onDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

// Settings › Admin › Platform. A stopgap until the admin web app: the table of workspaces and, per row, a drawer with
// members, usage this period and the Set plan form. Names and emails of members are the only personal data shown.
export function PlatformPage() {
  const a = useAccount();
  if (!a) return null;
  if (!a.signedIn) return <AccountCard account={a} />;
  if (!a.platformOwner) return <div data-ee={EE_MARKER}><p className="muted">This account is not the platform owner.</p></div>;
  return <Platform />;
}

function Platform() {
  const [list, setList] = useState<PlatformWorkspace[] | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const load = () => api.platformWorkspaces().then((r) => { if (r.error) setError(r.error); else setList(r.workspaces ?? []); });
  useEffect(() => { load(); }, []);
  const saved = (id: string, plan: Plan, seatsIncluded: number, notes: string | null) => setList((l) => l?.map((w) => (w.id === id ? { ...w, plan, seatsIncluded, notes } : w)) ?? l);
  return (
    <div data-ee={EE_MARKER}>
      <h3>{list ? `${list.length} ${list.length === 1 ? 'workspace' : 'workspaces'}` : 'Workspaces'}</h3>
      <div className="set-card plat">
        <div className="plat-row plat-head"><span>Name</span><span>Domain</span><span>Plan</span><span>Members</span><span>Last activity</span><span /></div>
        {list?.map((w) => (
          <div key={w.id} className="plat-item">
            <button className={`plat-row ${open === w.id ? 'on' : ''}`} aria-expanded={open === w.id} onClick={() => setOpen(open === w.id ? null : w.id)}>
              <strong>{w.name}</strong><span>{w.domain ?? '—'}</span><span><em className="stub">{PLAN_LABEL[w.plan] ?? w.plan}</em></span><span>{w.members}</span><span>{activityLabel(w.lastActivity)}</span>
              <IconChevron width={14} height={14} className={open === w.id ? 'open' : ''} />
            </button>
            {open === w.id && <Drawer ws={w} onSaved={(p, s, n) => saved(w.id, p, s, n)} />}
          </div>
        ))}
        {list && !list.length && <p className="set-hint">No workspaces yet.</p>}
        {error && <p className="set-error">{error}</p>}
      </div>
      <p className="set-note">Plans and seats set here are what the workspace is billed for; the relay's hour pool reads seats and hour packs on the workspace row, which stay as they are.</p>
    </div>
  );
}

function Drawer({ ws, onSaved }: { ws: PlatformWorkspace; onSaved: (plan: Plan, seatsIncluded: number, notes: string | null) => void }) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [usage, setUsage] = useState<PlatformUsage | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    api.platformMembers(ws.id).then((r) => { if (!live) return; if (r.error) setError(r.error); else setMembers(r.members ?? []); });
    api.platformUsage(ws.id).then((r) => { if (!live) return; if (r.error) setError(r.error); else if (r.usage) setUsage(r.usage); });
    return () => { live = false; };
  }, [ws.id]);
  const period = usage ? new Date(usage.period).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) : 'this period';
  return (
    <div className="plat-drawer">
      <div className="plat-col">
        <h4>{members ? `${members.length} ${members.length === 1 ? 'member' : 'members'}` : 'Members'}</h4>
        {members?.map((m) => (
          <div key={m.userId} className="member-row">
            <span className="member-avatar">{(m.name || m.email || '?')[0].toUpperCase()}</span>
            <div className="set-text"><strong>{m.name || m.email}</strong><span>{m.name ? `${m.email} · ` : ''}Joined {onDate(m.joinedAt)}</span></div>
            <em className="stub">{ROLE[m.role]}</em>
          </div>
        ))}
        <h4>Usage {usage ? `in ${period}` : period}</h4>
        <p className="muted plat-usage">{usage ? `${hours(usage.managedHours)} managed hours of ${hours(usage.hours)} · ${usage.calls} model ${usage.calls === 1 ? 'call' : 'calls'}` : 'Loading'}</p>
        {usage?.steps.map((s) => <p key={s.role} className="muted plat-usage">{s.role}: {s.calls} {s.calls === 1 ? 'call' : 'calls'}{s.hours ? `, ${hours(s.hours)} hours` : ''}</p>)}
        <p className="muted plat-usage">Created {onDate(ws.createdAt)}</p>
      </div>
      <PlanForm ws={ws} onSaved={onSaved} />
      {error && <p className="set-error">{error}</p>}
    </div>
  );
}

function PlanForm({ ws, onSaved }: { ws: PlatformWorkspace; onSaved: (plan: Plan, seatsIncluded: number, notes: string | null) => void }) {
  const [plan, setPlan] = useState<string>(ws.plan);
  const [seats, setSeats] = useState(String(ws.seatsIncluded));
  const [notes, setNotes] = useState(ws.notes ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const checked = validatePlanForm({ plan, seatsIncluded: seats, notes });
  const dirty = plan !== ws.plan || seats !== String(ws.seatsIncluded) || notes.trim() !== (ws.notes ?? '');
  const save = async () => {
    if ('error' in checked) { setError(checked.error); return; }
    setBusy(true); setError(''); setDone(false);
    const r = await api.platformSetPlan(ws.id, checked.draft);
    setBusy(false);
    if (r.error) { setError(r.error); return; }
    onSaved(checked.draft.plan, checked.draft.seatsIncluded, checked.draft.notes || null);
    setDone(true);
  };
  return (
    <div className="plat-col plat-form">
      <h4>Set plan</h4>
      <label className="plat-field"><span>Plan</span>
        <select className="set-select full" aria-label="Plan" value={plan} onChange={(e) => { setPlan(e.target.value); setDone(false); }}>
          {PLANS.map((p) => <option key={p} value={p}>{PLAN_LABEL[p]}</option>)}
        </select>
      </label>
      <label className="plat-field"><span>Seats included</span>
        <span className="set-field"><input inputMode="numeric" aria-label="Seats included" value={seats} onChange={(e) => { setSeats(e.target.value); setDone(false); }} /></span>
      </label>
      <label className="plat-field"><span>Notes</span>
        <textarea className="set-area" aria-label="Notes" maxLength={NOTES_MAX} value={notes} placeholder="For your own record" onChange={(e) => { setNotes(e.target.value); setDone(false); }} />
      </label>
      <div className="set-line-end">
        <button className="pill primary" disabled={busy || !dirty || 'error' in checked} onClick={save}>Save plan</button>
        {done && <span className="muted">Saved</span>}
      </div>
      {(error || ('error' in checked && dirty)) && <p className="set-error">{error || ('error' in checked ? checked.error : '')}</p>}
    </div>
  );
}
