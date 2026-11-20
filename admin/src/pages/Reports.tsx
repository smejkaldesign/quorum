import { useEffect, useState } from 'react';
import { api } from '../api';
import { type ReportCounts, type ReportDetail, type ReportRow, type ReportStatus, REPORT_STATUSES, REPORT_STATUS_LABEL, reportIssueUrl, validateReportForm } from '../reports';
import { activityLabel, onDate } from '../shape';
import { Badge, type BadgeTone, Button, Card, CardLine, Chip, Drawer, Empty, Field, PageHeader, Select, SkeletonRows, Table, TableHead, TableItem, TableRowButton, Textarea, useToast } from '../ui';

// Reports: issue reports people sent from the app (Report issue, POST /v1/reports on the relay, migration 0046), newest
// first. A row opens the report with its screenshots (5-minute links from the relay), the log lines the person kept,
// the triage form and Create GitHub issue, which opens a prefilled new-issue page with a cleaned description and no
// screenshots; attach them by hand.
const COLS = 'minmax(240px, 2.4fr) 90px minmax(110px, 1fr) 110px';
const TONE: Record<ReportStatus, BadgeTone> = { new: 'danger', filed: 'pending', closed: 'good', ignored: 'off' };
type Filter = ReportStatus | 'all';

export function Reports({ onCounts }: { onCounts?: (c: ReportCounts) => void }) {
  const [list, setList] = useState<ReportRow[] | null>(null);
  const [counts, setCounts] = useState<ReportCounts | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<Filter>('new');
  const loadCounts = () => api.reportCounts().then((r) => { if (r.ok) { setCounts(r.value); onCounts?.(r.value); } });
  const load = () => { setError(''); setList(null); return api.reports(filter === 'all' ? null : filter).then((r) => (r.ok ? setList(r.value) : setError(r.error))); };
  useEffect(() => { load(); }, [filter]);
  useEffect(() => { loadCounts(); }, []);
  const put = (d: ReportDetail) => { setList((l) => l?.map((x) => (x.id === d.id ? { ...x, status: d.status, note: d.note, updatedAt: d.updatedAt } : x)) ?? l); loadCounts(); };
  const total = counts ? REPORT_STATUSES.reduce((n, s) => n + counts[s], 0) : null;
  const chip = (f: Filter, label: string, n: number | null) => <Chip key={f} on={filter === f} onClick={() => setFilter(f)}>{label}{n !== null ? ` (${n})` : ''}</Chip>;
  return (
    <>
      <PageHeader
        title="Reports"
        description="Issues people sent from the app with Report issue. Each one was reviewed by the sender before it went out. Reports are deleted after 90 days."
        actions={<span className="chips">{REPORT_STATUSES.map((s) => chip(s, REPORT_STATUS_LABEL[s], counts ? counts[s] : null))}{chip('all', 'All', total)}</span>}
      />
      <Card list>
        <Table columns={COLS}>
          <TableHead><span>Report</span><span>Screenshots</span><span>Version</span><span>Received</span></TableHead>
          {list === null && error && <div className="pad"><p className="error" style={{ marginTop: 0 }}>{error}</p><Button onClick={load}>Try again</Button></div>}
          {list === null && !error && <SkeletonRows />}
          {list !== null && list.length === 0 && <Empty>{filter === 'new' ? 'No new reports.' : 'No reports here.'} Reports are deleted after 90 days.</Empty>}
          {list?.map((r) => <Row key={r.id} r={r} onChange={put} />)}
        </Table>
      </Card>
    </>
  );
}

function Row({ r, onChange }: { r: ReportRow; onChange: (d: ReportDetail) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <TableItem open={open}>
      <TableRowButton on={open} onClick={() => setOpen(!open)}>
        <span className="who">
          <strong title={r.title}>{r.title || r.description.split('\n')[0] || '(no title)'}</strong>
          <em><code className="flag-key">{r.view || 'unknown page'}</code></em>
          <span className="badges" style={{ marginTop: 4 }}>
            <Badge tone={TONE[r.status]}>{REPORT_STATUS_LABEL[r.status]}</Badge>
            {r.signedIn && <Badge tone="good">Account attached</Badge>}
          </span>
        </span>
        <span>{r.screenshots || ''}</span>
        <span className="muted small">{r.version || '?'} {r.edition}</span>
        <span className="when" title={r.receivedAt}>{activityLabel(r.receivedAt)}</span>
      </TableRowButton>
      {open && <Drawer><Detail id={r.id} onChange={onChange} /></Drawer>}
    </TableItem>
  );
}

function Detail({ id, onChange }: { id: string; onChange: (d: ReportDetail) => void }) {
  const [d, setD] = useState<ReportDetail | null>(null);
  const [shots, setShots] = useState<{ path: string; url: string }[] | null>(null);
  const [shotError, setShotError] = useState('');
  const [error, setError] = useState('');
  const load = () => { setError(''); api.report(id).then((r) => (r.ok ? setD(r.value) : setError(r.error))); };
  const loadShots = () => { setShotError(''); setShots(null); api.reportShots(id).then((r) => (r.ok ? setShots(r.value) : setShotError(r.error))); };
  useEffect(() => { load(); }, [id]);
  useEffect(() => { if (d && d.screenshots.length) loadShots(); }, [d?.id]);
  if (error) return <div><p className="error" style={{ marginTop: 0 }}>{error}</p><Button onClick={load}>Try again</Button></div>;
  if (!d) return <SkeletonRows />;
  return (
    <div className="err-detail">
      <p style={{ marginTop: 0, wordBreak: 'break-word' }}><strong>{d.title || '(no title)'}</strong></p>
      <div className="err-facts">
        <CardLine label="Page"><code>{d.view || 'unknown'}</code></CardLine>
        <CardLine label="Status">{REPORT_STATUS_LABEL[d.status]}</CardLine>
        <CardLine label="Version">{d.version || '?'}</CardLine>
        <CardLine label="Edition">{d.edition}</CardLine>
        <CardLine label="OS">{d.os || '?'}</CardLine>
        <CardLine label="Sent">{onDate(d.at)}</CardLine>
        {d.runId && <CardLine label="Run"><code>{d.runId}</code></CardLine>}
        <CardLine label="Account">{d.email ?? 'Not attached'}</CardLine>
      </div>
      {d.note && <p className="muted">Note: {d.note}</p>}
      <div className="actions">
        <a className="pill" href={reportIssueUrl(d)} target="_blank" rel="noreferrer">Create GitHub issue</a>
        <span className="muted small">Opens a prefilled issue on the public repository with a cleaned description. The sender was told the report stays with the Quorum team, so read the text before you submit it. Screenshots are not included; attach them by hand.</span>
      </div>
      <StatusForm d={d} onSaved={(saved) => { setD(saved); onChange(saved); }} />
      <h4>Description</h4>
      <pre className="stack">{d.description || '(none)'}</pre>
      {d.screenshots.length > 0 && <>
        <h4>Screenshots</h4>
        {shotError && <div><p className="error" style={{ marginTop: 0 }}>{shotError}</p><Button onClick={loadShots}>Try again</Button></div>}
        {!shotError && shots === null && <SkeletonRows />}
        {shots && <div className="report-shots">{shots.map((s, i) => <a key={s.path} href={s.url} target="_blank" rel="noreferrer"><img src={s.url} alt={`Screenshot ${i + 1}`} /></a>)}</div>}
        {shots && <p className="muted small">The links last 5 minutes. <Button variant="link" onClick={loadShots}>Load again</Button></p>}
      </>}
      <h4>Log lines ({d.logLines.length})</h4>
      <pre className="stack">{d.logLines.join('\n') || '(none)'}</pre>
    </div>
  );
}

function StatusForm({ d, onSaved }: { d: ReportDetail; onSaved: (d: ReportDetail) => void }) {
  const [status, setStatus] = useState<ReportStatus>(d.status);
  const [note, setNote] = useState(d.note ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const toast = useToast();
  const save = async () => {
    const v = validateReportForm({ status, note });
    if ('error' in v) { setError(v.error); return; }
    setBusy(true); setError('');
    const r = await api.setReportStatus(d.id, v.draft);
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    toast.success(`Marked ${REPORT_STATUS_LABEL[r.value.status].toLowerCase()}.`);
    onSaved(r.value);
  };
  return (
    <form className="plat-form" style={{ marginTop: 16 }} onSubmit={(e) => { e.preventDefault(); if (!busy) save(); }}>
      <div className="fields">
        <Field label="Status"><Select value={status} onChange={(e) => setStatus(e.target.value as ReportStatus)}>{REPORT_STATUSES.map((s) => <option key={s} value={s}>{s === 'filed' ? 'Filed on GitHub' : REPORT_STATUS_LABEL[s]}</option>)}</Select></Field>
        <Field label="Note" hint="Optional, only you see it"><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="The GitHub issue link, or why it was closed" /></Field>
      </div>
      <div className="actions"><Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save status'}</Button></div>
      {error && <p className="error">{error}</p>}
    </form>
  );
}
