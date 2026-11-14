import { useEffect, useState } from 'react';
import type { AccountState, ConnectorDraft, ConnectorProvider, ConnectorRole, WorkspaceConnector } from '../../src/quorum';
import { Row } from '../../src/controls';
import { IconGrid, IconPlus, IconReset, IconTrash, ProviderMark } from '../../src/icons';
import { AccountCard, EE_MARKER, useAccount } from './Account';
import { connectorsApi } from './accountMock';
import { WorkspaceIntegrations } from './WorkspaceIntegrations';
import { needsBaseUrl, PROVIDER_IDS, PROVIDERS, ROLE_LABEL, rolesFor, validRoles } from './connectorRoles';

const api = connectorsApi();

// the provider's mark: the logos icons.tsx has, the first letter for the rest
export function Mark({ provider }: { provider: ConnectorProvider }) {
  if (provider === 'anthropic' || provider === 'openai' || provider === 'google') return <ProviderMark provider={provider} />;
  return <span className="conn-mark">{PROVIDERS[provider].name[0]}</span>;
}

export const RolePills = ({ roles }: { roles: ConnectorRole[] }) => <span className="conn-roles">{roles.map((r) => <em key={r} className="stub">{ROLE_LABEL[r]}</em>)}</span>;

export function WorkspaceConnectorsPage() {
  const account = useAccount();
  if (!account) return null;
  if (!account.signedIn || !account.workspace) return <AccountCard account={account} />;
  return <Both account={account} />;
}

// the library connectors the workspace approves (WorkspaceIntegrations.tsx, migration 0030) on top, then the model
// provider keys (migration 0006) as their own section; a connector's read view takes the whole page
function Both({ account }: { account: AccountState }) {
  const [detail, setDetail] = useState(false);
  return (
    <>
      {'integrationsAdmin' in window.quorum && <WorkspaceIntegrations account={account} onDetail={setDetail} />}
      {!detail && <Connectors account={account} />}
    </>
  );
}

function Connectors({ account }: { account: AccountState }) {
  const ws = account.workspace!;
  const canManage = ws.role !== 'member';
  const [list, setList] = useState<WorkspaceConnector[] | null>(null);
  const [error, setError] = useState('');
  // the sheet: a fresh draft, or an existing connector to test with a pasted key or give a new one
  const [editing, setEditing] = useState<WorkspaceConnector | 'new' | null>(null);
  const load = () => api.connectorsList().then((r) => { if (r.error) setError(r.error); else setList(r.connectors ?? []); });
  useEffect(() => { load(); }, [ws.id]);
  const remove = async (c: WorkspaceConnector) => { setError(''); const r = await api.connectorRemove(c.id); if (r.error) setError(r.error); else load(); };
  const host = (c: WorkspaceConnector) => { try { return c.baseUrl ? new URL(c.baseUrl).host : null; } catch { return c.baseUrl; } };
  return (
    <div data-ee={EE_MARKER}>
      <div className="set-head">
        <h3>Model provider keys</h3>
        {canManage && <span className="set-head-actions"><button className="pill small-pill with-icon" onClick={() => setEditing('new')}><IconPlus width={15} height={15} />Add</button></span>}
      </div>
      <p className="mcp-lede">Provider keys for the whole workspace. Quorum keeps each key in the server vault and uses it only for the roles you pick; no one can read it back, not even here.</p>
      {list && !list.length ? (
        <div className="set-card set-zero">
          <span className="set-zero-icon"><IconGrid width={22} height={22} /></span>
          <strong>No connectors yet</strong>
          <p>{canManage ? 'Add a speech, model or voice provider once and every seat in the workspace uses it.' : 'An owner or admin adds speech, model and voice providers here for everyone.'}</p>
          {canManage && <button className="pill" onClick={() => setEditing('new')}>Add a connector</button>}
        </div>
      ) : (
        <div className="set-card">
          {list?.map((c) => (
            <Row key={c.id} icon={<Mark provider={c.provider} />} title={<>{c.label}<em className="stub">{PROVIDERS[c.provider].name}</em></>}
              desc={<><RolePills roles={c.roles} />{host(c) && <span className="muted"> · {host(c)}</span>}</>}>
              {canManage && <button className="pill small-pill" onClick={() => setEditing(c)}>Test</button>}
              {canManage && <button className="icon-btn mem-no" aria-label={`Remove ${c.label}`} data-tip="Remove" data-tip-pos="left" onClick={() => remove(c)}><IconTrash width={15} height={15} /></button>}
            </Row>
          ))}
        </div>
      )}
      {error && <p className="set-error">{error}</p>}
      <p className="set-note">Owners and admins manage connectors. Members see the list and use what is here.</p>
      {editing && <ConnectorSheet existing={editing === 'new' ? null : editing} onDone={(saved) => { setEditing(null); if (saved) load(); }} />}
    </div>
  );
}

// add a connector, or paste a key for an existing one to test it or replace what is stored. The key is tested against
// the provider before it is saved, and the roles offered are only the ones that provider can do
function ConnectorSheet({ existing, onDone }: { existing: WorkspaceConnector | null; onDone: (saved: boolean) => void }) {
  const [provider, setProvider] = useState<ConnectorProvider>(existing?.provider ?? 'anthropic');
  const [label, setLabel] = useState(existing?.label ?? '');
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? '');
  const [roles, setRoles] = useState<ConnectorRole[]>(existing?.roles ?? rolesFor(existing?.provider ?? 'anthropic'));
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const info = PROVIDERS[provider];
  const pick = (p: ConnectorProvider) => { setProvider(p); setRoles(validRoles(p, roles).length ? validRoles(p, roles) : rolesFor(p)); setNote(null); };
  const toggle = (r: ConnectorRole) => setRoles((cur) => (cur.includes(r) ? cur.filter((x) => x !== r) : [...cur, r]));
  const draft: ConnectorDraft = { provider, label: label.trim(), baseUrl: needsBaseUrl(provider) ? baseUrl.trim() || null : null, roles: validRoles(provider, roles), secret: secret.trim() };
  const ready = !!draft.label && !!draft.secret && draft.roles.length > 0 && (!needsBaseUrl(provider) || !!draft.baseUrl);
  const test = async () => {
    setBusy('test'); setNote(null);
    const r = await api.connectorTest({ provider, baseUrl: draft.baseUrl, secret: draft.secret });
    setBusy(null);
    setNote(r.error ? { ok: false, text: r.error } : { ok: true, text: `${info.name} accepted the key.` });
    return !r.error;
  };
  const save = async () => {
    setBusy('save'); setNote(null);
    const t = await api.connectorTest({ provider, baseUrl: draft.baseUrl, secret: draft.secret });
    if (t.error) { setBusy(null); setNote({ ok: false, text: t.error }); return; }
    const r = await api.connectorSet(draft);
    setBusy(null);
    if (r.error) setNote({ ok: false, text: r.error }); else onDone(true);
  };
  return (
    <div className="palette-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onDone(false); }}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onDone(false); } }}>
      <div className="modal conn-sheet" role="dialog" aria-modal="true" aria-labelledby="conn-title">
        <h2 id="conn-title">{existing ? `Test or replace ${existing.label}` : 'Add a connector'}</h2>
        <p>{existing ? 'Paste the key to test it, or Save to replace the one stored for this connector.' : 'Quorum checks the key with one read-only request, then keeps it in the server vault for the roles you pick.'}</p>
        <div className="set-line">
          <div className="set-label"><strong>Provider</strong></div>
          <select className="set-select" aria-label="Provider" value={provider} disabled={!!existing} onChange={(e) => pick(e.target.value as ConnectorProvider)}>
            {PROVIDER_IDS.map((p) => <option key={p} value={p}>{PROVIDERS[p].name}</option>)}
          </select>
        </div>
        <div className="set-line">
          <div className="set-label"><strong>Label</strong><span>How this connector shows up in Settings</span></div>
          <label className="set-field"><input aria-label="Label" placeholder={`${info.name} for the team`} value={label} disabled={!!existing} onChange={(e) => setLabel(e.target.value)} /></label>
        </div>
        {needsBaseUrl(provider) && (
          <div className="set-line">
            <div className="set-label"><strong>Base URL</strong><span>The OpenAI-compatible endpoint, up to /v1</span></div>
            <label className="set-field wide"><input aria-label="Base URL" placeholder="https://llm.example.com/v1" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} /></label>
          </div>
        )}
        <div className="set-line">
          <div className="set-label"><strong>{info.keyHint}</strong></div>
          <label className="set-field wide"><input type="password" autoFocus aria-label={info.keyHint} placeholder={info.placeholder} value={secret} onChange={(e) => { setSecret(e.target.value); setNote(null); }} onKeyDown={(e) => { if (e.key === 'Enter' && ready && !busy) save(); }} /></label>
        </div>
        <div className="set-line stacked">
          <div className="set-label"><strong>Roles</strong><span>What {info.name} may handle for the workspace</span></div>
          <div className="conn-roles-pick">
            {rolesFor(provider).map((r) => (
              <label key={r} className="conn-role"><input type="checkbox" checked={roles.includes(r)} onChange={() => toggle(r)} />{ROLE_LABEL[r]}</label>
            ))}
          </div>
        </div>
        {note && <p className={note.ok ? 'set-ok' : 'set-error'}>{note.text}</p>}
        <div className="modal-actions">
          <button className="pill with-icon" disabled={!draft.secret || busy !== null || (needsBaseUrl(provider) && !draft.baseUrl)} onClick={test}><IconReset width={15} height={15} />{busy === 'test' ? 'Testing…' : 'Test'}</button>
          <span className="modal-actions-end">
            <button className="pill" onClick={() => onDone(false)}>Cancel</button>
            <button className="pill primary" disabled={!ready || busy !== null} onClick={save}>{busy === 'save' ? 'Saving…' : existing ? 'Replace key' : 'Add'}</button>
          </span>
        </div>
      </div>
    </div>
  );
}
