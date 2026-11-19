import { useEffect, useState } from 'react';
import { api } from '../api';
import { type ErrorCounts, type ErrorDetail, type ErrorGroup, type ErrorSort, type ErrorStatus, ERROR_STATUSES, ERROR_STATUS_LABEL, agentPrompt, brokenOnReload, githubIssueUrl, regressed, statusLine, validateStatusForm } from '../errors';
import { activityLabel, onDate } from '../shape';
import { Badge, type BadgeTone, Button, Card, CardLine, Chip, Drawer, Empty, Field, Input, PageHeader, Select, SkeletonRows, Table, TableHead, TableItem, TableRowButton, Textarea, useToast } from '../ui';

// Errors: every page crash an install reported (POST /v1/errors on the relay, migration 0045), one row per cause. A
// row opens the group's detail with the latest events, the triage form and the two hand-offs: a prompt for a coding
// agent and a prefilled GitHub issue.
const COLS = 'minmax(240px, 2.4fr) 70px 70px minmax(110px, 1fr) 110px';
const TONE: Record<ErrorStatus, BadgeTone> = { new: 'danger', fixing: 'pending', fixed: 'good', ignored: 'off' };
type Filter = ErrorStatus | 'all';

export function Errors({ onCounts }: { onCounts?: (c: ErrorCounts) => void }) {
  const [list, setList] = useState<ErrorGroup[] | null>(null);
  const [counts, setCounts] = useState<ErrorCounts | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<Filter>('new');
  const [sort, setSort] = useState<ErrorSort>('last_seen');
  const loadCounts = () => api.errorCounts().then((r) => { if (r.ok) { setCounts(r.value); onCounts?.(r.value); } });
  const load = () => { setError(''); setList(null); return api.errorGroups(filter === 'all' ? null : filter, sort).then((r) => (r.ok ? setList(r.value) : setError(r.error))); };
  useEffect(() => { load(); }, [filter, sort]);
  useEffect(() => { loadCounts(); }, []);
  const put = (g: ErrorGroup) => { setList((l) => l?.map((x) => (x.fingerprint === g.fingerprint ? g : x)) ?? l); loadCounts(); };
  const total = counts ? ERROR_STATUSES.reduce((n, s) => n + counts[s], 0) : null;
  const chip = (f: Filter, label: string, n: number | null) => <Chip key={f} on={filter === f} onClick={() => setFilter(f)}>{label}{n !== null ? ` (${n})` : ''}</Chip>;
  return (
    <>
      <PageHeader
        title="Errors"
        description="Page crashes reported by installs, grouped by cause. Reports are scrubbed in the app and carry no install id."
        actions={<>
          <span className="chips">{ERROR_STATUSES.map((s) => chip(s, ERROR_STATUS_LABEL[s], counts ? counts[s] : null))}{chip('all', 'All', total)}</span>
          <Select aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value as ErrorSort)}><option value="last_seen">Last seen</option><option value="installs">Most installs</option></Select>
        </>}
      />
      <Card list>
        <Table columns={COLS}>
          <TableHead><span>Error</span><span>Events</span><span>Installs</span><span>Versions</span><span>Last seen</span></TableHead>
          {list === null && error && <div className="pad"><p className="error" style={{ marginTop: 0 }}>{error}</p><Button onClick={load}>Try again</Button></div>}
          {list === null && !error && <SkeletonRows />}
          {list !== null && list.length === 0 && <Empty>{filter === 'new' ? 'No new errors.' : 'No error groups here.'} Reports are deleted after 90 days; fixed and ignored groups keep their counts and status.</Empty>}
          {list?.map((g) => <Row key={g.fingerprint} g={g} onChange={put} />)}
        </Table>
      </Card>
    </>
  );
}

function Row({ g, onChange }: { g: ErrorGroup; onChange: (g: ErrorGroup) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <TableItem open={open}>
      <TableRowButton on={open} onClick={() => setOpen(!open)}>
        <span className="who">
          <strong title={g.message}>{g.message || (g.purged ? 'Details expired' : '(no message)')}</strong>
          <em><code className="flag-key">{g.view || 'unknown view'}</code></em>
          <span className="badges" style={{ marginTop: 4 }}>
            <Badge tone={TONE[g.status]}>{statusLine(g)}</Badge>
            {brokenOnReload(g) && <Badge tone="danger">Broken: fails on reload</Badge>}
            {regressed(g) && <Badge tone="pending">Back after fix in {g.fixedIn}</Badge>}
          </span>
        </span>
        <span>{g.events}</span>
        <span>{g.installs}</span>
        <span className="muted small" title={g.versions.join(', ')}>{g.versions.slice(0, 3).join(', ') || 'None'}{g.versions.length > 3 ? ` +${g.versions.length - 3}` : ''}</span>
        <span className="when" title={g.lastSeen}>{activityLabel(g.lastSeen)}</span>
      </TableRowButton>
      {open && <Drawer><Detail fingerprint={g.fingerprint} onChange={onChange} /></Drawer>}
    </TableItem>
  );
}

function Detail({ fingerprint, onChange }: { fingerprint: string; onChange: (g: ErrorGroup) => void }) {
  const [d, setD] = useState<ErrorDetail | null>(null);
  const [error, setError] = useState('');
  const toast = useToast();
  const load = () => { setError(''); api.errorGroup(fingerprint).then((r) => (r.ok ? setD(r.value) : setError(r.error))); };
  useEffect(() => { load(); }, [fingerprint]);
  if (error) return <div><p className="error" style={{ marginTop: 0 }}>{error}</p><Button onClick={load}>Try again</Button></div>;
  if (!d) return <SkeletonRows />;
  const g = d.group;
  const copyPrompt = async () => { try { await navigator.clipboard.writeText(agentPrompt(d)); toast.success('Agent prompt copied.'); } catch { toast.error('Could not copy the prompt.'); } };
  return (
    <div className="err-detail">
      <p style={{ marginTop: 0, wordBreak: 'break-word' }}><strong>{g.message || (g.purged ? 'Details expired' : '(no message)')}</strong></p>
      {g.purged && <p className="muted">Details expired: no report in the last 90 days, so the message, stacks and events were deleted. The counts and status stay, so a new report can reopen it.</p>}
      <div className="err-facts">
        <CardLine label="View"><code>{g.view || 'unknown'}</code></CardLine>
        <CardLine label="Fingerprint"><code className="flag-key">{g.fingerprint.slice(0, 8)}</code></CardLine>
        <CardLine label="Status">{statusLine(g)}</CardLine>
        <CardLine label="Events">{g.events}{g.repeats > 0 ? `, ${g.repeats} on reload` : ''}</CardLine>
        <CardLine label="Installs">{g.installs}</CardLine>
        <CardLine label="First seen">{onDate(g.firstSeen)}</CardLine>
        <CardLine label="Last seen">{onDate(g.lastSeen)}</CardLine>
        <CardLine label="Versions">{g.versions.join(', ') || 'None'}</CardLine>
        <CardLine label="Editions">{g.editions.join(', ') || 'None'}</CardLine>
        <CardLine label="OS">{d.oses.join('; ') || 'None'}</CardLine>
      </div>
      {g.note && <p className="muted">Note: {g.note}</p>}
      <div className="actions">
        <Button variant="primary" onClick={copyPrompt}>Copy agent prompt</Button>
        <a className="pill" href={githubIssueUrl(d)} target="_blank" rel="noreferrer">Open GitHub issue</a>
      </div>
      <StatusForm g={g} onSaved={(saved) => { setD({ ...d, group: saved }); onChange(saved); }} />
      <h4>Stack (latest event)</h4>
      <pre className="stack">{g.latestStack || '(none)'}</pre>
      <h4>Component stack (latest event)</h4>
      <pre className="stack">{g.latestComponentStack || '(none)'}</pre>
      <h4>Latest events</h4>
      <div className="events-wrap">
        <table className="events">
          <thead><tr><th>When</th><th>Version</th><th>Edition</th><th>OS</th><th>Kind</th><th>Reload</th><th>Signed in</th></tr></thead>
          <tbody>
            {d.events.map((e) => <tr key={e.id}><td title={e.receivedAt}>{new Date(e.receivedAt).toLocaleString()}</td><td>{e.version || '?'}</td><td>{e.edition}</td><td>{e.os || '?'}</td><td>{e.kind}</td><td>{e.repeat ? 'Failed again' : ''}</td><td>{e.workspaceId ? 'Yes' : ''}</td></tr>)}
            {d.events.length === 0 && <tr><td colSpan={7} className="muted">No events kept. Reports are deleted after 90 days.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatusForm({ g, onSaved }: { g: ErrorGroup; onSaved: (g: ErrorGroup) => void }) {
  const [status, setStatus] = useState<ErrorStatus>(g.status);
  const [fixedIn, setFixedIn] = useState(g.fixedIn ?? g.versions[0] ?? '');
  const [note, setNote] = useState(g.note ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const toast = useToast();
  const save = async () => {
    const v = validateStatusForm({ status, fixedIn, note });
    if ('error' in v) { setError(v.error); return; }
    setBusy(true); setError('');
    const r = await api.setErrorStatus(g.fingerprint, v.draft);
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    toast.success(`Marked ${statusLine(r.value).toLowerCase()}.`);
    onSaved(r.value);
  };
  return (
    <form className="plat-form" style={{ marginTop: 16 }} onSubmit={(e) => { e.preventDefault(); if (!busy) save(); }}>
      <div className="fields">
        <Field label="Status"><Select value={status} onChange={(e) => setStatus(e.target.value as ErrorStatus)}>{ERROR_STATUSES.map((s) => <option key={s} value={s}>{s === 'fixed' ? 'Fixed in a version' : ERROR_STATUS_LABEL[s]}</option>)}</Select></Field>
        {status === 'fixed' && <Field label="Fixed in" hint="A report from this version or a newer one moves the group back to New."><Input value={fixedIn} onChange={(e) => setFixedIn(e.target.value)} placeholder="0.4.3" /></Field>}
        <Field label="Note" hint="Optional, only you see it"><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="The cause, or the PR with the fix" /></Field>
      </div>
      <div className="actions"><Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save status'}</Button></div>
      {error && <p className="error">{error}</p>}
    </form>
  );
}
