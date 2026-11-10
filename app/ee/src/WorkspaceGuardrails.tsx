import { useEffect, useState } from 'react';
import type { AccountState, GuardrailRule } from '../../src/quorum';
import { Row, Toggle } from '../../src/controls';
import { IconFolder, IconLock, IconPlus, IconSearch, IconShield, IconTrash } from '../../src/icons';
import { AccountCard, useAccount } from './Account';

// Settings › Admin › Guardrails: rules for the whole workspace. Each member's Quorum merges them with its own rules and
// cannot turn them off. Every rule only denies, so adding one can only hide more, never less.
const KIND_LABEL: Record<string, string> = { path: 'Folder', frontmatter: 'Frontmatter key', secret: 'File name pattern', term: 'Term' };
const KIND_ICON: Record<string, typeof IconShield> = { path: IconFolder, frontmatter: IconLock, secret: IconLock, term: IconSearch };

export function WorkspaceGuardrailsPage() {
  const a = useAccount();
  if (!a) return null;
  if (!a.signedIn || !a.workspace) return <AccountCard account={a} />;
  return <Rules account={a} />;
}

function Rules({ account: acct }: { account: AccountState }) {
  const canManage = acct.workspace!.role !== 'member';
  const [rules, setRules] = useState<GuardrailRule[]>([]);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<{ kind: string; value: string; label: string }>({ kind: 'term', value: '', label: '' });
  const [busy, setBusy] = useState(false);
  const load = () => window.quorum.workspaceGuardrailsGet().then((r) => { if (r?.error) setError(r.error); else setRules(r?.rules ?? []); });
  useEffect(() => { load(); }, []);
  const save = async (next: GuardrailRule[]) => {
    setBusy(true); setError('');
    const r = await window.quorum.workspaceGuardrailsSet(next.map(({ id, kind, value, label, enabled }) => ({ id, kind, value, label, enabled })));
    setBusy(false);
    if (r?.error) setError(r.error); else setRules(r?.rules ?? next);
  };
  const add = async () => {
    const value = draft.value.trim();
    if (!value) return;
    await save([...rules, { id: '', kind: draft.kind as GuardrailRule['kind'], value, label: draft.label.trim() || value.slice(0, 60), enabled: true, source: 'workspace', locked: true }]);
    setDraft({ kind: draft.kind, value: '', label: '' });
  };
  return (
    <>
      <p className="set-lede">Rules every member's Quorum applies on top of its own: folders no agent may read, frontmatter keys that mark a note off limits, file name patterns, and names that are withheld from transcripts and answers. Members see them under Settings, Guardrails and cannot turn them off.</p>
      {error && <p className="set-error">{error}</p>}
      <h3>Workspace rules</h3>
      {rules.length ? (
        <div className="set-card">
          {rules.map((r, i) => { const Icon = KIND_ICON[r.kind] ?? IconShield; return (
            <Row key={r.id || i} icon={<Icon width={18} height={18} className={r.enabled !== false ? 'ok' : undefined} />} title={r.label || r.value} desc={`${KIND_LABEL[r.kind] ?? r.kind} · ${r.value}`}>
              {canManage ? <span className="guard-actions"><Toggle on={r.enabled !== false} onChange={(on) => save(rules.map((x, j) => (j === i ? { ...x, enabled: on } : x)))} /><button className="icon-btn" aria-label="Remove" disabled={busy} onClick={() => save(rules.filter((_, j) => j !== i))}><IconTrash width={15} height={15} /></button></span>
                : <span className="conn-ok"><i />{r.enabled !== false ? 'On' : 'Off'}</span>}
            </Row>
          ); })}
        </div>
      ) : <div className="set-card set-zero small"><p>No workspace rules yet. Members run with Quorum's built-in guardrails and their own.</p></div>}
      {canManage && (
        <>
          <h3>Add a rule</h3>
          <div className="set-card guard-add">
            <div className="guard-kinds" role="radiogroup" aria-label="What the rule matches">
              {Object.entries(KIND_LABEL).map(([k, l]) => <button key={k} role="radio" aria-checked={draft.kind === k} className={`pill ${draft.kind === k ? 'primary' : ''}`} onClick={() => setDraft({ ...draft, kind: k })}>{l}</button>)}
            </div>
            <div className="guard-add-row">
              <input value={draft.value} onChange={(e) => setDraft({ ...draft, value: e.target.value })} placeholder={draft.kind === 'path' ? 'legal/, board/' : draft.kind === 'frontmatter' ? 'legal_hold' : draft.kind === 'term' ? 'Project Falcon, Northwind' : String.raw`\.sqlite$`} aria-label="Rule value" onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
              <input value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} placeholder="Name (optional)" aria-label="Rule name" />
              <button className="pill primary with-icon" disabled={busy || !draft.value.trim()} onClick={add}><IconPlus width={15} height={15} />Add</button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
