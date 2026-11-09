import { Component, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Brain, HelperEvent, MeetingMeta, Notes, NotesDraft, Settings, Source, SpeakersEvent } from './quorum';
import { Markdown } from './Markdown';
import { useSession } from './session';
import { EndView } from './EndView';
import { Onboarding } from './Onboarding';
import { AccountArea } from './edition';
import markProd from '../assets/quorum-mark.png';
import markDev from '../assets/quorum-mark-dev.png';

const mark = window.quorum.isDev ? markDev : markProd;
if (window.quorum.isDev) document.documentElement.dataset.dev = '';
import { HistoryView } from './HistoryView';
import { KnowledgeView, type KbCommand } from './KnowledgeView';
import { Composer } from './Composer';
import { SettingsView } from './SettingsView';
import { SpeakerName, similarCount, type SpeakerInfo } from './Speaker';
import { IconFolderOpen, IconPerson, IconGear, IconHome, IconGraph, IconSearch, IconFolder, IconDoc, IconExternal, IconArrowUp, IconBack, IconChat, IconChevron, IconNotes, IconStop, IconPause, IconPlay, Wave } from './icons';

// one speaker turn as main.js built it; a turn that grows arrives again with the same id and replace: true
type Line = { id: number; channel: 'me' | 'them'; text: string; start: number } & Partial<SpeakerInfo>;
type Phase = 'idle' | 'starting' | 'listening' | 'paused' | 'review' | 'blocked';
type Tab = 'home' | 'knowledge' | 'chat' | 'notes';
const inCall = (p: string) => p === 'listening' || p === 'paused' || p === 'starting';
// Home and Knowledge always sit in the middle; on a call, Chat, live Notes and Logs open up beside Listening
const MAIN_TABS = [['home', IconHome, 'Home'], ['knowledge', IconGraph, 'Knowledge']] as const;
const CALL_TABS = [['chat', IconChat, 'Chat'], ['notes', IconNotes, 'Live notes']] as const;
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
    return (
      <div className="panel"><div className="body">
        <div className="card">Something broke: {this.state.error.message}</div>
        <button className="pill primary" onClick={() => this.setState({ error: null })}>Reload view</button>
      </div></div>
    );
  }
}

const SUGGESTIONS = ['Summarize so far', 'What did I commit to?', 'Any open questions?'];

export function App() {
  const [phase, setPhase] = useState<Phase>('idle');
  // paused from the header keeps the call; STOP from the chat deletes it
  const [held, setHeld] = useState(false);
  const [tab, setTab] = useSession<Tab>('tab', 'home', (t) => t === 'home' || t === 'knowledge');
  // off a call, chat lives inside Home as a conversation opened from Ask anything or a saved chat
  const [convoOpen, setConvoOpen] = useState(false);
  const [me, setMe] = useState<{ name: string; photo: string | null }>({ name: '', photo: null });
  const [focusAsk, setFocusAsk] = useState(0);
  const convoRef = useRef(false);
  convoRef.current = convoOpen;
  const phaseRef = useRef<Phase>('idle');
  const [view, setView] = useSession<'main' | 'settings'>('view', 'main');
  const [kbCommand, setKbCommand] = useState<KbCommand>(null);
  // a cited note opens in Quorum's Knowledge view
  const openInQuorum = (abs: string) => {
    if (!brain || !abs.startsWith(`${brain.vault}/`)) { window.quorum.openNote(abs); return; }
    setView('main');
    setTab('knowledge');
    setKbCommand({ kind: 'open', rel: abs.slice(brain.vault.length + 1), n: Date.now() });
  };
  // Obsidian's keys work from anywhere in Quorum: they jump to Knowledge and open the overlay
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.altKey || e.ctrlKey) return;
      const k = e.key.toLowerCase();
      const kind = k === 'o' && !e.shiftKey ? 'switcher' : k === 'p' && !e.shiftKey ? 'palette' : k === 'f' && e.shiftKey ? 'search' : null;
      if (!kind) return;
      e.preventDefault();
      setView('main');
      setTab('knowledge');
      setKbCommand({ kind, n: Date.now() });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setView, setTab]);
  const [menuOpen, setMenuOpen] = useState<null | 'status' | 'model' | 'brain'>(null);
  const [brain, setBrain] = useState<Brain | null>(null);
  // a fresh install shows the wizard until onboarding-done; null until the main process answers
  const [firstRun, setFirstRun] = useState<boolean | null>(null);
  useEffect(() => { window.quorum.onboardingStatus().then((s) => setFirstRun(s.firstRun)).catch(() => setFirstRun(false)); }, []);
  const [settingsPage, setSettingsPage] = useState<{ page: 'preferences' | 'memory' | 'connectors'; n: number } | null>(null);
  const openSettings = (page: 'preferences' | 'memory' | 'connectors') => { setSettingsPage({ page, n: Date.now() }); setView('settings'); };
  // the composer sits in three views, so its "Choose a model source" button asks for Settings through a window event
  useEffect(() => {
    const open = (e: Event) => openSettings((e as CustomEvent<'connectors'>).detail ?? 'preferences');
    window.addEventListener('quorum-open-settings', open);
    return () => window.removeEventListener('quorum-open-settings', open);
  }, []);
  const composer = useRef<HTMLTextAreaElement>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [partial, setPartial] = useState<{ me: string; them: string }>({ me: '', them: '' });
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [draft, setDraft] = useState('');
  const [log, setLog] = useState<string[]>([]);
  const [notes, setNotes] = useState<Notes | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const [notesDraft, setNotesDraft] = useState<NotesDraft | null>(null);
  const [meta, setMeta] = useState<MeetingMeta | null>(null);
  const [settings, setSettings] = useState<Settings>({ autoListen: false, model: 'sonnet', suggestions: true });
  const [themName, setThemName] = useState<string | null>(null);
  const [participants, setParticipants] = useState<string[]>([]);
  const [naming, setNaming] = useState(false);
  useEffect(() => { window.quorum.user().then((u) => setMe({ name: u?.name ?? '', photo: u?.photo ?? null })); }, [settings.profile]);
  const [unread, setUnread] = useState(false);
  const tabRef = useRef<Tab>('chat');
  tabRef.current = tab;
  const toggleMenu = (m: 'status' | 'model' | 'brain') => (e: React.MouseEvent) => { e.stopPropagation(); setMenuOpen((o) => (o === m ? null : m)); };
  const chatEnd = useRef<HTMLDivElement>(null);
  // a sent question is pinned to the top of the pane while its answer streams in below it; the spacer under the answer
  // gives the question room to reach the top and shrinks as the answer grows. Everything else scrolls to the end
  const bodyRef = useRef<HTMLDivElement>(null);
  const lastUser = useRef<HTMLDivElement>(null);
  const anchored = useRef(false);
  const anchorScroll = useRef(false);
  const [spacer, setSpacer] = useState(0);
  const notesEnd = useRef<HTMLDivElement>(null);

  const addLog = (s: string) => setLog((l) => [...l.slice(-200), `${new Date().toLocaleTimeString()}  ${s}`]);
  const resetMeeting = () => { setLines([]); setPartial({ me: '', them: '' }); setMsgs([]); setNotes(null); setMeta(null); setParticipants([]); };
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
        else if (e.event === 'chatSent') addLog(`posted in Zoom chat: ${e.text.slice(0, 60)}…`);
        else if (e.event === 'axStatus') addLog(`accessibility ${e.trusted ? 'granted' : 'NOT granted'}, Zoom ${e.zoomRunning ? 'running' : 'not running'}`);
        else if (e.event === 'audioRoute') addLog(`audio out: ${e.name || e.route} (${e.route})`);
      }),
      window.quorum.onSpeakers(applySpeakers),
      window.quorum.onState((s) => {
        if (s.phase === 'starting') { setPhase('starting'); addLog("posting Quorum's notice in the Zoom chat…"); return; }
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
  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menuOpen]);


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
  if (firstRun === null) return <div className="panel" />;
  if (firstRun) {
    return <div className="panel"><OnboardingShell brain={brain} onBrain={setBrain} onDone={() => setFirstRun(false)} /></div>;
  }

  if (phase === 'review') {
    return <EndView notes={notes} draft={notesDraft} meta={meta} summarizing={summarizing} transcript={lines.map((l) => ({ ...l, who: who(l) }))} participants={participants} onSpeaker={setSpeaker} onClose={() => { setPhase('idle'); resetMeeting(); setTab('home'); }} />;
  }

  return (
    <div className={`panel ${view === 'main' && tab === 'home' && convoOpen ? 'convo-wide' : ''}`}>
      <header className="bar">
        <div className="brand static"><img src={mark} alt={window.quorum.isDev ? 'Quorum Dev' : 'Quorum'} /></div>
        <nav className="tabs" aria-label="Views">
          {MAIN_TABS.map(([id, Icon, label]) => (
            <button key={id} className={`tab ${view === 'main' && tab === id ? 'on' : ''}`} aria-label={label} data-tip={label}
              onClick={() => { setView('main'); setTab(id); }}>
              <Icon />
            </button>
          ))}
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
            {phase === 'listening' && <button className="icon-btn call-btn" aria-label="Pause" data-tip="Pause" onClick={() => window.quorum.pause()}><IconPause /></button>}
            {phase === 'paused' && <button className="icon-btn call-btn" aria-label="Resume" data-tip="Resume" onClick={() => window.quorum.resume()}><IconPlay /></button>}
            {(phase === 'listening' || phase === 'paused') && <button className="icon-btn call-btn" aria-label="Stop and summarize" data-tip="Stop and summarize" onClick={() => window.quorum.end()}><IconStop /></button>}
            {/* one button from idle to listening, so the label that slid out on hover is the one that turns green */}
            <button className={`status listen ${phase === 'blocked' ? 'off-call' : phase}`} onClick={phase === 'idle' ? () => window.quorum.start() : undefined}
              data-tip={phase === 'blocked' ? 'Someone on your never-listen list is in this call' : undefined} aria-label={phase === 'idle' ? 'Listen' : status.label}>
              <span className="listen-hint">{phase === 'idle' ? 'Listen' : status.label}</span>{status.icon}
            </button>
          </div>
          <div className="status-wrap">
            <button className={`icon-btn brain ${view === 'settings' ? 'active' : ''}`} data-tip="Settings" aria-label="Settings and Agent OS"
              onClick={toggleMenu('brain')} aria-haspopup="menu" aria-expanded={menuOpen === 'brain'}>
              <IconGear width={19} height={19} />
            </button>
            {menuOpen === 'brain' && (
              <div className="menu brain-menu" role="menu">
                <button role="menuitem" className="brain-item" onClick={() => { setMenuOpen(null); openSettings('memory'); }}>
                  <IconFolder width={18} height={18} className={brain ? 'ok' : 'err'} />
                  <strong>{brain ? brain.name : 'No Agent OS'}</strong><em>{brain ? brain.root.replace(/^\/Users\/[^/]+/, '~') : 'Not connected'}</em>
                </button>
                <button role="menuitem" className="brain-item" disabled>
                  <IconFolderOpen width={18} height={18} /><strong>Team vault</strong><em className="soon">Coming soon</em>
                </button>
                <div className="menu-sep" />
                <button role="menuitem" onClick={() => { setMenuOpen(null); openSettings('preferences'); }}>Settings</button>
                <button role="menuitem" onClick={() => window.quorum.quit()}>Quit Quorum</button>
              </div>
            )}
          </div>
        </div>
      </header>

      {view === 'settings' ? (
        <div className="body wide flush">
          <SettingsView open={settingsPage} brain={brain} settings={settings} onSettings={setSettings} onConnect={async () => setBrain(await window.quorum.connectBrain())} onBack={() => setView('main')} />
        </div>
      ) : <>
      {tab === 'home' && !convoOpen && (
        <div className="body wide">
          <HistoryView brain={brain} focusAsk={focusAsk} onAsk={(q, f) => { setConvoOpen(true); send(q, f); }} onOpenChat={openChat} />
        </div>
      )}

      {tab === 'knowledge' && (
        <div className="body wide flush">
          <KnowledgeView brain={brain} command={kbCommand} />
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
                <p>{brain ? `Ask me anything from ${brain.name}. ` : 'Connect your Agent OS so I can answer from your notes. '}When a call starts, I post a notice in the Zoom chat and listen on your Mac.</p>
                <div className="row">
                  <button className="pill primary" onClick={() => window.quorum.start()}>Start listening</button>
                  <span className="hint">{settings.autoListen ? <><span className="live-dot" aria-hidden="true" />Auto-listen is on</> : 'Or turn on auto-listen in Settings'}</span>
                </div>
              </QuorumCard>
            )}
            {phase === 'starting' && <QuorumCard><p className="muted">Posting my notice in the Zoom chat…</p></QuorumCard>}
            {phase === 'listening' && msgs.length === 0 && (
              <QuorumCard>
                <p>I'm listening. Ask me anything about this meeting; only you see this chat.</p>
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
              m.state === 'dismissed' ? null : (
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
              {lines.some((l) => l.channel === 'them') && (
                <div className="transcript-head">
                  <button className="pill ghost small" disabled={naming} data-tip="Quorum names the other speakers from context. One other participant needs no model." onClick={nameSpeakers}>{naming ? <><span className="spinner tiny" /> Naming…</> : 'Name speakers'}</button>
                </div>
              )}
              {lines.map((l, i) => {
                const tail = liveWords && i === lines.length - 1 ? partial[l.channel] : '';
                return (
                  <p key={l.id} className={l.channel}>
                    {l.channel === 'them' ? <SpeakerName turn={l} fallback={themLabel} participants={participants} similar={similarCount(lines, l)} onPick={(name, similar) => setSpeaker(l.id, name, similar)} /> : <span>{who(l)}</span>}
                    <div>{l.text}{tail && <em className="partial"> {tail}</em>}</div>
                  </p>
                );
              })}
              {liveWords && (['me', 'them'] as const).map((c) => (partial[c] && lines[lines.length - 1]?.channel !== c ? <p key={`p-${c}`} className={c}><span>{who({ channel: c })}</span><div><em className="partial">{partial[c]}</em></div></p> : null))}
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

function QuorumCard({ children }: { children: ReactNode }) {
  return (
    <div className="quorum-row">
      <img className="avatar" src={markProd} alt="Quorum" />
      <div className="card">{children}</div>
    </div>
  );
}

// the wizard's account step is the same card as Settings › Workspace, so sign-in state is shared; the local edition
// has no account and says so in the same slot
function OnboardingShell({ brain, onBrain, onDone }: { brain: Brain | null; onBrain: (b: Brain | null) => void; onDone: () => void }) {
  const slot = <AccountArea fallback={<p className="onb-muted">Sign in from Settings › Workspace once you are in.</p>} local={<p className="onb-muted">Local edition. Everything stays on this Mac.</p>} />;
  return <Onboarding brain={brain} onBrain={onBrain} onDone={onDone} accountSlot={slot} />;
}
