import { useEffect, useState } from 'react';
import { api } from '../api';
import { type AccessRequest, CODE_LABEL, DAYS_CHOICES, EMAIL, REQUEST_LABEL, formatCode, onDate } from '../shape';
import { Badge, type BadgeTone, Button, Card, Chip, ConfirmDialog, Drawer, Empty, Field, IconChevron, Input, PageHeader, Select, SkeletonRows, Table, TableHead, TableItem, TableRowButton, useToast } from '../ui';

// Access: every request for Quorum Cloud, pending first. Approving one issues its access code and offers to email it;
// the code's own state (open, used, expired, revoked) shows on the same row, so one list tracks both.
const COLS = 'minmax(200px, 1.6fr) minmax(120px, 1fr) 110px 150px 14px';

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
          <TableHead><span>Who</span><span>From</span><span>State</span><span style={{ textAlign: 'right' }}>When</span><span /></TableHead>
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

function Row({ r, onChange, onReload }: { r: AccessRequest; onChange: (r: AccessRequest) => void; onReload: () => void }) {
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState<number>(30);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'decline' | 'revoke' | null>(null);
  const toast = useToast();
  const run = async (what: string, fn: () => Promise<{ ok: true; value: unknown } | { ok: false; error: string }>, then?: (v: unknown) => void) => {
    setBusy(what);
    const res = await fn();
    setBusy(null);
    if (!res.ok) { toast.error(res.error); return; }
    then?.(res.value);
  };
  const approve = () => run('approve', () => api.invite(r, days, note), (v) => { onChange(v as AccessRequest); setOpen(true); toast.success('Code issued. Send it by email, or copy it.'); });
  const decline = () => run('decline', () => api.decline(r.id, note), () => { onChange({ ...r, status: 'declined', decidedAt: new Date().toISOString(), adminNote: note.trim() || null }); setConfirm(null); setOpen(false); toast.info(`Declined ${r.email}.`); });
  const send = () => run('send', () => api.sendCodeEmail(r), () => toast.success(`Emailed to ${r.email}.`));
  const copy = async () => { if (!r.code) return; try { await navigator.clipboard.writeText(formatCode(r.code.code)); toast.success('Copied.'); } catch { toast.error('Could not copy; select the code instead.'); } };
  const revoke = () => run('revoke', () => api.revokeCode(r.code!.id), () => { setConfirm(null); toast.info(`Revoked the code for ${r.email}.`); onReload(); });
  const codeState = r.code ? CODE_LABEL[r.code.status] : null;
  const state = r.status === 'invited' && codeState ? codeState : REQUEST_LABEL[r.status];
  const tone: BadgeTone = r.status === 'pending' ? 'pending' : r.status === 'declined' ? 'off' : r.code?.status === 'redeemed' ? 'good' : r.code?.status === 'open' || r.code?.status === 'claimed' ? 'open' : 'off';
  const live = r.code && (r.code.status === 'open' || r.code.status === 'claimed');
  return (
    <TableItem open={open}>
      <TableRowButton on={open} onClick={() => setOpen(!open)}>
        <span className="who"><strong>{r.name || r.email}</strong>{r.name && <em>{r.email}</em>}</span>
        <span className="hide">{r.source === 'admin' ? 'Added by you' : 'From the site'}{r.hasAccount ? ' · has an account' : ''}</span>
        <span><Badge tone={tone}>{state}</Badge></span>
        <span className="when hide">{r.status === 'pending' ? `Asked ${onDate(r.createdAt)}` : r.code?.status === 'redeemed' ? `Used ${onDate(r.code.redeemedAt)}` : live ? `Until ${onDate(r.code!.expiresAt)}` : onDate(r.decidedAt)}</span>
        <IconChevron className="chev" />
      </TableRowButton>
      {open && (
        <Drawer>
          {r.note && <p className="quote">“{r.note}”</p>}
          {r.adminNote && <p className="muted small" style={{ marginBottom: 10 }}>Your note: {r.adminNote}</p>}
          {r.status === 'pending' && (
            <div className="decide">
              <Field label="Code lasts"><Select value={days} onChange={(e) => setDays(Number(e.target.value))}>{DAYS_CHOICES.map((d) => <option key={d} value={d}>{d} days</option>)}</Select></Field>
              <Field label="Note" grow><Input value={note} onChange={(e) => setNote(e.target.value.slice(0, 200))} placeholder="Optional, for your own record" /></Field>
              <Button variant="primary" disabled={!!busy} onClick={approve}>{busy === 'approve' ? 'Issuing…' : 'Approve and issue a code'}</Button>
              <Button variant="danger" disabled={!!busy} onClick={() => setConfirm('decline')}>Decline</Button>
            </div>
          )}
          {r.code && (
            <div className="code-line">
              <code className="code">{formatCode(r.code.code)}</code>
              <Badge tone={tone}>{CODE_LABEL[r.code.status]}</Badge>
              <span className="muted small">{r.code.status === 'redeemed' ? `Used ${onDate(r.code.redeemedAt)}` : r.code.status === 'revoked' ? '' : `Until ${onDate(r.code.expiresAt)}`}</span>
              <span className="grow" />
              {live && (
                <>
                  <Button variant="primary" disabled={!!busy} onClick={send}>{busy === 'send' ? 'Sending…' : 'Send by email'}</Button>
                  <Button onClick={copy}>Copy</Button>
                  <Button variant="link" className="danger" disabled={!!busy} onClick={() => setConfirm('revoke')}>Revoke</Button>
                </>
              )}
            </div>
          )}
          <ConfirmDialog open={confirm === 'decline'} onOpenChange={(o) => !o && setConfirm(null)} title={`Decline ${r.name || r.email}?`} description="The request stays in the list as declined. No email goes out." confirmLabel="Decline" variant="destructive" loading={busy === 'decline'} onConfirm={decline} />
          <ConfirmDialog open={confirm === 'revoke'} onOpenChange={(o) => !o && setConfirm(null)} title="Revoke this code?" description={`${r.email} can no longer sign up with it. Approve the request again to issue a new one.`} confirmLabel="Revoke" variant="destructive" loading={busy === 'revoke'} onConfirm={revoke} />
        </Drawer>
      )}
    </TableItem>
  );
}
