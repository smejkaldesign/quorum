import { useEffect, useState } from 'react';
import type { GuardrailRule, GuardrailsState } from './quorum';
import { Row, Toggle, useMenu } from './controls';
import { IconCheck, IconClose, IconFolder, IconLock, IconMore, IconPlus, IconSearch, IconShield, IconTrash } from './icons';

// Settings › Guardrails: what an agent may read from the Agent OS and say about it, as one list in two scopes. The
// individual rules: built-in rules first, then what the connected Agent OS offers (its CLAUDE.md rules, frontmatter
// conventions, Obsidian exclusions, guard hooks and opt-out lists, reviewed one by one and off until included), then
// the person's own rules with an Add sheet and a live test. The organization or team rules an admin set, locked.
// Then the recent denials so the guards are seen working. Every row says what it reaches once it is on.
const KIND_LABEL: Record<string, string> = { path: 'Folder', frontmatter: 'Frontmatter key', secret: 'File name pattern', term: 'Term', hook: 'Hook from your Agent OS' };
const ORIGIN: Record<string, string> = { hook: 'Hook', terms: 'Opt-out list', 'claude-md': 'CLAUDE.md', frontmatter: 'Frontmatter', obsidian: 'Obsidian' };
const KIND_HINT: Record<string, string> = {
  path: 'A folder, relative to your Agent OS. Nothing in it is read or searched. Several, separated by commas.',
  frontmatter: 'A frontmatter key. A note that has it, with any value, is never read, synced or shared.',
  secret: 'A pattern for file names that must never be read, as a regular expression.',
  term: 'Names or words. Any line containing one is withheld from transcripts, answers and the MCP server. Several, separated by commas.',
};
const KIND_ICON: Record<string, typeof IconShield> = { path: IconFolder, frontmatter: IconLock, secret: IconLock, term: IconSearch, hook: IconShield };

export function GuardrailsPage() {
  const [st, setSt] = useState<GuardrailsState | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');
  // opening the page scans the Agent OS again, so a rule added to CLAUDE.md or a newly tagged folder shows up here
  const refresh = (fresh = false) => window.quorum.guardrailsGet(fresh ? { fresh: true } : undefined).then((s) => { if (s) setSt(s); }).catch(() => {});
  useEffect(() => { refresh(true); }, []);
  if (!st) return null;
  const act = async (fn: () => Promise<{ ok?: boolean; error?: string } | null>) => { setError(''); const r = await fn(); if (r?.error) setError(r.error); await refresh(); };
  const builtIns = st.rules.filter((r) => r.source === 'built-in');
  const fromOs = st.rules.filter((r) => r.source === 'agent-os');
  const pending = fromOs.filter((r) => r.decision === null);
  const decided = fromOs.filter((r) => r.decision !== null);
  const mine = st.rules.filter((r) => r.source === 'personal');
  const workspace = st.rules.filter((r) => r.source === 'workspace');
  const valueOf = (r: GuardrailRule) => (r.kind === 'hook' ? (r.path ?? '').replace(/^\/Users\/[^/]+/, '~') : r.value.startsWith('@') ? r.value.slice(1).replace(/^\/Users\/[^/]+/, '~') : r.value);

  const ruleRow = (r: GuardrailRule) => {
    const Icon = KIND_ICON[r.kind] ?? IconShield;
    return (
      <Row key={r.id} icon={<Icon width={18} height={18} className={r.enabled ? 'ok' : undefined} />}
        title={<>{r.label}{r.source === 'workspace' && <em className="stub">Organization or team</em>}{r.source === 'agent-os' && r.origin && <em className="stub">{ORIGIN[r.origin] ?? r.origin}</em>}{r.stale && <em className="stub warn">No longer found in your Agent OS</em>}{r.mixed && <em className="stub warn">Read it first</em>}</>}
        desc={<>{r.what ?? `${KIND_LABEL[r.kind]} · ${valueOf(r)}`}{r.stale && ' Still on until you leave it out.'}{r.reach && <span className="guard-reach">{r.reach}</span>}</>}>
        {r.source === 'agent-os' && r.decision === null ? (
          <span className="mem-actions">
            <span className="new-badge">New</span>
            <button className="icon-btn mem-yes" aria-label={`Include ${r.label}`} data-tip="Include" onClick={() => act(() => window.quorum.guardrailsSet(r.id, { enabled: true }))}><IconCheck width={17} height={17} /></button>
            <button className="icon-btn mem-no" aria-label={`Leave out ${r.label}`} data-tip="Leave out" onClick={() => act(() => window.quorum.guardrailsSet(r.id, { enabled: false }))}><IconClose width={15} height={15} /></button>
          </span>
        ) : r.locked ? <span className="conn-ok"><i />On for the workspace</span>
          : <span className="guard-actions"><Toggle on={r.enabled} onChange={(on) => act(() => window.quorum.guardrailsSet(r.id, { enabled: on }))} />{r.source === 'personal' && <RuleMenu onRemove={() => act(() => window.quorum.guardrailsRemove(r.id))} />}</span>}
      </Row>
    );
  };

  return (
    <>
      <p className="set-lede">What Quorum's agent may read from your Agent OS and say about it. Every rule only ever denies, so the rules below add up. Individual rules are yours and work in both editions; organization or team rules come from your workspace admins. {st.summary.on} on{st.summary.toReview ? `, ${st.summary.toReview} to review` : ''}.</p>
      {error && <p className="set-error">{error}</p>}

      <h3>Built in</h3>
      <div className="set-card">{builtIns.map(ruleRow)}</div>

      {pending.length > 0 && (
        <>
          <h3>Found in your Agent OS · {pending.length} to review</h3>
          <p className="mcp-lede">{scanNote(st)} Include one and it applies on every read, sync and share Quorum makes; leave it out and nothing changes. Only rules that change what Quorum reads, writes, syncs, shares or lets an agent say are offered.</p>
          <div className="set-card">{pending.map(ruleRow)}</div>
        </>
      )}
      {decided.length > 0 && (
        <>
          <h3>From your Agent OS</h3>
          {pending.length === 0 && <p className="mcp-lede">{scanNote(st)}</p>}
          <div className="set-card">{decided.map(ruleRow)}</div>
        </>
      )}
      {fromOs.length === 0 && (
        <>
          <h3>From your Agent OS</h3>
          <p className="mcp-lede guard-note">{scanNote(st)} Nothing to offer beyond the built-in rules, which cover its private folders and confidential notes.</p>
        </>
      )}
      {st.skipped.length > 0 && (
        <details className="guard-skipped">
          <summary>{st.skipped.length} {st.skipped.length === 1 ? 'thing' : 'things'} in your Agent OS looked at and left out</summary>
          <ul>{st.skipped.map((s) => <li key={s.name}><strong>{s.name}</strong> {s.reason}</li>)}</ul>
        </details>
      )}

      <div className="set-head">
        <h3>Your rules</h3>
        <span className="set-head-actions"><button className="pill small-pill with-icon" onClick={() => setAdding(true)}><IconPlus width={15} height={15} />Add rule</button></span>
      </div>
      {mine.length ? <div className="set-card">{mine.map(ruleRow)}</div> : <div className="set-card set-zero small"><p>No rules of your own yet. Add a folder, a frontmatter key, a file name pattern or a term.</p></div>}

      {workspace.length > 0 && (
        <>
          <h3>Organization or team</h3>
          <p className="mcp-lede">Set by your workspace admins for everyone in the organization or team. They apply on every member's Mac and cannot be turned off here.</p>
          <div className="set-card">{workspace.map(ruleRow)}</div>
        </>
      )}

      <Tester />

      <h3>Recent denials</h3>
      {st.denials.length ? (
        <div className="set-card guard-denials">
          {st.denials.map((d, i) => <div key={`${d.t}-${i}`} className="guard-denial"><span className="guard-when">{new Date(d.t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span><span className="guard-path">{(d.path || '').replace(/^\/Users\/[^/]+/, '~')}</span><span className="guard-why">{d.reason.replace(/^Quorum read guard: /, '')}</span></div>)}
        </div>
      ) : <div className="set-card set-zero small"><p>Nothing denied yet. Every read the guards refuse shows up here.</p></div>}

      {adding && <AddRule onClose={() => setAdding(false)} onAdd={async (r) => { const out = await window.quorum.guardrailsAdd(r); if (out?.error) return out.error; setAdding(false); await refresh(); return null; }} />}
    </>
  );
}

// one line on how far the review went, so a short list is seen as a thorough look rather than a shallow one
const scanNote = (st: GuardrailsState) => {
  const n = st.scanned?.notes ?? 0;
  const when = st.scanned?.at ? new Date(st.scanned.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : null;
  const notes = st.scanned?.truncated ? `the first ${n} notes, which is where the review stopped` : `${n} ${n === 1 ? 'note' : 'notes'}`;
  return `Reviewed its CLAUDE.md, hooks, Obsidian settings and the frontmatter of ${notes}${when ? ` at ${when}` : ''}.`;
};

function RuleMenu({ onRemove }: { onRemove: () => void }) {
  const [open, setOpen] = useMenu();
  return (
    <span className="menu-wrap" onClick={(e) => e.stopPropagation()}>
      <button className="icon-btn" aria-label="Rule options" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}><IconMore /></button>
      {open && <div className="menu end" role="menu"><button role="menuitem" className="danger" onClick={() => { setOpen(false); onRemove(); }}><IconTrash width={15} height={15} /> Remove</button></div>}
    </span>
  );
}

// the live test: a path relative to the Agent OS, and whether the rules as they stand would deny it
function Tester() {
  const [q, setQ] = useState('');
  const [result, setResult] = useState<{ blocked: string | null } | null>(null);
  useEffect(() => {
    if (!q.trim()) { setResult(null); return; }
    let live = true;
    const t = setTimeout(() => window.quorum.guardrailsTest(q.trim()).then((r) => { if (live) setResult(r); }), 200);
    return () => { live = false; clearTimeout(t); };
  }, [q]);
  return (
    <>
      <h3>Try a path</h3>
      <div className="set-card guard-test">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="02-personal/finances.md" aria-label="A path inside your Agent OS" />
        {result && q.trim() && (result.blocked
          ? <p className="set-error"><IconLock width={14} height={14} /> Denied: {result.blocked}.</p>
          : <p className="set-ok"><IconCheck width={14} height={14} className="ok" /> Allowed. No rule matches this path.</p>)}
      </div>
    </>
  );
}

function AddRule({ onClose, onAdd }: { onClose: () => void; onAdd: (r: { kind: string; value: string; label: string }) => Promise<string | null> }) {
  const [kind, setKind] = useState('path');
  const [value, setValue] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => { setBusy(true); setError(''); const e = await onAdd({ kind, value, label }); setBusy(false); if (e) setError(e); };
  return (
    <div className="palette-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
      <div className="modal conn-sheet" role="dialog" aria-modal="true" aria-labelledby="guard-title">
        <h2 id="guard-title">Add a guardrail</h2>
        <div className="guard-kinds" role="radiogroup" aria-label="What the rule matches">
          {(['path', 'frontmatter', 'term', 'secret'] as const).map((k) => <button key={k} role="radio" aria-checked={kind === k} className={`pill ${kind === k ? 'primary' : ''}`} onClick={() => setKind(k)}>{KIND_LABEL[k]}</button>)}
        </div>
        <p className="mcp-lede">{KIND_HINT[kind]}</p>
        <label className="set-field wide"><span>{KIND_LABEL[kind]}</span><input autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder={kind === 'path' ? 'clients/acme' : kind === 'frontmatter' ? 'legal_hold' : kind === 'term' ? 'Project Falcon, Northwind' : String.raw`\.sqlite$`} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} /></label>
        <label className="set-field wide"><span>Name (optional)</span><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="What this protects" /></label>
        {error && <p className="set-error">{error}</p>}
        <div className="modal-actions"><span /><span className="modal-actions-end"><button className="pill" onClick={onClose}>Cancel</button><button className="pill primary" disabled={busy || !value.trim()} onClick={submit}>Add</button></span></div>
      </div>
    </div>
  );
}
