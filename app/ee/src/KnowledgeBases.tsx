import { useCallback, useEffect, useRef, useState } from 'react';
import type { Kb, KbKind, Member, Result } from '../../src/quorum';
import { Row, useMenu } from '../../src/controls';
import { IconMore, IconPlus, IconStack } from '../../src/icons';
import { AccountCard, EE_MARKER, useAccount } from './Account';
import { accountApi } from './accountMock';
import { accessDraft, KIND_LABEL, readersOf, readersSummary, sourceLine, type ReadersMode } from './kbTree';
import { DrivePanel, hasDrive } from './KbDrive';
import { announceKbChange, EMPTY_SOURCE, hasImport, ImportStatus, kbCall, KbConfirm, SourceFields, sourceOf, useImport, type SourceDraft } from './kbUi';

// Settings › Admin › Knowledge, Cloud: the workspace's knowledge bases. Owners and admins create one (empty, from a
// GitHub repository or from a zip), rename it, set who reads it and delete it. A KB's kind is chosen when it is
// created. The default KB (the workspace's team source) is not offered for deletion. Folders and notes are managed in
// the Knowledge tab.
export function KnowledgeBasesPage() {
  const a = useAccount();
  if (!a) return null;
  if (!a.signedIn || !a.workspace) return <AccountCard account={a} />;
  if (a.workspace.role === 'member') return <p className="set-hint">Owners and admins manage knowledge bases. Browse the ones you can read in the Knowledge tab.</p>;
  return <Bases />;
}

type Panel = { kind: 'rename' | 'readers' | 'import' | 'refresh' | 'drive'; kbId: string } | null;

function Bases() {
  const [kbs, setKbs] = useState<Kb[] | null>(null);
  const [error, setError] = useState('');
  const [panel, setPanel] = useState<Panel>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Kb | null>(null);
  const load = useCallback(async () => {
    const r = await kbCall(() => window.quorum.kbList(), 'The knowledge bases could not be read.');
    if (r.error) setError(r.error); else { setError(''); setKbs(r.kbs ?? []); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const replace = (kb: Kb) => { announceKbChange(); setKbs((list) => (list ?? []).map((k) => (k.id === kb.id ? kb : k))); };
  const remove = async (kb: Kb) => {
    setDeleting(null);
    const r = await kbCall(() => window.quorum.kbDelete(kb.id), 'The knowledge base could not be deleted.');
    if (r.error) setError(r.error); else { setError(''); announceKbChange(); setKbs((list) => (list ?? []).filter((k) => k.id !== kb.id)); if (panel?.kbId === kb.id) setPanel(null); }
  };
  return (
    <div data-ee={EE_MARKER}>
      <h3>Knowledge bases</h3>
      <div className="set-card">
        {kbs === null && !error && <p className="set-hint">Loading…</p>}
        {kbs?.map((kb) => (
          <div key={kb.id} className="kb-admin-item">
            <Row icon={<IconStack width={18} height={18} />}
              title={<>{kb.name}{kb.isDefault && <span className="kb-badge">Default</span>}</>}
              desc={[KIND_LABEL[kb.kind], readersSummary(kb.access), sourceLine(kb.source)].filter(Boolean).join(' · ')}>
              <button className="pill small" aria-expanded={panel?.kind === 'readers' && panel.kbId === kb.id} onClick={() => setPanel(panel?.kind === 'readers' && panel.kbId === kb.id ? null : { kind: 'readers', kbId: kb.id })}>Readers</button>
              <KbMenu kb={kb} onPick={(kind) => (kind === 'delete' ? setDeleting(kb) : setPanel({ kind, kbId: kb.id }))} />
            </Row>
            {panel?.kbId === kb.id && panel.kind === 'rename' && <Rename kb={kb} onDone={(next) => { if (next) replace(next); setPanel(null); }} />}
            {panel?.kbId === kb.id && panel.kind === 'readers' && <Readers kb={kb} onDone={(next) => { if (next) replace(next); setPanel(null); }} />}
            {panel?.kbId === kb.id && panel.kind === 'import' && <ImportInto kb={kb} onDone={() => setPanel(null)} onImported={load} />}
            {panel?.kbId === kb.id && panel.kind === 'refresh' && <Refresh kb={kb} onDone={() => setPanel(null)} onImported={load} />}
            {panel?.kbId === kb.id && panel.kind === 'drive' && <DrivePanel kb={kb} onDone={() => setPanel(null)} />}
          </div>
        ))}
        {kbs && !kbs.length && <p className="set-hint">No knowledge bases yet. Create one to give the workspace a shared place for notes.</p>}
      </div>
      {error && <p className="set-error" role="alert">{error}</p>}
      {creating ? <Create onDone={(kb) => { setCreating(false); if (kb) load(); }} /> : (
        <p><button className="pill with-icon" onClick={() => { setCreating(true); setPanel(null); }}><IconPlus width={15} height={15} />New knowledge base</button></p>
      )}
      {deleting && <KbConfirm title={`Delete ${deleting.name}?`} body="Its folders are deleted. Its notes stay with the people who wrote them and leave the knowledge base. This cannot be undone." action="Delete" onDone={(ok) => (ok ? remove(deleting) : setDeleting(null))} />}
    </div>
  );
}

function KbMenu({ kb, onPick }: { kb: Kb; onPick: (kind: 'rename' | 'import' | 'refresh' | 'drive' | 'delete') => void }) {
  const [open, setOpen] = useMenu();
  return (
    <span className="menu-wrap">
      <button className="icon-btn" aria-label={`More for ${kb.name}`} aria-haspopup="menu" aria-expanded={open} onClick={(e) => { e.stopPropagation(); setOpen(!open); }}><IconMore width={16} height={16} /></button>
      {open && (
        <div className="menu" role="menu">
          <button role="menuitem" onClick={() => onPick('rename')}>Rename</button>
          {hasImport() && kb.source?.kind === 'github' && <button role="menuitem" onClick={() => onPick('refresh')}>Refresh from GitHub</button>}
          {hasImport() && <button role="menuitem" onClick={() => onPick('import')}>Import notes</button>}
          {hasDrive() && kb.role === 'admin' && <button role="menuitem" onClick={() => onPick('drive')}>Add from Google Drive</button>}
          {!kb.isDefault && <button role="menuitem" className="danger-pill" onClick={() => onPick('delete')}>Delete</button>}
        </div>
      )}
    </span>
  );
}

function Rename({ kb, onDone }: { kb: Kb; onDone: (kb: Kb | null) => void }) {
  const [name, setName] = useState(kb.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    const next = name.trim();
    if (busy || !next) return;
    if (next === kb.name) { onDone(null); return; }
    setBusy(true); setError('');
    const r = await kbCall(() => window.quorum.kbRename(kb.id, next), 'The knowledge base could not be renamed.');
    setBusy(false);
    if (r.error || !r.kb) setError(r.error ?? 'The knowledge base could not be renamed.'); else onDone(r.kb);
  };
  return (
    <div className="kb-panel">
      <div className="kb-form-row">
        <span className="set-field wide"><input autoFocus value={name} onChange={(e) => setName(e.target.value)} aria-label="Knowledge base name" onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') onDone(null); }} /></span>
        <button className="pill primary" disabled={busy || !name.trim()} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
        <button className="pill ghost" onClick={() => onDone(null)}>Cancel</button>
      </div>
      {error && <p className="set-error" role="alert">{error}</p>}
    </div>
  );
}

// who reads the KB: the whole workspace, or chosen people from the member list. KB admins stay on the list as they are;
// workspace owners and admins read every KB without a row
function Readers({ kb, onDone }: { kb: Kb; onDone: (kb: Kb | null) => void }) {
  const start = readersOf(kb.access);
  const [mode, setMode] = useState<ReadersMode>(start.mode);
  const [people, setPeople] = useState<string[]>(start.people);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    kbCall<Result & { members?: Member[] }>(async () => { const r = await accountApi().membersList(); return 'error' in r ? { error: r.error } : { members: r.members }; }, 'The member list could not be read.')
      .then((r) => { if (!live) return; if (r.error) setError(r.error); else setMembers(r.members ?? []); });
    return () => { live = false; };
  }, []);
  const admins = new Set((kb.access ?? []).filter((a) => a.principal === 'user' && a.role === 'admin').map((a) => a.userId));
  const save = async () => {
    setBusy(true); setError('');
    const r = await kbCall(() => window.quorum.kbAccessSet(kb.id, accessDraft(kb.access, mode, people)), 'Access could not be saved.');
    setBusy(false);
    if (r.error || !r.access) setError(r.error ?? 'Access could not be saved.'); else onDone({ ...kb, access: r.access });
  };
  const toggle = (id: string, on: boolean) => setPeople((p) => (on ? [...p, id] : p.filter((x) => x !== id)));
  return (
    <div className="kb-panel">
      <div className="guard-kinds" role="radiogroup" aria-label="Who reads it">
        <button role="radio" aria-checked={mode === 'workspace'} className={`pill ${mode === 'workspace' ? 'primary' : ''}`} onClick={() => setMode('workspace')}>Whole workspace</button>
        <button role="radio" aria-checked={mode === 'people'} className={`pill ${mode === 'people' ? 'primary' : ''}`} onClick={() => setMode('people')}>Chosen people</button>
      </div>
      {mode === 'people' && (
        <fieldset className="kb-people">
          <legend className="muted">Owners and admins of the workspace read every knowledge base.</legend>
          {members === null && !error && <p className="set-hint">Loading members…</p>}
          {members?.map((m) => {
            const admin = admins.has(m.userId);
            return (
              <label key={m.userId} className="kb-person">
                <input type="checkbox" checked={admin || people.includes(m.userId)} disabled={admin} onChange={(e) => toggle(m.userId, e.target.checked)} />
                <span>{m.name || m.email}</span>
                <em className="muted">{admin ? 'KB admin' : m.role === 'member' ? '' : m.role === 'owner' ? 'Owner' : 'Admin'}</em>
              </label>
            );
          })}
        </fieldset>
      )}
      <div className="kb-form-row">
        <button className="pill primary" disabled={busy || (mode === 'people' && members === null)} onClick={save}>{busy ? 'Saving…' : 'Save readers'}</button>
        <button className="pill ghost" onClick={() => onDone(null)}>Cancel</button>
      </div>
      {error && <p className="set-error" role="alert">{error}</p>}
    </div>
  );
}

function ImportInto({ kb, onDone, onImported }: { kb: Kb; onDone: () => void; onImported: () => void }) {
  const [draft, setDraft] = useState<SourceDraft>({ ...EMPTY_SOURCE, kind: 'github' });
  const [error, setError] = useState('');
  const imp = useImport();
  const go = async () => {
    setError('');
    const s = sourceOf(draft);
    if ('error' in s) { setError(s.error); return; }
    if (s.source && (await imp.run(kb.id, s.source)) === null) onImported();
  };
  return (
    <div className="kb-panel">
      <SourceFields draft={draft} onChange={setDraft} withEmpty={false} disabled={imp.running} />
      <div className="kb-form-row">
        <button className="pill primary" disabled={imp.running || !hasImport()} onClick={go}>{imp.running ? 'Importing…' : `Import into ${kb.name}`}</button>
        <button className="pill ghost" disabled={imp.running} onClick={onDone}>{imp.result ? 'Done' : 'Cancel'}</button>
      </div>
      {error && <p className="set-error" role="alert">{error}</p>}
      <ImportStatus {...imp} />
    </div>
  );
}

// Refresh from GitHub: imports the KB's stored GitHub source again as soon as it opens, then shows the result
function Refresh({ kb, onDone, onImported }: { kb: Kb; onDone: () => void; onImported: () => void }) {
  const imp = useImport();
  const started = useRef(false);
  const { run } = imp;
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    run(kb.id).then((why) => { if (why === null) onImported(); });
  }, [kb.id, run, onImported]);
  return (
    <div className="kb-panel">
      <ImportStatus {...imp} />
      <div className="kb-form-row"><button className="pill ghost" disabled={imp.running} onClick={onDone}>{imp.running ? 'Refreshing…' : 'Done'}</button></div>
    </div>
  );
}

// a new KB: its name and kind, then where its notes come from. An import runs into the KB just created, so a failed
// import leaves the KB in place and empty, and says so
function Create({ onDone }: { onDone: (kb: Kb | null) => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<KbKind>('general');
  const [draft, setDraft] = useState<SourceDraft>(EMPTY_SOURCE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [made, setMade] = useState<Kb | null>(null);
  const imp = useImport();
  const go = async () => {
    setError('');
    const s = sourceOf(draft);
    if ('error' in s) { setError(s.error); return; }
    setBusy(true);
    let kb = made;
    if (!kb) {
      const r = await kbCall(() => window.quorum.kbCreate({ name: name.trim(), kind }), 'The knowledge base could not be created.');
      if (r.error || !r.kb) { setBusy(false); setError(r.error ?? 'The knowledge base could not be created.'); return; }
      kb = r.kb;
      setMade(kb);
      announceKbChange();
    }
    if (!s.source) { setBusy(false); onDone(kb); return; }
    const why = await imp.run(kb.id, s.source);
    setBusy(false);
    if (why) setError(`${why} ${kb.name} was created and is empty; fix the source and import again, or close this.`);
  };
  const running = busy || imp.running;
  return (
    <div className="set-card kb-create">
      <h3 className="kb-create-title">New knowledge base</h3>
      <div className="kb-form-row">
        <span className="set-field wide"><input autoFocus value={name} disabled={running || !!made} onChange={(e) => setName(e.target.value)} placeholder="Name, for example Handbook" aria-label="Knowledge base name" onKeyDown={(e) => { if (e.key === 'Enter' && name.trim() && !running) go(); if (e.key === 'Escape' && !running) onDone(null); }} /></span>
      </div>
      <p className="kb-label">Kind</p>
      <div className="guard-kinds" role="radiogroup" aria-label="Kind">
        {(Object.keys(KIND_LABEL) as KbKind[]).map((k) => <button key={k} role="radio" aria-checked={kind === k} disabled={running || !!made} className={`pill ${kind === k ? 'primary' : ''}`} onClick={() => setKind(k)}>{KIND_LABEL[k]}</button>)}
      </div>
      <p className="kb-hint muted">{kind === 'meetings' ? 'A meetings knowledge base collects meeting notes for a team.' : 'A general knowledge base holds any notes the workspace shares.'} The kind cannot be changed after the knowledge base is created.</p>
      <p className="kb-label">Start with</p>
      <SourceFields draft={draft} onChange={setDraft} withEmpty={!made} disabled={running} />
      <div className="kb-form-row">
        {imp.result ? <button className="pill primary" onClick={() => onDone(made)}>Done</button> : (
          <button className="pill primary" disabled={running || !name.trim()} onClick={go}>{running ? (imp.running ? 'Importing…' : 'Creating…') : made ? 'Import again' : 'Create'}</button>
        )}
        {!imp.result && <button className="pill ghost" disabled={running} onClick={() => onDone(made)}>{made ? 'Close' : 'Cancel'}</button>}
      </div>
      {error && <p className="set-error" role="alert">{error}</p>}
      <ImportStatus running={imp.running} progress={imp.progress} result={imp.result} error="" />
    </div>
  );
}
