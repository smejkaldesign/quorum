import { type ReactNode, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { type AccessRequest, CODE_LABEL, CODE_PLAN_LABEL, type CodePlan, DAYS_CHOICES, EMAIL, REQUEST_LABEL, activityLabel, formatCode, noteCount, onDate, rowActions, sourceLabel, sourcePlan } from '../shape';
import { Badge, type BadgeTone, Button, Card, Chip, ConfirmDialog, Dialog, Empty, Field, IconMore, IconNote, Input, PageHeader, Select, SkeletonRows, Table, TableHead, TableItem, TableRow, useToast } from '../ui';

// Access: every beta signup, pending first. Approving one picks the plan (free or cloud), issues its access code and
// offers to email it; the code's own state (open, used, expired, revoked), the plan, whether the person installed and
// whether they signed in all show on the same row, so one list tracks the whole path. Actions sit in the row; the
// person's message, the dates and the code's details open in a dialog from the note button.
const COLS = 'minmax(150px, 1.4fr) minmax(80px, 1fr) 64px 92px 124px 270px';

export function Access() {
  const [list, setList] = useState<AccessRequest[] | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const [adding, setAdding] = useState(false);
  const load = () => api.requests().then((r) => (r.ok ? setList(r.value) : setError(r.error)));
  useEffect(() => { load(); }, []);
  const put = (next: AccessRequest) => setList((l) => l?.map((r) => (r.id === next.id ? next : r)) ?? l);
  const shown = (list ?? []).filter((r) => filter === 'all' || r.status === 'pending' || (r.status === 'invited' && r.code && (r.code.status === 'open' || r.code.status === 'claimed')));
  const hidden = (list?.length ?? 0) - shown.length;
  return (
    <>
      <PageHeader
        title="Access"
        actions={<>
          <span className="chips"><Chip on={filter === 'open'} onClick={() => setFilter('open')}>Open</Chip><Chip on={filter === 'all'} onClick={() => setFilter('all')}>All{list ? ` (${list.length})` : ''}</Chip></span>
          <Button variant="primary" onClick={() => setAdding(true)}>Add a person</Button>
        </>}
      />
      {adding && <AddPerson onDone={(r) => { setAdding(false); if (r) load(); }} />}
      {error && <p className="error">{error}</p>}
      <Card list>
        <Table columns={COLS}>
          <TableHead><span>Who</span><span>From</span><span>Plan</span><span>State</span><span style={{ textAlign: 'right' }}>When</span><span /></TableHead>
          {list === null && <SkeletonRows />}
          {list && !shown.length && <Empty>{filter === 'open' ? 'Nothing waiting.' : 'No requests yet.'}</Empty>}
          {shown.map((r) => <Row key={r.id} r={r} onChange={put} onReload={load} />)}
        </Table>
        {filter === 'open' && hidden > 0 && <p className="pad"><Button variant="link" onClick={() => setFilter('all')}>Show {hidden} used, declined or expired</Button></p>}
      </Card>
    </>
  );
}

function AddPerson({ onDone }: { onDone: (added: boolean) => void }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const toast = useToast();
  const ok = EMAIL.test(email.trim());
  const add = async () => {
    setBusy(true); setError('');
    const r = await api.addRequest(email, name, note);
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    toast.success(`${email.trim().toLowerCase()} added. Approve the request to issue a code.`);
    onDone(true);
  };
  return (
    <Card form>
      <form onSubmit={(e) => { e.preventDefault(); if (ok && !busy) add(); }}>
        <h2>Add a person</h2>
        <p className="muted lede">For someone who never filled in the form. They appear as a pending request; approve it to issue their code.</p>
        <div className="fields">
          <Field label="Email"><Input type="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" /></Field>
          <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value.slice(0, 120))} placeholder="Optional" /></Field>
          <Field label="Note"><Input value={note} onChange={(e) => setNote(e.target.value.slice(0, 1000))} placeholder="Optional, for your own record" /></Field>
        </div>
        <div className="actions"><Button variant="primary" type="submit" disabled={!ok || busy}>{busy ? 'Adding…' : 'Add'}</Button><Button variant="link" onClick={() => onDone(false)}>Cancel</Button></div>
        {error && <p className="error">{error}</p>}
      </form>
    </Card>
  );
}

// the overflow menu on a live code's row: plan move and revoke, the two actions taken less often than send and copy
function More({ children, label }: { children: ReactNode; label: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', key); };
  }, [open]);
  return (
    <span className="more" ref={box}>
      <button type="button" className="icon-btn" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}><IconMore /></button>
      {open && <div className="more-menu" role="menu" onClick={() => setOpen(false)}>{children}</div>}
    </span>
  );
}

function Row({ r, onChange, onReload }: { r: AccessRequest; onChange: (r: AccessRequest) => void; onReload: () => void }) {
  const [days, setDays] = useState<number>(30);
  const [plan, setPlan] = useState<CodePlan>(sourcePlan(r.source));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'decline' | 'revoke' | 'approve' | 'notes' | null>(null);
  const toast = useToast();
  const run = async (what: string, fn: () => Promise<{ ok: true; value: unknown } | { ok: false; error: string }>, then?: (v: unknown) => void) => {
    setBusy(what);
    const res = await fn();
    setBusy(null);
    if (!res.ok) { toast.error(res.error); return; }
    then?.(res.value);
  };
  const approve = () => run('approve', () => api.invite(r, days, note, plan), (v) => { onChange(v as AccessRequest); setConfirm(null); setNote(''); toast.success(`Approved for ${CODE_PLAN_LABEL[plan]}. Send the code by email, or copy it.`); });
  const convert = (to: CodePlan) => run('convert', () => api.setCodePlan(r, to), (v) => { onChange(v as AccessRequest); toast.success(`${r.email} is now on the ${CODE_PLAN_LABEL[to]} plan.`); });
  const decline = () => run('decline', () => api.decline(r.id, ''), () => { onChange({ ...r, status: 'declined', decidedAt: new Date().toISOString() }); setConfirm(null); toast.info(`Declined ${r.email}.`); });
  const send = () => run('send', () => api.sendCodeEmail(r), () => toast.success(`Emailed to ${r.email}.`));
  const copy = async () => { if (!r.code) return; try { await navigator.clipboard.writeText(formatCode(r.code.code)); toast.success('Copied.'); } catch { toast.error('Could not copy; select the code instead.'); } };
  const revoke = () => run('revoke', () => api.revokeCode(r.code!.id), () => { setConfirm(null); toast.info(`Revoked the code for ${r.email}.`); onReload(); });
  const codeState = r.code ? CODE_LABEL[r.code.status] : null;
  const state = r.status === 'invited' && codeState ? codeState : REQUEST_LABEL[r.status];
  const tone: BadgeTone = r.status === 'pending' ? 'pending' : r.status === 'declined' ? 'off' : r.code?.status === 'redeemed' ? 'good' : r.code?.status === 'open' || r.code?.status === 'claimed' ? 'open' : 'off';
  const live = r.code && (r.code.status === 'open' || r.code.status === 'claimed');
  // the code's plan can move while it is live or after it was used; a revoked or expired code has nothing to move
  const movable = r.code && (live || r.code.status === 'redeemed');
  const stage = r.signedInAt ? `Signed in ${activityLabel(r.signedInAt).toLowerCase()}` : r.installed ? 'Installed' : null;
  const acts = rowActions(r);
  const notes = noteCount(r);
  const when = r.status === 'pending' ? `Asked ${onDate(r.createdAt)}` : r.code?.status === 'redeemed' ? `Used ${onDate(r.code.redeemedAt)}` : live ? `Until ${onDate(r.code!.expiresAt)}` : onDate(r.decidedAt);
  return (
    <TableItem>
      <TableRow className="access-row">
        <span className="who"><strong>{r.name || r.email}</strong>{r.name && <em>{r.email}</em>}</span>
        <span className="hide">{sourceLabel(r.source)}{stage ? ` · ${stage}` : r.hasAccount ? ' · has an account' : ''}</span>
        <span className="badges">{r.code ? <Badge tone={r.code.plan === 'cloud' ? 'good' : 'off'}>{CODE_PLAN_LABEL[r.code.plan]}</Badge> : null}</span>
        <span className="badges"><Badge tone={tone}>{state}</Badge></span>
        <span className="when hide">{when}</span>
        <span className="row-actions">
          {acts.approve && <Button className="sm" variant="primary" disabled={!!busy} onClick={() => setConfirm('approve')}>Approve</Button>}
          {acts.decline && <Button className="sm" variant="danger" disabled={!!busy} onClick={() => setConfirm('decline')}>Decline</Button>}
          {acts.send && <Button className="sm" variant="primary" disabled={!!busy} onClick={send}>{busy === 'send' ? 'Sending…' : 'Send by email'}</Button>}
          {acts.copy && <Button className="sm" onClick={copy}>Copy</Button>}
          {(acts.convert || acts.revoke) && (
            <More label={`More for ${r.email}`}>
              {acts.convert && <button type="button" role="menuitem" disabled={!!busy} onClick={() => convert(acts.convert!)}>{acts.convert === 'cloud' ? 'Convert to Cloud' : 'Move to Free'}</button>}
              {acts.revoke && <button type="button" role="menuitem" className="danger" disabled={!!busy} onClick={() => setConfirm('revoke')}>Revoke code</button>}
            </More>
          )}
          <button type="button" className="icon-btn note-btn" aria-label={notes ? `Notes for ${r.email}, ${notes}` : `Details for ${r.email}`} onClick={() => setConfirm('notes')}>
            <IconNote />{notes > 0 && <i className="note-dot" aria-hidden="true" />}
          </button>
        </span>
      </TableRow>
      <Dialog open={confirm === 'notes'} onOpenChange={(o) => !o && setConfirm(null)} title={r.name || r.email} description={r.name ? r.email : undefined}>
        <div className="notes-body">
          {r.note ? <p className="quote">“{r.note}”</p> : <p className="muted small">No message with the request.</p>}
          <dl className="notes-facts">
            <dt>From</dt><dd>{sourceLabel(r.source)}</dd>
            <dt>Asked</dt><dd>{onDate(r.createdAt)}</dd>
            {r.decidedAt && <><dt>{r.status === 'declined' ? 'Declined' : 'Approved'}</dt><dd>{onDate(r.decidedAt)}</dd></>}
            {stage && <><dt>Progress</dt><dd>{stage}{r.installed && r.signedInAt ? ', installed' : ''}</dd></>}
            {r.code && <><dt>Code</dt><dd><code className="code">{formatCode(r.code.code)}</code> <Badge tone={tone}>{CODE_LABEL[r.code.status]}</Badge> <Badge tone={r.code.plan === 'cloud' ? 'good' : 'off'}>{CODE_PLAN_LABEL[r.code.plan]}</Badge></dd></>}
            {r.code && r.code.status !== 'revoked' && <><dt>{r.code.status === 'redeemed' ? 'Used' : 'Open until'}</dt><dd>{onDate(r.code.status === 'redeemed' ? r.code.redeemedAt : r.code.expiresAt)}</dd></>}
          </dl>
          <dl className="notes-facts">
            <dt>Your note</dt><dd>{r.adminNote ? r.adminNote : <span className="muted">None. A note is added in the approve dialog.</span>}</dd>
          </dl>
          {movable && r.code!.status === 'redeemed' && (
            <p className="muted small">
              Plan changes apply at the next sign-up unless the code already set a workspace's plan.{' '}
              <Button variant="link" disabled={!!busy} onClick={() => convert(r.code!.plan === 'cloud' ? 'free' : 'cloud')}>{busy === 'convert' ? 'Moving…' : r.code!.plan === 'cloud' ? 'Move to Free' : 'Convert to Cloud'}</Button>
            </p>
          )}
        </div>
        <div className="modal-actions"><span /><Button onClick={() => setConfirm(null)}>Close</Button></div>
      </Dialog>
      <Dialog open={confirm === 'approve'} onOpenChange={(o) => !o && setConfirm(null)} title={`Approve ${r.name || r.email}`} description="Pick the plan the code grants and how long it stays open. The code goes out by email or by hand afterwards.">
        {r.note && <p className="quote">“{r.note}”</p>}
        <div className="fields">
          <Field label="Plan" hint={plan === 'cloud' ? 'Their workspace starts on Quorum Cloud, set by you, nothing to pay.' : 'The open-source app with their own keys. You can convert them later.'}>
            <Select value={plan} onChange={(e) => setPlan(e.target.value === 'cloud' ? 'cloud' : 'free')}><option value="free">Free</option><option value="cloud">Cloud</option></Select>
          </Field>
          <Field label="Code lasts"><Select value={days} onChange={(e) => setDays(Number(e.target.value))}>{DAYS_CHOICES.map((d) => <option key={d} value={d}>{d} days</option>)}</Select></Field>
        </div>
        <Field label="Note"><Input value={note} onChange={(e) => setNote(e.target.value.slice(0, 200))} placeholder="Optional, for your own record" /></Field>
        <div className="modal-actions">
          <Button variant="link" onClick={() => setConfirm(null)}>Cancel</Button>
          <Button variant="primary" disabled={!!busy} onClick={approve}>{busy === 'approve' ? 'Issuing…' : `Approve for ${CODE_PLAN_LABEL[plan]}`}</Button>
        </div>
      </Dialog>
      <ConfirmDialog open={confirm === 'decline'} onOpenChange={(o) => !o && setConfirm(null)} title={`Decline ${r.name || r.email}?`} description="The request stays in the list as declined. No email goes out." confirmLabel="Decline" variant="destructive" loading={busy === 'decline'} onConfirm={decline} />
      <ConfirmDialog open={confirm === 'revoke'} onOpenChange={(o) => !o && setConfirm(null)} title="Revoke this code?" description={`${r.email} can no longer sign up with it. Approve the request again to issue a new one.`} confirmLabel="Revoke" variant="destructive" loading={busy === 'revoke'} onConfirm={revoke} />
    </TableItem>
  );
}
