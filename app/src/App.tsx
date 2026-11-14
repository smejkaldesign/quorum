import { Component, Suspense, lazy, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AccountState, Brain, HelperEvent, MeetingMeta, Notes, NotesDraft, Settings, Source, SpeakersEvent, SummaryEvent, UpdateState } from './quorum';
import { Markdown } from './Markdown';
import { useSession } from './session';
import { BetaGate } from './BetaGate';
// the views a session may never open load on first use, so the window paints from a smaller bundle and the popup
// window never parses them at all
const EndView = lazy(() => import('./EndView').then((m) => ({ default: m.EndView })));
const Onboarding = lazy(() => import('./Onboarding').then((m) => ({ default: m.Onboarding })));
const KnowledgeView = lazy(() => import('./KnowledgeView').then((m) => ({ default: m.KnowledgeView })));
const SettingsView = lazy(() => import('./SettingsView').then((m) => ({ default: m.SettingsView })));
import { AccountArea, EDITION, isCloud, KnowledgeTabArea } from './edition';
import { MAIN_TAB_LABEL, keepTab, mainTabs, showsKnowledge, type MainTab } from './mainTabs';
import markProd from '../assets/quorum-mark.png';
import markDev from '../assets/quorum-mark-dev.png';

const mark = window.quorum.isDev ? markDev : markProd;
if (window.quorum.isDev) document.documentElement.dataset.dev = '';
import { HistoryView } from './HistoryView';
import { UpNext } from './UpNext';
import { nextMenuIndex, updateBadge } from './headerItems';
import { useExclusiveMenu } from './menuBus';
import type { KbCommand } from './KnowledgeView';
import { Composer } from './Composer';
import type { ConnectorsTarget, OpenSettingsDetail, SettingsPageId } from './connectorsNav';
import { IconPen, PrivateNotes, usePrivateNotes } from './PrivateNotes';
import { Avatar, SpeakerName, similarCounts, type SpeakerInfo } from './Speaker';
import { useNotetaker } from './flags';
import { IconFolderOpen, IconPerson, IconClose, IconMenu, IconHome, IconGraph, IconBrain, IconSearch, IconFolder, IconDoc, IconBack, IconChat, IconChevron, IconDownload, IconNotes, IconStop, IconPause, IconPlay, Wave } from './icons';

// one speaker turn as main.js built it; a turn that grows arrives again with the same id and replace: true
type Line = { id: number; channel: 'me' | 'them'; text: string; start: number } & Partial<SpeakerInfo>;
type Phase = 'idle' | 'starting' | 'listening' | 'paused' | 'review' | 'blocked';
type Tab = MainTab | 'chat' | 'notes' | 'mine';
const inCall = (p: string) => p === 'listening' || p === 'paused' || p === 'starting';
// Home and Memory always sit in the middle, Knowledge beside them in a signed-in Cloud build (mainTabs.ts); on a call,
// Chat, live Notes and Logs, and Your notes open up beside Listening
const MAIN_TAB_ICON = { home: IconHome, memory: IconGraph, knowledge: IconBrain } as const;
const CALL_TABS = [['chat', IconChat, 'Chat'], ['notes', IconNotes, 'Live notes'], ['mine', IconPen, 'Your notes']] as const;
type Msg =
  | { kind: 'user'; text: string; files?: string[] }
  | { kind: 'quorum'; text: string; pending?: boolean; steps?: string[]; sources?: Source[] }
  | { kind: 'suggest'; id: string; text: string; caption: string; state: 'open' | 'accepted' | 'dismissed' }
  | { kind: 'event'; text: string; tone: 'stop' | 'go' };

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error('render crash:', error.message, error.stack); }
  render() {
    if (!this.state.error) return this.props.children;
    return <CrashPage error={this.state.error} onReload={() => this.setState({ error: null })} />;
  }
}

// a view that failed while drawing, as a page: what happened in plain words, what is safe, what to do. The one case
// the app can name is its own files changing underneath an open window (an update, or a rebuild in development)
const STALE_BUNDLE = /dynamically imported module|Loading chunk|Importing a module script failed/i;
function CrashPage({ error, onReload }: { error: Error; onReload: () => void }) {
  const stale = STALE_BUNDLE.test(error.message);
  return (
    <div className="panel"><div className="crash" role="alert">
      <CrashArt />
      <h1>{stale ? 'Quorum updated underneath this view' : "Quorum couldn't draw this view"}</h1>
      <p>{stale
        ? "The app's files changed while this window was open, so a part of the view could not load. Reloading picks up the new version."
        : 'A part of the app failed while it was drawing. Reloading usually puts it back. If it happens again, quit and reopen Quorum.'}</p>
      <p>Your notes, transcripts and settings are not affected. Nothing was lost.</p>
      <button className="pill primary crash-reload" onClick={onReload}>Reload view</button>
      <details className="crash-detail">
        <summary>Technical detail</summary>
        <code>{error.message}</code>
      </details>
    </div></div>
  );
}

// three note cards, the front one slipped off its stack
function CrashArt() {
  return (
    <svg className="crash-art" width="120" height="96" viewBox="0 0 120 96" fill="none" aria-hidden="true">
      <rect x="30" y="10" width="60" height="72" rx="8" fill="#2a2a2d" stroke="#3a3a3e" />
      <rect x="24" y="16" width="60" height="72" rx="8" fill="#303034" stroke="#444449" />
      <g transform="rotate(-9 50 60)">
        <rect x="20" y="24" width="60" height="72" rx="8" fill="#39393e" stroke="#55555b" />
        <rect x="30" y="38" width="30" height="4" rx="2" fill="#8a8a92" />
        <rect x="30" y="48" width="40" height="4" rx="2" fill="#5e5e66" />
        <rect x="30" y="58" width="36" height="4" rx="2" fill="#5e5e66" />
        <rect x="30" y="68" width="22" height="4" rx="2" fill="#5e5e66" />
      </g>
      <circle cx="96" cy="22" r="11" fill="#1f1f22" stroke="#7fdb83" />
      <path d="M96 16v7" stroke="#7fdb83" strokeWidth="2" strokeLinecap="round" />
      <circle cx="96" cy="27.5" r="1.3" fill="#7fdb83" />
    </svg>
  );
}

// the header's update item (headerItems.ts): nothing while idle, progress while a version downloads, then a button
// that restarts Quorum into the new version
function UpdateItem({ state }: { state: UpdateState | null }) {
  const b = updateBadge(state);
  if (b.kind === 'progress') return (
    <span className="update-progress" role="progressbar" aria-label={b.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={b.percent} data-tip={b.label}>
      <IconDownload width={13} height={13} /><span className="update-track"><i style={{ width: `${b.percent}%` }} /></span>
    </span>
  );
  if (b.kind === 'ready') return <button className="pill update-pill" data-tip={b.tip} onClick={() => window.quorum.updateInstall()}><IconDownload width={14} height={14} />{b.label}</button>;
  return null;
}

// the header menu: the Agent OS and team vault, Settings, Hide (the whole app, as Cmd+H), and Quit last. Arrow keys, Home and End move between
// items, Escape closes it and puts focus back on the menu button
function AppMenu({ brain, active, onMemory, onSettings, next }: { brain: Brain | null; active: boolean; onMemory: () => void; onSettings: () => void; next: React.RefObject<HTMLButtonElement | null> }) {
  const [open, setOpen] = useState(false);
  const shut = useCallback(() => setOpen(false), []);
  useExclusiveMenu('app', open, shut);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const items = () => Array.from(list.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
  useEffect(() => {
    if (!open) return;
    items().find((b) => !b.disabled)?.focus();
    const close = () => setOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [open]);
  const close = () => { setOpen(false); button.current?.focus(); };
  const run = (fn: () => void) => () => { setOpen(false); fn(); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    // Tab leaves the menu for the control after it (the close button), Shift+Tab for the menu button
    if (e.key === 'Tab') { e.preventDefault(); setOpen(false); (e.shiftKey ? button.current : next.current)?.focus(); return; }
    const all = items();
    const i = nextMenuIndex(all.indexOf(document.activeElement as HTMLButtonElement), e.key, all.map((b) => b.disabled));
    if (i === null) return;
    e.preventDefault();
    all[i].focus();
  };
  return (
    <div className="status-wrap">
      <button ref={button} className={`icon-btn brain ${active ? 'active' : ''}`} data-tip="Menu" aria-label="Menu"
        aria-haspopup="menu" aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        onKeyDown={(e) => { if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !open) { e.preventDefault(); setOpen(true); } }}>
        <IconMenu width={19} height={19} />
      </button>
      {open && (
        <div ref={list} className="menu brain-menu" role="menu" aria-label="Quorum" onKeyDown={onKey} onClick={(e) => e.stopPropagation()}>
          <button role="menuitem" className="brain-item" onClick={run(onMemory)}>
            <IconFolder width={18} height={18} className={brain ? 'ok' : 'err'} />
            <strong>{brain ? brain.name : 'No Agent OS'}</strong><em>{brain ? brain.root.replace(/^\/Users\/[^/]+/, '~') : 'Not connected'}</em>
          </button>
          <button role="menuitem" className="brain-item" disabled>
            <IconFolderOpen width={18} height={18} /><strong>Team vault</strong><em className="soon">Coming soon</em>
          </button>
          <div className="menu-sep" role="separator" />
          <button role="menuitem" onClick={run(onSettings)}>Settings</button>
          <button role="menuitem" onClick={run(() => window.quorum.hideApp())}>Hide Quorum</button>
          <div className="menu-sep" role="separator" />
          <button role="menuitem" onClick={run(() => window.quorum.quit())}>Quit Quorum</button>
        </div>
      )}
    </div>
  );
}

const SUGGESTIONS = ['Summarize so far', 'What did I commit to?', 'Any open questions?'];

export function App() {
  // the notetaker flags (flags.ts): the main process refuses on its own; these keep the controls out of sight
  const nt = useNotetaker();
  const [phase, setPhase] = useState<Phase>('idle');
  // why a Start did nothing (the main process refused it), shown for a few seconds under the header
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<number | null>(null);
  const startListening = async () => {
    const r = await window.quorum.start();
    if (r?.error) {
      setNotice(r.error);
      if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
      noticeTimer.current = window.setTimeout(() => setNotice(null), 6000);
    }
  };
  // paused from the header keeps the call; STOP from the chat deletes it
  const [held, setHeld] = useState(false);
  const [tab, setTab] = useSession<Tab>('tab', 'home', keepTab(EDITION));
  // the hosted account, for the Knowledge tab: the Local edition has none, so it never asks
  const [account, setAccount] = useState<AccountState | null>(null);
  useEffect(() => {
    if (!isCloud) return;
    let live = true;
    window.quorum.accountStatus().then((a) => { if (live) setAccount(a); }).catch(() => {});
    const off = window.quorum.onAccount?.(setAccount);
    return () => { live = false; off?.(); };
  }, []);
  const tabs = mainTabs(EDITION, account);
  // a remembered Knowledge tab waits for the account, shows once it allows the tab, and closes when it does not
  const knowledgeOpen = tab === 'knowledge' && showsKnowledge(EDITION, account);
  useEffect(() => { if (tab === 'knowledge' && account && !showsKnowledge(EDITION, account)) setTab('home'); }, [tab, account, setTab]);
  // off a call, chat lives inside Home as a conversation opened from Ask anything or a saved chat
  const [convoOpen, setConvoOpen] = useState(false);
  // History filters hide Up next while they are on (HistoryView reports them)
  const [histFiltered, setHistFiltered] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [me, setMe] = useState<{ name: string; photo: string | null }>({ name: '', photo: null });
  const [focusAsk, setFocusAsk] = useState(0);
  const convoRef = useRef(false);
  convoRef.current = convoOpen;
  const phaseRef = useRef<Phase>('idle');
  const [view, setView] = useSession<'main' | 'settings'>('view', 'main');
  const [kbCommand, setKbCommand] = useState<KbCommand>(null);
  // a cited note opens in Quorum's Memory view
  const openInQuorum = (abs: string) => {
    if (!brain || !abs.startsWith(`${brain.vault}/`)) { window.quorum.openNote(abs); return; }
    setView('main');
    setTab('memory');
    setKbCommand({ kind: 'open', rel: abs.slice(brain.vault.length + 1), n: Date.now() });
  };
  // Obsidian's keys work from anywhere in Quorum: they jump to Memory and open the overlay
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.altKey || e.ctrlKey) return;
      const k = e.key.toLowerCase();
      const kind = k === 'o' && !e.shiftKey ? 'switcher' : k === 'p' && !e.shiftKey ? 'palette' : k === 'f' && e.shiftKey ? 'search' : null;
      if (!kind) return;
      e.preventDefault();
      setView('main');
      setTab('memory');
      setKbCommand({ kind, n: Date.now() });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setView, setTab]);
  const [brain, setBrain] = useState<Brain | null>(null);
  const [startingChat, setStartingChat] = useState<string | null>(null);
  // a fresh install shows the wizard until onboarding-done; null until the main process answers
  const [firstRun, setFirstRun] = useState<boolean | null>(null);
  useEffect(() => { window.quorum.onboardingStatus().then((s) => setFirstRun(s.firstRun)).catch(() => setFirstRun(false)); }, []);
  // the beta gate comes before everything, wizard included, until an access code was accepted (beta.js)
  const [gated, setGated] = useState<boolean | null>(null);
  useEffect(() => { Promise.resolve(window.quorum.betaStatus?.()).then((s) => setGated(s?.gate === true)).catch(() => setGated(false)); }, []);
  const [settingsPage, setSettingsPage] = useState<({ page: SettingsPageId; n: number } & ConnectorsTarget) | null>(null);
  const openSettings = (page: SettingsPageId, target: ConnectorsTarget = {}) => { setSettingsPage({ page, ...target, n: Date.now() }); setView('settings'); };
  // the composer sits in three views, so its "Choose a model source" button asks for Settings through a window event
  useEffect(() => {
    const open = (e: Event) => { const d = (e as CustomEvent<OpenSettingsDetail>).detail; if (!d || typeof d === 'string') openSettings(d ?? 'preferences'); else openSettings(d.page, { connector: d.connector, library: d.library }); };
    window.addEventListener('quorum-open-settings', open);
    return () => window.removeEventListener('quorum-open-settings', open);
  }, []);
  const composer = useRef<HTMLTextAreaElement>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [partial, setPartial] = useState<{ me: string; them: string }>({ me: '', them: '' });
  const [msgs, setMsgs] = useState<Msg[]>([]);
  // the running summary during a call, as the main process sends it after each pass
  const [soFar, setSoFar] = useState<SummaryEvent | null>(null);
  const [draft, setDraft] = useState('');
  const [log, setLog] = useState<string[]>([]);
  const [notes, setNotes] = useState<Notes | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const [notesDraft, setNotesDraft] = useState<NotesDraft | null>(null);
  const [meta, setMeta] = useState<MeetingMeta | null>(null);
  const [settings, setSettings] = useState<Settings>({ autoListen: false, model: 'sonnet', suggestions: true });
  // an update shows left of Listen: its progress while it downloads, then Update to vX; the rest lives in Preferences
  const [update, setUpdate] = useState<UpdateState | null>(null);
  useEffect(() => { window.quorum.updateStatus().then((s) => setUpdate(s ?? null)).catch(() => {}); return window.quorum.onUpdate(setUpdate); }, []);
  const [themName, setThemName] = useState<string | null>(null);
  const [participants, setParticipants] = useState<string[]>([]);
  const [naming, setNaming] = useState(false);
  useEffect(() => { window.quorum.user().then((u) => setMe({ name: u?.name ?? '', photo: u?.photo ?? null })); }, [settings.profile]);
  const [unread, setUnread] = useState(false);
  const tabRef = useRef<Tab>('chat');
  tabRef.current = tab;
  const chatEnd = useRef<HTMLDivElement>(null);
  // a sent question is pinned to the top of the pane while its answer streams in below it; the spacer under the answer
  // gives the question room to reach the top and shrinks as the answer grows. Everything else scrolls to the end
  const bodyRef = useRef<HTMLDivElement>(null);
  const lastUser = useRef<HTMLDivElement>(null);
  const anchored = useRef(false);
  const anchorScroll = useRef(false);
  const [spacer, setSpacer] = useState(0);
  const notesEnd = useRef<HTMLDivElement>(null);
  // your notes: typed on a call and in the review, read by the notes prompt as its outline
  const mine = usePrivateNotes();
  const mineRef = useRef<HTMLTextAreaElement>(null);
  // Cmd+Shift+N on a call opens Your notes and puts the cursor in it
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || !e.shiftKey || e.altKey || e.ctrlKey || e.key.toLowerCase() !== 'n' || !inCall(phaseRef.current)) return;
      e.preventDefault();
      setView('main');
      setTab('mine');
      setTimeout(() => mineRef.current?.focus(), 50);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setView, setTab]);

  const addLog = (s: string) => setLog((l) => [...l.slice(-200), `${new Date().toLocaleTimeString()}  ${s}`]);
  const resetMeeting = () => { setLines([]); setPartial({ me: '', them: '' }); setMsgs([]); setNotes(null); setMeta(null); setParticipants([]); mine.reset(); };
  // the speaker pass or a correction: names merged onto the lines by id, the list the popover offers
  const applySpeakers = (s: SpeakersEvent) => {
    setParticipants(s.participants);
    const by = new Map(s.turns.map((t) => [t.id, t]));
    setLines((l) => l.map((x) => { const t = by.get(x.id); return t ? { ...x, speaker: t.speaker, confidence: t.confidence, cluster: t.cluster, corrected: t.corrected } : x; }));
  };
  const nameSpeakers = async () => { setNaming(true); try { applySpeakers(await window.quorum.nameSpeakers()); } finally { setNaming(false); } };
  const setSpeaker = async (id: number, name: string | null, similar: boolean) => applySpeakers(await window.quorum.setSpeaker(id, name, similar));

  useEffect(() => {
    const offs = [
      window.quorum.onHelperEvent((e: HelperEvent) => {
        // dictation belongs to whichever composer started it
        if (e.event === 'dictation' || (e.event === 'transcript' && e.channel === 'dictation')) return;
        if (e.event === 'transcript') {
          const text = typeof e.text === 'string' ? e.text : '';
          if (e.channel === 'them' && 'who' in e) setThemName(e.who ?? null);
          if (e.isFinal) {
            const turn: Line = { id: e.id ?? 0, channel: e.channel as 'me' | 'them', text: text.trim(), start: e.start, ...(e.speaker !== undefined ? { speaker: e.speaker, confidence: e.confidence ?? 0, cluster: e.cluster ?? null, corrected: !!e.corrected } : {}) };
            setLines((l) => {
              if (e.replace && l.some((x) => x.id === turn.id)) return l.map((x) => (x.id === turn.id ? { ...x, ...turn } : x));
              const i = l.findIndex((x) => x.start > turn.start);
              return i < 0 ? [...l, turn] : [...l.slice(0, i), turn, ...l.slice(i)];
            });
            setPartial((p) => ({ ...p, [e.channel]: '' }));
          } else setPartial((p) => ({ ...p, [e.channel]: text }));
        } else if (e.event === 'status' || e.event === 'error') addLog(`${e.event}: ${e.message}`);
        else if (e.event === 'chatSent') addLog(`posted in the call chat: ${e.text.slice(0, 60)}…`);
        else if (e.event === 'axStatus') addLog(`accessibility ${e.trusted ? 'granted' : 'NOT granted'}, meeting app ${e.zoomRunning ? 'running' : 'not running'}`);
        else if (e.event === 'audioRoute') addLog(`audio out: ${e.name || e.route} (${e.route})`);
      }),
      window.quorum.onSpeakers(applySpeakers),
      window.quorum.onSummary(setSoFar),
      window.quorum.onState((s) => {
        if (s.phase === 'starting') { setPhase('starting'); setStartingChat(s.chatName ?? null); addLog(s.chatName ? `posting Quorum's notice in the ${s.chatName}…` : 'starting…'); return; }
        if (s.phase === 'idle') { setPhase('idle'); return; }
        if (s.phase === 'summarizing') { setPhase('review'); setSummarizing(true); setNotes(null); setNotesDraft(null); setMeta(s.meta ?? null); return; }
        if (s.phase === 'review') { setPhase('review'); setSummarizing(false); setNotes(s.notes); setNotesDraft(null); setMeta(s.meta ?? null); return; }
        setHeld('soft' in s && !!s.soft);
        if (s.phase === 'paused' && 'soft' in s && s.soft) {
          setPartial({ me: '', them: '' });
          setMsgs((m) => [...m, { kind: 'event', tone: 'stop', text: 'Paused. Everything so far is kept, and nothing new is recorded until you resume.' }]);
        } else if (s.phase === 'paused') {
          setLines([]); setPartial({ me: '', them: '' });
          setMsgs([{ kind: 'event', tone: 'stop', text: `Stopped by ${s.by ?? 'someone'} from the Zoom chat. Everything from this call was deleted. Reply ${s.go ?? 'GO'} in the chat to turn me back on.` }]);
        }
        if (s.phase === 'listening') {
          if (s.by && s.by !== 'auto-listen') setMsgs((m) => [...m, { kind: 'event', tone: 'go', text: `Turned back on by ${s.by}. Transcribing again on this Mac.` }]);
          else resetMeeting();
        }
        setPhase(s.phase);
      }),
      window.quorum.onLog(addLog),
      window.quorum.onSettings(setSettings),
      window.quorum.onAgentStep(({ text }) => setMsgs((m) => m.map((x) => (x.kind === 'quorum' && x.pending ? { ...x, steps: [...(x.steps ?? []), text] } : x)))),
      window.quorum.onAgentDelta(({ text }) => setMsgs((m) => m.map((x) => (x.kind === 'quorum' && x.pending ? { ...x, text } : x)))),
      window.quorum.onNotesDelta(setNotesDraft),
      window.quorum.onFocusComposer(() => {
        setView('main');
        if (inCall(phaseRef.current)) setTab('chat');
        else { setTab('home'); if (!convoRef.current) { setFocusAsk((n) => n + 1); return; } }
        setTimeout(() => composer.current?.focus(), 50);
      }),
      window.quorum.onSuggestion((sg) => {
        setMsgs((m) => [...m, { kind: 'suggest', id: sg.id, text: sg.text, caption: sg.caption, state: 'open' }]);
        if (tabRef.current !== 'chat') setUnread(true);
      }),
    ];
    window.quorum.axStatus();
    window.quorum.getSettings().then(setSettings);
    window.quorum.brain().then(setBrain);
    return () => offs.forEach((off) => off());
  }, []);

  useLayoutEffect(() => {
    const body = bodyRef.current, q = lastUser.current;
    if (!anchored.current || !body || !q) { setSpacer(0); chatEnd.current?.scrollIntoView({ block: 'end' }); return; }
    const used = (chatEnd.current?.offsetTop ?? 0) - q.offsetTop;
    setSpacer(Math.max(0, body.clientHeight - used - 24));
    if (anchorScroll.current) { anchorScroll.current = false; requestAnimationFrame(() => q.scrollIntoView({ block: 'start' })); }
  }, [msgs]);
  // a call starting moves you to Chat; leaving one lands on History
  phaseRef.current = phase;
  useEffect(() => { setTab(inCall(phase) ? 'chat' : 'home'); }, [inCall(phase)]);
  // History gets the big Granola-sized window; everything else is the docked panel
  useEffect(() => { notesEnd.current?.scrollIntoView({ block: 'end' }); }, [lines, partial]);


  async function send(text = draft, files: string[] = []) {
    const q = text.trim();
    if (!q || !brain) return;
    setDraft('');
    anchored.current = true;
    anchorScroll.current = true;
    setMsgs((m) => [...m, { kind: 'user', text: q, files: files.map((f) => f.split('/').pop()!) }, { kind: 'quorum', text: '', pending: true }]);
    let reply: Msg;
    try {
      const r = await window.quorum.ask(q, files);
      reply = { kind: 'quorum', text: r.text, sources: r.sources };
    } catch (err) { reply = { kind: 'quorum', text: `Couldn't answer: ${String(err).replace(/^Error:\s*/, '')}` }; }
    setMsgs((m) => {
      const i = m.findLastIndex((x) => x.kind === 'quorum' && x.pending);
      if (i < 0) return [...m, reply];
      const prev = m[i];
      const steps = prev.kind === 'quorum' ? prev.steps : undefined;
      return [...m.slice(0, i), { ...reply, steps } as Msg, ...m.slice(i + 1)];
    });
  }

  async function openChat(id: string) {
    const c = await window.quorum.loadChat(id);
    if (!c) return;
    anchored.current = false;
    setMsgs(c.turns.flatMap((t): Msg[] => [{ kind: 'user', text: t.q }, { kind: 'quorum', text: t.a, sources: t.sources, steps: t.steps }]));
    setConvoOpen(true);
  }

  async function newChat() {
    await window.quorum.newChat();
    anchored.current = false;
    setMsgs([]);
    setTimeout(() => composer.current?.focus(), 50);
  }

  async function acceptSuggestion(id: string) {
    anchored.current = false;
    setMsgs((m) => [...m.map((x) => (x.kind === 'suggest' && x.id === id ? { ...x, state: 'accepted' as const } : x)), { kind: 'quorum', text: '', pending: true }]);
    let reply: Msg;
    try {
      const r = await window.quorum.acceptSuggestion(id);
      reply = { kind: 'quorum', text: r.text, sources: r.sources };
    } catch (err) { reply = { kind: 'quorum', text: `Couldn't search your notes: ${String(err)}` }; }
    setMsgs((m) => { const i = m.findLastIndex((x) => x.kind === 'quorum' && x.pending); return i < 0 ? [...m, reply] : [...m.slice(0, i), reply, ...m.slice(i + 1)]; });
  }

  const dismissSuggestion = (id: string) => setMsgs((m) => m.map((x) => (x.kind === 'suggest' && x.id === id ? { ...x, state: 'dismissed' as const } : x)));


  const liveWords = settings.transcription?.live ?? true;
  const themLabel = themName ?? 'Them';
  const who = (l: { channel: 'me' | 'them'; speaker?: string | null }) => (l.channel === 'me' ? 'You' : l.speaker ?? themLabel);
  // the live transcript draws every row on each render; the similar-turn count comes from one pass, and the row's
  // callback stays the same object so the memoized rows skip the partial words that arrive several times a second
  const similar = useMemo(() => similarCounts(lines), [lines]);
  const pickSpeaker = useCallback((id: number, name: string | null, same: boolean) => setSpeaker(id, name, same), []); // eslint-disable-line react-hooks/exhaustive-deps

  const status = {
    idle: { label: 'Not listening', icon: <Wave live={false} /> },
    starting: { label: 'Starting…', icon: <Wave live={false} /> },
    listening: { label: 'Listening', icon: <Wave live /> },
    paused: held ? { label: 'Paused', icon: <Wave live={false} /> } : { label: 'Stopped', icon: <IconStop width={14} height={14} /> },
    review: { label: 'Ended', icon: <span className="dot" /> },
    blocked: { label: 'Off for this call', icon: <Wave live={false} /> },
  }[phase];


  const lastUserIdx = msgs.findLastIndex((x) => x.kind === 'user');

  // nothing renders until the main process says whether this is a first run, so the wizard never flashes in or out
  if (firstRun === null || gated === null) return <div className="panel" />;
  if (gated) return <div className="panel"><BetaGate onDone={() => setGated(false)} /></div>;
  if (firstRun) {
    return <div className="panel"><OnboardingShell brain={brain} onBrain={setBrain} onDone={() => setFirstRun(false)} /></div>;
  }

  if (phase === 'review') {
    const close = () => { setPhase('idle'); resetMeeting(); setTab('home'); };
    return <div className="panel"><LazyView name="your notes" onClose={close}><EndView notes={notes} draft={notesDraft} meta={meta} summarizing={summarizing} transcript={lines.map((l) => ({ ...l, who: who(l) }))} participants={participants} onSpeaker={setSpeaker} me={me}
      privateNotes={mine.text} onPrivateNotes={mine.change} flushPrivateNotes={mine.flush} onClose={close} /></LazyView></div>;
  }

  return (
    <div className={`panel ${view === 'main' && tab === 'home' && convoOpen ? 'convo-wide' : ''}`}>
      <header className="bar">
        <div className="brand static"><img src={mark} alt={window.quorum.isDev ? 'Quorum Dev' : 'Quorum'} /></div>
        <nav className="tabs" aria-label="Views">
          {tabs.map((id) => { const Icon = MAIN_TAB_ICON[id]; const label = MAIN_TAB_LABEL[id]; return (
            <button key={id} className={`tab ${view === 'main' && tab === id ? 'on' : ''}`} aria-label={label} data-tip={label}
              onClick={() => { setView('main'); setTab(id); }}>
              <Icon />
            </button>
          ); })}
        </nav>
        <div className="right">
          {inCall(phase) && (
          <nav className="tabs call-tabs" aria-label="Call views">
            {CALL_TABS.map(([id, Icon, label]) => (
              <button key={id} className={`tab ${view === 'main' && tab === id ? 'on' : ''}`} aria-label={label} data-tip={label}
                onClick={() => { setView('main'); setTab(id); if (id === 'chat') setUnread(false); }}>
                <Icon />{id === 'chat' && unread && <span className="badge" aria-label="New suggestion" />}
              </button>
            ))}
          </nav>
          )}
          <div className="status-wrap">
            <UpdateItem state={update} />
            {phase === 'listening' && <button className="icon-btn call-btn" aria-label="Pause" data-tip="Pause" onClick={() => window.quorum.pause()}><IconPause /></button>}
            {phase === 'paused' && <button className="icon-btn call-btn" aria-label="Resume" data-tip="Resume" onClick={() => window.quorum.resume()}><IconPlay /></button>}
            {(phase === 'listening' || phase === 'paused') && <button className="icon-btn call-btn" aria-label="Stop and summarize" data-tip="Stop and summarize" onClick={() => window.quorum.end()}><IconStop /></button>}
            {/* one button from idle to listening, so the label that slid out on hover is the one that turns green */}
            {(nt.manualListen || phase !== 'idle') && (
            <button className={`status listen ${phase === 'blocked' ? 'off-call' : phase}`} onClick={phase === 'idle' ? startListening : undefined}
              data-tip={phase === 'blocked' ? 'Someone on your never-listen list is in this call' : undefined} aria-label={phase === 'idle' ? 'Listen' : status.label}>
              <span className="listen-hint">{phase === 'idle' ? 'Listen' : status.label}</span>{status.icon}
            </button>
            )}
          </div>
          <AppMenu brain={brain} active={view === 'settings'} onMemory={() => openSettings('memory')} onSettings={() => openSettings('preferences')} next={closeRef} />
          <button ref={closeRef} className="icon-btn close-win" aria-label="Close window" data-tip="Close window. Quorum keeps running in the menu bar." data-tip-pos="left" onClick={() => window.quorum.hideWindow()}>
            <IconClose width={17} height={17} />
          </button>
        </div>
      </header>
      {notice && <p className="set-error start-notice" role="alert">{notice}</p>}
      {view === 'main' && <UpNext hidden={(inCall(phase) && (tab === 'chat' || tab === 'notes' || tab === 'mine')) || (tab === 'home' && !convoOpen && histFiltered)} />}

      {view === 'settings' ? (
        <div className="body wide flush">
          <Suspense fallback={null}><SettingsView open={settingsPage} brain={brain} settings={settings} onSettings={setSettings} onConnect={async () => setBrain(await window.quorum.connectBrain())} onDisconnect={async () => setBrain(await window.quorum.disconnectBrain())} onBrain={setBrain} onBack={() => setView('main')} /></Suspense>
        </div>
      ) : <>
      {tab === 'home' && !convoOpen && (
        <div className="body wide">
          <HistoryView brain={brain} focusAsk={focusAsk} onAsk={(q, f) => { setConvoOpen(true); send(q, f); }} onOpenChat={openChat} onFiltered={setHistFiltered} />
        </div>
      )}

      {tab === 'memory' && (
        <div className="body wide flush">
          <Suspense fallback={null}><KnowledgeView brain={brain} command={kbCommand} /></Suspense>
        </div>
      )}

      {knowledgeOpen && (
        <div className="body wide flush">
          <KnowledgeTabArea />
        </div>
      )}

      {(tab === 'chat' || (tab === 'home' && convoOpen)) && (
        <>
          <div className="body" ref={bodyRef}>
            {!inCall(phase) && (
              <div className="row convo-bar">
                <button className="pill primary small-pill" onClick={() => setConvoOpen(false)}><IconBack width={16} height={16} /> Back</button>
                {msgs.length > 0 && <button className="pill small-pill" onClick={newChat}>New chat</button>}
              </div>
            )}
            {phase === 'idle' && msgs.length === 0 && (
              <QuorumCard>
                <p>{brain ? `Ask me anything from ${brain.name}. ` : 'Connect your Agent OS so I can answer from your notes. '}{nt.meetingCapture ? "When a call starts, I post a notice in the call's chat and listen on your Mac." : nt.manualListen ? 'Start listening to take a note of your own; I write it into your Agent OS.' : ''}</p>
                {nt.manualListen && (
                <div className="row">
                  <button className="pill primary" onClick={startListening}>Start listening</button>
                  {nt.meetingCapture && <span className="hint">{settings.autoListen ? <><span className="live-dot" aria-hidden="true" />Auto-listen is on</> : 'Or turn on auto-listen in Settings'}</span>}
                </div>
                )}
              </QuorumCard>
            )}
            {phase === 'starting' && <QuorumCard><p className="muted">{startingChat ? `Posting my notice in the ${startingChat}…` : 'Starting…'}</p></QuorumCard>}
            {phase === 'listening' && msgs.length === 0 && (
              <QuorumCard>
                <SoFar s={soFar} lines={lines} partial={partial} who={who} me={me} />
                <p className="muted">Ask me anything about this meeting; only you see this chat.</p>
                <div className="row wrap">
                  {SUGGESTIONS.map((s) => <button key={s} className="pill" onClick={() => send(s)}>{s}</button>)}
                </div>
              </QuorumCard>
            )}
            {msgs.map((m, i) => m.kind === 'user' ? (
              <div key={i} className="user-row" ref={i === lastUserIdx ? lastUser : undefined}>
                <div className="user-msg">{m.files?.length ? <div className="user-files">{m.files.map((f) => <span key={f}>{f}</span>)}</div> : null}{m.text}</div>
                <span className="user-avatar" aria-label="You">{me.photo ? <img src={me.photo} alt="" /> : me.name ? me.name[0].toUpperCase() : <IconPerson width={14} height={14} />}</span>
              </div>
            ) : m.kind === 'suggest' ? (
              m.state === 'dismissed' || !nt.liveAssist ? null : (
                <QuorumCard key={i}>
                  <p>{m.text}</p>
                  <div className="row">
                    {m.state === 'open' ? (
                      <>
                        <button className="pill primary" onClick={() => acceptSuggestion(m.id)}>Yes</button>
                        <button className="pill" onClick={() => dismissSuggestion(m.id)}>Not now</button>
                      </>
                    ) : <span className="muted small">Searching your notes…</span>}
                    <span className="hint">{m.caption}</span>
                  </div>
                </QuorumCard>
              )
            ) : m.kind === 'event' ? (
              <QuorumCard key={i}><p><span className="emoji">{m.tone === 'stop' ? '🛑' : '🏎️'}</span>{m.text}</p></QuorumCard>
            ) : (
              <div key={i} className="turn">
                {(m.pending || (m.steps?.length ?? 0) > 0) && <Steps steps={m.steps ?? []} live={!!m.pending} />}
                {(!m.pending || m.text) && <QuorumCard>
                <Markdown text={m.text} root={brain?.root} />
                {m.sources?.map((src) => (
                  <div key={src.rel} className="source">
                    <span className="source-icon"><IconDoc /></span>
                    <button className="source-text" onClick={() => openInQuorum(src.abs)} data-tip="Open in Quorum">
                      <strong>[{src.n}] {src.title}</strong>
                      <span>{src.rel.replace(/^MyBrain\//, '')}</span>
                    </button>
                    <button className="icon-btn" aria-label={`Show in ${src.app}`} data-tip={`Show in ${src.app}`} onClick={() => window.quorum.openNote(src.abs)}><IconFolder /></button>
                  </div>
                ))}
              </QuorumCard>}
              </div>
            ))}
            <div ref={chatEnd} style={{ flex: 'none', minHeight: spacer }} />
          </div>
          <Composer value={draft} onChange={setDraft} onSubmit={(q, f) => send(q, f)} inputRef={composer} disabled={!brain}
            placeholder={!brain ? 'Connect your Agent OS to start' : phase === 'listening' ? 'Message Quorum privately…' : `Ask ${brain.name} anything…`} />
        </>
      )}

      {tab === 'notes' && (
        <div className="body">
          <section className="card transcript">
              {inCall(phase) && <SoFar s={soFar} lines={lines} partial={partial} who={who} me={me} ticker={false} />}
              {nt.liveAssist && lines.some((l) => l.channel === 'them') && (
                <div className="transcript-head">
                  <button className="pill ghost small" disabled={naming} data-tip="Quorum names the other speakers from context. One other participant needs no model." onClick={nameSpeakers}>{naming ? <><span className="spinner tiny" /> Naming…</> : 'Name speakers'}</button>
                </div>
              )}
              {lines.map((l, i) => (
                <TranscriptRow key={l.id} line={l} tail={liveWords && i === lines.length - 1 ? partial[l.channel] : ''} name={who(l)} meName={me.name} mePhoto={me.photo} themLabel={themLabel} participants={participants} similar={similar(l)} onPick={pickSpeaker} />
              ))}
              {liveWords && (['me', 'them'] as const).map((c) => (partial[c] && lines[lines.length - 1]?.channel !== c ? <p key={`p-${c}`} className={c}><span className="spk"><Avatar name={c === 'me' ? me.name || 'You' : who({ channel: c })} photo={c === 'me' ? me.photo : null} /><span>{who({ channel: c })}</span></span><div><em className="partial">{partial[c]}</em></div></p> : null))}
              {!lines.length && !partial.me && !partial.them && (
                <p className="muted">{phase === 'listening' ? 'Waiting for speech…' : 'The live transcript shows up here while Quorum is listening.'}</p>
              )}
              <div ref={notesEnd} />
          </section>
          <details className="card logs-fold">
            <summary>Logs{log.length ? ` · ${log.length}` : ''}</summary>
            <div className="logs">{log.length === 0 ? <p className="muted">Nothing yet.</p> : log.map((l, i) => <div key={i}>{l}</div>)}</div>
          </details>
        </div>
      )}

      {tab === 'mine' && (
        <div className="body">
          <section className="card my-notes-card">
            <h3>Your notes</h3>
            <PrivateNotes ref={mineRef} value={mine.text} onChange={mine.change} onBlur={mine.flush} />
          </section>
          {inCall(phase) && <SoFar s={soFar} lines={lines} partial={partial} who={who} me={me} compact />}
        </div>
      )}
      </>}
    </div>
  );
}

// what the agent did, between the question and the answer: the running step shimmers, then "Used N steps" opens the history
function Steps({ steps, live }: { steps: string[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  const label = live ? steps[steps.length - 1] ?? 'Thinking…' : `Used ${steps.length} ${steps.length === 1 ? 'step' : 'steps'}`;
  return (
    <div className={`steps ${live ? 'live' : ''}`}>
      <button className="steps-row" onClick={() => setOpen((o) => !o)} disabled={!steps.length} aria-expanded={open}>
        {live ? <span className="spinner tiny" /> : <IconSearch width={14} height={14} />}
        <span className={`steps-label ${live ? 'shimmer' : ''}`}>{label}</span>
        {steps.length > 0 && <IconChevron className={open ? 'flip' : ''} />}
      </button>
      {open && (
        <ol className="steps-list">
          {steps.map((st, i) => <li key={i} className={live && i === steps.length - 1 ? 'active' : ''}>{st}</li>)}
        </ol>
      )}
    </div>
  );
}

// the call so far: the summary, decisions, actions and open questions the running pass has gathered, with the
// latest words underneath so the view moves between passes. Compact drops the lists and the ticker
function SoFar({ s, lines, partial, who, me, compact = false, ticker = true }: { s: SummaryEvent | null; lines: Line[]; partial: { me: string; them: string }; who: (l: { channel: 'me' | 'them'; speaker?: string | null }) => string; me: { name: string; photo: string | null }; compact?: boolean; ticker?: boolean }) {
  const st = s?.state;
  const has = !!st && !!(st.summary || st.decisions.length || st.actions.length || st.questions.length);
  const last = lines[lines.length - 1];
  const tail = last ? partial[last.channel] : partial.me || partial.them;
  const ago = s?.at ? Math.max(0, Math.round((Date.now() - s.at) / 60000)) : null;
  const head = s?.thinking ? <span className="shimmer">Updating the summary…</span>
    : has ? `So far${ago != null ? ` · updated ${ago === 0 ? 'just now' : `${ago} min ago`}` : ''}`
    : lines.length ? <span className="sofar-wait">Listening · {lines.length} {lines.length === 1 ? 'turn' : 'turns'} · the summary starts after a few exchanges</span>
    : <span className="sofar-wait">Listening · waiting for the first words</span>;
  return (
    <div className={`sofar ${compact ? 'compact' : ''}`} aria-live="polite">
      <div className="sofar-head"><span className="live-dot pulse" aria-hidden="true" />{head}</div>
      {has && st.summary && <p className="sofar-summary">{st.summary}</p>}
      {has && !compact && st.decisions.length > 0 && <div className="sofar-group"><h4>Decisions</h4><ul>{st.decisions.map((d, i) => <li key={i}>{d.text}{d.status === 'suggested' && <em> · suggested</em>}</li>)}</ul></div>}
      {has && st.actions.length > 0 && <div className="sofar-group"><h4>Actions</h4><ul>{st.actions.map((a, i) => <li key={i}>{a.task}{a.owner && <em> · {a.owner}</em>}</li>)}</ul></div>}
      {has && !compact && st.questions.length > 0 && <div className="sofar-group"><h4>Open</h4><ul>{st.questions.map((q, i) => <li key={i}>{q.text}</li>)}</ul></div>}
      {ticker && !compact && (last || tail) && (() => { const l = last ?? { channel: partial.them ? 'them' as const : 'me' as const }; const name = who(l); return (
        <p className="sofar-ticker"><span className="spk"><Avatar name={l.channel === 'me' ? me.name || 'You' : name} photo={l.channel === 'me' ? me.photo : null} /><span>{name}</span></span><span className="ticker-text">{last?.text}{tail && <em className="partial"> {tail}</em>}</span></p>
      ); })()}
    </div>
  );
}

function QuorumCard({ children }: { children: ReactNode }) {
  return (
    <div className="quorum-row">
      <img className="avatar" src={markProd} alt="Quorum" />
      <div className="card">{children}</div>
    </div>
  );
}

// a view that loads on first use: a short wait line while its code comes in, and if the import fails (the app's files
// changed underneath the window) a way to try again or close, so the page behind it is never out of reach
class LazyView extends Component<{ name: string; onClose: () => void; children: ReactNode }, { error: Error | null; attempt: number }> {
  state = { error: null as Error | null, attempt: 0 };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error('lazy view failed:', error.message); }
  render() {
    const { error, attempt } = this.state;
    if (error) {
      return (
        <div className="card lazy-fail" role="alert">
          <p>Quorum could not load {this.props.name}. {STALE_BUNDLE.test(error.message) ? "The app's files changed while this window was open." : 'A part of the app failed to load.'} Your notes and transcript are safe.</p>
          <div className="row">
            <button className="pill primary" onClick={() => this.setState({ error: null, attempt: attempt + 1 })}>Try again</button>
            <button className="pill" onClick={this.props.onClose}>Close</button>
          </div>
        </div>
      );
    }
    return <Suspense key={attempt} fallback={<p className="muted lazy-wait">Opening {this.props.name}…</p>}>{this.props.children}</Suspense>;
  }
}

// one transcript row; memoized, so partial words landing on the last row leave the rows above untouched
const TranscriptRow = memo(function TranscriptRow({ line, tail, name, meName, mePhoto, themLabel, participants, similar, onPick }: {
  line: Line; tail: string; name: string; meName: string; mePhoto: string | null; themLabel: string; participants: string[]; similar: number;
  onPick: (id: number, name: string | null, similar: boolean) => Promise<void>;
}) {
  return (
    <p className={line.channel}>
      <span className="spk"><Avatar name={line.channel === 'me' ? meName || 'You' : name} photo={line.channel === 'me' ? mePhoto : null} />{line.channel === 'them' ? <SpeakerName turn={line} fallback={themLabel} participants={participants} similar={similar} onPick={(n, s) => onPick(line.id, n, s)} /> : <span>{name}</span>}</span>
      <div>{line.text}{tail && <em className="partial"> {tail}</em>}</div>
    </p>
  );
});

// the wizard's account step is the same card as Settings › Workspace, so sign-in state is shared; the local edition
// has no account and says so in the same slot
function OnboardingShell({ brain, onBrain, onDone }: { brain: Brain | null; onBrain: (b: Brain | null) => void; onDone: () => void }) {
  const slot = <AccountArea fallback={<p className="onb-muted">Sign in from Settings › Workspace once you are in.</p>} local={<p className="onb-muted">Local edition. Everything stays on this Mac.</p>} />;
  return <Suspense fallback={null}><Onboarding brain={brain} onBrain={onBrain} onDone={onDone} accountSlot={slot} /></Suspense>;
}
