import { useEffect, useState } from 'react';
import { api } from '../api';
import { type Member, NOTES_MAX, PLANS, PLAN_LABEL, type Plan, ROLE_LABEL, type Usage, type Workspace, activityLabel, hours, onDate, validatePlanForm } from '../shape';
import { Badge, Button, Card, Drawer, Empty, Field, IconChevron, Input, PageHeader, Select, SkeletonRows, Table, TableHead, TableItem, TableRowButton, Textarea, useToast } from '../ui';

// every workspace on this Quorum and, per row, a drawer with its members, usage this period and the Set plan form.
// Plans and seats set here are what the workspace is billed for; the relay's hour pool reads seats and hour packs on
// the workspace row, which stay as they are.
const COLS = 'minmax(160px, 1.6fr) minmax(120px, 1.2fr) 100px 90px 130px 14px';

export function Workspaces() {
  const [list, setList] = useState<Workspace[] | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { api.workspaces().then((r) => (r.ok ? setList(r.value) : setError(r.error))); }, []);
  const saved = (id: string, plan: Plan, seatsIncluded: number, notes: string | null) => setList((l) => l?.map((w) => (w.id === id ? { ...w, plan, seatsIncluded, notes } : w)) ?? l);
  return (
    <>
      <PageHeader title={list ? `${list.length} ${list.length === 1 ? 'workspace' : 'workspaces'}` : 'Workspaces'} />
      {error && <p className="error">{error}</p>}
      <Card list>
        <Table columns={COLS}>
          <TableHead><span>Name</span><span>Domain</span><span>Plan</span><span>Members</span><span>Last activity</span><span /></TableHead>
          {list === null && <SkeletonRows />}
          {list?.map((w) => (
            <TableItem key={w.id} open={open === w.id}>
              <TableRowButton on={open === w.id} onClick={() => setOpen(open === w.id ? null : w.id)}>
                <strong>{w.name}</strong><span className="hide">{w.domain ?? '—'}</span><span><Badge tone={w.plan === 'free' ? 'off' : 'good'}>{PLAN_LABEL[w.plan] ?? w.plan}</Badge></span><span className="hide">{w.members}</span><span className="hide">{activityLabel(w.lastActivity)}</span>
                <IconChevron className="chev" />
              </TableRowButton>
              {open === w.id && <WorkspaceDrawer ws={w} onSaved={(p, s, n) => saved(w.id, p, s, n)} />}
            </TableItem>
          ))}
          {list && !list.length && <Empty>No workspaces yet. The first appears when someone signs in and creates one.</Empty>}
        </Table>
      </Card>
    </>
  );
}

function WorkspaceDrawer({ ws, onSaved }: { ws: Workspace; onSaved: (plan: Plan, seatsIncluded: number, notes: string | null) => void }) {
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
    <Drawer className="split">
      <div>
        <h4>{members ? `${members.length} ${members.length === 1 ? 'member' : 'members'}` : 'Members'}</h4>
        {members?.map((m) => (
          <div key={m.userId} className="member">
            <span className="avatar">{(m.name || m.email || '?')[0].toUpperCase()}</span>
            <span className="who"><strong>{m.name || m.email}</strong><em>{m.name ? `${m.email} · ` : ''}Joined {onDate(m.joinedAt)}</em></span>
            <Badge>{ROLE_LABEL[m.role]}</Badge>
          </div>
        ))}
        <h4>Usage {usage ? `in ${period}` : period}</h4>
        <p className="muted small">{usage ? `${hours(usage.managedHours)} managed hours of ${hours(usage.hours)} · ${usage.calls} model ${usage.calls === 1 ? 'call' : 'calls'}` : 'Loading…'}</p>
        {usage?.steps.map((s) => <p key={s.role} className="muted small">{s.role}: {s.calls} {s.calls === 1 ? 'call' : 'calls'}{s.hours ? `, ${hours(s.hours)} hours` : ''}</p>)}
        <p className="muted small" style={{ marginTop: 10 }}>Created {onDate(ws.createdAt)} · id {ws.id}</p>
      </div>
      <PlanForm ws={ws} onSaved={onSaved} />
      {error && <p className="error">{error}</p>}
    </Drawer>
  );
}

function PlanForm({ ws, onSaved }: { ws: Workspace; onSaved: (plan: Plan, seatsIncluded: number, notes: string | null) => void }) {
  const [plan, setPlan] = useState<string>(ws.plan);
  const [seats, setSeats] = useState(String(ws.seatsIncluded));
  const [notes, setNotes] = useState(ws.notes ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const checked = validatePlanForm({ plan, seatsIncluded: seats, notes });
  const dirty = plan !== ws.plan || seats !== String(ws.seatsIncluded) || notes.trim() !== (ws.notes ?? '');
  const save = async () => {
    if ('error' in checked) { setError(checked.error); return; }
    setBusy(true); setError('');
    const r = await api.setPlan(ws.id, checked.draft);
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    onSaved(checked.draft.plan, checked.draft.seatsIncluded, checked.draft.notes || null);
    toast.success(`Saved the plan for ${ws.name}.`);
  };
  return (
    <form className="plan-form" onSubmit={(e) => { e.preventDefault(); if (!busy && dirty) save(); }}>
      <h4>Set plan</h4>
      <Field label="Plan"><Select value={plan} onChange={(e) => setPlan(e.target.value)}>{PLANS.map((p) => <option key={p} value={p}>{PLAN_LABEL[p]}</option>)}</Select></Field>
      <Field label="Seats included"><Input inputMode="numeric" value={seats} onChange={(e) => setSeats(e.target.value)} /></Field>
      <Field label="Notes"><Textarea maxLength={NOTES_MAX} value={notes} placeholder="For your own record" onChange={(e) => setNotes(e.target.value)} /></Field>
      <div className="actions"><Button variant="primary" type="submit" disabled={busy || !dirty || 'error' in checked}>{busy ? 'Saving…' : 'Save plan'}</Button></div>
      {(error || ('error' in checked && dirty)) && <p className="error">{error || ('error' in checked ? checked.error : '')}</p>}
    </form>
  );
}
