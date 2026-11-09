import { useEffect, useState } from 'react';
import type { ConnectorId, ConnectorRole, ModelSourceStatus } from './quorum';
import { Row, useMenu } from './controls';
import { BY_ID, CATALOG, ROLES, ROLE_LABEL, canServe, needsBaseUrl, needsKey, type ConnectorManifest } from '../connectors/catalog';
import { IconChat, IconCheck, IconCode, IconExternal, IconMic, IconMore, IconNotes, IconPerson, IconReset, IconTrash, ProviderMark, Wave } from './icons';

// the provider's mark: the logos icons.tsx has, the first letter for the rest
export function Mark({ id }: { id: ConnectorId }) {
  if (id === 'anthropic' || id === 'claude-code') return <ProviderMark provider="anthropic" />;
  if (id === 'openai' || id === 'google') return <ProviderMark provider={id} />;
  if (id === 'ollama') return <IconCode width={18} height={18} />;
  return <span className="conn-mark">{BY_ID[id].name[0]}</span>;
}

export const RolePills = ({ roles }: { roles: ConnectorRole[] }) => <span className="conn-roles">{roles.map((r) => <em key={r} className="stub">{ROLE_LABEL[r]}</em>)}</span>;

const ROLE_ICON: Record<ConnectorRole, () => React.ReactElement> = {
  speech: () => <IconMic width={18} height={18} />,
  summary: () => <Wave live={false} />,
  notes: () => <IconNotes width={18} height={18} />,
  agent: () => <IconChat width={18} height={18} />,
  voice: () => <IconPerson width={18} height={18} />,
};
const ROLE_DESC: Record<ConnectorRole, string> = {
  speech: 'Turns call audio into the transcript',
  summary: 'Folds new turns into the running summary during a call',
  notes: 'Writes the saved note when a call ends',
  agent: 'Answers your questions; only Claude Code can read your Agent OS',
  voice: 'Reads notes and answers aloud',
};

// Settings › Connectors, personal edition (docs/open-source-strategy.md: bring your own key). One row per provider in
// connectors/catalog.js: a key is proven with one read-only request, kept in the Keychain, and comes back only as
// "set". Below the list, which provider handles each step; the free defaults are Apple on this Mac for speech and the
// Claude Code sign-in for the model roles
export function PersonalConnectors() {
  const [st, setSt] = useState<ModelSourceStatus | null>(null);
  const [open, setOpen] = useState<ConnectorId | null>(null);
  const [note, setNote] = useState<{ id: ConnectorId; ok: boolean; text: string } | null>(null);
  const refresh = () => window.quorum.modelSourceStatus().then(setSt);
  useEffect(() => { refresh(); }, []);
  const claude = st?.claude ?? null;
  const claudeOk = !!claude?.installed && !!claude?.loggedIn;
  const connected = (id: ConnectorId) => id === 'apple' ? true : id === 'claude-code' ? claudeOk : id === 'ollama' ? !!st?.ollama.reachable : !!st?.keys[id];
  const effective = (role: ConnectorRole): ConnectorId | '' => st?.providers[role] ?? (role === 'speech' ? 'apple' : '');
  const defaults = (id: ConnectorId) => ROLES.filter((r) => effective(r.id) === id).map((r) => ROLE_LABEL[r.id]);
  const status = (p: ConnectorManifest) => {
    const d = defaults(p.id);
    const base = p.id === 'apple' ? 'On this Mac, no account needed'
      : p.id === 'claude-code' ? (!claude ? 'Checking…' : !claude.installed ? 'Not installed' : !claude.loggedIn ? 'Signed out' : `Signed in as ${claude.email}`)
      : p.id === 'ollama' ? (!st ? '' : !st.ollama.reachable ? 'Not running at localhost:11434' : st.ollama.hasModel ? `Running · ${st.localModel}` : `Running · ${st.localModel} not pulled`)
      : connected(p.id) ? 'Connected' : 'Not connected';
    return d.length ? `${base} · Default for ${d.join(', ')}` : base;
  };
  const test = async (id: ConnectorId) => {
    setNote(null);
    const r = await window.quorum.connectorKeyTest(id);
    setNote({ id, ok: !r.error, text: r.error ?? `${BY_ID[id].name} answered.` });
  };
  const remove = async (id: ConnectorId) => { setNote(null); await window.quorum.connectorKeyRemove(id); refresh(); };
  const setRole = async (role: ConnectorRole, id: string) => { await window.quorum.setSettings({ providers: { [role]: (id || null) as ConnectorId } }); refresh(); };
  // who may take a role: connected providers that can do it, the free defaults, and the current pick even when it is not connected
  const options = (role: ConnectorRole) => CATALOG.filter((p) => canServe(p.id, role) && (connected(p.id) || p.id === 'apple' || (p.id === 'claude-code' && claudeOk) || effective(role) === p.id));
  const speech = effective('speech');
  return (
    <>
      <div className="set-head"><h3>Providers</h3></div>
      <p className="mcp-lede">Every provider is your own. A key stays in your Mac's Keychain and goes only to the provider you gave it to; Quorum has no key of its own.</p>
      <div className="set-card">
        {CATALOG.map((p) => (
          <ConnectorRow key={p.id} p={p} st={st} connected={connected(p.id)} status={status(p)} open={open === p.id} note={note?.id === p.id ? note : null}
            onOpen={() => { setNote(null); setOpen(p.id); }} onClose={() => setOpen(null)} onTest={() => test(p.id)} onRemove={() => remove(p.id)}
            onSaved={(text) => { setOpen(null); setNote({ id: p.id, ok: true, text }); refresh(); }} onRefresh={refresh} />
        ))}
      </div>

      <h3>Which provider handles each step</h3>
      <p className="mcp-lede">Each step runs on one provider. Only connected providers that can do the step are listed.</p>
      <div className="set-card even">
        {ROLES.map((r) => {
          const list = options(r.id);
          const value = effective(r.id);
          return (
            <Row key={r.id} icon={ROLE_ICON[r.id]()} title={ROLE_LABEL[r.id]} desc={ROLE_DESC[r.id]}>
              <select className="set-select" aria-label={ROLE_LABEL[r.id]} value={value} disabled={!st} onChange={(e) => setRole(r.id, e.target.value)}>
                {r.id !== 'speech' && <option value="">{r.id === 'voice' ? 'Off' : 'Not set'}</option>}
                {list.map((p) => <option key={p.id} value={p.id}>{p.name}{p.id === 'apple' ? ' on this Mac' : p.id === 'claude-code' ? ' sign-in' : connected(p.id) ? '' : ' (not connected)'}</option>)}
              </select>
            </Row>
          );
        })}
      </div>
      {speech !== 'apple' && <p className="set-note">Cloud speech engines arrive with the speech provider interface. Until then Apple transcribes every meeting on this Mac.</p>}
    </>
  );
}

function ConnectorRow({ p, st, connected, status, open, note, onOpen, onClose, onTest, onRemove, onSaved, onRefresh }: {
  p: ConnectorManifest; st: ModelSourceStatus | null; connected: boolean; status: string; open: boolean; note: { ok: boolean; text: string } | null;
  onOpen: () => void; onClose: () => void; onTest: () => void; onRemove: () => void; onSaved: (text: string) => void; onRefresh: () => void;
}) {
  const [more, setMore] = useMenu();
  const key = needsKey(p.id);
  const claude = st?.claude;
  return (
    <>
      <Row icon={<Mark id={p.id} />} title={<>{p.name}{connected && <span className="conn-ok"><i />Connected</span>}</>} desc={<><RolePills roles={p.roles} /><span className="muted"> · {status}</span></>}>
        {p.id === 'claude-code' && claude && !claude.loggedIn && (claude.installed
          ? <button className="pill" onClick={() => window.quorum.claudeLogin()}>Sign in</button>
          : <button className="pill" onClick={onRefresh}>Check again</button>)}
        {p.id === 'ollama' && (
          <>
            <label className="set-field"><input key={st?.localModel ?? ''} defaultValue={st?.localModel ?? ''} aria-label="Ollama model name" placeholder="llama3.1"
              onBlur={async (e) => { await window.quorum.localModelSet(e.target.value); onRefresh(); }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} /></label>
            <button className="pill" onClick={onTest}>Test</button>
          </>
        )}
        {key && !connected && !open && <button className="pill" onClick={onOpen}>Add key</button>}
        {key && connected && (
          <>
            <button className="pill" onClick={onTest}>Test</button>
            <span className="menu-wrap" onClick={(e) => e.stopPropagation()}>
              <button className="icon-btn" aria-label={`${p.name} options`} aria-haspopup="menu" aria-expanded={more} onClick={() => setMore((o) => !o)}><IconMore /></button>
              {more && (
                <div className="menu end" role="menu">
                  <button role="menuitem" onClick={() => { setMore(false); onOpen(); }}><IconReset width={15} height={15} /> Replace key</button>
                  <button role="menuitem" onClick={() => { setMore(false); window.quorum.openExternal(p.docs); }}><IconExternal width={15} height={15} /> Docs</button>
                  {p.pricing && <button role="menuitem" onClick={() => { setMore(false); window.quorum.openExternal(p.pricing!); }}><IconExternal width={15} height={15} /> Pricing</button>}
                  <div className="menu-sep" />
                  <button role="menuitem" className="danger" onClick={() => { setMore(false); onRemove(); }}><IconTrash width={15} height={15} /> Remove</button>
                </div>
              )}
            </span>
          </>
        )}
      </Row>
      {(open || note) && (
        <div className="row-extra conn-extra">
          {open && <KeyForm p={p} st={st} onDone={onClose} onSaved={onSaved} />}
          {note && !open && <p className={note.ok ? 'set-ok' : 'set-error'}>{note.ok && <IconCheck width={14} height={14} className="ok" />} {note.text}</p>}
        </div>
      )}
    </>
  );
}

// the key, and for a compatible server its base URL and model name. Save proves the key with the catalog's read-only
// request before keeping it; Test runs the same request without saving
function KeyForm({ p, st, onDone, onSaved }: { p: ConnectorManifest; st: ModelSourceStatus | null; onDone: () => void; onSaved: (text: string) => void }) {
  const saved = st?.connectors[p.id] ?? {};
  const [key, setKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(saved.baseUrl ?? '');
  const [model, setModel] = useState(saved.model ?? '');
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [error, setError] = useState('');
  const url = needsBaseUrl(p.id);
  const ready = !!key.trim() && (!url || /^https?:\/\/\S+$/.test(baseUrl.trim()));
  const test = async () => {
    setBusy('test'); setError('');
    const r = await window.quorum.connectorKeyTest(p.id, key, url ? baseUrl : undefined);
    setBusy(null);
    setError(r.error ?? `${p.name} accepted the key.`);
  };
  const save = async () => {
    setBusy('save'); setError('');
    const r = await window.quorum.connectorKeySet(p.id, key, url ? baseUrl.trim() : undefined);
    if (r.error) { setBusy(null); setError(r.error); return; }
    if (url) await window.quorum.setSettings({ connectors: { [p.id]: { model: model.trim() } } });
    setBusy(null);
    onSaved(`${p.name} accepted the key. It is saved in your Keychain.`);
  };
  return (
    <div className="conn-form">
      {url && (
        <>
          <label className="set-field wide"><input aria-label="Base URL" placeholder="https://llm.example.com/v1" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} /></label>
          <label className="set-field wide"><input aria-label="Model name" placeholder="Model name the server expects" value={model} onChange={(e) => setModel(e.target.value)} /></label>
        </>
      )}
      <label className="set-field wide"><input type="password" autoFocus aria-label={p.keyHint} placeholder={p.placeholder} value={key} onChange={(e) => { setKey(e.target.value); setError(''); }} onKeyDown={(e) => { if (e.key === 'Enter' && ready && !busy) save(); }} /></label>
      <div className="conn-form-actions">
        <button className="pill" disabled={!ready || busy !== null} onClick={test}>{busy === 'test' ? 'Testing…' : 'Test'}</button>
        <button className="pill primary" disabled={!ready || busy !== null} onClick={save}>{busy === 'save' ? 'Checking…' : 'Save'}</button>
        <button className="pill ghost" onClick={onDone}>Cancel</button>
        <span className="conn-links">
          <button className="link-btn" onClick={() => window.quorum.openExternal(p.docs)}>Docs</button>
          {p.pricing && <button className="link-btn" onClick={() => window.quorum.openExternal(p.pricing!)}>Pricing</button>}
        </span>
      </div>
      {error && <p className={/accepted/.test(error) ? 'set-ok' : 'set-error'}>{error}</p>}
      <p className="set-note conn-note">One read-only request proves the key. It goes to {p.name} and nowhere else.</p>
    </div>
  );
}
