import { useEffect, useState, type ReactNode } from 'react';
import type { AccountState, ConnectorPolicyInfo, IntegrationConfig, IntegrationDraft, IntegrationMode, Member, WorkspaceIntegration } from '../../src/quorum';
import { Row, Toggle } from '../../src/controls';
import { IconGrid, IconPlus, IconTrash } from '../../src/icons';
import { connectorsFor, type LibraryConnector } from '../../connectors/library';
import { POLICY_CHANGED, workspaceStateOf } from '../../connectors/approval';
import { OAUTH_APPS } from '../../connectors/oauthApps';
import { ELIGIBLE_IDS, checkScope, cleanIntegrationDraft, keepsSecret } from '../integrationDraft';
import { EE_MARKER } from './Account';

// Settings > Admin > Workspace > Connectors, the library part (migration 0030): each connector Quorum can reach, with
// its workspace state (Off, Org, Personal). Enabling one opens a form with two identity modes. Org: one shared identity
// the organization provisions, with an API key or client secret that goes to the server vault and never comes back.
// Personal: each member signs in with their own account through the personal OAuth flow. Once saved, a connector opens
// in a read view with edit, on/off and remove. The "approved connectors only" switch for members sits on top.

const LIBRARY = connectorsFor({ meetingCapture: false }).filter((x) => ELIGIBLE_IDS.includes(x.id));
const STATE_LABEL = { off: 'Off', org: 'Org', personal: 'Personal' } as const;
const QUORUM_MCP = 'quorum mcp';

const authOf = (x: LibraryConnector, mode: IntegrationMode, cfg: IntegrationConfig | null): string => {
  if (mode === 'org') return cfg?.auth === 'oauth_client' ? 'OAuth client (organization)' : 'API key';
  if (x.kind === 'mcp-source') return `OAuth, over ${x.name}'s MCP server`;
  if (x.kind === 'meeting-app') return `OAuth, through Quorum Cloud`;
  return 'OAuth, through Quorum\'s registered app';
};
const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;
const nameOf = (members: Member[], id: string | null) => {
  if (!id) return 'Not set';
  const m = members.find((x) => x.userId === id);
  return m ? m.name || m.email : 'A former member';
};

export function WorkspaceIntegrations({ account, onDetail }: { account: AccountState; onDetail?: (open: boolean) => void }) {
  const ws = account.workspace!;
  const canManage = ws.role !== 'member';
  const [rows, setRows] = useState<WorkspaceIntegration[] | null>(null);
  const [policy, setPolicy] = useState<ConnectorPolicyInfo | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [icons, setIcons] = useState<Record<string, string | null>>({});
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [form, setForm] = useState<{ connector: LibraryConnector; row: WorkspaceIntegration | null } | null>(null);
  // every change here can change what members see, so Connections reloads its policy
  const changed = () => { window.dispatchEvent(new Event(POLICY_CHANGED)); load(); };
  const load = async () => {
    const r = await window.quorum.integrationsAdmin();
    if (r.error) { setError(r.error); return; }
    setRows(r.integrations ?? []); setPolicy(r.policy ?? null);
  };
  useEffect(() => {
    if (!canManage) return;
    load();
    window.quorum.libraryIcons().then(setIcons).catch(() => {});
    window.quorum.membersList().then((r) => { if ('members' in r) setMembers(r.members); }).catch(() => {});
  }, [ws.id, canManage]);
  const detailOpen = !!open && !!rows?.some((r) => r.provider === open);
  useEffect(() => { onDetail?.(detailOpen); }, [detailOpen, onDetail]);
  if (!canManage) return null;
  const setApprovedOnly = async (on: boolean) => {
    setError('');
    const r = await window.quorum.approvedOnlySet(on);
    if (r.error) setError(r.error); else changed();
  };
  const toggle = async (row: WorkspaceIntegration, on: boolean) => {
    setError('');
    const r = await window.quorum.integrationEnable(row.id, on);
    if (r.error) setError(r.error); else changed();
  };
  const remove = async (row: WorkspaceIntegration) => {
    setError('');
    const r = await window.quorum.integrationRemove(row.id);
    if (r.error) setError(r.error); else { setOpen(null); changed(); }
  };
  const sheet = form && <IntegrationForm connector={form.connector} row={form.row} members={members} onDone={(saved) => { setForm(null); if (saved) { changed(); setOpen(form.connector.id); } }} />;
  const openConnector = open ? LIBRARY.find((x) => x.id === open) : null;
  const openRow = open ? rows?.find((r) => r.provider === open) ?? null : null;
  if (openConnector && openRow) {
    return (
      <div data-ee={EE_MARKER}>
        <IntegrationView connector={openConnector} row={openRow} icon={icons[openConnector.id] ?? null} members={members}
          onBack={() => setOpen(null)} onEdit={() => setForm({ connector: openConnector, row: openRow })} onToggle={(on) => toggle(openRow, on)} onRemove={() => remove(openRow)} />
        {error && <p className="set-error">{error}</p>}
        {sheet}
      </div>
    );
  }
  return (
    <div data-ee={EE_MARKER}>
      <div className="set-head"><h3>Workspace connectors</h3></div>
      <p className="mcp-lede">Approve the tools your organization uses. Each one runs as a shared org identity you provision, or as each member's own account.</p>
      <div className="set-card">
        <Row icon={<IconGrid width={18} height={18} />} title="Members may only use approved connectors"
          desc={policy?.teamEnabled ? 'Members see only the connectors enabled below. Anything a member already connected stays until they disconnect it.' : 'Applies once a team is enabled on this workspace. Until then every member sees the full library.'}>
          <Toggle on={policy?.approvedConnectorsOnly !== false} disabled={!policy} onChange={setApprovedOnly} />
        </Row>
      </div>
      <div className="set-card">
        {LIBRARY.map((x) => {
          const { state, row } = workspaceStateOf(x.id, rows);
          const desc = !row ? x.description : !row.enabled ? `Turned off · ${STATE_LABEL[row.mode]} identity` : row.mode === 'org' ? `Shared org identity · ${row.secretSet ? 'secret set' : 'no secret'}` : `Each member's own account · ${plural(row.connections, 'connection')}`;
          return (
            <Row key={x.id} icon={<Logo icon={icons[x.id] ?? null} />} title={<>{x.name}<em className={`stub${state === 'off' ? '' : ' new'}`}>{STATE_LABEL[state]}</em></>} desc={desc}>
              {row ? <button className="pill small-pill" onClick={() => setOpen(x.id)}>Open</button>
                : <button className="pill small-pill with-icon" disabled={!rows} onClick={() => setForm({ connector: x, row: null })}><IconPlus width={15} height={15} />Enable</button>}
            </Row>
          );
        })}
      </div>
      {error && <p className="set-error">{error}</p>}
      <p className="set-note">Secrets are stored in the server vault and never returned to this app. Members do not see org secrets.</p>
      {sheet}
    </div>
  );
}

function Logo({ icon, size = 28 }: { icon: string | null; size?: number }) {
  return icon ? <img className="conn-logo" src={icon} alt="" style={{ width: size, height: size }} /> : <span className="conn-logo blank" style={{ width: size, height: size }}><IconGrid width={14} height={14} /></span>;
}

// the read view of one enabled connector: what it is, who it acts as, how many are connected, with edit, on/off, remove
function IntegrationView({ connector: x, row, icon, members, onBack, onEdit, onToggle, onRemove }: { connector: LibraryConnector; row: WorkspaceIntegration; icon: string | null; members: Member[]; onBack: () => void; onEdit: () => void; onToggle: (on: boolean) => void; onRemove: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const org = row.mode === 'org';
  const rows: [string, ReactNode][] = org ? [
    ['Identity', 'Org (shared)'],
    ['Acts as', 'The organization, with one shared identity'],
    ['Connections', row.connections ? '1 active' : 'None yet'],
    ['Accountable owner', nameOf(members, row.config.ownerId)],
    ['Auth method', authOf(x, 'org', row.config)],
    ...(row.config.auth === 'oauth_client' && row.config.clientId ? [['Client id', <code>{row.config.clientId}</code>] as [string, ReactNode]] : []),
    ['Secret', row.secretSet ? `Set${row.secretLast4 ? `, ending in ${row.secretLast4}` : ''}` : 'Not set'],
    ['Scopes', row.config.customScopes && row.config.scopes.length ? <code>{row.config.scopes.join(' ')}</code> : 'The provider\'s defaults'],
    ...(row.config.domain ? [['Domain', row.config.domain] as [string, ReactNode]] : []),
  ] : [
    ['Identity', 'Personal'],
    ['Acts as', 'Each member, with their own account'],
    ['Connections', row.connections ? `${row.connections} active` : 'None yet'],
    ['Accountable owner', nameOf(members, row.config.ownerId)],
    ['Auth method', authOf(x, 'personal', null)],
    ['Access', OAUTH_APPS[x.id]?.scopeNote ?? 'Set by the provider\'s consent screen'],
    ['Quorum MCP endpoint', <span><code>{QUORUM_MCP}</code> on each member's Mac</span>],
  ];
  return (
    <div className="conn-detail">
      <p className="wsi-crumbs"><button className="link-btn plain" onClick={onBack}>Workspace connectors</button> / {x.name}</p>
      <div className="conn-detail-head">
        <Logo icon={icon} size={44} />
        <div className="conn-detail-title">
          <h3>{x.name}<em className={`stub${row.enabled ? ' new' : ''}`}>{row.enabled ? 'On' : 'Off'}</em></h3>
          <p>Updated {new Date(row.updatedAt).toLocaleDateString()}</p>
        </div>
        <span className="wsi-head-actions"><Toggle on={row.enabled} onChange={onToggle} /></span>
      </div>
      <h4>{org ? 'Shared org identity' : 'Personal accounts'}</h4>
      <div className="set-card conn-table">
        <p className="wsi-lede">{org
          ? `${x.name} runs as one identity your organization provisions. Quorum uses it on the organization's behalf; members never see or authorize it.`
          : `Each member links their own ${x.name} account the first time they connect it in Settings, Connections. Quorum acts as that member, with only the access they granted.`}</p>
        {rows.map(([k, v]) => <div key={k} className="conn-kv"><span>{k}</span><span>{v}</span></div>)}
      </div>
      <div className="modal-actions wsi-actions">
        <button className="pill with-icon danger" onClick={() => (confirm ? onRemove() : setConfirm(true))}><IconTrash width={15} height={15} />{confirm ? 'Remove for everyone' : 'Remove'}</button>
        <button className="pill primary" onClick={onEdit}>Edit</button>
      </div>
      {confirm && <p className="set-note">Removing deletes the stored secret and the connector's settings. Members who connected their own account keep it on their Mac.</p>}
    </div>
  );
}

// the form: two identity modes. Org takes an API key or OAuth client secret (write-only), an accountable owner, custom
// scopes. Personal shows how members connect. Checks run here (integrationDraft.js) and again on save
export function IntegrationForm({ connector: x, row, members, onDone }: { connector: LibraryConnector; row: WorkspaceIntegration | null; members: Member[]; onDone: (saved: boolean) => void }) {
  const [mode, setMode] = useState<IntegrationMode>(row?.mode ?? 'personal');
  const [auth, setAuth] = useState<IntegrationConfig['auth']>(row?.config.auth ?? 'api_key');
  const [clientId, setClientId] = useState(row?.config.clientId ?? '');
  const [secret, setSecret] = useState('');
  const [ownerId, setOwnerId] = useState(row?.config.ownerId ?? '');
  const [customScopes, setCustomScopes] = useState(row?.config.customScopes ?? false);
  const [scopes, setScopes] = useState<string[]>(row?.config.scopes ?? []);
  const [scopeText, setScopeText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  // the secret travels only with org mode
  const draft: IntegrationDraft = { provider: x.id, mode, ...(mode === 'org' && secret ? { secret } : {}), config: { auth, clientId, ownerId: ownerId || null, customScopes, scopes } };
  const check = cleanIntegrationDraft(draft, row);
  const stored = row?.mode === 'org' && row.secretSet;
  // a blank field keeps the stored secret only under the auth method it was saved for
  const keeps = keepsSecret(row, auth);
  const addScope = () => {
    const r = checkScope(scopeText);
    if (r.error) { setNote(r.error); return; }
    setNote(''); if (!scopes.includes(r.scope!)) setScopes([...scopes, r.scope!]); setScopeText('');
  };
  const save = async () => {
    if ('error' in check) { setNote(check.error); return; }
    setBusy(true); setNote('');
    const r = await window.quorum.integrationSave(draft);
    setBusy(false);
    if (r.error) setNote(r.error); else onDone(true);
  };
  const secretLabel = auth === 'oauth_client' ? 'Client secret' : 'API key';
  return (
    <div className="palette-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onDone(false); }}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onDone(false); } }}>
      <div className="modal conn-sheet wsi-form" role="dialog" aria-modal="true" aria-labelledby="wsi-title">
        <h2 id="wsi-title">{row ? `Edit ${x.name}` : `Enable ${x.name}`}</h2>
        <div className="wsi-modes" role="radiogroup" aria-label="Identity">
          <label className={`wsi-mode${mode === 'org' ? ' on' : ''}`}><input type="radio" name="wsi-mode" checked={mode === 'org'} onChange={() => setMode('org')} />
            <strong>Org shared identity</strong><span>One identity your organization provisions. Quorum uses it on the organization's behalf; members never see or authorize it.</span></label>
          <label className={`wsi-mode${mode === 'personal' ? ' on' : ''}`}><input type="radio" name="wsi-mode" checked={mode === 'personal'} onChange={() => { setMode('personal'); setSecret(''); }} />
            <strong>Personal</strong><span>Each member authorizes their own {x.name} account. Quorum acts as that member, with only the access they granted.</span></label>
        </div>
        {mode === 'org' ? <>
          <div className="set-line">
            <div className="set-label"><strong>Auth method</strong></div>
            <select className="set-select" aria-label="Auth method" value={auth} onChange={(e) => setAuth(e.target.value as IntegrationConfig['auth'])}>
              <option value="api_key">API key</option>
              <option value="oauth_client">OAuth client</option>
            </select>
          </div>
          {auth === 'oauth_client' && (
            <div className="set-line">
              <div className="set-label"><strong>Client id</strong><span>Your organization's OAuth app</span></div>
              <label className="set-field wide"><input aria-label="Client id" value={clientId} onChange={(e) => setClientId(e.target.value)} /></label>
            </div>
          )}
          <div className="set-line stacked">
            <div className="set-label"><strong>{secretLabel}</strong><span>Stored in the server vault and never returned to this app.</span></div>
            <label className="set-field wide"><input type="password" autoComplete="off" aria-label={secretLabel} placeholder={keeps ? `•••••••• ${row?.secretLast4 ?? ''}`.trim() : `Paste the ${secretLabel.toLowerCase()}`} value={secret} onChange={(e) => { setSecret(e.target.value); setNote(''); }} /></label>
            {keeps && <span className="muted wsi-hint">Saved. Enter a new value to replace it, or leave it blank to keep it.</span>}
            {stored && !keeps && <span className="muted wsi-hint">The stored secret belongs to the other auth method. Paste a new one to switch.</span>}
          </div>
        </> : (
          <div className="set-card conn-table wsi-personal">
            <div className="conn-kv"><span>Auth method</span><span>{authOf(x, 'personal', null)}</span></div>
            <div className="conn-kv"><span>Connections</span><span>{row?.mode === 'personal' ? `${row.connections} active` : 'None yet'}</span></div>
            <div className="conn-kv"><span>Quorum MCP endpoint</span><span><code>{QUORUM_MCP}</code> on each member's Mac</span></div>
            {stored && <p className="muted wsi-hint">Switching to personal deletes the stored org secret.</p>}
          </div>
        )}
        <div className="set-line">
          <div className="set-label"><strong>Accountable owner</strong><span>The member who answers for this connector</span></div>
          <select className="set-select" aria-label="Accountable owner" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
            <option value="">No one yet</option>
            {members.map((m) => <option key={m.userId} value={m.userId}>{m.name || m.email}</option>)}
          </select>
        </div>
        <div className="set-line stacked">
          <div className="wsi-switch-line">
            <div className="set-label"><strong>Custom scopes</strong><span>Ask {x.name} for these scopes instead of Quorum's defaults</span></div>
            <Toggle on={customScopes} onChange={setCustomScopes} />
          </div>
          {customScopes && <>
            {scopes.length > 0 && <div className="wsi-chips">{scopes.map((s) => <button key={s} className="wsi-chip" aria-label={`Remove ${s}`} onClick={() => setScopes(scopes.filter((y) => y !== s))}><code>{s}</code> ×</button>)}</div>}
            <div className="wsi-scope-add">
              <label className="set-field wide"><input aria-label="Add a scope" placeholder="Add a scope (for example chat:write)" value={scopeText} onChange={(e) => setScopeText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addScope(); } }} /></label>
              <button className="icon-btn" aria-label="Add scope" onClick={addScope}><IconPlus width={15} height={15} /></button>
            </div>
          </>}
        </div>
        {note && <p className="set-error">{note}</p>}
        <div className="modal-actions">
          <span />
          <span className="modal-actions-end">
            <button className="pill" onClick={() => onDone(false)}>Cancel</button>
            <button className="pill primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : row ? 'Save' : 'Enable'}</button>
          </span>
        </div>
      </div>
    </div>
  );
}
