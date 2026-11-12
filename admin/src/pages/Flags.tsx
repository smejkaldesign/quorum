import { useEffect, useState } from 'react';
import { api } from '../api';
import { type Flag, blockedBy, filterFlags, flagKeyFrom, onDate, validateFlagForm } from '../shape';
import { Badge, Button, Card, Chip, Dialog, Drawer, Empty, Field, Input, PageHeader, Select, SkeletonRows, Switch, Table, TableHead, TableItem, TableRow, Textarea, useToast } from '../ui';

// Feature flags: every switch installs read through the relay (GET /v1/flags, a minute behind at most). The row's
// switch flips it at once; the drawer under a row edits the name, description and tags, which only the owner sees.
const COLS = 'minmax(220px, 2fr) minmax(160px, 1.4fr) 110px 60px';

export function Flags() {
  const [list, setList] = useState<Flag[] | null>(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'all' | 'enabled' | 'disabled'>('all');
  const [creating, setCreating] = useState(false);
  const load = () => { setError(''); return api.flags().then((r) => (r.ok ? setList(r.value) : setError(r.error))); };
  useEffect(() => { load(); }, []);
  const put = (f: Flag) => setList((l) => l?.map((x) => (x.key === f.key ? f : x)) ?? l);
  const shown = filterFlags(list ?? [], q, status);
  const on = (list ?? []).filter((f) => f.enabled).length;
  return (
    <>
      <PageHeader
        title="Feature flags"
        actions={<>
          <Input className="search" placeholder="Find a flag" value={q} onChange={(e) => setQ(e.target.value)} />
          <span className="chips"><Chip on={status === 'all'} onClick={() => setStatus('all')}>All{list ? ` (${list.length})` : ''}</Chip><Chip on={status === 'enabled'} onClick={() => setStatus('enabled')}>On{list ? ` (${on})` : ''}</Chip><Chip on={status === 'disabled'} onClick={() => setStatus('disabled')}>Off{list ? ` (${list.length - on})` : ''}</Chip></span>
          <Button variant="primary" onClick={() => setCreating(true)}>New flag</Button>
        </>}
      />
      <Card list>
        <Table columns={COLS}>
          <TableHead><span>Flag</span><span>Tags</span><span>Changed</span><span>On</span></TableHead>
          {list === null && error && <div className="pad"><p className="error" style={{ marginTop: 0 }}>{error}</p><Button onClick={load}>Try again</Button></div>}
          {list === null && !error && <SkeletonRows />}
          {list !== null && error && <p className="error pad">{error}</p>}
          {list !== null && shown.length === 0 && <Empty>{list.length === 0 ? 'No flags yet. Migration 0021 seeds the notetaker flags; New flag adds one.' : 'No flag matches.'}</Empty>}
          {shown.map((f) => <Row key={f.key} f={f} list={list ?? []} onChange={put} />)}
        </Table>
      </Card>
      <NewFlag open={creating} onClose={(made) => { setCreating(false); if (made) setList((l) => [made, ...(l ?? [])]); }} />
    </>
  );
}

function Row({ f, list, onChange }: { f: Flag; list: Flag[]; onChange: (f: Flag) => void }) {
  const blocked = blockedBy(f, list);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const flip = async (next: boolean) => {
    setBusy(true);
    const r = await api.setFlag(f.key, next);
    setBusy(false);
    if (!r.ok) { toast.error(r.error); return; }
    onChange(r.value);
    toast.success(`${f.name} is ${next ? 'on' : 'off'}. Installs pick it up within an hour, or on their next launch.`);
  };
  return (
    <TableItem open={open}>
      <TableRow>
        <span className="who"><strong>{f.name}</strong><em><code className="flag-key">{f.key}</code>{f.requires ? ` · needs ${f.requires}` : ''}{f.description ? ` · ${f.description}` : ''}</em></span>
        <span className="badges">{blocked && f.enabled && <Badge tone="pending">Off: {blocked} is off</Badge>}{f.tags.map((t) => <Badge key={t} tone="off">{t}</Badge>)}{f.tags.length === 0 && <span className="muted small">No tags</span>}</span>
        <span className="when hide"><Button variant="link" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Close' : 'Edit'}</Button><span className="muted small"> · {onDate(f.updatedAt)}</span></span>
        <Switch checked={f.enabled} disabled={busy} label={`${f.name} on`} onChange={flip} />
      </TableRow>
      {open && <Drawer><EditFlag f={f} list={list} onSaved={(saved) => { onChange(saved); setOpen(false); }} onCancel={() => setOpen(false)} /></Drawer>}
    </TableItem>
  );
}

function EditFlag({ f, list, onSaved, onCancel }: { f: Flag; list: Flag[]; onSaved: (f: Flag) => void; onCancel: () => void }) {
  const [name, setName] = useState(f.name);
  const [requires, setRequires] = useState(f.requires ?? '');
  const [description, setDescription] = useState(f.description);
  const [tags, setTags] = useState(f.tags.join(', '));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const toast = useToast();
  const save = async () => {
    const v = validateFlagForm({ name, key: f.key, description, tags });
    if ('error' in v) { setError(v.error); return; }
    setBusy(true); setError('');
    let r = await api.updateFlag(v.draft);
    if (r.ok && (requires || null) !== f.requires) r = await api.setRequires(f.key, requires || null);
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    toast.success(`Saved ${r.value.name}.`);
    onSaved(r.value);
  };
  return (
    <form className="plat-form" onSubmit={(e) => { e.preventDefault(); if (!busy) save(); }}>
      <div className="fields">
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Key" hint="Keys do not change; the app reads this one."><Input value={f.key} readOnly /></Field>
        <Field label="Description"><Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        <Field label="Tags" hint="Comma separated, like notetaker, cloud"><Input value={tags} onChange={(e) => setTags(e.target.value)} /></Field>
        <Field label="Needs" hint="While the parent is off, installs read this flag as off."><Select value={requires} onChange={(e) => setRequires(e.target.value)}><option value="">No parent</option>{list.filter((p) => p.key !== f.key && p.requires !== f.key).map((p) => <option key={p.key} value={p.key}>{p.name} ({p.key})</option>)}</Select></Field>
      </div>
      <div className="actions"><Button variant="primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button><Button variant="link" onClick={onCancel}>Cancel</Button></div>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

function NewFlag({ open, onClose }: { open: boolean; onClose: (made: Flag | null) => void }) {
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [keyTouched, setKeyTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const toast = useToast();
  const reset = () => { setName(''); setKey(''); setKeyTouched(false); setDescription(''); setTags(''); setError(''); };
  const close = (made: Flag | null) => { reset(); onClose(made); };
  const create = async () => {
    const v = validateFlagForm({ name, key, description, tags });
    if ('error' in v) { setError(v.error); return; }
    setBusy(true); setError('');
    const r = await api.createFlag(v.draft);
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    toast.success(`${r.value.name} created, off until you turn it on.`);
    close(r.value);
  };
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) close(null); }} title="New flag" description="A new flag starts off. The key is what the app reads; it cannot change later.">
      <form onSubmit={(e) => { e.preventDefault(); if (!busy) create(); }}>
        <div className="fields">
          <Field label="Name"><Input autoFocus value={name} onChange={(e) => { setName(e.target.value); if (!keyTouched) setKey(flagKeyFrom(e.target.value)); }} placeholder="Dark mode" /></Field>
          <Field label="Key"><Input value={key} onChange={(e) => { setKeyTouched(true); setKey(e.target.value.toLowerCase()); }} placeholder="dark-mode" /></Field>
          <Field label="Description"><Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What turns on with it" /></Field>
          <Field label="Tags"><Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="Comma separated, optional" /></Field>
        </div>
        <div className="modal-actions"><Button variant="link" disabled={busy} onClick={() => close(null)}>Cancel</Button><Button variant="primary" type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create'}</Button></div>
        {error && <p className="error">{error}</p>}
      </form>
    </Dialog>
  );
}
