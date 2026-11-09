import { useEffect, useState, type ReactNode } from 'react';
import type { Brain, ModelSource, OnboardingChecks, OnboardingStatus } from './quorum';
import { IconCheck, IconCode, IconFolder, IconLock, IconMic, IconPerson, IconShield, ProviderMark } from './icons';
import { ModelKey, SOURCE_NAMES } from './modelSource';
import mark from '../assets/quorum-mark.png';

type Step = 'welcome' | 'notes' | 'model' | 'account' | 'permissions' | 'done';
const ORDER: Step[] = ['welcome', 'notes', 'model', 'account', 'permissions', 'done'];
type Status = (OnboardingStatus & Partial<OnboardingChecks>) | null;

// first run on a fresh install: a short wizard in place of the main window until settings.onboarded is set
export function Onboarding({ brain, onBrain, accountSlot, onDone }: { brain: Brain | null; onBrain: (b: Brain | null) => void; accountSlot?: ReactNode; onDone: () => void }) {
  const [step, setStep] = useState<Step>('welcome');
  const [status, setStatus] = useState<(OnboardingStatus & Partial<OnboardingChecks>) | null>(null);
  // the fast part first, then permissions and Claude Code, which can take a few seconds
  const refresh = () => window.quorum.onboardingStatus().then((s) => { setStatus((prev) => ({ ...prev, ...s })); window.quorum.onboardingChecks().then((c) => setStatus((prev) => ({ ...(prev ?? s), ...c }))); });
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
        {step === 'notes' && <NotesStep brain={brain} status={status} onBrain={onBrain} onBack={back} onNext={next} />}
        {step === 'model' && <ModelStep status={status} onRefresh={refresh} onBack={back} onNext={next} />}
        {step === 'account' && (
          <section className="onb-step">
            <h1>Your account</h1>
            <p>Optional. Sign in to sync notes and meetings and to share a workspace with your team. You can do this later in Settings.</p>
            <div className="onb-slot">{accountSlot ?? <p className="onb-muted">Sign in from Settings › Workspace once you are in.</p>}</div>
            <div className="onb-actions"><button className="pill ghost" onClick={back}>Back</button><button className="pill primary" onClick={next}>Continue</button></div>
          </section>
        )}
        {step === 'permissions' && <PermissionsStep status={status} onRefresh={refresh} onBack={back} onNext={next} />}
        {step === 'done' && (
          <section className="onb-step">
            <h1>You're set</h1>
            <ul className="onb-summary">
              <li><IconFolder width={16} height={16} /> {brain ? `Notes in ${brain.root.replace(/^\/Users\/[^/]+/, '~')}` : 'No notes folder yet (connect one in Settings)'}</li>
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

function NotesStep({ brain, status, onBrain, onBack, onNext }: { brain: Brain | null; status: (OnboardingStatus & Partial<OnboardingChecks>) | null; onBrain: (b: Brain | null) => void; onBack: () => void; onNext: () => void }) {
  const [name, setName] = useState('My Agent OS');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const create = async () => {
    setBusy(true); setError('');
    try { onBrain(await window.quorum.onboardingCreateVault(null, name.trim() || 'My Agent OS')); } catch (e) { setError(String((e as Error).message || e)); }
    setBusy(false);
  };
  return (
    <section className="onb-step">
      <h1>Where do your notes live?</h1>
      <p>Quorum works on a folder of markdown notes, your Agent OS. Create a fresh one, or connect a folder you already have (an Obsidian vault or a repo with CLAUDE.md).</p>
      {brain ? (
        <div className="onb-choice on">
          <IconCheck width={18} height={18} className="ok" />
          <div><strong>{brain.name}</strong><em>{brain.root.replace(/^\/Users\/[^/]+/, '~')}</em></div>
          <button className="pill" onClick={async () => onBrain(await window.quorum.connectBrain())}>Change</button>
        </div>
      ) : (
        <>
          <div className="onb-choice">
            <IconFolder width={18} height={18} />
            <div>
              <strong>Create a new folder</strong>
              <em>{status?.defaultVaultDir?.replace(/^\/Users\/[^/]+/, '~') ?? '~/Documents/Quorum'}</em>
              <label className="set-field wide onb-field"><input value={name} aria-label="Name of your Agent OS" placeholder="My Agent OS" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') create(); }} /></label>
            </div>
            <button className="pill primary" disabled={busy} onClick={create}>{busy ? 'Creating…' : 'Create'}</button>
          </div>
          <div className="onb-choice">
            <IconFolder width={18} height={18} />
            <div><strong>Connect an existing folder</strong><em>Your notes stay where they are</em></div>
            <button className="pill" onClick={async () => onBrain(await window.quorum.connectBrain())}>Choose…</button>
          </div>
        </>
      )}
      {error && <p className="set-error">{error}</p>}
      <div className="onb-actions"><button className="pill ghost" onClick={onBack}>Back</button><button className="pill primary" disabled={!brain} onClick={onNext}>Continue</button></div>
    </section>
  );
}

// where the model runs. Claude Code is preselected when it is installed and signed in; Skip leaves the source at none
function ModelStep({ status, onRefresh, onBack, onNext }: { status: Status; onRefresh: () => void; onBack: () => void; onNext: () => void }) {
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
      <div className="onb-actions"><button className="pill ghost" onClick={onBack}>Back</button><button className="pill primary" onClick={finish}>{pick && ready ? 'Continue' : 'Skip for now'}</button></div>
    </section>
  );
}

const PERMS: { id: 'microphone' | 'audio' | 'accessibility' | 'calendar'; title: string; why: string; icon: ReactNode }[] = [
  { id: 'microphone', title: 'Microphone', why: 'Your side of a call', icon: <IconMic width={18} height={18} /> },
  { id: 'audio', title: 'System audio', why: 'The other people on the call. macOS asks on your first call', icon: <IconMic width={18} height={18} /> },
  { id: 'accessibility', title: 'Accessibility', why: 'Reads the meeting chat for STOP and GO and posts the notice', icon: <IconShield width={18} height={18} /> },
  { id: 'calendar', title: 'Calendar', why: 'Shows your upcoming meetings on Home', icon: <IconPerson width={18} height={18} /> },
];

function PermissionsStep({ status, onRefresh, onBack, onNext }: { status: (OnboardingStatus & Partial<OnboardingChecks>) | null; onRefresh: () => void; onBack: () => void; onNext: () => void }) {
  const p = status?.permissions;
  const label = (s?: string) => (s === 'granted' || s === 'authorized' ? 'Allowed' : s === 'denied' || s === 'restricted' ? 'Denied' : 'Not yet');
  return (
    <section className="onb-step">
      <h1>Permissions</h1>
      <p>Quorum records and transcribes on this Mac only. Grant what you want now; anything skipped is asked for when it is first needed.</p>
      <div className="onb-perms">
        {PERMS.map((x) => {
          const s = p?.[x.id];
          const on = s === 'granted' || s === 'authorized';
          return (
            <div key={x.id} className={`onb-choice ${on ? 'on' : ''}`}>
              {x.icon}
              <div><strong>{x.title} <span className={`onb-state ${on ? 'ok' : ''}`}>{x.id === 'audio' && !on ? 'On first call' : label(s)}</span></strong><em>{x.why}</em></div>
              {on ? <IconCheck width={18} height={18} className="ok" /> : x.id === 'microphone' ? <button className="pill primary" onClick={async () => { await window.quorum.onboardingRequestMicrophone(); onRefresh(); }}>Allow</button>
                : x.id === 'audio' ? <span /> : <button className="pill" onClick={() => window.quorum.onboardingOpenPermission(x.id)}>Open Settings</button>}
            </div>
          );
        })}
      </div>
      <div className="onb-actions"><button className="pill ghost" onClick={onBack}>Back</button><span className="onb-actions-end"><button className="pill" onClick={onRefresh}>Check again</button><button className="pill primary" onClick={onNext}>Continue</button></span></div>
    </section>
  );
}
