import { useEffect, useState } from 'react';
import { api } from '../api';
import { type AccessRequest, CODE_LABEL, DAYS_CHOICES, EMAIL, REQUEST_LABEL, formatCode, onDate } from '../shape';

// Access: every request for Quorum Cloud, pending first. Approving one issues its access code and offers to email it;
// the code's own state (open, used, expired, revoked) shows on the same row, so one list tracks both.
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
      <div className="head-row">
        <h1>Access</h1>
        <div className="actions">
          <button className={`chip ${filter === 'open' ? 'on' : ''}`} onClick={() => setFilter('open')}>Open</button>
          <button className={`chip ${filter === 'all' ? 'on' : ''}`} onClick={() => setFilter('all')}>All{list ? ` (${list.length})` : ''}</button>
          <button className="pill primary" onClick={() => setAdding(true)}>Add a person</button>
        </div>
      </div>
      <p className="muted lede">Cloud sign-up is invite-only. A request from quorum.watch lands here; approving it issues a one-time access code for that email, good for the days you pick, which the person enters once in the app.</p>
      {adding && <AddPerson onDone={(r) => { setAdding(false); if (r) load(); }} />}
      {error && <p className="error">{error}</p>}
      <div className="card list">
        {list === null && <p className="muted pad">Loading…</p>}
        {list && !shown.length && <p className="muted pad">{filter === 'open' ? 'Nothing waiting.' : 'No requests yet.'}</p>}
        {shown.map((r) => <Row key={r.id} r={r} onChange={put} onReload={load} />)}
        {filter === 'open' && hidden > 0 && <button className="link pad" onClick={() => setFilter('all')}>Show {hidden} used, declined or expired</button>}
      </div>
    </>
  );
}

function AddPerson({ onDone }: { onDone: (added: boolean) => void }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ok = EMAIL.test(email.trim());
  const add = async () => {
    setBusy(true); setError('');
    const r = await api.addRequest(email, name, note);
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    onDone(true);
  };
  return (
    <form className="card form" onSubmit={(e) => { e.preventDefault(); if (ok && !busy) add(); }}>
      <h2>Add a person</h2>
      <p className="muted">For someone who never filled in the form. They appear as a pending request; approve it to issue their code.</p>
      <div className="fields">
        <label>Email<input type="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" /></label>
        <label>Name<input value={name} onChange={(e) => setName(e.target.value.slice(0, 120))} placeholder="Optional" /></label>
        <label>Note<input value={note} onChange={(e) => setNote(e.target.value.slice(0, 1000))} placeholder="Optional, for your own record" /></label>
      </div>
      <div className="actions"><button className="pill primary" type="submit" disabled={!ok || busy}>{busy ? 'Adding…' : 'Add'}</button><button className="link" type="button" onClick={() => onDone(false)}>Cancel</button></div>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

function Row({ r, onChange, onReload }: { r: AccessRequest; onChange: (r: AccessRequest) => void; onReload: () => void }) {
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState<number>(30);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [said, setSaid] = useState('');
  const run = async (what: string, fn: () => Promise<{ ok: true; value: unknown } | { ok: false; error: string }>, then?: (v: unknown) => void) => {
    setBusy(what); setError(''); setSaid('');
    const res = await fn();
    setBusy(null);
    if (!res.ok) { setError(res.error); return; }
    then?.(res.value);
  };
  const approve = () => run('approve', () => api.invite(r, days, note), (v) => { onChange(v as AccessRequest); setOpen(true); setSaid('Code issued. Send it by email, or copy it.'); });
  const decline = () => run('decline', () => api.decline(r.id, note), () => { onChange({ ...r, status: 'declined', decidedAt: new Date().toISOString(), adminNote: note.trim() || null }); setOpen(false); });
  const send = () => run('send', () => api.sendCodeEmail(r), () => setSaid(`Emailed to ${r.email}.`));
  const copy = async () => { if (!r.code) return; try { await navigator.clipboard.writeText(formatCode(r.code.code)); setSaid('Copied.'); } catch { setSaid('Could not copy; select the code instead.'); } };
  const revoke = () => run('revoke', () => api.revokeCode(r.code!.id), () => onReload());
  const codeState = r.code ? CODE_LABEL[r.code.status] : null;
  const state = r.status === 'invited' && codeState ? codeState : REQUEST_LABEL[r.status];
  const tone = r.status === 'pending' ? 'pending' : r.status === 'declined' ? 'off' : r.code?.status === 'redeemed' ? 'good' : r.code?.status === 'open' || r.code?.status === 'claimed' ? 'open' : 'off';
  return (
    <div className={`req ${open ? 'open' : ''}`}>
      <button className="req-row" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="who"><strong>{r.name || r.email}</strong>{r.name && <em>{r.email}</em>}</span>
        <span className="muted">{r.source === 'admin' ? 'Added by you' : 'From the site'}{r.hasAccount ? ' · has an account' : ''}</span>
        <span className={`state ${tone}`}>{state}</span>
        <span className="muted when">{r.status === 'pending' ? `Asked ${onDate(r.createdAt)}` : r.code?.status === 'redeemed' ? `Used ${onDate(r.code.redeemedAt)}` : r.code && (r.code.status === 'open' || r.code.status === 'claimed') ? `Until ${onDate(r.code.expiresAt)}` : onDate(r.decidedAt)}</span>
      </button>
      {open && (
        <div className="req-body">
          {r.note && <p className="quote">“{r.note}”</p>}
          {r.adminNote && <p className="muted">Your note: {r.adminNote}</p>}
          {r.status === 'pending' && (
            <div className="decide">
              <label>Code lasts<select value={days} onChange={(e) => setDays(Number(e.target.value))}>{DAYS_CHOICES.map((d) => <option key={d} value={d}>{d} days</option>)}</select></label>
              <label className="grow">Note<input value={note} onChange={(e) => setNote(e.target.value.slice(0, 200))} placeholder="Optional, for your own record" /></label>
              <button className="pill primary" disabled={!!busy} onClick={approve}>{busy === 'approve' ? 'Issuing…' : 'Approve and issue a code'}</button>
              <button className="link danger" disabled={!!busy} onClick={decline}>{busy === 'decline' ? 'Declining…' : 'Decline'}</button>
            </div>
          )}
          {r.code && (
            <div className="code-line">
              <code className="code">{formatCode(r.code.code)}</code>
              <span className={`state ${tone}`}>{CODE_LABEL[r.code.status]}</span>
              <span className="muted">{r.code.status === 'redeemed' ? `Used ${onDate(r.code.redeemedAt)}` : r.code.status === 'revoked' ? '' : `Until ${onDate(r.code.expiresAt)}`}</span>
              <span className="grow" />
              {(r.code.status === 'open' || r.code.status === 'claimed') && (
                <>
                  <button className="pill primary" disabled={!!busy} onClick={send}>{busy === 'send' ? 'Sending…' : 'Send by email'}</button>
                  <button className="pill" onClick={copy}>Copy</button>
                  <button className="link danger" disabled={!!busy} onClick={revoke}>{busy === 'revoke' ? 'Revoking…' : 'Revoke'}</button>
                </>
              )}
            </div>
          )}
          {said && <p className="good">{said}</p>}
          {error && <p className="error">{error}</p>}
        </div>
      )}
    </div>
  );
}
