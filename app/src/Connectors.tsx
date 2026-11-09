import { useEffect, useState } from 'react';
import type { ConnectorId, ConnectorRole, ModelSourceStatus, Providers, Settings } from './quorum';
import { Row, useMenu } from './controls';
import { BY_ID, CATALOG, ROLES, ROLE_LABEL, canServe, modelName, needsBaseUrl, needsKey, rolesFor, type ConnectorManifest } from '../connectors/catalog';
import { MODELS } from './Composer';
import { IconChat, IconCheck, IconCode, IconExternal, IconGrid, IconMic, IconMore, IconNotes, IconPerson, IconPlus, IconReset, IconTrash, ProviderMark, Wave } from './icons';

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

// the add flow's order and wording; Apple needs no adding and is the speech default
const ADD_ORDER: ConnectorId[] = ['claude-code', 'anthropic', 'openai', 'google', 'ollama', 'openai_compatible', 'assemblyai', 'deepgram', 'elevenlabs'];
const ADD_LABEL: Partial<Record<ConnectorId, string>> = { 'claude-code': 'Claude Code sign-in', anthropic: 'Anthropic API key', google: 'Google Gemini', ollama: 'Ollama local model', openai_compatible: 'OpenAI-compatible endpoint' };
const ADD_NOTE: Partial<Record<ConnectorId, string>> = {
  'claude-code': 'Your own claude.ai sign-in on this Mac; the only provider that reads your Agent OS',
  anthropic: 'A key from console.anthropic.com, kept in your Keychain',
  openai: 'A key from platform.openai.com; models, speech and voice',
  google: 'A key from aistudio.google.com; models and speech',
  ollama: 'A model running at localhost:11434, nothing leaves this Mac',
  openai_compatible: 'Any chat-completions server: a base URL, a model name and a key',
  assemblyai: 'Speech to text', deepgram: 'Speech to text', elevenlabs: 'Speech to text and voice',
};

// a provider is connected when its key is saved or, for the two without a key, when it was added or a role points at it
const isAdded = (st: ModelSourceStatus, id: ConnectorId) => !!st.connectors[id] || Object.values(st.providers).includes(id);
export const connectedIds = (st: ModelSourceStatus): ConnectorId[] => CATALOG.filter((p) => p.id !== 'apple' && (needsKey(p.id) ? !!st.keys[p.id] : isAdded(st, p.id))).map((p) => p.id);
const effectiveOf = (st: ModelSourceStatus | null, role: ConnectorRole): ConnectorId | '' => st?.providers[role] ?? (role === 'speech' ? 'apple' : '');
const claudeReady = (st: ModelSourceStatus | null) => !!st?.claude?.installed && !!st?.claude?.loggedIn;

// Settings › Connectors, personal edition (docs/open-source-strategy.md: bring your own key). One list of the AI
// providers the user added; each key is proven with one read-only request, kept in the Keychain, and comes back only as
// "set". Below the list, which provider handles each step, among the connected ones
export function PersonalConnectors() {
  const [st, setSt] = useState<ModelSourceStatus | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [sheet, setSheet] = useState<{ id: ConnectorId | null } | null>(null);
  const [note, setNote] = useState<{ id: ConnectorId; ok: boolean; text: string } | null>(null);
  const refresh = () => Promise.all([window.quorum.modelSourceStatus(), window.quorum.getSettings()]).then(([s, g]) => { setSt(s); setSettings(g); });
  useEffect(() => { refresh(); }, []);
  const rows = st ? connectedIds(st) : [];
  const effective = (role: ConnectorRole) => effectiveOf(st, role);
  const defaults = (id: ConnectorId) => ROLES.filter((r) => effective(r.id) === id).map((r) => r.id);
  const setDefault = async (id: ConnectorId) => { await window.quorum.setSettings({ providers: Object.fromEntries(rolesFor(id).map((r) => [r, id])) as Providers }); refresh(); };
  const remove = async (id: ConnectorId) => {
    setNote(null);
    if (needsKey(id)) await window.quorum.connectorKeyRemove(id);
    else await window.quorum.setSettings({ connectors: { [id]: null } as Settings['connectors'], providers: Object.fromEntries(defaults(id).map((r) => [r, null])) as Providers });
    refresh();
  };
  const test = async (id: ConnectorId) => {
    setNote(null);
    if (id === 'claude-code') { await refresh(); setNote({ id, ok: claudeReady(st), text: claudeReady(st) ? 'Claude Code is signed in.' : 'Claude Code is not signed in.' }); return; }
    const r = await window.quorum.connectorKeyTest(id);
    setNote({ id, ok: !r.error, text: r.error ?? `${BY_ID[id].name} answered.` });
  };
  const setRole = async (role: ConnectorRole, id: string) => { await window.quorum.setSettings({ providers: { [role]: (id || null) as ConnectorId } }); refresh(); };
  const options = (role: ConnectorRole) => CATALOG.filter((p) => canServe(p.id, role) && (rows.includes(p.id) || p.id === 'apple' || effective(role) === p.id));
  const speech = effective('speech');
  return (
    <>
      <div className="set-head">
        <h3>AI providers</h3>
        {rows.length > 0 && <span className="set-head-actions"><button className="pill small-pill with-icon" onClick={() => setSheet({ id: null })}><IconPlus width={15} height={15} />Add</button></span>}
      </div>
      {st && !rows.length ? (
        <div className="set-card set-zero">
          <span className="set-zero-icon"><IconGrid width={22} height={22} /></span>
          <strong>No AI provider yet</strong>
          <p>Add your Claude Code sign-in, an API key or a local model. Every provider is your own; Quorum has no key of its own.</p>
          <button className="pill primary" onClick={() => setSheet({ id: null })}>Add AI provider</button>
        </div>
      ) : (
        <div className="set-card">
          {rows.map((id) => (
            <ProviderRow key={id} p={BY_ID[id]} st={st!} settings={settings} defaults={defaults(id)} note={note?.id === id ? note : null}
              onDefault={() => setDefault(id)} onTest={() => test(id)} onEdit={() => { setNote(null); setSheet({ id }); }} onRemove={() => remove(id)} />
          ))}
        </div>
      )}

      {rows.length > 0 && (
        <>
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
      {sheet && <ProviderSheet id={sheet.id} st={st} settings={settings} onPick={(id) => setSheet({ id })} onRefresh={refresh} onDone={(changed) => { setSheet(null); if (changed) refresh(); }} />}
    </>
  );
}

// one connected provider: mark, name, the Default pill, and the subtext (sign-in or key, the model it runs); ••• menu with
// Set as default, Test, Edit, Remove
function ProviderRow({ p, st, settings, defaults, note, onDefault, onTest, onEdit, onRemove }: {
  p: ConnectorManifest; st: ModelSourceStatus; settings: Settings | null; defaults: ConnectorRole[]; note: { ok: boolean; text: string } | null;
  onDefault: () => void; onTest: () => void; onEdit: () => void; onRemove: () => void;
}) {
  const [more, setMore] = useMenu();
  const c = st.claude;
  const alias = settings?.model ?? 'sonnet';
  const aliasLabel = MODELS.find((m) => m.id === alias)?.label ?? alias;
  const full = defaults.length === rolesFor(p.id).length;
  const sub = p.id === 'claude-code' ? (!c ? 'Checking…' : !c.installed ? 'Not installed' : !c.loggedIn ? 'Signed out · Sign in to use it' : ['AI usage', c.email, c.org, c.plan && `${c.plan[0].toUpperCase()}${c.plan.slice(1)} plan`, aliasLabel].filter(Boolean).join(' · '))
    : p.id === 'anthropic' ? `API key in Keychain · ${aliasLabel}`
    : p.id === 'ollama' ? `localhost:11434 · ${st.localModel}${!st.ollama.reachable ? ' · not running' : st.ollama.hasModel ? '' : ' · not pulled'}`
    : p.id === 'openai_compatible' ? [host(st.connectors.openai_compatible?.baseUrl), modelName(p.id, alias, st.localModel, st.connectors)].filter(Boolean).join(' · ')
    : p.models ? `API key in Keychain · ${modelName(p.id, alias, st.localModel, st.connectors)}`
    : 'API key in Keychain';
  const editLabel = p.id === 'claude-code' || p.id === 'ollama' ? 'Edit model' : p.id === 'anthropic' ? 'Edit key or model' : p.id === 'openai_compatible' ? 'Edit key or endpoint' : 'Edit key';
  return (
    <>
      <Row icon={<Mark id={p.id} />} title={<>{p.name}{p.id === 'claude-code' && c?.version && <em className="muted ver">v{c.version}</em>}{defaults.length > 0 && <em className="stub">{full ? 'Default' : `Default for ${defaults.map((r) => ROLE_LABEL[r]).join(', ')}`}</em>}</>} desc={sub}>
        {p.id === 'claude-code' && c && !c.loggedIn && (c.installed
          ? <button className="pill" onClick={() => window.quorum.claudeLogin()}>Sign in</button>
          : <button className="pill" onClick={onTest}>Check again</button>)}
        <span className="menu-wrap" onClick={(e) => e.stopPropagation()}>
          <button className="icon-btn" aria-label={`${p.name} options`} aria-haspopup="menu" aria-expanded={more} data-tip="More options" onClick={() => setMore((o) => !o)}><IconMore /></button>
          {more && (
            <div className="menu end" role="menu">
              <button role="menuitem" disabled={full} onClick={() => { setMore(false); onDefault(); }}><IconCheck width={15} height={15} /> {full ? 'Default' : 'Set as default'}</button>
              <button role="menuitem" onClick={() => { setMore(false); onTest(); }}><IconReset width={15} height={15} /> {p.id === 'claude-code' ? 'Check again' : 'Test'}</button>
              <button role="menuitem" onClick={() => { setMore(false); onEdit(); }}><IconCode width={15} height={15} /> {editLabel}</button>
              {p.id === 'claude-code' && <button role="menuitem" onClick={() => { setMore(false); window.quorum.claudeLogin(); }}><IconPerson width={15} height={15} /> {c?.loggedIn ? 'Switch account' : 'Sign in'}</button>}
              <button role="menuitem" onClick={() => { setMore(false); window.quorum.openExternal(p.docs); }}><IconExternal width={15} height={15} /> Docs</button>
              <div className="menu-sep" />
              <button role="menuitem" className="danger" onClick={() => { setMore(false); onRemove(); }}><IconTrash width={15} height={15} /> Remove</button>
            </div>
          )}
        </span>
      </Row>
      {note && <div className="row-extra conn-extra"><p className={note.ok ? 'set-ok' : 'set-error'}>{note.ok && <IconCheck width={14} height={14} className="ok" />} {note.text}</p></div>}
    </>
  );
}

const host = (url?: string) => { try { return url ? new URL(url).host : ''; } catch { return url ?? ''; } };

// the add flow: pick a provider from the catalog, then its fields; Edit opens the fields for a connected provider. Save
// proves a pasted key with the catalog's read-only request before keeping it; Test runs the same request without saving
function ProviderSheet({ id, st, settings, onPick, onRefresh, onDone }: {
  id: ConnectorId | null; st: ModelSourceStatus | null; settings: Settings | null; onPick: (id: ConnectorId) => void; onRefresh: () => Promise<void>; onDone: (changed: boolean) => void;
}) {
  const scrim = (body: React.ReactNode, title: string) => (
    <div className="palette-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onDone(false); }}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onDone(false); } }}>
      <div className="modal conn-sheet" role="dialog" aria-modal="true" aria-labelledby="conn-title"><h2 id="conn-title">{title}</h2>{body}</div>
    </div>
  );
  if (!id) {
    const taken = st ? connectedIds(st) : [];
    return scrim(
      <>
        <p>Every provider is your own. A key stays in your Mac's Keychain and goes only to the provider you gave it to.</p>
        <div className="conn-pick" role="list">
          {ADD_ORDER.filter((x) => !taken.includes(x)).map((x) => (
            <button key={x} type="button" role="listitem" className="onb-choice pick conn-pick-item" onClick={() => onPick(x)}>
              <Mark id={x} /><div><strong>{ADD_LABEL[x] ?? BY_ID[x].name}</strong><em>{ADD_NOTE[x]}</em></div><RolePills roles={rolesFor(x)} />
            </button>
          ))}
        </div>
        <div className="modal-actions"><span /><span className="modal-actions-end"><button className="pill" onClick={() => onDone(false)}>Cancel</button></span></div>
      </>,
      'Add a provider',
    );
  }
  const p = BY_ID[id];
  const existing = !!st && connectedIds(st).includes(id);
  return scrim(<ProviderFields p={p} st={st} settings={settings} existing={existing} onRefresh={onRefresh} onDone={onDone} />, `${existing ? 'Edit' : 'Add'} ${p.name}`);
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
  const claudeOk = claudeReady(st);
  const urlOk = !url || /^https?:\/\/\S+$/.test(baseUrl.trim());
  const ready = p.id === 'claude-code' ? claudeOk
    : p.id === 'ollama' ? !!model.trim()
    : urlOk && (!!secret.trim() || existing) && (!url || !!model.trim());
  const canTest = p.id === 'claude-code' || (p.id === 'ollama') || (urlOk && (!!secret.trim() || existing));
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
    if (!key) await window.quorum.setSettings({ connectors: { [p.id]: {} } });
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
