import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AccountState, Brain, MeetingSourceInfo, OnboardingChecks, OnboardingStatus } from './quorum';
import { ConnectHint } from './ConnectHint';
import { McpPaths, useMcpOverlap } from './McpPaths';
import { CONNECTORS, mcpPathsOf } from '../connectors/library';
import { IconCalendar, IconCheck, IconFolder, IconFolderOpen, IconLock, IconMic, IconPerson, IconQuorum, IconShield, ProviderMark } from './icons';
import { isCloud } from './edition';
import { useNotetaker } from './flags';
import { detectProvider, KEY_NAMES, KEY_PROVIDERS, SOURCE_NAMES, type KeyProvider } from './modelSource';
import { SetupForm, answersFrom, draftFrom, draftIsEmpty, emptyDraft, type SetupDraft } from './SetupForm';
import mark from '../assets/quorum-mark.png';

type Step = 'welcome' | 'agentos' | 'you' | 'model' | 'account' | 'permissions' | 'done';
const ORDER: Step[] = ['welcome', 'agentos', 'you', 'model', 'account', 'permissions', 'done'];
type Status = (OnboardingStatus & Partial<OnboardingChecks>) | null;
const home = (p: string) => p.replace(/^\/Users\/[^/]+/, '~');

// first run on a fresh install: a short wizard in place of the main window until settings.onboarded is set. Every step
// keeps Continue off until the step is done; the optional steps (model, account) offer a quieter Skip for now instead
export function Onboarding({ brain, onBrain, accountSlot, onDone }: { brain: Brain | null; onBrain: (b: Brain | null) => void; accountSlot?: ReactNode; onDone: () => void }) {
  const [step, setStep] = useState<Step>('welcome');
  const [status, setStatus] = useState<Status>(null);
  const nt = useNotetaker();
  // Use Quorum's models was picked: the account step is then required, since the relay needs a signed-in Cloud account
  const [managed, setManaged] = useState(false);
  // the fast part first, then permissions and Claude Code, which can take a few seconds; resolves when both are in
  const refresh = () => window.quorum.onboardingStatus().then(async (s) => {
    setStatus((prev) => ({ ...prev, ...s }));
    const c = await window.quorum.onboardingChecks();
    setStatus((prev) => ({ ...(prev ?? s), ...c }));
  });
  // permissions alone, cheap enough to poll; one in flight at a time
  const inflight = useRef(false);
  const refreshPermissions = async () => {
    if (inflight.current) return;
    inflight.current = true;
    try { const c = await window.quorum.onboardingPermissions(); setStatus((prev) => (prev ? { ...prev, ...c } : prev)); } catch {} finally { inflight.current = false; }
  };
  useEffect(() => { refresh(); }, [step]);
  const i = ORDER.indexOf(step);
  const next = () => setStep(ORDER[Math.min(i + 1, ORDER.length - 1)]);
  const back = () => setStep(ORDER[Math.max(i - 1, 0)]);
  return (
    <div className="onb">
      <div className="onb-card">
        <div className="onb-progress" aria-hidden="true">{ORDER.map((s, n) => <i key={s} className={n <= i ? 'on' : ''} />)}</div>
        {step === 'welcome' && (
          <section className="onb-step">
            <img className="onb-mark" src={mark} alt="" />
            <h1>Welcome to Quorum</h1>
            <p>Meetings and your notes, on your Mac. Quorum transcribes calls on this device, keeps notes as plain markdown, and answers questions from them with a model you choose. Nothing leaves this Mac unless you turn sync on.</p>
            <div className="onb-actions"><span /><button className="pill primary" autoFocus onClick={next}>Get started</button></div>
          </section>
        )}
        {step === 'agentos' && <AgentOsStep brain={brain} status={status} onBrain={onBrain} onBack={back} onNext={next} />}
        {step === 'you' && <NameStep onBack={back} onNext={next} />}
        {step === 'model' && <ModelStep status={status} onRefresh={refresh} onBack={back} onNext={next} onManaged={setManaged} />}
        {step === 'account' && <AccountStep slot={accountSlot} required={managed} onBack={back} onNext={next} />}
        {step === 'permissions' && <PermissionsStep status={status} onRefresh={refresh} onPoll={refreshPermissions} onBack={back} onNext={next} />}
        {step === 'done' && (
          <section className="onb-step">
            <h1>You're set</h1>
            <ul className="onb-summary">
              <li><IconFolder width={16} height={16} /> {brain ? `Agent OS at ${home(brain.root)}` : 'No Agent OS yet (connect one in Settings)'}</li>
              <li><ProviderMark provider="anthropic" /> {managed ? "Model: Quorum's models (after you sign in)" : status?.model?.source && status.model.source !== 'none' ? `Model: ${SOURCE_NAMES[status.model.source]}` : 'No model source yet (choose one in Settings › Connectors)'}</li>
              {nt.manualListen && <li><IconMic width={16} height={16} /> {status?.permissions?.microphone === 'granted' ? 'Microphone allowed' : nt.meetingCapture ? 'Microphone: macOS will ask on your first call' : 'Microphone: macOS will ask the first time you start listening'}</li>}
              {nt.meetingCapture && <li><IconShield width={16} height={16} /> {status?.permissions?.accessibility === 'granted' ? 'Accessibility allowed' : 'Accessibility: needed to read the meeting chat'}</li>}
            </ul>
            <p>{nt.meetingCapture ? 'Quorum lives in the menu bar. When a Zoom, Google Meet or Teams call starts, it offers to listen.' : nt.manualListen ? 'Quorum lives in the menu bar. Start listening there or in the app to take a note of your own.' : 'Quorum lives in the menu bar.'}</p>
            <div className="onb-actions"><button className="pill ghost" onClick={back}>Back</button><button className="pill primary" autoFocus onClick={async () => { await window.quorum.onboardingDone(); onDone(); }}>Open Quorum</button></div>
          </section>
        )}
      </div>
    </div>
  );
}

// Back, Continue (off until `ready`), and for optional steps a Skip for now link; `extra` sits between them (Check again)
function Actions({ onBack, onNext, ready, onSkip, extra, busy }: { onBack: () => void; onNext: () => void; ready: boolean; onSkip?: () => void; extra?: ReactNode; busy?: boolean }) {
  return (
    <div className="onb-actions">
      <span className="onb-actions-start"><button className="pill ghost" onClick={onBack}>Back</button>{onSkip && !ready && <button className="link-btn onb-skip" onClick={onSkip}>Skip for now</button>}</span>
      <span className="onb-actions-end">{extra}<button className="pill primary" disabled={!ready || busy} onClick={onNext}>Continue</button></span>
    </div>
  );
}

// the first real step: the folder of markdown notes Quorum and Claude Code work in. Two choices, and the create form
// shows only once Create new is picked; meeting notes inside an existing folder are found by scanning it afterwards
function AgentOsStep({ brain, status, onBrain, onBack, onNext }: { brain: Brain | null; status: Status; onBrain: (b: Brain | null) => void; onBack: () => void; onNext: () => void }) {
  const [mode, setMode] = useState<'create' | null>(null);
  const [name, setName] = useState('My Agent OS');
  const [dir, setDir] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const where = dir ?? status?.defaultVaultDir ?? '~/Documents/Quorum';
  // the interview: prefilled once from what the person's own AI already knows (no model source, no prefill), skippable
  const [draft, setDraft] = useState<SetupDraft>(emptyDraft());
  const [suggest, setSuggest] = useState<'idle' | 'asking' | 'filled' | 'none'>('idle');
  useEffect(() => {
    if (mode !== 'create' || suggest !== 'idle') return;
    let live = true;
    setSuggest('asking');
    window.quorum.onboardingSetupSuggest().then((r) => {
      if (!live) return;
      if (r.suggestion) { setDraft((d) => (draftIsEmpty(d) ? draftFrom(r.suggestion) : d)); setSuggest('filled'); } else setSuggest('none');
    }).catch(() => { if (live) setSuggest('none'); });
    return () => { live = false; };
  }, [mode]);
  const create = async (shaped: boolean) => {
    setBusy(true); setError('');
    try { onBrain(await window.quorum.onboardingCreateVault(dir, name.trim() || 'My Agent OS', shaped ? answersFrom(draft) : null)); setMode(null); } catch (e) { setError(String((e as Error).message || e)); }
    setBusy(false);
  };
  const connect = async () => { const b = await window.quorum.connectBrain(); if (b) { onBrain(b); setMode(null); } };
  // meeting notes inside the connected folder: found by scanning it (badge), or a folder the user points at
  const [notes, setNotes] = useState<Awaited<ReturnType<typeof window.quorum.meetingsDir>> | undefined>(undefined);
  useEffect(() => { if (!brain) { setNotes(undefined); return; } let live = true; window.quorum.meetingsDir().then((r) => { if (live) setNotes(r); }).catch(() => { if (live) setNotes(null); }); return () => { live = false; }; }, [brain?.root]);
  const pickNotes = async () => { if (await window.quorum.pickMeetingsDir()) setNotes(await window.quorum.meetingsDir()); };
  // a notetaker connected through the library (Granola today); its notes import into this folder in the background
  const [granola, setGranola] = useState<MeetingSourceInfo | null>(null);
  const loadGranola = () => window.quorum.sourcesList().then((l) => setGranola(l.find((s) => s.id === 'granola') ?? null)).catch(() => setGranola(null));
  useEffect(() => { if (brain) loadGranola(); }, [brain?.root]);
  // guardrails found in the folder: the count, for one line here; the review itself is on Settings, Guardrails
  const [guardCount, setGuardCount] = useState(0);
  useEffect(() => { if (!brain) { setGuardCount(0); return; } window.quorum.guardrailsGet().then((g) => setGuardCount(g?.summary?.toReview ?? 0)).catch(() => {}); }, [brain?.root]);
  const [connecting, setConnecting] = useState(false);
  const connectGranola = async () => {
    setConnecting(true); setError('');
    const r = await window.quorum.sourceConnect('granola');
    if (r.error) setError(r.error); else { await loadGranola(); setNotes(await window.quorum.meetingsDir().catch(() => null)); }
    setConnecting(false);
  };
  // the provider MCP servers the agent already has, shown before any import runs: Granola first, then the others
  const { overlap } = useMcpOverlap({ key: brain?.root ?? '' });
  const overlapping = brain && overlap ? CONNECTORS.filter((x) => x.status === 'available' && mcpPathsOf(x) && overlap.matches[x.id]?.length).sort((a, b) => Number(!!mcpPathsOf(b)?.ingest) - Number(!!mcpPathsOf(a)?.ingest)) : [];
  const foundText = notes ? [...notes.sources.map((x) => `${x.count} ${x.name} ${x.count === 1 ? 'note' : 'notes'}`), ...(notes.notes ? [`${notes.notes} Quorum ${notes.notes === 1 ? 'note' : 'notes'}`] : [])].join(' · ') || 'Quorum saves new meeting notes here' : '';
  return (
    <section className="onb-step">
      <h1>Connect your Agent OS</h1>
      <p>Your Agent OS is a folder of markdown notes that Quorum and your AI read and write. Connect one you already have (an Obsidian vault or a repo with CLAUDE.md) and Quorum finds the meeting notes in it, or start a fresh one.</p>
      {brain ? (
        <div className="onb-choice on">
          <IconCheck width={18} height={18} className="ok" />
          <div><strong>{brain.name}</strong><em>{home(brain.root)}{guardCount ? ` · ${guardCount} ${guardCount === 1 ? 'guardrail' : 'guardrails'} found, review them in Settings, Guardrails` : ''}</em></div>
          <button className="pill" onClick={connect}>Change</button>
        </div>
      ) : (
        <div className="onb-split">
          <button type="button" className={`onb-tile ${mode === 'create' ? 'on' : ''}`} onClick={() => setMode('create')}>
            <IconFolder width={20} height={20} /><span><strong>Create new</strong><em>A starter folder with an index and instructions</em></span>
          </button>
          <button type="button" className="onb-tile" onClick={connect}>
            <IconFolderOpen width={20} height={20} /><span><strong>Connect existing</strong><em>Your notes stay where they are</em></span>
          </button>
        </div>
      )}
      {!brain && mode === 'create' && (
        <div className="onb-form">
          <label className="set-field wide onb-field"><span className="onb-label">Name</span><input value={name} aria-label="Name of your Agent OS" placeholder="My Agent OS" autoFocus onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') create(true); }} /></label>
          <div className="onb-row">
            <span className="onb-label">Location</span>
            <code className="onb-path" title={where}>{home(where)}</code>
            <button className="pill" onClick={async () => { const d = await window.quorum.onboardingPickDir(); if (d) setDir(d); }}>Choose…</button>
          </div>
          <div className="onb-or"><span>Shape it around you</span></div>
          <SetupForm draft={draft} onChange={setDraft} note={suggest === 'asking' ? 'Asking your AI what it already knows about you…' : suggest === 'filled' ? 'Prefilled from what your AI already knows about you. Edit anything.' : null} />
          <div className="onb-row end"><button className="link-btn onb-skip" disabled={busy} onClick={() => create(false)}>Skip the questions</button><button className="pill primary" disabled={busy} onClick={() => create(true)}>{busy ? 'Creating…' : 'Create folder'}</button></div>
        </div>
      )}
      {error && <p className="set-error">{error}</p>}
      {overlapping.length > 0 && (
        <>
          <div className="onb-or"><span>Already in your agent</span></div>
          {overlapping.map((x) => <McpPaths key={x.id} connector={x} servers={overlap?.matches[x.id]} open={!!mcpPathsOf(x)?.ingest} />)}
        </>
      )}
      {brain && notes !== undefined && (
        <>
          <div className="onb-or"><span>Meeting notes</span></div>
          {notes ? (
            <div className="onb-choice on">
              <IconCheck width={18} height={18} className="ok" />
              <div><strong>{notes.root}{!notes.chosen && <span className="onb-badge">Found in {brain.name}</span>}</strong><em>{foundText}</em></div>
              <button className="pill" onClick={pickNotes}>Change…</button>
            </div>
          ) : granola?.connected ? (
            <div className="onb-choice on">
              <IconCheck width={18} height={18} className="ok" />
              <div><strong>Granola connected{granola.account && <span className="onb-badge">{granola.account}</span>}</strong><em>{granola.imported ? `${granola.imported} ${granola.imported === 1 ? 'note' : 'notes'} imported into this folder` : 'Importing your notes into this folder in the background'}</em></div>
            </div>
          ) : (
            <ConnectHint connector="granola" title={<>Connect your meeting notes app <span className="onb-opt">optional</span></>} desc="Granola today, more notetakers soon. Their notes land in this folder beside the ones Quorum writes, each tagged with its source. Or point Quorum at a folder of notes you already have.">
              <button className="pill primary" disabled={connecting} onClick={connectGranola}>{connecting ? 'Finish in your browser…' : 'Connect Granola'}</button>
              <button className="pill" onClick={pickNotes}>Choose a folder…</button>
            </ConnectHint>
          )}
        </>
      )}
      <Actions onBack={onBack} onNext={onNext} ready={!!brain} />
    </section>
  );
}

// the name Quorum writes as the recorder in every note. Prefilled with the name the main process resolved (a saved
// settings.userName, else the macOS account's full name, else the login); Continue saves it only when it was changed
function NameStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const [name, setName] = useState('');
  const [resolved, setResolved] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { window.quorum.user().then((u) => { setResolved(u.name); setName((v) => v || u.name); }); }, []);
  const ready = name.trim().length > 0;
  const go = async () => {
    const v = name.trim();
    if (!v) return;
    if (v !== resolved) { setBusy(true); await window.quorum.setSettings({ userName: v, profile: { name: v } }); setBusy(false); }
    onNext();
  };
  return (
    <section className="onb-step">
      <h1>What should Quorum call you?</h1>
      <p>Quorum writes this as your name in meeting notes and transcripts. It comes from your Mac account; change it if you like.</p>
      <div className="onb-plain">
        <div className="onb-plain-head"><IconPerson width={18} height={18} /><strong>Your name</strong></div>
        <label className="set-field wide onb-field"><input value={name} aria-label="Your name" placeholder={resolved || 'Your name'} autoFocus onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && ready) go(); }} /></label>
      </div>
      <Actions onBack={onBack} onNext={go} ready={ready} busy={busy} />
    </section>
  );
}

// optional: the hosted account. Continue turns on once the account card reports a sign-in; Skip for now otherwise
function AccountStep({ slot, required, onBack, onNext }: { slot?: ReactNode; required: boolean; onBack: () => void; onNext: () => void }) {
  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => {
    let live = true;
    const apply = (s: AccountState) => { if (live) setSignedIn(!!s.signedIn); };
    window.quorum.accountStatus().then(apply).catch(() => {});
    const off = window.quorum.onAccount(apply);
    return () => { live = false; off(); };
  }, []);
  return (
    <section className="onb-step">
      <h1>Your account</h1>
      <p>{required ? "Quorum's models run on your Quorum Cloud account, so sign in here. Sync and a shared workspace come with it." : 'Optional. Sign in to sync notes and meetings and to share a workspace with your team. You can do this later in Settings.'}</p>
      <div className="onb-slot">{slot ?? <p className="onb-muted">Sign in from Settings › Workspace once you are in.</p>}</div>
      <Actions onBack={onBack} onNext={onNext} ready={signedIn} onSkip={required ? undefined : onNext} />
    </section>
  );
}

// how Quorum thinks: a sign-in Quorum rides on (Claude Code today), a key from any provider, or Quorum's own models
// with a Cloud account. One of them must be in place before the wizard moves on
type Pick = 'login' | 'key' | 'managed';
function ModelStep({ status, onRefresh, onBack, onNext, onManaged }: { status: Status; onRefresh: () => Promise<void>; onBack: () => void; onNext: () => void; onManaged: (on: boolean) => void }) {
  const c = status?.claude;
  const m = status?.model;
  const claudeOk = !!c?.installed && !!c?.loggedIn;
  const savedKey = KEY_PROVIDERS.find((id) => m?.keys?.[id]) ?? null;
  const [pick, setPick] = useState<Pick | null>(null);
  const [keying, setKeying] = useState(false);
  const [key, setKey] = useState('');
  const [forced, setForced] = useState<KeyProvider | null>(null);
  const [last4, setLast4] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setPick((p) => p ?? (savedKey && m?.source !== 'claude-code' ? 'key' : claudeOk ? 'login' : null)); }, [claudeOk, savedKey, m?.source]);
  const ready = pick === 'login' ? claudeOk : pick === 'key' ? !!savedKey : pick === 'managed' ? isCloud : false;
  const finish = async () => {
    if (!ready) return;
    if (pick === 'login') await window.quorum.modelSourceSet('claude-code');
    if (pick === 'key' && savedKey) await window.quorum.setSettings({ providers: { summary: savedKey, notes: savedKey, agent: savedKey } });
    await window.quorum.setSettings({ managedModels: pick === 'managed' });
    onManaged(pick === 'managed');
    onNext();
  };
  const detected = detectProvider(key);
  const provider = detected ?? forced;
  const saveKey = async () => {
    if (!provider || !key.trim()) return;
    setBusy(true); setError('');
    const r = await window.quorum.connectorKeySet(provider, key.trim());
    setBusy(false);
    if (r.error) { setError(r.error); return; }
    setLast4(key.trim().slice(-4)); setKey(''); setForced(null); setKeying(false);
    await onRefresh();
    setPick('key');
  };
  const removeKey = async () => { if (savedKey) { await window.quorum.connectorKeyRemove(savedKey); setLast4(''); await onRefresh(); if (pick === 'key') setPick(null); } };
  const disconnect = async () => { await window.quorum.modelSourceSet('none'); await onRefresh(); setPick(null); };
  const row = (id: Pick, selectable: boolean, icon: ReactNode, body: ReactNode, action: ReactNode, below?: ReactNode) => (
    <div className={`onb-choice ${selectable ? 'pick' : ''} ${pick === id ? 'on' : ''} ${below ? 'stack' : ''}`} role="radio" aria-checked={pick === id} tabIndex={selectable ? 0 : -1}
      onClick={() => { if (selectable) setPick(id); }} onKeyDown={(e) => { if (selectable && e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setPick(id); } }}>
      <div className="onb-choice-line">{icon}<div>{body}</div>{action}</div>
      {below}
    </div>
  );
  return (
    <section className="onb-step" role="radiogroup" aria-label="Model source">
      <h1>Where should Quorum's model run?</h1>
      <p>Quorum has no key of its own. Sign in with an AI subscription you already pay for, paste a key from any provider, or use Quorum's models with a Cloud account.</p>
      {row('login', claudeOk, <IconPerson width={18} height={18} />,
        <><strong>Log in with…</strong><em>An AI app you already use on this Mac. Quorum rides on its sign-in and plan{claudeOk && c ? ` · ${c.email}${c.plan ? ` · ${c.plan}` : ''}` : ''}</em></>,
        claudeOk && m?.source === 'claude-code' ? <button className="pill ghost" onClick={(e) => { e.stopPropagation(); disconnect(); }}>Disconnect</button> : claudeOk ? <IconCheck width={18} height={18} className="ok" /> : null,
        <div className="onb-logins">
          <button type="button" className={`onb-login ${claudeOk ? 'ok' : ''}`} onClick={(e) => { e.stopPropagation(); if (claudeOk) setPick('login'); else if (c?.installed) window.quorum.claudeLogin(); else window.quorum.openExternal('https://docs.claude.com/en/docs/claude-code/setup'); }}>
            <ProviderMark provider="anthropic" /><strong>Claude</strong><em>{!c ? 'Checking…' : claudeOk ? 'Connected' : c.installed ? 'Sign in' : 'Install Claude Code'}</em>{claudeOk && <IconCheck width={14} height={14} className="ok onb-login-check" />}
          </button>
          <button type="button" className="onb-login" disabled><ProviderMark provider="openai" /><strong>ChatGPT</strong><em>Soon</em></button>
          <button type="button" className="onb-login" disabled><ProviderMark provider="google" /><strong>Gemini</strong><em>Soon</em></button>
        </div>)}
      {row('key', !!savedKey, savedKey ? <ProviderMark provider={savedKey} /> : <IconLock width={18} height={18} />,
        <><strong>Your own API key</strong><em>{savedKey ? `${KEY_NAMES[savedKey]} · ${last4 ? `••••••••${last4}` : 'saved'} · in your Mac's Keychain` : 'Anthropic, OpenAI or Google. Quorum tells them apart from the key and keeps it in your Keychain'}</em></>,
        savedKey ? <button className="pill ghost" onClick={(e) => { e.stopPropagation(); removeKey(); }}>Remove</button>
          : keying ? null : <button className="pill" onClick={(e) => { e.stopPropagation(); setKeying(true); setPick('key'); }}>Add key</button>,
        !savedKey && keying ? (
          <div className="onb-form" onClick={(e) => e.stopPropagation()}>
            <label className="set-field wide onb-field"><span className="onb-label">API key</span><input type="password" autoFocus aria-label="API key" placeholder="sk-ant-…, sk-…, AIza…" value={key} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') saveKey(); if (e.key === 'Escape') { setKeying(false); setKey(''); } }} /></label>
            <div className="onb-row">
              <span className="onb-label">Provider</span>
              {detected ? <span className="onb-detected"><ProviderMark provider={detected} />{KEY_NAMES[detected]}</span>
                : <span className="onb-provs" role="radiogroup" aria-label="Provider">{KEY_PROVIDERS.map((id) => <button type="button" key={id} className={`onb-prov ${forced === id ? 'on' : ''}`} title={KEY_NAMES[id]} aria-label={KEY_NAMES[id]} aria-pressed={forced === id} onClick={() => setForced(id)}><ProviderMark provider={id} /></button>)}</span>}
              <span className="onb-row-end"><button className="pill" onClick={() => { setKeying(false); setKey(''); setError(''); }}>Cancel</button><button className="pill primary" disabled={!provider || !key.trim() || busy} onClick={saveKey}>{busy ? 'Checking…' : 'Save'}</button></span>
            </div>
            {error && <p className="set-error">{error}</p>}
          </div>
        ) : undefined)}
      {row('managed', isCloud, <IconQuorum width={18} height={18} />,
        <><strong>Use Quorum's models</strong><em>{isCloud ? "Built in highest quality models, nothing to manage. Included with Quorum Cloud; you sign in on the next step" : 'Upgrade to Quorum Cloud for built-in models, sync across Macs, and team knowledge'}</em></>,
        isCloud ? (pick === 'managed' ? <IconCheck width={18} height={18} className="ok" /> : <button className="pill" onClick={(e) => { e.stopPropagation(); setPick('managed'); }}>Select</button>)
          : <button className="pill" onClick={(e) => { e.stopPropagation(); window.quorum.openExternal('https://quorum.watch'); }}>Upgrade to Cloud</button>)}
      <Actions onBack={onBack} onNext={finish} ready={ready} />
    </section>
  );
}

// one line each: what it is, why, the state, and one Allow button that asks macOS the way Quorum itself would
const PERMS: { id: 'microphone' | 'audio' | 'accessibility' | 'calendar'; title: string; why: string; icon: ReactNode }[] = [
  { id: 'microphone', title: 'Microphone', why: 'Your side of a call', icon: <IconMic width={18} height={18} /> },
  { id: 'audio', title: 'System audio', why: 'The other people on the call', icon: <IconMic width={18} height={18} /> },
  { id: 'accessibility', title: 'Accessibility', why: 'Reads the meeting chat for STOP and GO', icon: <IconShield width={18} height={18} /> },
  { id: 'calendar', title: 'Calendar', why: 'Your upcoming meetings on Home', icon: <IconCalendar width={18} height={18} /> },
];
const granted = (s?: string) => s === 'granted' || s === 'authorized';

function PermissionsStep({ status, onRefresh, onPoll, onBack, onNext }: { status: Status; onRefresh: () => Promise<void>; onPoll: () => Promise<void>; onBack: () => void; onNext: () => void }) {
  const p = status?.permissions;
  const label = (s?: string) => (granted(s) ? 'Allowed' : s === 'denied' || s === 'restricted' ? 'Denied' : 'Not yet');
  // after Allow for Accessibility the grant happens in System Settings, so the state is re-read every 1.5 s for 90 s
  const poll = useRef<number | null>(null);
  const watch = () => {
    if (poll.current) window.clearInterval(poll.current);
    const until = Date.now() + 90000;
    poll.current = window.setInterval(() => { onPoll(); if (Date.now() > until && poll.current) { window.clearInterval(poll.current); poll.current = null; } }, 1500);
  };
  useEffect(() => () => { if (poll.current) window.clearInterval(poll.current); }, []);
  // Accessibility is only for noticing calls and reading their chat (the meeting-capture flag); without it the step
  // asks for the microphone and the optional calendar
  const nt = useNotetaker();
  const perms = PERMS.filter((x) => x.id !== 'accessibility' || nt.meetingCapture);
  // the two Quorum cannot work without (Accessibility only with meeting capture on); calendar stays optional. The
  // poll stops once everything this step asks for is granted
  const ready = granted(p?.microphone) && (!nt.meetingCapture || granted(p?.accessibility));
  useEffect(() => { if (ready && poll.current) { window.clearInterval(poll.current); poll.current = null; } }, [ready]);
  const allow = async (id: (typeof PERMS)[number]['id']) => {
    if (id === 'microphone') await window.quorum.onboardingRequestMicrophone();
    else if (id === 'calendar') await window.quorum.calendarConnect();
    else if (id === 'accessibility') { await window.quorum.onboardingRequestAccessibility(); watch(); }
    onPoll();
  };
  return (
    <section className="onb-step">
      <h1>Permissions</h1>
      <p>{nt.meetingCapture ? 'Quorum records and transcribes on this Mac only. Microphone and Accessibility are needed to listen and to read the meeting chat; Calendar is optional.' : 'Quorum records and transcribes on this Mac only when you start listening. The microphone is needed for that; Calendar is optional.'}</p>
      <div className="onb-perms">
        {perms.map((x) => {
          const s = p?.[x.id];
          const on = granted(s);
          return (
            <div key={x.id} className={`onb-choice line ${on ? 'on' : ''}`}>
              {x.icon}
              <div><strong>{x.title} <span className={`onb-state ${on ? 'ok' : ''}`}>{x.id === 'audio' && !on ? 'On first call' : label(s)}</span></strong><em>{x.why}</em></div>
              {on ? <IconCheck width={18} height={18} className="ok" /> : x.id === 'audio' ? <span /> : <button className="pill primary" onClick={() => allow(x.id)}>Allow</button>}
            </div>
          );
        })}
      </div>
      <Actions onBack={onBack} onNext={onNext} ready={ready} extra={<CheckAgain onRun={onRefresh} />} />
    </section>
  );
}

// Check again: a spinner while the checks run, a checkmark for a moment, then back to the label, each a crossfade
function CheckAgain({ onRun }: { onRun: () => Promise<void> }) {
  const [phase, setPhase] = useState<'idle' | 'busy' | 'done'>('idle');
  const run = async () => {
    if (phase !== 'idle') return;
    setPhase('busy');
    const started = Date.now();
    try { await onRun(); } catch {}
    // the spinner shows for at least 500 ms so a fast answer does not flicker
    await new Promise((r) => setTimeout(r, Math.max(0, 500 - (Date.now() - started))));
    setPhase('done');
    setTimeout(() => setPhase('idle'), 1200);
  };
  return (
    <button className={`pill onb-check ${phase}`} onClick={run} aria-busy={phase === 'busy'} aria-live="polite">
      <span className="onb-check-label">Check again</span>
      <span className="onb-check-busy" aria-hidden="true"><i className="spinner tiny" /></span>
      <span className="onb-check-done" aria-hidden="true"><IconCheck width={16} height={16} /></span>
      <span className="sr-only">{phase === 'busy' ? 'Checking' : phase === 'done' ? 'Checked' : ''}</span>
    </button>
  );
}
