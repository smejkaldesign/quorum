import { useEffect, useState } from 'react';
import { api } from '../api';
import { type Member, NOTES_MAX, PLANS, PLAN_LABEL, type Plan, ROLE_LABEL, type Usage, type Workspace, activityLabel, hours, onDate, validatePlanForm } from '../shape';

// every workspace on this Quorum and, per row, a drawer with its members, usage this period and the Set plan form.
// Plans and seats set here are what the workspace is billed for; the relay's hour pool reads seats and hour packs on
// the workspace row, which stay as they are.
export function Workspaces() {
  const [list, setList] = useState<Workspace[] | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { api.workspaces().then((r) => (r.ok ? setList(r.value) : setError(r.error))); }, []);
  const saved = (id: string, plan: Plan, seatsIncluded: number, notes: string | null) => setList((l) => l?.map((w) => (w.id === id ? { ...w, plan, seatsIncluded, notes } : w)) ?? l);
  return (
    <>
      <h1>{list ? `${list.length} ${list.length === 1 ? 'workspace' : 'workspaces'}` : 'Workspaces'}</h1>
      {error && <p className="error">{error}</p>}
      <div className="card list">
        <div className="ws-row ws-head"><span>Name</span><span>Domain</span><span>Plan</span><span>Members</span><span>Last activity</span></div>
        {list?.map((w) => (
          <div key={w.id} className={`ws ${open === w.id ? 'open' : ''}`}>
            <button className="ws-row" aria-expanded={open === w.id} onClick={() => setOpen(open === w.id ? null : w.id)}>
              <strong>{w.name}</strong><span>{w.domain ?? '—'}</span><span><em className={`state ${w.plan === 'free' ? 'off' : 'good'}`}>{PLAN_LABEL[w.plan] ?? w.plan}</em></span><span>{w.members}</span><span>{activityLabel(w.lastActivity)}</span>
            </button>
            {open === w.id && <Drawer ws={w} onSaved={(p, s, n) => saved(w.id, p, s, n)} />}
          </div>
        ))}
        {list && !list.length && <p className="muted pad">No workspaces yet. The first appears when someone signs in and creates one.</p>}
      </div>
    </>
  );
}

function Drawer({ ws, onSaved }: { ws: Workspace; onSaved: (plan: Plan, seatsIncluded: number, notes: string | null) => void }) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    api.members(ws.id).then((r) => { if (!live) return; if (r.ok) setMembers(r.value); else setError(r.error); });
    api.usage(ws.id).then((r) => { if (!live) return; if (r.ok) setUsage(r.value); else setError(r.error); });
    return () => { live = false; };
  }, [ws.id]);
  const period = usage ? new Date(usage.period).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }) : 'this period';
  return (
    <div className="ws-body">
      <div>
        <h3>{members ? `${members.length} ${members.length === 1 ? 'member' : 'members'}` : 'Members'}</h3>
        {members?.map((m) => (
          <div key={m.userId} className="member">
            <span className="avatar">{(m.name || m.email || '?')[0].toUpperCase()}</span>
            <span className="who"><strong>{m.name || m.email}</strong><em>{m.name ? `${m.email} · ` : ''}Joined {onDate(m.joinedAt)}</em></span>
            <em className="state off">{ROLE_LABEL[m.role]}</em>
          </div>
        ))}
        <h3>Usage {usage ? `in ${period}` : period}</h3>
        <p className="muted">{usage ? `${hours(usage.managedHours)} managed hours of ${hours(usage.hours)} · ${usage.calls} model ${usage.calls === 1 ? 'call' : 'calls'}` : 'Loading…'}</p>
        {usage?.steps.map((s) => <p key={s.role} className="muted small">{s.role}: {s.calls} {s.calls === 1 ? 'call' : 'calls'}{s.hours ? `, ${hours(s.hours)} hours` : ''}</p>)}
        <p className="muted small">Created {onDate(ws.createdAt)} · id {ws.id}</p>
      </div>
      <PlanForm ws={ws} onSaved={onSaved} />
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function PlanForm({ ws, onSaved }: { ws: Workspace; onSaved: (plan: Plan, seatsIncluded: number, notes: string | null) => void }) {
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
    const r = await api.setPlan(ws.id, checked.draft);
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    onSaved(checked.draft.plan, checked.draft.seatsIncluded, checked.draft.notes || null);
    setDone(true);
  };
  return (
    <form className="plan-form" onSubmit={(e) => { e.preventDefault(); if (!busy && dirty) save(); }}>
      <h3>Set plan</h3>
      <label>Plan<select value={plan} onChange={(e) => { setPlan(e.target.value); setDone(false); }}>{PLANS.map((p) => <option key={p} value={p}>{PLAN_LABEL[p]}</option>)}</select></label>
      <label>Seats included<input inputMode="numeric" value={seats} onChange={(e) => { setSeats(e.target.value); setDone(false); }} /></label>
      <label>Notes<textarea maxLength={NOTES_MAX} value={notes} placeholder="For your own record" onChange={(e) => { setNotes(e.target.value); setDone(false); }} /></label>
      <div className="actions"><button className="pill primary" type="submit" disabled={busy || !dirty || 'error' in checked}>Save plan</button>{done && <span className="good">Saved</span>}</div>
      {(error || ('error' in checked && dirty)) && <p className="error">{error || ('error' in checked ? checked.error : '')}</p>}
    </form>
  );
}
