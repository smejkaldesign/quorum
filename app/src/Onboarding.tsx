import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AccountState, Brain, ModelSource, OnboardingChecks, OnboardingStatus } from './quorum';
import { IconCalendar, IconCheck, IconCode, IconFolder, IconFolderOpen, IconLock, IconMic, IconPerson, IconShield, ProviderMark } from './icons';
import { ModelKey, SOURCE_NAMES } from './modelSource';
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
  // the fast part first, then permissions and Claude Code, which can take a few seconds; resolves when both are in
  const refresh = () => window.quorum.onboardingStatus().then(async (s) => {
    setStatus((prev) => ({ ...prev, ...s }));
    const c = await window.quorum.onboardingChecks();
    setStatus((prev) => ({ ...(prev ?? s), ...c }));
  });
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
        {step === 'model' && <ModelStep status={status} onRefresh={refresh} onBack={back} onNext={next} />}
        {step === 'account' && <AccountStep slot={accountSlot} onBack={back} onNext={next} />}
        {step === 'permissions' && <PermissionsStep status={status} onRefresh={refresh} onBack={back} onNext={next} />}
        {step === 'done' && (
          <section className="onb-step">
            <h1>You're set</h1>
            <ul className="onb-summary">
              <li><IconFolder width={16} height={16} /> {brain ? `Agent OS at ${home(brain.root)}` : 'No Agent OS yet (connect one in Settings)'}</li>
              <li><ProviderMark provider="anthropic" /> {status?.model?.source && status.model.source !== 'none' ? `Model: ${SOURCE_NAMES[status.model.source]}` : 'No model source yet (choose one in Settings › Connectors)'}</li>
              <li><IconMic width={16} height={16} /> {status?.permissions?.microphone === 'granted' ? 'Microphone allowed' : 'Microphone: macOS will ask on your first call'}</li>
              <li><IconShield width={16} height={16} /> {status?.permissions?.accessibility === 'granted' ? 'Accessibility allowed' : 'Accessibility: needed to read the meeting chat'}</li>
            </ul>
            <p>Quorum lives in the menu bar. When a Zoom, Google Meet or Teams call starts, it offers to listen.</p>
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
  const create = async () => {
    setBusy(true); setError('');
    try { onBrain(await window.quorum.onboardingCreateVault(dir, name.trim() || 'My Agent OS')); setMode(null); } catch (e) { setError(String((e as Error).message || e)); }
    setBusy(false);
  };
  const connect = async () => { const b = await window.quorum.connectBrain(); if (b) { onBrain(b); setMode(null); } };
  return (
    <section className="onb-step">
      <h1>Connect your Agent OS</h1>
      <p>Your Agent OS is a folder of markdown notes that Quorum and your AI read and write. Connect one you already have (an Obsidian vault or a repo with CLAUDE.md) and Quorum finds the meeting notes in it, or start a fresh one.</p>
      {brain ? (
        <div className="onb-choice on">
          <IconCheck width={18} height={18} className="ok" />
          <div><strong>{brain.name}</strong><em>{home(brain.root)}</em></div>
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
          <label className="set-field wide onb-field"><span className="onb-label">Name</span><input value={name} aria-label="Name of your Agent OS" placeholder="My Agent OS" autoFocus onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') create(); }} /></label>
          <div className="onb-row">
            <span className="onb-label">Location</span>
            <code className="onb-path" title={where}>{home(where)}</code>
            <button className="pill" onClick={async () => { const d = await window.quorum.onboardingPickDir(); if (d) setDir(d); }}>Choose…</button>
          </div>
          <div className="onb-row end"><button className="pill primary" disabled={busy} onClick={create}>{busy ? 'Creating…' : 'Create folder'}</button></div>
        </div>
      )}
      {error && <p className="set-error">{error}</p>}
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
function AccountStep({ slot, onBack, onNext }: { slot?: ReactNode; onBack: () => void; onNext: () => void }) {
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
      <p>Optional. Sign in to sync notes and meetings and to share a workspace with your team. You can do this later in Settings.</p>
      <div className="onb-slot">{slot ?? <p className="onb-muted">Sign in from Settings › Workspace once you are in.</p>}</div>
      <Actions onBack={onBack} onNext={onNext} ready={signedIn} onSkip={onNext} />
    </section>
  );
}

// where the model runs. Claude Code is preselected when it is installed and signed in; Skip leaves the source at none
function ModelStep({ status, onRefresh, onBack, onNext }: { status: Status; onRefresh: () => Promise<void>; onBack: () => void; onNext: () => void }) {
  const c = status?.claude;
  const m = status?.model;
  const claudeOk = !!c?.installed && !!c?.loggedIn;
  const [pick, setPick] = useState<ModelSource | null>(null);
  const [keying, setKeying] = useState(false);
  const [local, setLocal] = useState('');
  useEffect(() => { if (claudeOk) setPick((p) => p ?? 'claude-code'); }, [claudeOk]);
  const ready = pick === 'claude-code' ? claudeOk : pick === 'anthropic-api' ? !!m?.key : pick === 'local';
  const finish = async () => {
    if (pick && ready) {
      if (pick === 'local' && local.trim()) await window.quorum.localModelSet(local);
      await window.quorum.modelSourceSet(pick);
    }
    onNext();
  };
  const choice = (s: ModelSource, icon: ReactNode, body: ReactNode, action: ReactNode) => (
    <div role="radio" aria-checked={pick === s} tabIndex={0} className={`onb-choice pick ${pick === s ? 'on' : ''}`} onClick={() => setPick(s)}
      onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setPick(s); } }}>
      {icon}<div>{body}</div>{action}
    </div>
  );
  const ollama = !m ? '' : !m.ollama.reachable ? ' · not running' : m.ollama.hasModel ? ' · running' : ` · running, ${m.localModel} not pulled`;
  return (
    <section className="onb-step" role="radiogroup" aria-label="Model source">
      <h1>Where should Quorum's model run?</h1>
      <p>Every option is your own. Quorum has no key of its own, and only Claude Code can read your notes to answer questions.</p>
      {choice('claude-code', <ProviderMark provider="anthropic" />,
        <><strong>Claude Code on this Mac</strong><em>Your own sign-in, reads your Agent OS{!c ? ' · checking…' : !c.installed ? ' · not installed' : !c.loggedIn ? ' · not signed in' : ` · signed in as ${c.email}`}</em></>,
        claudeOk ? <IconCheck width={18} height={18} className="ok" />
          : c && c.installed && !c.loggedIn ? <button className="pill primary" onClick={(e) => { e.stopPropagation(); window.quorum.claudeLogin(); }}>Sign in</button>
          : c ? <button className="pill" onClick={(e) => { e.stopPropagation(); onRefresh(); }}>Check again</button> : null)}
      {choice('anthropic-api', <IconLock width={18} height={18} />,
        <><strong>Your own API key</strong><em>Anthropic key stored in Keychain{m ? (m.key ? ' · key saved' : ' · no key yet') : ''}</em></>,
        m?.key ? <IconCheck width={18} height={18} className="ok" /> : <button className="pill" onClick={(e) => { e.stopPropagation(); setPick('anthropic-api'); setKeying(true); }}>Add key</button>)}
      {choice('local', <IconCode width={18} height={18} />,
        <>
          <strong>Local model</strong><em>Ollama at localhost{ollama}</em>
          <label className="set-field wide onb-field"><input value={local} aria-label="Ollama model name" placeholder={m?.localModel || 'llama3.1'} onChange={(e) => setLocal(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); finish(); } }} /></label>
        </>,
        pick === 'local' ? <IconCheck width={18} height={18} className="ok" /> : null)}
      {keying && <ModelKey onDone={(ok) => { setKeying(false); if (ok) onRefresh(); }} />}
      <Actions onBack={onBack} onNext={finish} ready={!!(pick && ready)} onSkip={onNext} />
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

function PermissionsStep({ status, onRefresh, onBack, onNext }: { status: Status; onRefresh: () => Promise<void>; onBack: () => void; onNext: () => void }) {
  const p = status?.permissions;
  const label = (s?: string) => (granted(s) ? 'Allowed' : s === 'denied' || s === 'restricted' ? 'Denied' : 'Not yet');
  // after Allow for Accessibility the grant happens in System Settings, so the state is re-read every 1.5 s for 90 s
  const poll = useRef<number | null>(null);
  const watch = () => {
    if (poll.current) window.clearInterval(poll.current);
    const until = Date.now() + 90000;
    poll.current = window.setInterval(() => { onRefresh(); if (Date.now() > until && poll.current) { window.clearInterval(poll.current); poll.current = null; } }, 1500);
  };
  useEffect(() => () => { if (poll.current) window.clearInterval(poll.current); }, []);
  useEffect(() => { if (granted(p?.accessibility) && poll.current) { window.clearInterval(poll.current); poll.current = null; } }, [p?.accessibility]);
  const allow = async (id: (typeof PERMS)[number]['id']) => {
    if (id === 'microphone') await window.quorum.onboardingRequestMicrophone();
    else if (id === 'calendar') await window.quorum.calendarConnect();
    else if (id === 'accessibility') { await window.quorum.onboardingRequestAccessibility(); watch(); }
    onRefresh();
  };
  // the two Quorum cannot work without; calendar stays optional
  const ready = granted(p?.microphone) && granted(p?.accessibility);
  return (
    <section className="onb-step">
      <h1>Permissions</h1>
      <p>Quorum records and transcribes on this Mac only. Microphone and Accessibility are needed to listen and to read the meeting chat; Calendar is optional.</p>
      <div className="onb-perms">
        {PERMS.map((x) => {
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
