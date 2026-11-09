import { useEffect, useState } from 'react';
import type { ConnectorId, ConnectorRole, ModelSourceStatus, Providers, Settings } from './quorum';
import { Row, useMenu } from './controls';
import { BY_ID, CATALOG, MODEL_ROLES, ROLES, ROLE_LABEL, canServe, modelName, needsBaseUrl, needsKey, rolesFor, type ConnectorManifest } from '../connectors/catalog';
import { MODELS } from './Composer';
import { IconChat, IconCheck, IconCode, IconExternal, IconGrid, IconMic, IconMore, IconNotes, IconPerson, IconPlus, IconReset, IconTrash, ProviderMark, Wave } from './icons';

// the provider's mark: the logos icons.tsx has, the first letter for the rest
export function Mark({ id }: { id: ConnectorId }) {
  if (id === 'anthropic' || id === 'claude-code') return <ProviderMark provider="anthropic" />;
  if (id === 'openai' || id === 'google') return <ProviderMark provider={id} />;
  if (id === 'ollama') return <IconCode width={18} height={18} />;
  if (id === 'apple') return <IconMic width={18} height={18} />;
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

// the add flow: the catalog in three groups, each provider once; Apple needs no adding and is always present
const GROUPS: { label: string; ids: ConnectorId[] }[] = [
  { label: 'Language models', ids: ['claude-code', 'anthropic', 'openai', 'google', 'ollama', 'openai_compatible'] },
  { label: 'Speech to text', ids: ['assemblyai', 'deepgram'] },
  { label: 'Voice', ids: ['elevenlabs'] },
];
const ADD_LABEL: Partial<Record<ConnectorId, string>> = { 'claude-code': 'Claude Code sign-in', anthropic: 'Anthropic API key', google: 'Google Gemini', ollama: 'Ollama local model', openai_compatible: 'OpenAI-compatible endpoint' };
const ADD_NOTE: Partial<Record<ConnectorId, string>> = {
  'claude-code': 'Your own claude.ai sign-in on this Mac; the only provider that reads your Agent OS',
  anthropic: 'A key from console.anthropic.com, kept in your Keychain',
  openai: 'A key from platform.openai.com; models, speech and voice',
  google: 'A key from aistudio.google.com; models and speech',
  ollama: 'A model running at localhost:11434, nothing leaves this Mac',
  openai_compatible: 'Any chat-completions server: a base URL, a model name and a key',
  assemblyai: 'Speech to text', deepgram: 'Speech to text', elevenlabs: 'Voice, and speech to text',
};

// connected: a key saved, Claude Code signed in, Ollama running, and Apple always, on this Mac
const claudeReady = (st: ModelSourceStatus | null) => !!st?.claude?.installed && !!st?.claude?.loggedIn;
export const isConnected = (st: ModelSourceStatus, id: ConnectorId) => id === 'apple' ? true : id === 'claude-code' ? claudeReady(st) : id === 'ollama' ? st.ollama.reachable : !!st.keys[id];
export const connectedIds = (st: ModelSourceStatus): ConnectorId[] => CATALOG.filter((p) => isConnected(st, p.id)).map((p) => p.id);
const effectiveOf = (st: ModelSourceStatus | null, role: ConnectorRole): ConnectorId | '' => st?.providers[role] ?? (role === 'speech' ? 'apple' : '');

// Settings › Connectors, personal edition (docs/open-source-strategy.md: bring your own key). One list of the connected
// providers; each key is proven with one read-only request, kept in the Keychain, and comes back only as "set". Below
// the list, which connected provider handles each step
export function PersonalConnectors() {
  const [st, setSt] = useState<ModelSourceStatus | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [sheet, setSheet] = useState<{ kind: 'add'; id: ConnectorId | null } | { kind: 'default'; id: ConnectorId } | null>(null);
  const [note, setNote] = useState<{ id: ConnectorId; ok: boolean; text: string } | null>(null);
  const refresh = () => Promise.all([window.quorum.modelSourceStatus(), window.quorum.getSettings()]).then(([s, g]) => { setSt(s); setSettings(g); });
  useEffect(() => { refresh(); }, []);
  const rows = st ? connectedIds(st) : [];
  // the zero state: nothing beyond Apple can run a model step
  const zero = !!st && !rows.some((id) => MODEL_ROLES.some((r) => canServe(id, r)));
  const effective = (role: ConnectorRole) => effectiveOf(st, role);
  const defaults = (id: ConnectorId) => ROLES.filter((r) => effective(r.id) === id).map((r) => r.id);
  const remove = async (id: ConnectorId) => { setNote(null); await window.quorum.connectorKeyRemove(id); refresh(); };
  const test = async (id: ConnectorId) => {
    setNote(null);
    if (id === 'claude-code') { const s = await window.quorum.modelSourceStatus(); setSt(s); setNote({ id, ok: claudeReady(s), text: claudeReady(s) ? `Claude Code is signed in as ${s.claude?.email}.` : 'Claude Code is not signed in.' }); return; }
    const r = await window.quorum.connectorKeyTest(id);
    setNote({ id, ok: !r.error, text: r.error ?? `${BY_ID[id].name} answered.` });
  };
  const setRole = async (role: ConnectorRole, id: string) => { await window.quorum.setSettings({ providers: { [role]: (id || null) as ConnectorId } }); refresh(); };
  const options = (role: ConnectorRole) => CATALOG.filter((p) => canServe(p.id, role) && (rows.includes(p.id) || effective(role) === p.id));
  const speech = effective('speech');
  return (
    <>
      <div className="set-head">
        <h3>AI providers</h3>
        {st && !zero && <span className="set-head-actions"><button className="pill small-pill with-icon" onClick={() => setSheet({ kind: 'add', id: null })}><IconPlus width={15} height={15} />Add</button></span>}
      </div>
      {!st ? null : zero ? (
        <div className="set-card set-zero">
          <span className="set-zero-icon"><IconGrid width={22} height={22} /></span>
          <strong>No AI provider yet</strong>
          <p>Quorum has no key of its own. Connect the AI you already use.</p>
          <button className="pill primary" onClick={() => setSheet({ kind: 'add', id: null })}>Add AI provider</button>
        </div>
      ) : (
        <>
          <div className="set-card">
            {rows.map((id) => (
              <ProviderRow key={id} p={BY_ID[id]} st={st} settings={settings} defaults={defaults(id)} note={note?.id === id ? note : null}
                onDefault={() => setSheet({ kind: 'default', id })} onTest={() => test(id)} onEdit={() => { setNote(null); setSheet({ kind: 'add', id }); }} onRemove={() => remove(id)} />
            ))}
          </div>

          <h3>Which provider handles each step</h3>
          <p className="mcp-lede">Each step runs on one of your connected providers.</p>
          <div className="set-card even">
            {ROLES.map((r) => (
              <Row key={r.id} icon={ROLE_ICON[r.id]()} title={ROLE_LABEL[r.id]} desc={ROLE_DESC[r.id]}>
                <select className="set-select" aria-label={ROLE_LABEL[r.id]} value={effective(r.id)} onChange={(e) => setRole(r.id, e.target.value)}>
                  {r.id !== 'speech' && <option value="">{r.id === 'voice' ? 'Off' : 'Not set'}</option>}
                  {options(r.id).map((p) => <option key={p.id} value={p.id}>{p.name}{p.id === 'apple' ? ' on this Mac' : rows.includes(p.id) ? '' : ' (not connected)'}</option>)}
                </select>
              </Row>
            ))}
          </div>
          {speech !== 'apple' && <p className="set-note">Cloud speech engines arrive with the speech provider interface. Until then Apple transcribes every meeting on this Mac.</p>}
        </>
      )}
      {sheet?.kind === 'add' && <ProviderSheet id={sheet.id} st={st} settings={settings} onPick={(id) => setSheet({ kind: 'add', id })} onRefresh={refresh} onDone={(changed) => { setSheet(null); if (changed) refresh(); }} />}
      {sheet?.kind === 'default' && <DefaultSheet p={BY_ID[sheet.id]} st={st} onDone={(changed) => { setSheet(null); if (changed) refresh(); }} />}
    </>
  );
}

const plan = (p?: string) => (p ? `${p[0].toUpperCase()}${p.slice(1)} plan` : '');
const host = (url?: string) => { try { return url ? new URL(url).host : ''; } catch { return url ?? ''; } };

// one connected provider: mark, name, the Default pill, and the grey subtext (the model it runs, where the credential
// is); ••• menu with Set as default, Test, Edit, Docs, Remove. Apple, Claude Code and Ollama have nothing to remove
function ProviderRow({ p, st, settings, defaults, note, onDefault, onTest, onEdit, onRemove }: {
  p: ConnectorManifest; st: ModelSourceStatus; settings: Settings | null; defaults: ConnectorRole[]; note: { ok: boolean; text: string } | null;
  onDefault: () => void; onTest: () => void; onEdit: () => void; onRemove: () => void;
}) {
  const [more, setMore] = useMenu();
  const c = st.claude;
  const alias = settings?.model ?? 'sonnet';
  const aliasLabel = MODELS.find((m) => m.id === alias)?.label ?? alias;
  const sub = p.id === 'apple' ? 'Speech to text on this Mac · no account needed'
    : p.id === 'claude-code' ? ['AI usage', c?.email, c?.org, plan(c?.plan), aliasLabel].filter(Boolean).join(' · ')
    : p.id === 'anthropic' ? `${aliasLabel} · key in Keychain`
    : p.id === 'ollama' ? `${st.localModel}${st.ollama.hasModel ? '' : ' (not pulled)'} · localhost:11434`
    : p.id === 'openai_compatible' ? [modelName(p.id, alias, st.localModel, st.connectors), host(st.connectors.openai_compatible?.baseUrl), 'key in Keychain'].filter(Boolean).join(' · ')
    : p.models ? `${modelName(p.id, alias, st.localModel, st.connectors)} · key in Keychain`
    : `${rolesFor(p.id).map((r) => ROLE_LABEL[r]).join(', ')} · key in Keychain`;
  const editLabel = p.id === 'claude-code' || p.id === 'ollama' ? 'Edit model' : p.id === 'anthropic' ? 'Edit key or model' : p.id === 'openai_compatible' ? 'Edit key or endpoint' : 'Edit key';
  return (
    <>
      <Row icon={<Mark id={p.id} />} title={<>{p.name}{p.id === 'claude-code' && c?.version && <em className="muted ver">v{c.version}</em>}{defaults.length > 0 && <em className="stub">Default for {defaults.map((r) => ROLE_LABEL[r]).join(', ')}</em>}</>} desc={sub}>
        <span className="menu-wrap" onClick={(e) => e.stopPropagation()}>
          <button className="icon-btn" aria-label={`${p.name} options`} aria-haspopup="menu" aria-expanded={more} data-tip="More options" onClick={() => setMore((o) => !o)}><IconMore /></button>
          {more && (
            <div className="menu end" role="menu">
              <button role="menuitem" onClick={() => { setMore(false); onDefault(); }}><IconCheck width={15} height={15} /> Set as default</button>
              {p.id !== 'apple' && <button role="menuitem" onClick={() => { setMore(false); onTest(); }}><IconReset width={15} height={15} /> {p.id === 'claude-code' ? 'Check again' : 'Test'}</button>}
              {p.id !== 'apple' && <button role="menuitem" onClick={() => { setMore(false); onEdit(); }}><IconCode width={15} height={15} /> {editLabel}</button>}
              {p.id === 'claude-code' && <button role="menuitem" onClick={() => { setMore(false); window.quorum.claudeLogin(); }}><IconPerson width={15} height={15} /> Switch account</button>}
              <button role="menuitem" onClick={() => { setMore(false); window.quorum.openExternal(p.docs); }}><IconExternal width={15} height={15} /> Docs</button>
              {needsKey(p.id) && <><div className="menu-sep" /><button role="menuitem" className="danger" onClick={() => { setMore(false); onRemove(); }}><IconTrash width={15} height={15} /> Remove</button></>}
            </div>
          )}
        </span>
      </Row>
      {note && <div className="row-extra conn-extra"><p className={note.ok ? 'set-ok' : 'set-error'}>{note.ok && <IconCheck width={14} height={14} className="ok" />} {note.text}</p></div>}
    </>
  );
}

function Scrim({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="palette-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
      <div className="modal conn-sheet" role="dialog" aria-modal="true" aria-labelledby="conn-title"><h2 id="conn-title">{title}</h2>{children}</div>
    </div>
  );
}

// Set as default: the steps this provider can run, checked where it already is the default
function DefaultSheet({ p, st, onDone }: { p: ConnectorManifest; st: ModelSourceStatus | null; onDone: (changed: boolean) => void }) {
  const roles = rolesFor(p.id);
  const [picked, setPicked] = useState<ConnectorRole[]>(roles.filter((r) => effectiveOf(st, r) === p.id));
  const toggle = (r: ConnectorRole) => setPicked((cur) => (cur.includes(r) ? cur.filter((x) => x !== r) : [...cur, r]));
  const save = async () => {
    // a step this provider gives up falls back: Apple for speech, otherwise unset until another provider is picked
    const patch = Object.fromEntries(roles.map((r) => [r, picked.includes(r) ? p.id : effectiveOf(st, r) === p.id ? null : effectiveOf(st, r) || null])) as Providers;
    await window.quorum.setSettings({ providers: patch });
    onDone(true);
  };
  return (
    <Scrim title={`${p.name} as the default`} onClose={() => onDone(false)}>
      <p>Pick the steps {p.name} should handle. Each step runs on one provider.</p>
      <div className="conn-roles-pick">
        {roles.map((r) => <label key={r} className="conn-role"><input type="checkbox" checked={picked.includes(r)} onChange={() => toggle(r)} />{ROLE_LABEL[r]}<span className="muted"> · {ROLE_DESC[r]}</span></label>)}
      </div>
      <div className="modal-actions">
        <span />
        <span className="modal-actions-end">
          <button className="pill" onClick={() => onDone(false)}>Cancel</button>
          <button className="pill primary" onClick={save}>Save</button>
        </span>
      </div>
    </Scrim>
  );
}

// the add flow: a provider from the catalog, grouped, then its fields; Edit opens the fields for a connected provider.
// Save proves a pasted key with the catalog's read-only request before keeping it; Test runs the same request without saving
function ProviderSheet({ id, st, settings, onPick, onRefresh, onDone }: {
  id: ConnectorId | null; st: ModelSourceStatus | null; settings: Settings | null; onPick: (id: ConnectorId) => void; onRefresh: () => Promise<void>; onDone: (changed: boolean) => void;
}) {
  if (!id) {
    const taken = st ? connectedIds(st) : [];
    return (
      <Scrim title="Add AI provider" onClose={() => onDone(false)}>
        <p>Every provider is your own. A key stays in your Mac's Keychain and goes only to the provider you gave it to.</p>
        <div className="conn-pick">
          {GROUPS.map((g) => {
            const ids = g.ids.filter((x) => !taken.includes(x));
            if (!ids.length) return null;
            return (
              <div key={g.label} role="list" aria-label={g.label}>
                <p className="menu-label conn-group">{g.label}</p>
                {ids.map((x) => (
                  <button key={x} type="button" role="listitem" className="onb-choice pick conn-pick-item" onClick={() => onPick(x)}>
                    <Mark id={x} /><div><strong>{ADD_LABEL[x] ?? BY_ID[x].name}</strong><em>{ADD_NOTE[x]}</em></div><RolePills roles={rolesFor(x)} />
                  </button>
                ))}
              </div>
            );
          })}
        </div>
        <div className="modal-actions"><span /><span className="modal-actions-end"><button className="pill" onClick={() => onDone(false)}>Cancel</button></span></div>
      </Scrim>
    );
  }
  const p = BY_ID[id];
  const existing = !!st && isConnected(st, id);
  return <Scrim title={`${existing ? 'Edit' : 'Add'} ${p.name}`} onClose={() => onDone(false)}><ProviderFields p={p} st={st} settings={settings} existing={existing} onRefresh={onRefresh} onDone={onDone} /></Scrim>;
}

function ProviderFields({ p, st, settings, existing, onRefresh, onDone }: { p: ConnectorManifest; st: ModelSourceStatus | null; settings: Settings | null; existing: boolean; onRefresh: () => Promise<void>; onDone: (changed: boolean) => void }) {
  const saved = st?.connectors[p.id] ?? {};
  const key = needsKey(p.id);
  const url = needsBaseUrl(p.id);
  const claudeModel = p.id === 'claude-code' || p.id === 'anthropic';
  const [secret, setSecret] = useState('');
  const [baseUrl, setBaseUrl] = useState(saved.baseUrl ?? '');
  const [model, setModel] = useState(p.id === 'ollama' ? st?.localModel ?? '' : saved.model ?? '');
  const [alias, setAlias] = useState<Settings['model']>(settings?.model ?? 'sonnet');
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const c = st?.claude;
  const urlOk = !url || /^https?:\/\/\S+$/.test(baseUrl.trim());
  const ready = p.id === 'claude-code' ? claudeReady(st)
    : p.id === 'ollama' ? !!model.trim()
    : urlOk && (!!secret.trim() || existing) && (!url || !!model.trim());
  const canTest = p.id === 'ollama' || (urlOk && (!!secret.trim() || existing));
  const test = async () => {
    setBusy('test'); setMsg(null);
    if (p.id === 'claude-code') { await onRefresh(); setBusy(null); return; }
    const r = await window.quorum.connectorKeyTest(p.id, secret.trim() || undefined, url ? baseUrl.trim() : undefined);
    setBusy(null);
    setMsg(r.error ? { ok: false, text: r.error } : { ok: true, text: p.id === 'ollama' ? 'Ollama answered.' : `${p.name} accepted the key.` });
  };
  const save = async () => {
    setBusy('save'); setMsg(null);
    if (key && secret.trim()) {
      const r = await window.quorum.connectorKeySet(p.id, secret.trim(), url ? baseUrl.trim() : undefined);
      if (r.error) { setBusy(null); setMsg({ ok: false, text: r.error }); return; }
    }
    if (url) await window.quorum.setSettings({ connectors: { [p.id]: { baseUrl: baseUrl.trim(), model: model.trim() } } });
    if (p.id === 'ollama') await window.quorum.localModelSet(model.trim());
    if (claudeModel && alias !== settings?.model) await window.quorum.setSettings({ model: alias });
    // a new provider takes the steps nobody handles yet; Apple keeps speech until the user says otherwise
    if (!existing) {
      const open = rolesFor(p.id).filter((r) => r !== 'speech' && !effectiveOf(st, r));
      if (open.length) await window.quorum.setSettings({ providers: Object.fromEntries(open.map((r) => [r, p.id])) as Providers });
    }
    setBusy(null);
    onDone(true);
  };
  return (
    <>
      <p>{ADD_NOTE[p.id]}{existing && key ? ' Leave the key blank to keep the one saved.' : ''}</p>
      {p.id === 'claude-code' && (
        <div className="set-line">
          <div className="set-label"><strong>Sign-in</strong><span>{!c ? 'Checking…' : !c.installed ? 'Claude Code is not installed on this Mac' : !c.loggedIn ? 'Signed out' : `Signed in as ${c.email}`}</span></div>
          {c && !c.loggedIn && c.installed && <button className="pill" onClick={() => window.quorum.claudeLogin()}>Sign in</button>}
          {c?.loggedIn && <IconCheck width={18} height={18} className="ok" />}
        </div>
      )}
      {p.id === 'ollama' && st && !st.ollama.reachable && <p className="set-note conn-note">Ollama is not running at localhost:11434. Start it and the row appears here.</p>}
      {url && (
        <div className="set-line">
          <div className="set-label"><strong>Base URL</strong><span>The chat-completions endpoint, up to /v1</span></div>
          <label className="set-field wide"><input aria-label="Base URL" placeholder="https://llm.example.com/v1" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} /></label>
        </div>
      )}
      {(url || p.id === 'ollama') && (
        <div className="set-line">
          <div className="set-label"><strong>Model</strong><span>{p.id === 'ollama' ? 'An Ollama tag, such as llama3.1 or qwen2.5:7b' : 'The model name the server expects'}</span></div>
          <label className="set-field wide"><input aria-label="Model name" placeholder={p.id === 'ollama' ? 'llama3.1' : 'Model name'} value={model} onChange={(e) => setModel(e.target.value)} /></label>
        </div>
      )}
      {key && (
        <div className="set-line">
          <div className="set-label"><strong>{p.keyHint}</strong></div>
          <label className="set-field wide"><input type="password" autoFocus aria-label={p.keyHint} placeholder={existing ? 'Saved in Keychain' : p.placeholder} value={secret} onChange={(e) => { setSecret(e.target.value); setMsg(null); }} onKeyDown={(e) => { if (e.key === 'Enter' && ready && !busy) save(); }} /></label>
        </div>
      )}
      {claudeModel && (
        <div className="set-line">
          <div className="set-label"><strong>Model</strong><span>Which Claude answers</span></div>
          <select className="set-select" aria-label="Claude model" value={alias} onChange={(e) => setAlias(e.target.value as Settings['model'])}>
            {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}{m.note ? ` · ${m.note}` : ''}</option>)}
          </select>
        </div>
      )}
      {p.models && !claudeModel && <p className="set-note conn-note">Runs {p.models.sonnet}; the running summary uses {p.models.haiku}.</p>}
      {msg && <p className={msg.ok ? 'set-ok' : 'set-error'}>{msg.text}</p>}
      <div className="modal-actions">
        <span>
          {p.test && <button className="pill with-icon" disabled={!canTest || busy !== null} onClick={test}><IconReset width={15} height={15} />{busy === 'test' ? 'Testing…' : 'Test'}</button>}
          {p.id === 'claude-code' && <button className="pill with-icon" disabled={busy !== null} onClick={test}><IconReset width={15} height={15} />Check again</button>}
          <button className="link-btn" onClick={() => window.quorum.openExternal(p.docs)}>Docs</button>
          {p.pricing && <button className="link-btn" onClick={() => window.quorum.openExternal(p.pricing!)}>Pricing</button>}
        </span>
        <span className="modal-actions-end">
          <button className="pill" onClick={() => onDone(false)}>Cancel</button>
          <button className="pill primary" disabled={!ready || busy !== null} onClick={save}>{busy === 'save' ? 'Checking…' : existing ? 'Save' : 'Add'}</button>
        </span>
      </div>
    </>
  );
}
