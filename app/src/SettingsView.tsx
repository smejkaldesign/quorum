import { ConfirmModal } from './ConfirmModal';
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { SetupForm, answersFrom, draftFrom, draftIsEmpty, emptyDraft, type SetupDraft } from './SetupForm';
import type { AccountState, BetaState, Brain, CalendarSettings, DecisionProvider, DecisionsStatus, KeeperPlugin, KeeperStatus, LearnedTarget, Memory, MemoryItem, OptOut, Profile, ScreenContextStatus, Settings, TeamVault, Transcription, UpdateState, Voice, Workspace } from './quorum';
import { PersonalConnectors } from './Connectors';
import { ConnectorsPage, connectorDetailName } from './ConnectorsPage';
import { GuardrailsPage } from './Guardrails';
import { CONNECTORS, CONNECTOR_BY_ID } from '../connectors/library';
import { ConnectHint } from './ConnectHint';
import { connectorsScroll, openConnectors, type ConnectorsTarget } from './connectorsNav';
import { BY_ID } from '../connectors/catalog';
import { useSession } from './session';
import { EmptyState, Modal, ModalActions, Row, Toggle, useMenu } from './controls';
import { BrainCheckPanel, ContextPanel, SkillsPanel } from './PluginPanels';
import { AccountArea, BillingArea, DeleteAccountArea, DeleteOrgArea, EDITION, KnowledgeBasesArea, KnowledgeQueueArea, MembersArea, TeamsArea, WorkspaceConnectorsArea, WorkspaceGuardrailsArea, WorkspaceVoiceArea, useHostedAccounts } from './edition';
import { TOP_ADMIN_PAGES, canAdmin, flagHiddenPages, modeOf, resolvePage, voiceMode, workspacePages, type Page } from './settingsNav';
import { EnvSwitch } from './EnvSwitch';
import { AgentRows, ConnectionCheckButton, ConnectionCheckList, useAgents, useConnectionCheck, type Agents } from './AgentLinks';
import { MeetingSourcesRows } from './MeetingSources';
import { useFlag, useFlags, useNotetaker } from './flags';
import { MemoryUpdatesCard } from './MemoryUpdates';
import { MemoryRulesCard } from './MemoryRules';
import { LocalModelsCard } from './LocalModels';
import {
  IconBell, IconBrain, IconBuilding, IconCalendar, IconChat, IconFolder, IconGrid, IconKeyboard, IconLock,
  IconChevron, IconCode, IconExternal, IconGlobe, ProviderMark, IconMic, IconMore, IconNotes, IconPeople, IconPerson, IconPlus, IconPower, IconReset, IconSliders, IconStack, IconCheck, IconCopy, IconFolderFill, IconFork, IconShield, IconGraph, IconSearch, IconClose, Wave,
  IconInfo, IconQuorum, IconUpload, IconListCheck, IconTrash, IconScale,
} from './icons';

type Nav = { id: Page; label: string; icon: (p: { width?: number; height?: number }) => ReactNode; soon?: boolean };

const ACCOUNT: Nav[] = [
  { id: 'preferences', label: 'Preferences', icon: IconSliders },
  { id: 'memory', label: 'Memory', icon: IconBrain },
  { id: 'calendar', label: 'Calendar', icon: IconCalendar },
  { id: 'meetings', label: 'Meetings', icon: IconMic },
  { id: 'voice', label: 'Voice typing', icon: IconKeyboard },
];
// the pages behind the Admin button; settingsNav.workspacePages decides which of them a build lists. The first two are
// about the person; the rest sit under the Workspace heading
const WORKSPACE: Nav[] = [
  { id: 'general', label: 'General', icon: IconBuilding },
  { id: 'notifications', label: 'Notifications', icon: IconBell },
  { id: 'developers', label: 'AI tools', icon: IconCode },
  { id: 'guardrails', label: 'Guardrails', icon: IconShield },
  { id: 'connectors', label: 'Connectors', icon: IconGrid },
  { id: 'teams', label: 'Teams', icon: IconPeople },
  { id: 'billing', label: 'Billing', icon: IconScale },
  { id: 'knowledge', label: 'Knowledge', icon: IconBrain },
  { id: 'members', label: 'Members', icon: IconPerson },
  { id: 'org-connectors', label: 'Connectors', icon: IconGrid },
  { id: 'org-voice', label: 'Voice typing', icon: IconKeyboard },
  { id: 'org-guardrails', label: 'Guardrails', icon: IconShield },
];

// the chip on every row whose control is disabled on purpose: the feature is planned and the row shows what it will do
const Soon = () => <em className="soon">Soon</em>;

export function SettingsView({ open, brain, settings, onSettings, onConnect, onDisconnect, onBrain, onBack }: {
  open?: ({ page: Page; n: number } & ConnectorsTarget) | null; brain: Brain | null; settings: Settings; onSettings: (s: Settings) => void; onConnect: () => void; onDisconnect: () => void; onBrain?: (b: Brain) => void; onBack: () => void;
}) {
  const nt = useNotetaker();
  const [saved, setPage] = useSession<Page>('settingsPage', 'preferences');
  // an open connector detail page; cleared when the page changes
  const [connectorDetail, setConnectorDetail] = useState<string | null>(null);
  // a page change clears the detail, so a connector named along with a page change waits until the page has changed
  // the group a link from outside Settings pointed at (Home's hints, the Memory page); Connectors scrolls to it
  const [connectorsFocus, setConnectorsFocus] = useState<{ cat: string | true; n: number } | null>(null);
  const pending = useRef<string | null>(null);
  // the connector library (Add connector) is open; a connector opened from it keeps it as the middle breadcrumb
  const [connLib, setConnLib] = useState(false);
  const pendingLib = useRef(false);
  useEffect(() => { setConnectorDetail(pending.current); pending.current = null; setConnLib(pendingLib.current); pendingLib.current = false; }, [saved]);
  const goConnector = (id: string) => { if (saved !== 'connectors') pending.current = id; setConnectorDetail(id); setPage('connectors'); };
  useEffect(() => {
    if (!open) return;
    // a link naming a library category opens the library there
    const lib = !!open.library && !open.connector;
    if (open.page !== saved) { pending.current = open.connector ?? null; pendingLib.current = lib; } else { setConnectorDetail(open.connector ?? null); setConnLib(lib); }
    setPage(open.page);
    setConnectorsFocus(open.library ? { cat: open.library, n: open.n } : null);
  }, [open, setPage]);
  const [user, setUser] = useState<{ name: string; email: string; photo: string | null } | null>(null);
  useEffect(() => { window.quorum.user().then(setUser); }, [settings.profile]);
  // the Quorum account comes first; without one, the Claude sign-in on this Mac is the only identity there is
  const [account, setAccount] = useState<AccountState | null>(null);
  useEffect(() => { let live = true; window.quorum.accountStatus().then((a) => { if (live) setAccount(a); }).catch(() => {}); return () => { live = false; }; }, [settings.profile]);
  useEffect(() => { if (!window.quorum.onAccount) return; return window.quorum.onAccount(setAccount); }, []);
  const admin = canAdmin(EDITION, account?.workspace?.role);
  // a cloud build without hosted account config has no members to list, so the page leaves the nav; the team-level
  // pages come and go with the Teams page's switch
  const hosted = useHostedAccounts();
  const listed = workspacePages(EDITION, hosted, account?.workspace?.teamEnabled === true, account?.workspace?.role);
  const voice = voiceMode(nt.dictation, nt.manualListen);
  const guardrailsOn = useFlag('guardrails');
  const customGuardrails = useFlag('guardrails-custom');
  const hidden = flagHiddenPages(voice, guardrailsOn, customGuardrails);
  const page = resolvePage(saved, admin, listed, hidden);
  const mode = modeOf(page);
  const quorumEmail = account?.signedIn ? account.email : null;
  const email = quorumEmail || user?.email || '';
  // in the hosted edition the identity is the Quorum account; until there is one the row holds only the photo, and the
  // sign-in card lower on the page says what signing in adds. The local edition's only identity is the Claude Code sign-in
  const emailLabel = quorumEmail ? 'Email' : EDITION === 'cloud' ? 'Photo' : 'Signed in with Claude Code';
  const showEmail = !!quorumEmail || EDITION !== 'cloud';
  // the content pane scrolls: a connector's page opens at its top with its heading focused, and Back to the list or
  // the library returns to where it was (connectorsScroll)
  const mainRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const scrollView = page === 'connectors' ? (connectorDetail ? `connectors:detail:${connectorDetail}` : connLib ? 'connectors:library' : 'connectors:list') : page;
  // top is the pane's scroll as of the last scroll event, so it still belongs to the view being left
  const scrollState = useRef<{ view: string; top: number; saved: Record<string, number> }>({ view: scrollView, top: 0, saved: {} });
  useLayoutEffect(() => {
    const box = mainRef.current;
    const { top, saved: kept } = connectorsScroll(scrollState.current.view, scrollView, scrollState.current.top, scrollState.current.saved);
    scrollState.current = { view: scrollView, top: top ?? box?.scrollTop ?? 0, saved: kept };
    if (box && top !== null) box.scrollTop = top;
    if (scrollView.startsWith('connectors:detail:') && top !== null) titleRef.current?.focus({ preventScroll: true });
  }, [scrollView]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onBack(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onBack]);

  const set = async (patch: Partial<Settings>) => onSettings(await window.quorum.setSettings(patch));
  // with dictation off, the account Voice typing page is Notes: what Record captures, then the Dictionary (settingsNav.voiceMode)
  const named = (n: Nav): Nav => (n.id === 'voice' && voice === 'dictionary' ? { ...n, label: 'Notes' } : n);
  const accountNav = ACCOUNT.filter((n) => !hidden.includes(n.id)).map(named);
  const adminNav = WORKSPACE.filter((n) => (listed as Page[]).includes(n.id) && !hidden.includes(n.id));
  const topNav = adminNav.filter((n) => (TOP_ADMIN_PAGES as Page[]).includes(n.id));
  const workspaceNav = adminNav.filter((n) => !(TOP_ADMIN_PAGES as Page[]).includes(n.id));
  const all = [...ACCOUNT, ...WORKSPACE].map(named);
  const current = all.find((n) => n.id === page)!;

  const navItem = (n: Nav) => (
    <button key={n.id} className={`set-nav ${page === n.id ? 'on' : ''}`} onClick={() => setPage(n.id)}>
      <n.icon width={18} height={18} /><span>{n.label}{n.soon && <em className="soon grey">Soon</em>}</span>
    </button>
  );
  const go = (p: Page) => setPage(p);

  return (
    <div className="settings-shell">
      <aside className="set-side">
        <div className="set-user">
          <span className="set-avatar">{user?.photo ? <img src={user.photo} alt="" /> : (user?.name ?? 'H')[0]}</span>
          <strong>{user?.name ?? ' '}</strong>
          <span>{email || 'Not signed in to Claude'}</span>
        </div>
        <nav className="set-navs">
          {mode === 'account' ? (
            <>
              {accountNav.map(navItem)}
              {admin && <button className="set-nav admin" onClick={() => go('general')}><IconBuilding width={18} height={18} /><span>Admin</span></button>}
            </>
          ) : (
            <>
              <button className="set-menu-back" onClick={() => go('preferences')}><IconChevron width={16} height={16} />Menu</button>
              {topNav.map(navItem)}
              {workspaceNav.length > 0 && <h4>Workspace</h4>}
              {workspaceNav.map(navItem)}
            </>
          )}
        </nav>
        <button className="set-quit" onClick={() => window.quorum.quit()}><IconPower width={18} height={18} /> Quit Quorum</button>
      </aside>

      <main className="set-main" ref={mainRef} onScroll={(e) => { scrollState.current.top = e.currentTarget.scrollTop; }}>
        <div className="set-col">
          {page === 'connectors' && ((connectorDetail && connectorDetailName(connectorDetail)) || connLib)
            ? <h1 className="set-title crumbs" ref={titleRef} tabIndex={-1}>
                <Crumb label="Connectors" onClick={() => { setConnectorDetail(null); setConnLib(false); }} />
                {connLib && <>{CRUMB_SEP}{connectorDetail ? <Crumb label="Library" onClick={() => setConnectorDetail(null)} /> : <span className="crumb-here">Library</span>}</>}
                {connectorDetail && <>{CRUMB_SEP}<span className="crumb-here">{connectorDetailName(connectorDetail)}</span></>}
                {connLib && !connectorDetail && <span className="crumb-actions" id="conn-title-actions" />}
              </h1>
            : <h1 className={`set-title${page === 'connectors' ? ' crumbs' : ''}`}>{current.label}{current.soon && <Soon />}{page === 'connectors' && <span className="crumb-actions" id="conn-title-actions" />}</h1>}
          {page === 'preferences' && <p className="set-lede">Quorum works best knowing a little about you. Quorum uses this when it writes your meeting notes and answers questions.</p>}
          {page === 'knowledge' && <p className="set-lede">Company knowledge for your whole workspace, chosen by admins.</p>}
          {page === 'general' && <p className="set-lede">Settings for everyone in your workspace. Quorum gives this context to every meeting summary and answer, so it's the same for each person.</p>}
          {page === 'teams' && <p className="set-lede">A workspace starts as yours alone. Turn on a team to invite members and build knowledge together.</p>}
          {page === 'billing' && <p className="set-lede">Your plan, the card it charges, and this month's usage against the hours it includes.</p>}
          {page === 'connectors' && !connectorDetail && !connLib && <p className="set-lede">The apps and MCP servers Quorum is connected to, by area.</p>}
          {page === 'developers' && <p className="set-lede">Model providers, Claude Code and Terminal access, and API keys for your own scripts.</p>}
          {page === 'preferences' ? (
            <ProfilePage settings={settings} email={showEmail ? email : ''} emailLabel={emailLabel} name={user?.name ?? ''} onSettings={onSettings}>
              <h3>General</h3>
              <div className="set-card">
                {nt.liveAssist && <Row icon={<IconChat width={18} height={18} />} title="Suggest answers from my notes" desc="Offers your notes when someone asks you a question">
                  <Toggle on={settings.suggestions !== false} onChange={(v) => set({ suggestions: v })} />
                </Row>}
                {nt.screenContext && voice !== 'dictionary' && <ScreenContextRow />}
                <Row icon={<IconLock width={18} height={18} />} title="Data" desc="Transcribed on this Mac, answered by Claude Enterprise" />
              </div>
              <AboutCard />
            </ProfilePage>
          ) : page === 'knowledge' ? (
            <KnowledgePage />
          ) : page === 'general' ? (
            <WorkspacePage settings={settings} onSettings={onSettings} onGo={go} billing={(listed as string[]).includes('billing')}
              company={(listed as string[]).includes('teams') && account?.workspace?.teamEnabled === true ? null : <CompanyCard settings={settings} onSettings={onSettings} />} />
          ) : page === 'teams' ? (
            <TeamsArea company={<CompanyCard settings={settings} onSettings={onSettings} />} />
          ) : page === 'billing' ? (
            <BillingArea />
          ) : page === 'memory' ? (
            <>
              <SecondBrain part="folder" brain={brain} onConnect={onConnect} onDisconnect={onDisconnect} onBrain={onBrain} onViewConnector={goConnector} />
              {brain && <MemoryUpdatesCard settings={settings} onSettings={onSettings} after={<MemoryScan brain={brain} />} advanced={<><KeeperCard brain={brain} part="reports" /><MemoryRulesCard /><LocalModelsCard /></>} />}
            </>
          ) : page === 'members' ? <MembersArea />
            : page === 'org-connectors' ? <WorkspaceConnectorsArea local={<OrgConnectorsLocal onGo={go} />} />
            : page === 'org-voice' ? <WorkspaceVoiceArea local={<OrgVoiceLocal onGo={go} />} />
            : page === 'org-guardrails' ? <WorkspaceGuardrailsArea local={<p className="set-lede">Workspace guardrails come with Quorum Cloud: rules an admin sets once that every member's Quorum applies and cannot turn off. Your own rules live under Settings, Guardrails.</p>} />
            : page === 'guardrails' ? <GuardrailsPage />
            : page === 'calendar' ? <CalendarPage onConnector={goConnector} />
            : page === 'meetings' ? <MeetingsPage settings={settings} onSettings={onSettings} onConnector={goConnector} teamMeetings={EDITION === 'cloud' && account?.workspace?.teamEnabled === true}
                folders={<><SecondBrain part="meetings" brain={brain} onConnect={onConnect} onDisconnect={onDisconnect} onBrain={onBrain} onViewConnector={goConnector} />{brain && <KeeperCard brain={brain} part="upkeep" />}</>} />
            : page === 'developers' ? <DevelopersPage />
            : page === 'notifications' ? <NotificationsPage settings={settings} set={set} />
            : page === 'connectors' ? <ConnectorsPage detail={connectorDetail} onDetail={setConnectorDetail} library={connLib} onLibrary={setConnLib} brain={brain} onFolder={onConnect} onNotes={() => go('memory')} focus={connectorsFocus} />
            : <VoicePage settings={settings} onSettings={onSettings} dictionaryOnly={voice === 'dictionary'} screenRow={nt.screenContext} />}
        </div>
      </main>
    </div>
  );
}

// the Local edition's Workspace › Connectors and Voice typing: organization providers need a hosted workspace, so each
// page says so and points at the personal page that works on this Mac
function OrgConnectorsLocal({ onGo }: { onGo: (p: Page) => void }) {
  return (
    <EmptyState icon={<IconGrid width={22} height={22} />} title="Organization connectors are a Cloud feature">
      <p>In Quorum Cloud an admin adds speech, model and voice providers once, and every seat in the workspace uses them. The Local edition keeps every key on this Mac.</p>
      <button className="pill" onClick={() => onGo('connectors')}>Open your Connectors</button>
    </EmptyState>
  );
}

function OrgVoiceLocal({ onGo }: { onGo: (p: Page) => void }) {
  return (
    <EmptyState icon={<IconKeyboard width={22} height={22} />} title="Organization overrides are a Cloud feature">
      <p>In Quorum Cloud an admin chooses which provider handles speech to text, the running summary and the final notes for the whole workspace. The Local edition transcribes on this Mac with your own settings.</p>
      <button className="pill" onClick={() => onGo('voice')}>Open your Voice typing settings</button>
    </EmptyState>
  );
}

// the Agent OS, where Quorum saves notes, and meeting notes from other apps; Add takes a folder by hand when there's no connector for that app
function SecondBrain({ part, brain, onConnect, onDisconnect, onBrain, onViewConnector }: { part: 'folder' | 'meetings'; brain: Brain | null; onConnect: () => void; onDisconnect: () => void; onBrain?: (b: Brain) => void; onViewConnector: (id: string) => void }) {
  // the setup interview again, on a folder Quorum built: prefilled with the saved answers
  const [setup, setSetup] = useState<SetupDraft | null>(null);
  const [applying, setApplying] = useState(false);
  const openSetup = async () => { setCreating(false); let rec = null; try { rec = await window.quorum.setupRead(); } catch {} setSetup(draftFrom(rec?.answers)); };
  // the same form creates a folder for someone who skipped it in onboarding: name, location, the interview
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('My Agent OS');
  const [newDir, setNewDir] = useState<string | null>(null);
  const [defaultDir, setDefaultDir] = useState('~/Documents/Quorum');
  const [setupError, setSetupError] = useState('');
  const openCreate = async () => {
    setCreating(true); setSetupError(''); setSetup(emptyDraft());
    window.quorum.onboardingStatus().then((st) => setDefaultDir(st.defaultVaultDir)).catch(() => {});
    window.quorum.onboardingSetupSuggest().then((r) => { if (r.suggestion) setSetup((d) => (d && draftIsEmpty(d) ? draftFrom(r.suggestion) : d)); }).catch(() => {});
  };
  const applySetup = async () => {
    if (!setup) return;
    setApplying(true); setSetupError('');
    try {
      const b = creating ? await window.quorum.onboardingCreateVault(newDir, newName.trim() || 'My Agent OS', answersFrom(setup)) : await window.quorum.setupRerun(answersFrom(setup));
      onBrain?.(b); setSetup(null);
    } catch (e) { setSetupError(String((e as Error).message || e)); } finally { setApplying(false); }
  };
  const [connecting, setConnecting] = useMenu();
  type Source = Awaited<ReturnType<typeof window.quorum.meetingSources>>[number];
  const [sources, setSources] = useState<Source[]>([]);
  const [icons, setIcons] = useState<Record<string, string | null>>({});
  // folders that a connector feeds show the connection and offer its controls instead of the plain remove
  const [connected, setConnected] = useState<Record<string, { connected: boolean; syncNotes: boolean }>>({});
  const [adding, setAdding] = useMenu();
  const [confirm, setConfirm] = useState(false);
  const load = () => { window.quorum.meetingSources().then(setSources); window.quorum.sourcesList().then((l) => setConnected(Object.fromEntries(l.map((s) => [s.id, { connected: s.connected, syncNotes: s.syncNotes }])))); };
  useEffect(() => { load(); window.quorum.sourceIcons().then(setIcons); }, [brain]);
  const anyConnected = Object.values(connected).some((c) => c.connected);
  // notetakers Quorum can connect today that are not connected yet; each opens its connector page, where Connect lives
  const addable = CONNECTORS.filter((x) => x.category === 'meeting-notes' && x.status === 'available' && !connected[x.id]?.connected);
  const home = (p: string) => p.replace(/^\/Users\/[^/]+/, '~');
  if (part === 'meetings') return (
    <>
      <div className="set-head">
        <h3>Meeting notes folders</h3>
        <span className="set-head-actions menu-wrap" onClick={(e) => e.stopPropagation()}>
          <button className="pill small-pill with-icon" aria-haspopup="menu" aria-expanded={adding} onClick={() => setAdding((o) => !o)}><IconPlus width={15} height={15} />Add</button>
          {adding && (
            <div className="menu end" role="menu">
              <button role="menuitem" onClick={async () => { setAdding(false); if (await window.quorum.meetingSourceAdd()) load(); }}><IconFolder width={15} height={15} /> Select from folder</button>
              {addable.map((x) => <button key={x.id} role="menuitem" onClick={() => { setAdding(false); onViewConnector(x.id); }}><IconGrid width={15} height={15} /> Add {x.name}</button>)}
              <button role="menuitem" onClick={() => { setAdding(false); openConnectors({ library: 'meeting-notes' }); }}><IconSearch width={15} height={15} /> Browse connectors</button>
            </div>
          )}
        </span>
      </div>
      <div className="set-card">
        <MeetingsRow />
        {sources.map((src) => (
          <Row key={src.id} icon={icons[src.key] ? <img className="set-app-icon" src={icons[src.key]!} alt="" /> : <IconFolder width={18} height={18} />}
            title={<button className="mem-title" onClick={() => window.quorum.meetingSourceOpen(src.id)}>{src.name} meeting notes<IconExternal width={14} height={14} /></button>}
            desc={`${src.rel} · ${src.notes} ${src.notes === 1 ? 'note' : 'notes'}`}>
            {connected[src.key]?.connected && <span className="conn-ok"><i />{connected[src.key].syncNotes ? 'Connected' : 'Connected · sync off'}</span>}
            <SourceRowMenu name={src.name} connector={connected[src.key] ? { id: src.key, ...connected[src.key] } : null}
              onView={() => onViewConnector(src.key)}
              onToggleSync={async (on) => { await window.quorum.sourceSetOption(src.key, { syncNotes: on }); load(); }}
              onRemove={async () => { if (await window.quorum.meetingSourceRemove(src.id)) load(); }} />
          </Row>
        ))}
        {!anyConnected && (
          <ConnectHint connector="granola" title="Meeting notes from another app" desc="Granola today, more notetakers soon. Their notes land in the meetings folder with the source on each note.">
            <button className="pill small-pill" onClick={() => openConnectors({ library: 'meeting-notes' })}>Browse connectors</button>
          </ConnectHint>
        )}
      </div>
    </>
  );
  return (
    <>
      <div className="set-card">
        <Row icon={<IconBrain width={18} height={18} className={brain ? 'ok' : undefined} />}
          title={brain ? <button className="mem-title" onClick={() => window.quorum.openBrain('finder')}>{brain.made === 'quorum' ? 'QuorumBrain' : brain.name}<IconExternal width={14} height={14} /></button> : 'QuorumBrain'}
          desc={brain ? (brain.made === 'quorum' ? `Built by Quorum · ${home(brain.vault || brain.root)}` : home(brain.vault || brain.root)) : 'Optional. An Agent OS folder of notes Quorum can answer from. Meeting notes work without one.'}>
          {brain
            ? <RowMenu label={`${brain.made === 'quorum' ? 'QuorumBrain' : brain.name} options`} items={[...(brain.made === 'quorum' ? [{ label: 'Set up again', icon: <IconBrain width={15} height={15} />, onPick: openSetup }] : []), { label: 'Change folder', icon: <IconFolder width={15} height={15} />, onPick: onConnect }, { label: 'Disconnect', icon: <IconClose width={15} height={15} />, danger: true, onPick: () => setConfirm(true) }]} />
            : (
              <span className="menu-wrap">
                <button className="pill" aria-haspopup="menu" aria-expanded={connecting} onClick={() => setConnecting((v) => !v)}>Connect</button>
                {connecting && (
                  <div className="menu end" role="menu">
                    <button role="menuitem" onClick={() => { setConnecting(false); onConnect(); }}><IconFolder width={15} height={15} /> Connect an existing folder</button>
                    <button role="menuitem" onClick={() => { setConnecting(false); openCreate(); }}><IconBrain width={15} height={15} /> Create a new one</button>
                  </div>
                )}
              </span>
            )}
        </Row>
      </div>
      {setup && (
        <div className="palette-scrim" onClick={() => setSetup(null)}>
          <div className="modal setup-modal" role="dialog" aria-label="Set up QuorumBrain again" onClick={(e) => e.stopPropagation()}>
            <h2>{creating ? 'Create your QuorumBrain' : 'Set up QuorumBrain again'}</h2>
            <p>{creating ? 'A folder of markdown notes Quorum and your AI read and write, shaped around you. Every answer is optional.' : 'Applying adds new folders and notes, replaces the section Quorum generated in CLAUDE.md, and adds missing lines to index.md. No other file you wrote changes.'}</p>
            {creating && (
              <div className="setup-form setup-where">
                <label className="set-field wide onb-field"><span className="onb-label">Name</span><input value={newName} aria-label="Name of your Agent OS" onChange={(e) => setNewName(e.target.value)} /></label>
                <div className="onb-row"><span className="onb-label">Location</span><code className="onb-path">{home(newDir ?? defaultDir)}</code><button className="pill small-pill" onClick={async () => { const d = await window.quorum.onboardingPickDir(); if (d) setNewDir(d); }}>Choose…</button></div>
              </div>
            )}
            <SetupForm draft={setup} onChange={setSetup} lockOrganize={!creating} />
            {setupError && <p className="set-error">{setupError}</p>}
            <div className="modal-actions"><button className="link-btn" onClick={() => setSetup(null)}>Cancel</button><button className="pill primary" disabled={applying} onClick={applySetup}>{applying ? (creating ? 'Creating…' : 'Applying…') : creating ? 'Create folder' : 'Apply'}</button></div>
          </div>
        </div>
      )}
      {confirm && (
        <ConfirmModal title={`Disconnect ${brain?.made === 'quorum' ? 'QuorumBrain' : brain?.name ?? 'this folder'}?`} action="Disconnect"
          body="Quorum stops reading this folder. Answers, memory power-ups and guardrails that came from it stop working, and a meetings folder found inside it has to be chosen again. Nothing is deleted, but this cannot be undone: connecting a folder again means a new import."
          onDone={(ok) => { setConfirm(false); if (ok) onDisconnect(); }} />
      )}
    </>
  );
}

type MenuItem = { label: string; icon: ReactNode; danger?: boolean; onPick: () => void };
// the ••• on a Context row
function RowMenu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useMenu();
  return (
    <span className="menu-wrap" onClick={(e) => e.stopPropagation()}>
      <button className="icon-btn" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}><IconMore width={16} height={16} /></button>
      {open && <div className="menu" role="menu">{items.map((it) => <button key={it.label} role="menuitem" className={it.danger ? 'danger' : undefined} onClick={() => { setOpen(false); it.onPick(); }}>{it.icon} {it.label}</button>)}</div>}
    </span>
  );
}

// the menu on a meeting-notes folder: the connector's controls when one feeds it, else just remove
function SourceRowMenu({ name, connector, onView, onToggleSync, onRemove }: { name: string; connector: { id: string; connected: boolean; syncNotes: boolean } | null; onView: () => void; onToggleSync: (on: boolean) => void; onRemove: () => void }) {
  const [open, setOpen] = useMenu();
  return (
    <span className="menu-wrap" onClick={(e) => e.stopPropagation()}>
      <button className="icon-btn" aria-label={`${name} meeting notes options`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}><IconMore width={16} height={16} /></button>
      {open && (
        <div className="menu" role="menu">
          {connector && <button role="menuitem" onClick={() => { setOpen(false); onView(); }}><IconGrid width={15} height={15} /> View connection</button>}
          {connector?.connected && <button role="menuitem" onClick={() => { setOpen(false); onToggleSync(!connector.syncNotes); }}><IconReset width={15} height={15} /> {connector.syncNotes ? 'Pause sync into Quorum' : 'Resume sync into Quorum'}</button>}
          <button role="menuitem" className="danger" onClick={() => { setOpen(false); onRemove(); }}><IconClose width={15} height={15} /> Remove from Quorum</button>
        </div>
      )}
    </span>
  );
}

// where meeting notes live; past meetings you bring in land here too, so it's the same folder Quorum lists in History.
// Disconnect is offered only for a folder you chose: one found inside the Agent OS goes away with it
function MeetingsRow() {
  const [dir, setDir] = useState<Awaited<ReturnType<typeof window.quorum.meetingsDir>> | undefined>();
  const [confirm, setConfirm] = useState(false);
  const load = () => window.quorum.meetingsDir().then(setDir);
  useEffect(() => { load(); return window.quorum.onBrainChanged(() => { load(); }); }, []);
  const pick = async () => { if (await window.quorum.pickMeetingsDir()) load(); };
  if (dir === undefined) return null;
  if (!dir) return (
    <Row icon={<IconQuorum width={18} height={18} />} title="Quorum meeting notes" desc="Choose a folder for notes. Past meetings you import go here too.">
      <button className="pill" onClick={pick}>Choose folder</button>
    </Row>
  );
  const items: MenuItem[] = [{ label: 'Change folder', icon: <IconFolder width={15} height={15} />, onPick: pick }];
  if (dir.chosen) items.push({ label: 'Disconnect', icon: <IconClose width={15} height={15} />, danger: true, onPick: () => setConfirm(true) });
  return (
    <>
      <Row icon={<IconQuorum width={18} height={18} className="ok" />}
        title={<button className="mem-title" onClick={() => window.quorum.openBrain('meetings')}>Quorum meeting notes<IconExternal width={14} height={14} /></button>}
        desc={`${dir.rel} · ${dir.notes} ${dir.notes === 1 ? 'note' : 'notes'}`}>
        <RowMenu label="Quorum meeting notes options" items={items} />
      </Row>
      {confirm && (
        <ConfirmModal title="Disconnect this meetings folder?" action="Disconnect"
          body="Quorum stops saving to and listing notes from this folder. The notes stay where they are, but History empties until you choose a folder, and bringing these notes back means a new import. This cannot be undone from Quorum."
          onDone={async (ok) => { setConfirm(false); if (ok) { await window.quorum.clearMeetingsDir(); load(); } }} />
      )}
    </>
  );
}

// saves a field when you leave it, so typing never fights a round trip
// a text field that saves itself: shortly after typing stops, on blur, on Enter, and when the page changes under it,
// so nothing typed is lost to a click elsewhere. A short Saved mark confirms each write
function Field({ value, placeholder, onSave }: { value: string; placeholder?: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(value);
  const [saved, setSaved] = useState(false);
  const latest = useRef(value);
  const written = useRef(value.trim());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  useEffect(() => { setV(value); latest.current = value; written.current = value.trim(); }, [value]);
  const commit = () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const t = latest.current.trim();
    if (t === written.current) return;
    written.current = t;
    onSave(t);
    if (mounted.current) { setSaved(true); setTimeout(() => { if (mounted.current) setSaved(false); }, 1400); }
  };
  const change = (val: string) => { setV(val); latest.current = val; if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(commit, 700); };
  useEffect(() => () => { mounted.current = false; if (timer.current) commit(); }, []);
  return (
    <label className="set-field">
      <input value={v} placeholder={placeholder} onChange={(e) => change(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
      {saved && <span className="field-saved" aria-live="polite">Saved</span>}
    </label>
  );
}

function ProfilePage({ settings, email, emailLabel, name, onSettings, children }: { settings: Settings; email: string; emailLabel: string; name: string; onSettings: (s: Settings) => void; children?: ReactNode }) {
  const p = settings.profile ?? {};
  const save = async (patch: Partial<Profile>) => onSettings(await window.quorum.setSettings({ profile: patch }));
  // one name for both uses: the profile shown in Settings and settings.userName, which names the recorder in every note
  const saveName = async (v: string) => onSettings(await window.quorum.setSettings({ userName: v, profile: { name: v } }));
  return (
    <>
      <h3>Account</h3>
      <div className="set-card form">
        <div className="set-line">
          <strong>{emailLabel}</strong>
          <div className="set-line-end">
            {(email || emailLabel !== 'Photo') && <span className="muted">{email || 'Not signed in to Claude'}</span>}
            <button className="photo-btn" aria-label={p.photo ? 'Change photo' : 'Add photo'} data-tip={p.photo ? 'Change photo' : 'Add photo'} onClick={async () => onSettings(await window.quorum.pickPhoto())}>
              {p.photo ? <img src={p.photo} alt="" /> : <IconPerson width={18} height={18} />}
            </button>
            {p.photo && <button className="pill small-pill" onClick={async () => onSettings(await window.quorum.removePhoto())}>Remove</button>}
          </div>
        </div>
        <div className="set-line"><div className="set-label"><strong>Your name</strong><span>How Quorum names you in notes and transcripts</span></div><Field value={settings.userName || p.name || name} placeholder={name} onSave={saveName} /></div>
        <div className="set-line"><strong>Job title</strong><Field value={p.title ?? ''} onSave={(v) => save({ title: v })} /></div>
        <div className="set-line"><strong>LinkedIn URL</strong><Field value={p.linkedin ? `linkedin.com/in/${p.linkedin}` : ''} placeholder="linkedin.com/in/username" onSave={(v) => save({ linkedin: v.trim().replace(/^.*linkedin\.com\/in\//, '').replace(/[/?#].*$/, '') })} /></div>
      </div>
      {children}

      <h3>Account management</h3>
      <div className="set-card form">
        <ExportRow />
      </div>

      <DeleteAccountArea />
    </>
  );
}

// one zip of every note, meeting note and chat, saved where the person picks. The notes are already plain markdown
// files in the vault; the archive also holds the chats, which only Quorum's own folder has
type ExportState = { phase: 'idle' | 'running' | 'done' | 'error'; done?: number; total?: number; path?: string; files?: number; skipped?: number; error?: string };
function ExportRow() {
  const [state, setState] = useState<ExportState>({ phase: 'idle' });
  useEffect(() => window.quorum.onExportProgress((p) => setState((s) => (s.phase === 'running' ? { ...s, done: p.done, total: p.total } : s))), []);
  const run = async () => {
    setState({ phase: 'running' });
    const r = await window.quorum.exportNotes().catch(() => ({ error: 'The export could not be written. Try again.' }) as Awaited<ReturnType<Window['quorum']['exportNotes']>>);
    if (r.canceled) setState({ phase: 'idle' });
    else if (r.error) setState({ phase: 'error', error: r.error });
    else setState({ phase: 'done', path: r.path, files: r.files, skipped: r.skipped });
  };
  const n = (v: number | undefined, word: string) => `${(v ?? 0).toLocaleString()} ${v === 1 ? word : `${word}s`}`;
  const desc = state.phase === 'running' ? (state.total ? `Writing ${n(state.done, 'file')} of ${state.total.toLocaleString()}` : 'Gathering your notes')
    : state.phase === 'done' ? `Saved ${n(state.files, 'file')}${state.skipped ? `; ${n(state.skipped, 'file')} could not be read` : ''}`
    : state.phase === 'error' ? state.error ?? 'The export could not be written.'
    : 'Saves every note, meeting note and chat as one zip archive. Your notes are also plain files in your Agent OS';
  return (
    <Row icon={<IconStack width={18} height={18} />} title="Export your notes" desc={desc}>
      {state.phase === 'done' && state.path && <button className="pill" onClick={() => window.quorum.exportReveal(state.path!)}>Show in Finder</button>}
      <button className="pill" disabled={state.phase === 'running'} onClick={run}>{state.phase === 'running' ? <><span className="spinner tiny" /> Exporting</> : 'Export'}</button>
    </Row>
  );
}

// the team's name, description and mark, shown on the Teams page once a team is on. Quorum gives the name and
// description to every meeting summary and answer; the logo is kept small, as a data URL in settings
export function CompanyCard({ settings, onSettings }: { settings: Settings; onSettings: (s: Settings) => void }) {
  const w = settings.workspace ?? {};
  const save = async (patch: Partial<Workspace>) => onSettings(await window.quorum.setSettings({ workspace: patch }));
  const [about, setAbout] = useState(w.companyDescription ?? '');
  useEffect(() => setAbout(w.companyDescription ?? ''), [w.companyDescription]);
  const [logoError, setLogoError] = useState('');
  const pickLogo = (file: File | undefined) => {
    if (!file) return;
    if (!/^image\//.test(file.type)) { setLogoError('Choose an image file.'); return; }
    setLogoError('');
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const side = 128, canvas = document.createElement('canvas');
        canvas.width = side; canvas.height = side;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const scale = Math.max(side / img.width, side / img.height);
        const dw = img.width * scale, dh = img.height * scale;
        ctx.drawImage(img, (side - dw) / 2, (side - dh) / 2, dw, dh);
        save({ companyLogo: canvas.toDataURL('image/png') });
      };
      img.onerror = () => setLogoError('That image could not be read.');
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  };
  return (
    <>
      <h3>Company</h3>
      <div className="set-card form">
        <div className="set-line">
          <div className="set-label"><strong>Logo</strong><span>Shown beside the team's name in Quorum</span></div>
          <div className="set-line-end">
            <span className="company-logo" aria-hidden="true">{w.companyLogo ? <img src={w.companyLogo} alt="" /> : (w.company ?? 'Q')[0]?.toUpperCase()}</span>
            <label className="pill small-pill">{w.companyLogo ? 'Change' : 'Choose'}<input type="file" accept="image/*" hidden onChange={(e) => { pickLogo(e.target.files?.[0]); e.target.value = ''; }} /></label>
            {w.companyLogo && <button className="link-btn" onClick={() => save({ companyLogo: '' })}>Remove</button>}
          </div>
        </div>
        {logoError && <p className="set-error">{logoError}</p>}
        <div className="set-line"><strong>Company name</strong><Field value={w.company ?? ''} placeholder="Company" onSave={(v) => save({ company: v })} /></div>
        <div className="set-line stacked">
          <div className="set-label"><strong>Company description</strong><span>Quorum takes this into account when it summarizes meetings and answers questions</span></div>
          <textarea className="set-area" value={about} maxLength={1000} placeholder="What the company does, who it serves, words people use internally" onChange={(e) => setAbout(e.target.value)} onBlur={() => { if (about !== (w.companyDescription ?? '')) save({ companyDescription: about.trim() }); }} />
        </div>
      </div>
    </>
  );
}

// `company` is the CompanyCard while this page is its home: the Local edition, a Cloud build without a hosted account,
// and a workspace whose team is off. Once a team is on, the card lives on the Teams page and this one gets null
function WorkspacePage({ settings, onSettings, onGo, billing, company }: { settings: Settings; onSettings: (s: Settings) => void; onGo: (p: Page) => void; billing: boolean; company: ReactNode }) {
  const w = settings.workspace ?? {};
  const save = async (patch: Partial<Workspace>) => onSettings(await window.quorum.setSettings({ workspace: patch }));
  const nt = useNotetaker();
  return (
    <>
      <AccountArea local={<><h3>Account</h3><p className="muted">Local edition. Your meetings and notes stay on this Mac.</p></>}
        unconfigured={<><h3>Account</h3><p className="muted">Hosted accounts are not set up in this build</p></>} />
      {billing && <p className="set-note">The plan, the card on file and this month's usage live under <button className="link-btn" onClick={() => onGo('billing')}>Billing</button>.</p>}
      <EnvSwitch />
      {company}

      <h3>Connections</h3>
      <WorkspaceDecisions connectedBy={w.decisions?.by} />

      {nt.meetingCapture && <>
      <h3>Meetings</h3>
      <div className="set-card form words">
        <div className="set-line"><div className="set-label"><strong>Stop word</strong><span>Stops Quorum and deletes the call when sent in the chat</span></div>
          <Field value={w.stopWord ?? 'STOP'} placeholder="STOP" onSave={(v) => save({ stopWord: v })} /></div>
        <div className="set-line"><div className="set-label"><strong>Go word</strong><span>Turns Quorum back on after a stop</span></div>
          <Field value={w.goWord ?? 'GO'} placeholder="GO" onSave={(v) => save({ goWord: v })} /></div>
      </div>
      <CustomerBlacklist list={w.optOuts ?? (w.neverListen ?? []).map((domain) => ({ domain }))} onChange={(optOuts) => save({ optOuts })} />
      </>}

      <DeleteOrgArea />
    </>
  );
}

// customers who've opted out: Quorum stays off when their domain is on the invite or their name comes up in the title, the participants or the call
const cleanDomain = (raw: string) => raw.trim().toLowerCase().replace(/^["']|["']$/g, '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/^@/, '').replace(/\/.*$/, '');
const isDomain = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) || /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v);
const cleanName = (raw: string) => raw.trim().replace(/^["']|["']$/g, '').replace(/\s+/g, ' ');
const okEntry = (o: OptOut) => (o.name ?? '').length >= 3 || isDomain(o.domain ?? '');
const sameEntry = (a: OptOut, b: OptOut) => (a.name ?? '').toLowerCase() === (b.name ?? '').toLowerCase() && (a.domain ?? '') === (b.domain ?? '');

function CustomerBlacklist({ list, onChange }: { list: OptOut[]; onChange: (next: OptOut[]) => void }) {
  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');
  const [uploading, setUploading] = useState(false);
  const entry: OptOut = { name: cleanName(name), domain: cleanDomain(domain) };
  const badDomain = !!entry.domain && !isDomain(entry.domain);
  const valid = okEntry(entry) && !badDomain;
  const add = () => { if (!valid) return; if (!list.some((x) => sameEntry(x, entry))) onChange([...list, entry]); setName(''); setDomain(''); };
  const onEnter = (e: ReactKeyboardEvent) => { if (e.key === 'Enter') add(); };
  return (
    <div className="set-card form">
      <div className="set-line">
        <div className="set-label">
          <strong>Customer blacklist</strong>
          <span>Quorum stays off when these customers are invited or mentioned</span>
        </div>
        <button className="pill small-pill with-icon" data-tip="Upload a CSV of customers" onClick={() => setUploading(true)}><IconUpload width={15} height={15} />Bulk</button>
      </div>
      <div className="set-line">
        <label className="set-field"><input type="text" aria-label="Customer name" placeholder="Customer name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={onEnter} /></label>
        <label className="set-field wide"><input type="text" aria-label="Domain" placeholder="company.com" value={domain} onChange={(e) => setDomain(e.target.value)} onKeyDown={onEnter} /></label>
        <div className="set-line-end"><button className="pill" disabled={!valid} onClick={add}>Add</button></div>
      </div>
      {list.map((x) => (
        <div key={`${x.name}|${x.domain}`} className="set-line never-row">
          <span>{x.name ? <><strong>{x.name}</strong>{x.domain && <em className="muted"> · {x.domain}</em>}</> : x.domain}</span>
          <button className="icon-btn mem-no" aria-label={`Remove ${x.name || x.domain}`} data-tip="Remove" data-tip-pos="left" onClick={() => onChange(list.filter((y) => !sameEntry(y, x)))}><IconClose width={15} height={15} /></button>
        </div>
      ))}
      {uploading && <UploadCustomers list={list} onAdd={(more) => onChange([...list, ...more])} onClose={() => setUploading(false)} />}
    </div>
  );
}

// reads name and domain from each row (either can be blank); the header and anything unreadable are skipped
function UploadCustomers({ list, onAdd, onClose }: { list: OptOut[]; onAdd: (more: OptOut[]) => void; onClose: () => void }) {
  const [file, setFile] = useState<{ name: string; add: OptOut[]; skipped: number; already: number } | null>(null);
  const [drag, setDrag] = useState(false);
  const read = async (f: File | undefined) => {
    if (!f) return;
    const rows = (await f.text()).split(/\r?\n/).filter((r) => r.trim());
    const parsed = rows.map((r) => {
      const cells = r.split(',');
      // one column means a domain, the old template's shape
      return cells.length === 1 ? { name: '', domain: cleanDomain(cells[0]) } : { name: cleanName(cells[0] ?? ''), domain: cleanDomain(cells[1] ?? '') };
    });
    const good = parsed.filter((o) => okEntry(o) && (!o.domain || isDomain(o.domain)) && !(o.name.toLowerCase() === 'name' && o.domain === 'domain'));
    const fresh = good.filter((o, i) => !list.some((x) => sameEntry(x, o)) && good.findIndex((y) => sameEntry(y, o)) === i);
    setFile({ name: f.name, add: fresh, skipped: rows.length - good.length, already: good.length - fresh.length });
  };
  const n = file?.add.length ?? 0;
  return (
    <Modal titleId="upload-title" title="Upload customers" onClose={onClose}>
      <p>One customer per row: the name in the first column and their email domain in the second. Either can be blank. Quorum skips the header and anything it can't read.</p>
      <label className={`dropzone ${drag ? 'on' : ''}`} onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); read(e.dataTransfer.files[0]); }}>
        <IconUpload width={22} height={22} />
        <strong>{file ? file.name : 'Drop a CSV file here'}</strong>
        <span>{file ? [`${n} to add`, file.already && `${file.already} already on the list`, file.skipped && `${file.skipped} skipped`].filter(Boolean).join(' · ') : 'or click to choose one'}</span>
        <input type="file" accept=".csv,text/csv" autoFocus onChange={(e) => read(e.target.files?.[0])} />
      </label>
      <ModalActions start={<button className="link-btn" onClick={() => window.quorum.neverListTemplate()}>Download CSV template</button>}>
        <button className="pill" onClick={onClose}>Cancel</button>
        <button className="pill primary" disabled={!n} onClick={() => { onAdd(file!.add); onClose(); }}>{n ? `Add ${n}` : 'Add'}</button>
      </ModalActions>
    </Modal>
  );
}

// why each kind is worth including, folded together with what the scan found
function why(it: MemoryItem): string {
  const n = it.detail.match(/\d+/)?.[0] ?? '';
  switch (it.kind) {
    case 'guards': return `${it.detail} · review and add rules on the Guardrails page`;
    case 'index': return `Quorum starts from ${it.detail.split(' · ')[0]} to find notes faster`;
    case 'search': return it.detail === 'local embeddings' ? 'Finds related notes first, with embeddings on this Mac' : 'Finds matching notes before Quorum answers';
    case 'graph': return 'Search also pulls in notes linked to each match';
    case 'instructions': return `Quorum follows ${it.detail} when it answers`;
    case 'skills': return `${it.detail}; Quorum can run one when a question calls for it`;
    case 'agents': return `${it.detail}; Quorum can hand a sub-question to one`;
    case 'mcp': return `${it.detail} in .mcp.json; their tools open to Quorum, with your credentials`;
    default: return 'Quorum can read this folder when it answers';
  }
}

const KIND_ICON: Record<string, (p: { width?: number; height?: number; filled?: boolean; className?: string }) => ReactNode> = {
  instructions: IconBrain, agents: IconPeople, skills: IconGrid, guards: IconShield, vault: IconStack, meetings: IconFolder, index: IconFork, folder: IconFolder, search: IconSearch, graph: IconGraph, decisions: IconListCheck, mcp: IconCode,
};

// additional context from the Agent OS: found by a local scan of file names, reviewed one by one
function MemoryScan({ brain }: { brain: Brain }) {
  const [m, setM] = useState<Memory | null>(null);
  const [scanning, setScanning] = useState(false);
  useEffect(() => { window.quorum.memoryGet().then(setM); }, []);
  if (!m) return null;
  const refresh = async () => {
    setScanning(true);
    const r = await window.quorum.memoryRefresh();
    setScanning(false);
    if (r.cancelled) return;
    setM(r);
  };
  // each part of the folder Quorum can use when it answers is one switch; guards always apply and link to Guardrails
  const row = (it: MemoryItem) => {
    const Icon = KIND_ICON[it.kind] ?? IconFolder;
    const on = it.kind === 'guards' || it.include === true;
    const icon = it.kind === 'folder' && on ? <IconFolderFill width={18} height={18} className="ok" /> : <Icon width={18} height={18} {...(it.kind === 'guards' || it.kind === 'index' ? { filled: on } : {})} className={on ? 'ok' : undefined} />;
    return (
      <Row key={it.id} icon={icon} desc={why(it)}
        title={<button className="mem-title" onClick={() => (it.kind === 'guards' ? window.dispatchEvent(new CustomEvent('quorum-open-settings', { detail: 'guardrails' })) : window.quorum.memoryOpen(it.id))}>{it.label}{it.kind === 'guards' ? <IconChevron className="right" width={14} height={14} /> : <IconExternal width={14} height={14} />}</button>}>
        {it.kind !== 'guards' && <Toggle on={on} onChange={async (v) => setM(await (v ? window.quorum.memoryInclude(it.id) : window.quorum.memoryExclude(it.id)))} />}
      </Row>
    );
  };
  return (
    <>
      <div className="set-head">
        <h3>When Quorum answers</h3>
        <span className="set-head-actions">
          {scanning
            ? <button className="icon-btn scan-btn scanning" aria-label="Cancel refresh" data-tip="Cancel refresh" onClick={() => window.quorum.memoryRefreshCancel()}>
                <span className="brand-spin" aria-hidden="true" /><IconClose className="scan-x-ic" width={13} height={13} />
              </button>
            : <button className="icon-btn scan-btn" aria-label="Refresh" data-tip="Look for new files" onClick={refresh}><IconReset width={16} height={16} /></button>}
          <button className="pill small-pill with-icon" onClick={async () => setM(await window.quorum.memoryAdd())}><IconPlus width={15} height={15} />Add folder</button>
        </span>
      </div>
      <div className="set-card mem-card">
        {m.items.map(row)}
        <KeeperCard brain={brain} part="search" />
        {!m.items.length && <Row icon={<IconReset width={18} height={18} />} title="Nothing found yet" desc="Refresh to look through your folder, or add a folder." />}
      </div>
    </>
  );
}

// the workspace version of Memory: one company source, reviewed by admins, applied to everyone
function KnowledgePage() {
  return (
    <>
      <KnowledgeBasesArea local={(
        <>
          <h3>Company knowledge</h3>
          <EmptyState icon={<IconBuilding width={22} height={22} />} title={<>No company knowledge source<Soon /></>}>
            <p>Admins will connect a repo, wiki or knowledge base, and Quorum will read it for everyone in the workspace.</p>
            <button className="pill" disabled>Connect to company knowledge source</button>
          </EmptyState>
        </>
      )} />

      <KnowledgeQueueArea local={(
        <>
          <h3>Shared with your team</h3>
          <div className="set-card">
            <TeamVaultRow />
          </div>
        </>
      )} />

      <h3>Who controls it</h3>
      <div className="set-card">
        <Row icon={<IconPeople width={18} height={18} />} title="Admins" desc="Only admins can include or remove company knowledge" />
        <Row icon={<IconStack width={18} height={18} />} title="Everyone in the workspace" desc="Applies to every teammate, next to their own memory" />
      </div>
    </>
  );
}

// upkeep: the keeper (keeper.js) files each new meeting note into the index, the daily note and the people and project
// notes it concerns, and writes learned facts with the person's own model source. On by default for a folder Quorum
// built; a folder the person connected themselves turns it on here. Each job is a plugin row below: Quorum's by
// default, and the vault's when the vault already does that job, with the files that show it. Report plugins write
// nothing in the vault on their own, so they are listed whether upkeep is on or not, with their result under the row
const PLUGIN_ICON: Record<string, (p: { width?: number; height?: number; className?: string }) => ReactNode> = {
  index: IconFork, daily: IconCalendar, links: IconPeople, facts: IconBrain, search: IconSearch, context: IconScale, skills: IconStack, 'brain-check': IconListCheck,
};
// what each job does for the memory Quorum keeps, in one line
const PLUGIN_TITLE: Record<string, string> = { index: 'Meeting index', daily: 'Daily notes', links: 'People and project links', facts: 'Learned facts', search: "Use Quorum's search", context: 'Context size check', skills: 'Skill usage', 'brain-check': 'Memory quiz' };
const PLUGIN_VALUE: Record<string, string> = {
  index: 'Lists every meeting in index.md so you and your AI can find it.',
  daily: "Adds each meeting to that day's daily note.",
  links: 'Links each meeting from the people and project notes it mentions.',
  facts: 'Saves up to three facts per meeting that your AI can recall later.',
  search: 'Quorum finds the notes behind each answer. Off: it uses your own search script.',
  context: 'Warns when the files Claude Code loads every session grow too large.',
  skills: 'Shows which skills ran lately, so you can drop the ones you never use.',
  'brain-check': 'Asks a few questions with known answers to test what your memory returns.',
};
const PLUGIN_PANEL: Record<string, () => ReactNode> = { context: () => <ContextPanel />, skills: () => <SkillsPanel />, 'brain-check': () => <BrainCheckPanel /> };
// the vault note's path. It saves on blur or Enter only, since each save moves the list to the new path; a path the
// keeper refuses (outside the folder, in a dot folder or the meetings folder) leaves the saved one and says why. Paths
// are compared the way the keeper stores them, so ./notes/facts and notes/facts.md are the same path
const normNote = (p: string) => { const t = p.normalize('NFC').trim().replace(/\\/g, '/').replace(/^(\.\/)+/, ''); return t && !/\.md$/i.test(t) ? `${t}.md` : t; };
function NotePathField({ value, onSave }: { value: string; onSave: (v: string) => Promise<string> }) {
  const [v, setV] = useState(value);
  const [refused, setRefused] = useState(false);
  useEffect(() => { setV(value); }, [value]);
  const commit = async () => {
    const t = normNote(v);
    if (t === normNote(value)) return;
    try {
      const saved = await onSave(t);
      setRefused(!!t && normNote(saved) !== t);
      setV(saved);
    } catch {
      setRefused(true);
      setV(value);
    }
  };
  return (
    <label className="set-field wide">
      <input value={v} aria-label="Learned facts note" onChange={(e) => { setV(e.target.value); setRefused(false); }} onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
      {refused && <span className="field-saved" aria-live="polite">Use a .md path inside the folder, outside dot folders and the meetings folder</span>}
    </label>
  );
}
function KeeperCard({ brain, part }: { brain: Brain; part: 'upkeep' | 'reports' | 'search' }) {
  const [k, setK] = useState<KeeperStatus | null>(null);
  const [busy, setBusy] = useState(false);
  // picking Default when it would move lines out of the list asks first
  const [askDefault, setAskDefault] = useState(false);
  const [askRemove, setAskRemove] = useState(false);
  const load = () => window.quorum.keeperStatus().then(setK).catch(() => setK(null));
  useEffect(() => { load(); return window.quorum.onKeeper?.(() => load()); }, [brain.root]);
  if (!k) return null;
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null);
  const run = async (allowCreate = false) => { setBusy(true); try { await window.quorum.keeperRun(allowCreate ? { allowCreate } : undefined); } finally { setBusy(false); load(); } };
  const marked = k.last?.marked?.length ?? 0;
  const last = k.last && !k.last.off && !k.last.held ? `${k.last.filed} filed${k.last.skipped ? `, ${k.last.skipped} withheld` : ''}${marked ? `, ${marked} generated ${marked === 1 ? 'file' : 'files'} left alone` : ''}${k.last.error ? ` · ${k.last.error}` : ''}` : null;
  const desc = !k.on ? 'Off. Quorum writes meeting notes here and changes nothing else.'
    : k.lastRunAt ? `Last run ${when(k.lastRunAt)}${last ? `: ${last}` : ''}` : 'Index, daily note, people and project notes, after each meeting';
  // turning the brain check on is one of the two moves that start a run (Run is the other); checks without terms are skipped
  const pick = async (p: KeeperPlugin, owner: 'quorum' | 'vault') => {
    setK(await window.quorum.keeperPlugin(p.id, owner));
    if (p.id === 'brain-check' && owner === 'quorum') window.quorum.brainCheckRun().catch(() => {});
  };
  const factsOn = k.plugins.find((p) => p.id === 'facts')?.owner === 'quorum';
  // one switch per job: on, Quorum does it; off, Quorum leaves it to the folder. The subtitle says what it does for
  // memory, and names the file that already does the job when the scan found one
  const plugin = (p: KeeperPlugin) => {
    const Icon = PLUGIN_ICON[p.id] ?? IconFolder;
    const on = p.owner === 'quorum';
    const found = p.evidence[0]?.path;
    const pdesc = `${PLUGIN_VALUE[p.id] ?? p.does}${p.id === 'facts' && on && !k.model ? ' Needs a model source in AI settings.' : ''}${found ? ` Your setup already does this: ${found}.` : ''}`;
    return (
      <Fragment key={p.id}>
        <Row icon={<Icon width={18} height={18} className={on ? 'ok' : undefined} />} title={PLUGIN_TITLE[p.id] ?? p.title} desc={pdesc}>
          <Toggle on={on} disabled={p.always && !p.evidence.length} onChange={(v) => pick(p, v ? 'quorum' : 'vault')} />
        </Row>
        {on && PLUGIN_PANEL[p.id]?.()}
      </Fragment>
    );
  };
  const reports = k.plugins.filter((p) => p.report);
  const writers = k.plugins.filter((p) => !p.report && p.id !== 'search');
  const search = k.plugins.find((p) => p.id === 'search');
  if (part === 'search') return search && search.evidence.length ? plugin(search) : null;
  if (part === 'reports') return reports.length ? <><h3>Reports</h3><div className="set-card">{reports.map(plugin)}</div></> : null;
  if (part === 'upkeep') return (
    <>
      <h3>Memory</h3>
      <div className="set-card">
        <Row icon={<IconReset width={18} height={18} className={k.on ? 'ok' : undefined} />} title="Auto maintain memories from new meetings" desc={desc}>
          {k.on && <button className="pill small-pill" disabled={busy || k.running} onClick={() => run()}>{busy || k.running ? 'Running…' : 'Run now'}</button>}
          <Toggle on={k.on} onChange={async (on) => setK(await window.quorum.keeperSet({ on }))} />
        </Row>
        {k.errors.count > 0 && (
          <Row icon={<IconInfo width={18} height={18} />} title={`${k.errors.count} upkeep ${k.errors.count === 1 ? 'error' : 'errors'}`}
            desc={k.errors.last ? `Last: ${k.errors.last.where}, ${k.errors.last.message}` : 'Logged under Application Support'}>
            <button className="pill small-pill" onClick={() => window.quorum.keeperErrorsOpen()}>Open log</button>
            <button className="pill small-pill" onClick={async () => setK(await window.quorum.keeperErrorsClear())}>Clear</button>
          </Row>
        )}
        {k.on && k.held && (
          <Row icon={<IconInfo width={18} height={18} />} title={`Waiting to create ${k.held.count} new files`}
            desc={`The last run would have added ${k.held.count} files, such as ${k.held.sample.slice(0, 3).join(', ')}. Nothing was written. Turn off a job below, or create them.`}>
            <button className="pill small-pill" disabled={busy || k.running} onClick={() => run(true)}>Create them</button>
          </Row>
        )}
      </div>
      {k.on && (
        <>
          <h3>What it writes</h3>
          <div className="set-card">
            {k.on && (
              <Row icon={<IconNotes width={18} height={18} />} title="Edit notes Quorum did not create"
                desc={`Lets the jobs below add meeting lines to notes you wrote. Off: Quorum writes only to files it created.${!k.editVault && k.last?.left?.length ? ` The last run left ${k.last.left.length} ${k.last.left.length === 1 ? 'note' : 'notes'} as ${k.last.left.length === 1 ? 'it was' : 'they were'}.` : ''}`}>
                <Toggle on={k.editVault} onChange={async (on) => setK(await window.quorum.keeperSet({ editVault: on }))} />
              </Row>
            )}
            {writers.map(plugin)}
            {k.on && k.folders.meetings && k.plugins.find((p) => p.id === 'index')?.owner === 'vault' && (
              <Row icon={<IconFork width={18} height={18} />} title={`Write meeting index lines to ${k.folders.meetings}/index.md`}
                desc="Your Agent OS keeps index.md, so Quorum leaves it alone. This keeps one line per meeting in the meetings folder instead, which your index can link to.">
                <Toggle on={k.meetingsIndex} onChange={async (on) => setK(await window.quorum.keeperSet({ meetingsIndex: on }))} />
              </Row>
            )}
            {k.on && factsOn && k.learned && (
              <Row icon={<IconNotes width={18} height={18} />} title="Learned facts file"
                desc={`${k.learned.target === 'note' ? `A note in your Agent OS. ${k.learned.linked ? 'index.md links to it' : k.learned.indexGenerated ? 'index.md is marked as generated, so Quorum adds no link to it' : 'index.md is kept by your Agent OS, so Quorum adds no link to it'}. ` : ''}Claude Code does not load this file on its own. Agents read it through the Quorum MCP server. The oldest lines move to the changelog past the budget`}>
                <select className="set-select" aria-label="Learned facts file" value={k.learned.pick} onChange={async (e) => setK(await window.quorum.keeperSet({ factsTarget: e.target.value as LearnedTarget }))}>
                  <option value="learned">.quorum/learned.md</option>
                  <option value="note">A vault note</option>
                </select>
                <select className="set-select" aria-label="Budget" value={String(k.learned.budgetPick)} onChange={async (e) => {
                  if (e.target.value === 'auto') { if (k.learned!.defaultMoves > 0) setAskDefault(true); else setK(await window.quorum.keeperSet({ factsBudget: 'auto' })); return; }
                  setK(await window.quorum.keeperSet({ factsBudget: Number(e.target.value) }));
                }}>
                  <option value="auto">Default ({k.learned.defaultBudget.toLocaleString()} characters)</option>
                  {[1000, 2000, 4000, 8000].map((n) => <option key={n} value={n}>{n.toLocaleString()} characters</option>)}
                </select>
              </Row>
            )}
            {k.on && factsOn && k.learned?.noteHeld && (
              <Row icon={<IconInfo width={18} height={18} />} title="Learned facts go to .quorum/learned.md for now"
                desc={`Quorum did not create ${k.learned.note}, so it writes the facts to .quorum/learned.md until you turn on Edit notes Quorum did not create, or pick a note path that does not exist yet.`} />
            )}
            {k.on && factsOn && (k.learned?.target === 'note' || k.learned?.noteHeld) && (
              <Row icon={<IconNotes width={18} height={18} />} title="Learned facts note" desc="A path inside your Agent OS. Changing it moves the facts to the new note">
                <NotePathField value={k.learned.note} onSave={async (p) => { const s = await window.quorum.keeperSet({ factsNote: p }); setK(s); return s.learned?.note ?? p; }} />
              </Row>
            )}
            {k.on && factsOn && k.learned && (
              <Row icon={<IconNotes width={18} height={18} />} title="Copy the newest facts into CLAUDE.md"
                desc={`CLAUDE.md is loaded in every Claude Code session. When this is on, Quorum keeps the newest ${k.learned.claude.facts} facts there, up to ${k.learned.claude.budget.toLocaleString()} characters, and rewrites that block on each run. Off by default.${k.learned.claude.editable ? '' : ' Quorum did not create CLAUDE.md, so this also needs Edit notes Quorum did not create.'}`}>
                <Toggle on={k.learned.claude.on} onChange={async (on) => setK(await window.quorum.keeperSet({ factsInClaude: on }))} />
              </Row>
            )}
            {askDefault && k.learned && (
              <ConfirmModal title={`Use the default of ${k.learned.defaultBudget.toLocaleString()} characters?`}
                body={`${k.learned.defaultMoves} older ${k.learned.defaultMoves === 1 ? 'fact moves' : 'facts move'} from ${k.learned.file} to .quorum/changelog.md, where you can copy them back.`}
                action="Use the default" onDone={async (ok) => { setAskDefault(false); if (ok) setK(await window.quorum.keeperSet({ factsBudget: 'auto' })); }} />
            )}
            {k.learned?.claude.block && !k.learned.claude.on && !k.learned.claude.generated && (
              <Row icon={<IconTrash width={18} height={18} />} title="Remove the learned facts block from CLAUDE.md"
                desc={k.learned.claude.block === 'list'
                  ? `CLAUDE.md has a block of ${k.learned.claude.lines} learned ${k.learned.claude.lines === 1 ? 'fact' : 'facts'}, and Quorum no longer updates it. Removing it moves the facts to ${k.learned.file} and deletes only the text between Quorum's markers.`
                  : "CLAUDE.md has a learned facts block that Quorum no longer updates. Removing it deletes only the text between Quorum's markers."}>
                <button className="pill small-pill" onClick={() => setAskRemove(true)}>Remove</button>
              </Row>
            )}
            {askRemove && k.learned && (
              <ConfirmModal title="Remove the learned facts block from CLAUDE.md?"
                body={k.learned.claude.block === 'list' ? `The facts move to ${k.learned.file}. The rest of CLAUDE.md stays as it is.` : 'The rest of CLAUDE.md stays as it is.'}
                action="Remove" onDone={async (ok) => { setAskRemove(false); if (ok) setK(await window.quorum.keeperRemoveClaude()); }} />
            )}
          </div>
        </>
      )}
    </>
  );
}

// the workspace vault on this Mac: teammates' included notes with their provenance bonds (ee/sync.js applyShared).
// Without a signed-in workspace the row explains what it will hold
function TeamVaultRow() {
  const [team, setTeam] = useState<TeamVault | null | undefined>(undefined);
  useEffect(() => { Promise.resolve().then(() => window.quorum.knowledgeStatus()).then((r) => setTeam(r.team ?? null)).catch(() => setTeam(null)); }, []);
  if (!team) return <Row icon={<IconStack width={18} height={18} />} title="Workspace vault" desc="A Quorum Cloud workspace shares the notes teammates mark public with you, after an admin includes them. They land in a second folder, read-only, each with its source." />;
  const home = (p: string) => p.replace(/^\/Users\/[^/]+/, '~');
  const parts = [home(team.root), `${team.notes} shared ${team.notes === 1 ? 'note' : 'notes'}`, ...(team.behind ? [`${team.behind} edited here and behind the team copy`] : [])];
  return (
    <Row icon={<IconStack width={18} height={18} className={team.notes ? 'ok' : undefined} />} title="Workspace vault" desc={parts.join(' · ')}>
      <button className="pill" onClick={() => window.quorum.knowledgeTeamOpen()}>Open</button>
    </Row>
  );
}

// whether Record offers Screen: while a recording with Screen on runs, the call window is read on this Mac to name who
// spoke. Nothing is read at any other time. Needs the Screen Recording permission, asked for once when the toggle goes on
function ScreenContextRow() {
  const [s, setS] = useState<ScreenContextStatus | null>(null);
  useEffect(() => { window.quorum.screenContextStatus().then(setS).catch(() => setS(null)); }, []);
  if (!s) return null;
  const desc = !s.on ? 'Adds Screen to Record: the call window is read on this Mac while you record, to name who spoke'
    : s.granted === false ? 'On, but macOS has not allowed Screen Recording for Quorum yet'
    : 'On. Record offers Screen, off until you turn it on for a recording; nothing is read at other times';
  return (
    <Row icon={<IconStack width={18} height={18} className={s.on && s.granted !== false ? 'ok' : undefined} />} title="Screen in Record" desc={desc}>
      {s.on && s.granted === false && <button className="pill small-pill" onClick={() => window.quorum.screenContextPrivacy()}>Open System Settings</button>}
      <Toggle on={s.on} onChange={async (on) => setS(await window.quorum.screenContextSet(on))} />
    </Row>
  );
}

// the pages below are real layouts with every control disabled until the feature behind them exists
const noop = () => {};

// the source is the Calendar app on this Mac for now; Google Calendar comes later as a second source
function CalendarPage({ onConnector }: { onConnector: (id: string) => void }) {
  const [cal, setCal] = useState<CalendarSettings | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { window.quorum.calendarStatus().then(setCal); }, []);
  if (!cal) return null;
  const on = !!cal.enabled && cal.status === 'granted';
  const connect = async () => { setBusy(true); setCal(await window.quorum.calendarConnect()); setBusy(false); };
  const macDesc = on ? 'Connected · upcoming meetings show on Home'
    : cal.status === 'denied' ? 'Access is off for Quorum in System Settings'
    : 'Reads the calendars you already have in the Calendar app';
  return (
    <>
      <h3>Calendars</h3>
      <div className="set-card">
        <Row icon={<IconCalendar width={18} height={18} className={on ? 'ok' : undefined} />} title="Calendar app on this Mac" desc={macDesc}>
          {on ? <button className="pill" onClick={async () => setCal({ ...(await window.quorum.calendarSet({ enabled: false })), status: cal.status })}>Disconnect</button>
            : cal.status === 'denied' ? <button className="pill" onClick={() => window.quorum.calendarPrivacy()}>Open System Settings</button>
            : <button className="pill" disabled={busy} onClick={connect}>{busy ? 'Waiting for macOS' : 'Connect'}</button>}
        </Row>
        {CONNECTORS.filter((x) => x.category === 'calendar' && x.id !== 'apple-calendar').map((x) => {
          const g = x.id === 'google-calendar' ? cal.google ?? null : null;
          return (
            <Row key={x.id} icon={<IconGlobe width={18} height={18} className={g?.connected ? 'ok' : undefined} />} title={<>{x.name}{x.status === 'soon' && <Soon />}</>} desc={g?.connected ? `Connected · ${g.account ?? 'Google account'} · upcoming meetings show on Home` : x.description}>
              <button className="pill" onClick={() => onConnector(x.id)}>{g?.connected ? 'Manage' : x.status === 'soon' ? 'Details' : 'Connect'}</button>
            </Row>
          );
        })}
      </div>

      <h3>Home</h3>
      <div className="set-card">
        <Row icon={<IconCalendar width={18} height={18} />} title="Up next" desc="How far ahead Home shows your meetings">
          <select className="set-select" disabled={!on} value={cal.days} onChange={async (e) => setCal({ ...(await window.quorum.calendarSet({ days: e.target.value === 'week' ? 'week' : Number(e.target.value) })), status: cal.status })}>
            {[1, 2, 3, 4, 5].map((d) => <option key={d} value={d}>{d === 1 ? 'Next 1 day' : `Next ${d} days`}</option>)}
            <option value="week">Weekly</option>
          </select>
        </Row>
      </div>

      <h3>Meetings</h3>
      <div className="set-card">
        <Row icon={<IconNotes width={18} height={18} />} title={<>Name notes after the event<Soon /></>} desc="Will use the calendar title instead of the Zoom topic"><Toggle on onChange={noop} disabled /></Row>
        <Row icon={<IconPeople width={18} height={18} />} title={<>Add attendees to notes<Soon /></>} desc="Will list everyone invited, even if they don't speak"><Toggle on onChange={noop} disabled /></Row>
        <Row icon={<Wave live={false} />} title={<>Only listen to my meetings<Soon /></>} desc="Will skip events you weren't invited to"><Toggle on={false} onChange={noop} disabled /></Row>
      </div>
    </>
  );
}

// the version this is, whether a newer one is ready, and a check on request; a failure shows here, never as a popup
function AboutCard() {
  const [u, setU] = useState<UpdateState | null>(null);
  useEffect(() => { window.quorum.updateStatus().then((s) => setU(s ?? null)).catch(() => {}); return window.quorum.onUpdate(setU); }, []);
  // the beta line: what this install reports and under which id, as long as the gate is part of the build
  const [beta, setBeta] = useState<BetaState | null>(null);
  useEffect(() => { Promise.resolve(window.quorum.betaStatus?.()).then((b) => setBeta(b ?? null)).catch(() => {}); }, []);
  if (!u) return null;
  const when = u.checkedAt ? new Date(u.checkedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : null;
  const desc = u.status === 'off' ? (u.current ? 'A development copy; updates come with the installed app' : 'No update feed for this build')
    : u.status === 'checking' ? 'Checking for updates…'
    : u.status === 'downloading' ? `Downloading ${u.version ?? 'the update'}${u.percent ? ` · ${u.percent}%` : ''}`
    : u.status === 'ready' ? `Quorum ${u.version} is downloaded and installs when you choose Update`
    : u.status === 'failed' ? `Could not check for updates${u.error ? `: ${u.error}` : ''}`
    : `Up to date${when ? ` · checked at ${when}` : ''}`;
  return (
    <>
      <h3>About</h3>
      <div className="set-card">
        <Row icon={<IconQuorum width={18} height={18} />} title={`Quorum ${u.current}`} desc={desc}>
          {u.status === 'ready' ? <button className="pill primary" onClick={() => window.quorum.updateInstall()}>Update and restart</button>
            : u.status !== 'off' && <button className="pill" disabled={u.status === 'checking' || u.status === 'downloading'} onClick={() => window.quorum.updateCheck()}>Check for updates</button>}
        </Row>
        {beta?.on && (
          <Row icon={<IconInfo width={18} height={18} />} title="Beta" desc={`This install reports its access code${beta.code ? ` (${beta.code})` : ''}, an anonymous machine id and the app version to Quorum once a day, so active installs can be counted while the beta lasts. Machine id: ${beta.machineId ?? 'not assigned yet'}.`} />
        )}
      </div>
    </>
  );
}

// every row is planned work: the controls are disabled on purpose and each line says what the notification will do
function NotificationsPage({ settings, set }: { settings: Settings; set: (patch: Partial<Settings>) => void }) {
  // which of Quorum's own notifications show in the bell's list and count toward its dot; all on until turned off
  const n = { noteUpdates: true, memoryChanges: true, reviews: true, guardrails: true, ...(settings.notifications ?? {}) };
  const flip = (k: keyof typeof n) => (on: boolean) => set({ notifications: { ...n, [k]: on } });
  return (
    <>
      <p className="mcp-lede">What Quorum's agents did, in the bell at the top of the window. Turn off a kind to leave it out of the list and the dot.</p>
      <h3>From Quorum</h3>
      <div className="set-card">
        <Row icon={<IconNotes width={18} height={18} />} title="Note updates" desc="Quorum updated, filed, linked or referenced one of your notes"><Toggle on={n.noteUpdates} onChange={flip('noteUpdates')} /></Row>
        <Row icon={<IconBrain width={18} height={18} />} title="Memory changes" desc="Quorum created or changed a memory page"><Toggle on={n.memoryChanges} onChange={flip('memoryChanges')} /></Row>
        <Row icon={<IconBell width={18} height={18} />} title="Needs your review" desc="A change Quorum made is waiting for your approval"><Toggle on={n.reviews} onChange={flip('reviews')} /></Row>
        <Row icon={<IconShield width={18} height={18} />} title="Guardrail blocked something" desc="A built-in guardrail kept the agent from a file or a person"><Toggle on={n.guardrails} onChange={flip('guardrails')} /></Row>
      </div>
    </>
  );
}

// one connection for the whole workspace: a System One decision model (OpenAI decisions or TypeSafe Jev) for quick yes-or-no checks.
// No backend yet, so the key sits in this Mac's Keychain
function WorkspaceDecisions({ connectedBy }: { connectedBy?: string }) {
  const [dk, setDk] = useState<DecisionsStatus | null>(null);
  const [more, setMore] = useMenu();
  const [pick, setPick] = useMenu();
  const [keying, setKeying] = useState<DecisionProvider | null>(null);
  const refresh = () => window.quorum.decisionsStatus().then(setDk);
  useEffect(() => { refresh(); }, []);
  const on = !!dk?.connected && !!dk.provider;
  const name = on && dk?.provider ? dk.providers[dk.provider].name : 'Decision checks';
  const ids = (Object.keys(dk?.providers ?? {}) as DecisionProvider[]);
  return (
    <div className="set-card">
      <Row icon={on && dk?.provider ? <ProviderMark provider={dk.provider} /> : <IconShield width={18} height={18} />} title={name}
        desc={on ? `Quick yes-or-no checks for everyone${connectedBy ? ` · set up by ${connectedBy}` : ''}` : 'Quick yes-or-no checks during calls: STOP said another way, what is worth a note, when to look for an answer'}>
        {on ? (
          <span className="menu-wrap" onClick={(e) => e.stopPropagation()}>
            <button className="icon-btn" aria-label="Decision checks options" aria-haspopup="menu" aria-expanded={more} onClick={() => setMore((o) => !o)}><IconMore /></button>
            {more && (
              <div className="menu end" role="menu">
                <button role="menuitem" onClick={() => { setMore(false); setKeying(dk!.provider); }}><IconReset width={15} height={15} /> Replace key</button>
                {ids.filter((id) => id !== dk?.provider).map((id) => <button key={id} role="menuitem" onClick={() => { setMore(false); setKeying(id); }}><ProviderMark provider={id} /> Switch to {dk!.providers[id].name}</button>)}
                <button role="menuitem" className="danger" onClick={async () => { setMore(false); await window.quorum.decisionsRemove(); refresh(); }}><IconClose width={15} height={15} /> Disconnect</button>
              </div>
            )}
          </span>
        ) : (
          <span className="menu-wrap" onClick={(e) => e.stopPropagation()}>
            <button className="pill" aria-haspopup="menu" aria-expanded={pick} onClick={() => setPick((o) => !o)}>Connect</button>
            {pick && (
              <div className="menu end" role="menu">
                {ids.map((id) => <button key={id} role="menuitem" onClick={() => { setPick(false); setKeying(id); }}><ProviderMark provider={id} /> {dk!.providers[id].name}</button>)}
              </div>
            )}
          </span>
        )}
      </Row>
      {keying && dk && <DecisionsKey provider={keying} info={dk.providers[keying]} onDone={(ok) => { setKeying(null); if (ok) refresh(); }} />}
    </div>
  );
}

// the key is checked with one tiny question, then saved to the Keychain
function DecisionsKey({ provider, info, onDone }: { provider: DecisionProvider; info: { name: string; placeholder: string; keyHint: string }; onDone: (ok: boolean) => void }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    setBusy(true); setError('');
    const r = await window.quorum.decisionsSet(provider, key);
    setBusy(false);
    if (r.error) setError(r.error); else onDone(true);
  };
  return (
    <Modal titleId="dk-title" title={<>Connect {info.name}</>} onClose={() => onDone(false)}>
      <p>Paste your {info.keyHint}. Quorum keeps it in your Mac's Keychain.</p>
      <label className="set-field wide"><input type="password" autoFocus aria-label={info.keyHint} placeholder={info.placeholder} value={key} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && key.trim()) save(); }} /></label>
      {error && <p className="set-error">{error}</p>}
      <ModalActions>
        <button className="pill" onClick={() => onDone(false)}>Cancel</button>
        <button className="pill primary" disabled={!key.trim() || busy} onClick={save}>{busy ? 'Checking…' : 'Connect'}</button>
      </ModalActions>
    </Modal>
  );
}

// Quorum reached from outside: the MCP server in Claude Code and Codex, and the quorum command in Terminal. Claude Code
// as a model provider is a row in PersonalConnectors above
function ClaudeCard() {
  const agents = useAgents();
  const check = useConnectionCheck(agents);
  return (
    <>
      <div className="set-head"><h3>Connect to AI tools</h3></div>
      <p className="mcp-lede">Give Claude Code, Codex and Terminal access to your notes and meetings through the quorum MCP server and command.</p>
      <div className="set-card">
        <McpRows agents={agents} />
      </div>
      <div className="conn-check-head">
        <p className="mcp-lede">Check connection makes sure your agent can reach Quorum's meeting notes. It changes nothing in your Agent OS folder.</p>
        <ConnectionCheckButton running={check.running} onRun={check.run} />
      </div>
      {check.result && <ConnectionCheckList result={check.result} running={check.running} onAction={check.act} />}
    </>
  );
}

// the agent rows (AgentLinks.tsx) and the Access choice. All run the CLI that ships beside the app; nothing listens on
// a port
function McpRows({ agents }: { agents: Agents }) {
  const [access, setAccess] = useState<'read' | 'write'>('write');
  useEffect(() => { window.quorum.getSettings().then((st) => setAccess(st.access ?? 'write')); }, []);
  return (
    <>
        <AgentRows agents={agents} variant="settings" manual={(command) => (
          <div className="row-extra">
            <p className="copy-label">Or run Quorum in Terminal with its full path</p>
            <CopyField value={command} />
          </div>
        )} />
        <Row icon={<IconLock width={18} height={18} />} title="Access" desc="Your workspace admin will set this later">
          <select className="set-select" aria-label="Access" value={access} onChange={async (e) => { const v = e.target.value as 'read' | 'write'; setAccess(v); await window.quorum.setSettings({ access: v }); }}>
            <option value="write">Read and write</option>
            <option value="read">Read only</option>
          </select>
        </Row>
    </>
  );
}

// a read-only value with a copy button; the check stays 5 seconds, then dissolves back to the copy icon
function CopyField({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (!copied) return; const t = setTimeout(() => setCopied(false), 5000); return () => clearTimeout(t); }, [copied]);
  return (
    <label className="set-field wide copy-field">
      <input readOnly value={value} onFocus={(e) => e.target.select()} aria-label="Terminal command" />
      <button type="button" className={`icon-btn copy-btn ${copied ? 'copied' : ''}`} aria-label={copied ? 'Copied' : 'Copy'} data-tip={copied ? 'Copied' : 'Copy'} data-tip-pos="left"
        onClick={() => { navigator.clipboard.writeText(value); setCopied(true); }}>
        <IconCopy className="ic-copy" width={16} height={16} /><IconCheck className="ic-check" width={16} height={16} />
      </button>
    </label>
  );
}

// meeting apps Quorum listens to and how it turns their audio into text
// keeps call audio from showing as you; the description follows the choice
const ECHO_DESC: Record<NonNullable<Transcription['echo']>, string> = {
  auto: 'On the built-in speakers, drops your lines that repeat what the call just said; nothing with headphones',
  filter: 'Drops your lines that repeat what the call just said',
  aec: "Apple's voice processing in the microphone. Can take the mic away from the call app on this Mac",
  off: 'Call audio can show as you on speakers',
};

function MeetingsPage({ settings, onSettings, onConnector, teamMeetings, folders }: { settings: Settings; onSettings: (s: Settings) => void; onConnector: (id: string) => void; teamMeetings: boolean; folders: ReactNode }) {
  const t = settings.transcription ?? {};
  const saveTx = async (patch: Transcription) => onSettings(await window.quorum.setSettings({ transcription: patch }));
  // call detection and auto-listen follow meeting-capture; the transcription rows follow manual-listen (flags.ts)
  const nt = useNotetaker();
  return (
    <>
      {folders}
      {nt.meetingCapture && <>
      <h3>Listening</h3>
      <div className="set-card">
        <Row icon={<Wave live={false} />} title="Listen automatically" desc="Starts transcribing when a meeting begins in Zoom, Google Meet or Teams">
          <Toggle on={settings.autoListen} onChange={async (v) => onSettings(await window.quorum.setSettings({ autoListen: v }))} />
        </Row>
      </div>
      <MeetingProviders onConnector={onConnector} />
      </>}
      <h3>Meeting notes</h3>
      <div className="set-card">
        <ConnectHint connector="zoom" title="Cloud recordings" desc="Zoom's cloud recordings and transcripts import through the Zoom connector in Quorum Cloud. Google Meet and Teams recordings are next.">
          <button className="pill small-pill" onClick={() => onConnector('zoom')}>Open Zoom connector</button>
        </ConnectHint>
        {teamMeetings && (
          <Row icon={<IconNotes width={18} height={18} />} title="Save meeting notes to the team's meetings knowledge base"
            desc="New notes you record with Record or Start listening are shared with your team, one folder per month. Each meeting-notes account asks first, below. Confidential notes stay private, and Keep private on any note takes it out.">
            <Toggle on={settings.meetingsKb?.autoSave !== false} onChange={async (on) => onSettings(await window.quorum.setSettings({ meetingsKb: { autoSave: on } }))} />
          </Row>
        )}
        {teamMeetings && <MeetingSourcesRows />}
      </div>
      {nt.manualListen && <>
      <h3>Transcribing</h3>
      <p className="mcp-lede">How Quorum turns what it hears into text when you start listening.</p>
      {settings.providers?.speech && settings.providers.speech !== 'apple' && <p className="set-note">Cloud speech engines arrive with the speech provider interface. {BY_ID[settings.providers.speech]?.name ?? 'That provider'} is saved as your speech provider; until then Apple transcribes every meeting on this Mac.</p>}
      <div className="set-card even">
        <Row icon={<IconKeyboard width={18} height={18} />} title="Show words as they're heard" desc="Unconfirmed words appear dimmed"><Toggle on={t.live ?? true} onChange={(on) => saveTx({ live: on })} /></Row>
        <Row icon={<Wave live={false} />} title="Transcript refs in saved notes" desc="Each bullet gets a footnote with the transcript turn behind it"><Toggle on={settings.notes?.refs ?? false} onChange={async (on) => onSettings(await window.quorum.setSettings({ notes: { refs: on } }))} /></Row>
        <Row icon={<Wave live={false} />} title="Echo handling" desc={ECHO_DESC[t.echo ?? 'auto']}>
          <select className="set-select" value={t.echo ?? 'auto'} onChange={(e) => saveTx({ echo: e.target.value as Transcription['echo'] })}>
            <option value="auto">Automatic</option><option value="filter">Filter repeats</option><option value="aec">Cancel echo</option><option value="off">Off</option>
          </select>
        </Row>
        <Row icon={<IconSliders width={18} height={18} />} title="Clean up transcript" desc="Removes fillers and repeats, fixes capitalization and writes numbers as digits. Off keeps every word as spoken."><Toggle on={t.clean ?? true} onChange={(on) => saveTx({ clean: on })} /></Row>
        <Row icon={<IconNotes width={18} height={18} />} title="New paragraph after" desc="How long a pause starts a new turn">
          <select className="set-select" value={t.gap ?? 1.5} onChange={(e) => saveTx({ gap: Number(e.target.value) })}>
            <option value={0.8}>Short pause</option><option value={1.5}>1.5 seconds</option><option value={3}>Long pause</option>
          </select>
        </Row>
        <Row icon={<IconGlobe width={18} height={18} />} title="Audio from calls" desc="Notes always hear everything your Mac plays">
          <select className="set-select" value={t.capture ?? 'meeting'} onChange={(e) => saveTx({ capture: e.target.value as Transcription['capture'] })}>
            <option value="meeting">Meeting app only</option><option value="all">Everything on this Mac</option>
          </select>
        </Row>
      </div>
      </>}
    </>
  );
}

function DevelopersPage() {
  return (
    <>
      <ClaudeCard />
      <PersonalConnectors />
      <FlagsCard />
      <h3>API</h3>
      <p className="mcp-lede">Keys for scripts and tools to reach your notes.</p>
      <div className="set-card">
        <Row icon={<IconCode width={18} height={18} />} title={<>Personal API keys<Soon /></>} desc="Will issue keys that let your scripts and tools read and write your notes">
          <button className="icon-btn" disabled aria-label="Manage API keys"><IconChevron className="right" /></button>
        </Row>
      </div>
    </>
  );
}

// the feature flags this copy runs with (app/flags.js): read-only here, the admin app sets them; each row names where
// its value came from, and Refresh asks the relay now instead of waiting for the hourly read
const FLAG_SOURCE: Record<string, string> = { env: 'QUORUM_FLAGS in the environment', relay: 'the relay', cache: 'the last relay answer, cached', defaults: 'built into this build' };
function FlagsCard() {
  const state = useFlags();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = async () => {
    setBusy(true); setError(null);
    try { const r = await window.quorum.flagsRefresh(); if (r.ok === false) setError(r.error || 'The flags could not be read.'); }
    catch { setError('The flags could not be read.'); }
    finally { setBusy(false); }
  };
  const shownError = error ?? state.error ?? null;
  const entries = Object.entries(state.flags).sort(([a], [b]) => a.localeCompare(b));
  return (
    <>
      <div className="set-head">
        <h3>Feature flags</h3>
        <span className="set-head-actions"><button className="pill small-pill" disabled={busy} onClick={refresh}>{busy ? 'Reading…' : 'Refresh'}</button></span>
      </div>
      <p className="mcp-lede">Switches set in the admin app. A change takes effect as soon as this copy reads it, with no restart; screen-context needs manual-listen on. This copy reads them on launch and every hour{state.fetchedAt ? `; last read ${new Date(state.fetchedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : '; not read from the relay yet'}.</p>
      {shownError && <p className="set-error">{shownError} The values below are the last ones this copy had.</p>}
      <div className="set-card">
        {entries.length === 0 && <Row icon={<IconSliders width={18} height={18} />} title="No flags yet" desc="The relay has not answered and this build has no defaults" />}
        {entries.map(([key, v]) => (
          <Row key={key} icon={<IconSliders width={18} height={18} />} title={<code className="ac-code">{key}</code>} desc={`${v.enabled ? 'On' : 'Off'}, from ${FLAG_SOURCE[v.source] ?? v.source}${v.blockedBy ? `; off because ${v.blockedBy} is off` : v.requires ? `; needs ${v.requires}` : ''}`}>
            <Toggle on={v.enabled} disabled onChange={() => {}} />
          </Row>
        ))}
      </div>
    </>
  );
}

// the meeting apps the workspace uses, read on this Mac. Zoom gets the notice in its chat; Meet and Teams are detected and captured
const CONNECTOR_FOR_APP: Record<string, string> = { zoom: 'zoom', meet: 'google-meet', teams: 'teams' };
function MeetingProviders({ onConnector }: { onConnector: (id: string) => void }) {
  type Provider = Awaited<ReturnType<typeof window.quorum.meetingProviders>>[number];
  const [list, setList] = useState<Provider[] | null>(null);
  const [icons, setIcons] = useState<Record<string, string | null>>({});
  const [adding, setAdding] = useState(false);
  const [menu, setMenu] = useState<string | null>(null);
  const [details, setDetails] = useState<Provider | null>(null);
  const reload = () => window.quorum.meetingProviders().then(setList);
  const toggle = async (p: Provider, on: boolean) => { setMenu(null); await window.quorum.meetingProviderSet(p.id, on); reload(); };
  useEffect(() => {
    window.quorum.meetingProviders().then(setList);
    window.quorum.sourceIcons().then(setIcons);
    const close = () => { setAdding(false); setMenu(null); };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);
  const ready = (p: Provider) => p.enabled && p.installed && p.access !== false;
  const where = (p: Provider) => (p.id === 'zoom' ? `the ${p.name} app` : `${p.name} in the ${p.id === 'teams' ? 'Teams app or a' : ''} browser`);
  const desc = (p: Provider) => !p.enabled ? `Removed. Quorum won't notice ${p.name} calls`
    : !p.installed ? `${p.name} isn't installed on this Mac`
    : p.access === false ? `Quorum needs Accessibility access to read ${p.name}`
    : p.inCall ? 'In a call now'
    : p.chat ? `Experimental: reads ${where(p)} on this Mac and posts Quorum's notice in the chat`
    : `Experimental: reads ${where(p)} on this Mac. No chat posting yet, so you start Quorum and tell the call`;
  const removed = list?.filter((p) => !p.enabled) ?? [];
  return (
    <>
      <div className="set-head">
        <h3>Providers</h3>
        <span className="set-head-actions menu-wrap" onClick={(e) => e.stopPropagation()}>
          <button className="pill small-pill with-icon" aria-haspopup="menu" aria-expanded={adding} onClick={() => setAdding((o) => !o)}><IconPlus width={15} height={15} />Add</button>
          {adding && (
            <div className="menu end" role="menu">
              {removed.map((p) => <button key={p.id} role="menuitem" onClick={() => { setAdding(false); toggle(p, true); }}>{p.name}</button>)}
              {!removed.length && <button role="menuitem" disabled>Zoom, Google Meet and Microsoft Teams are all added</button>}
            </div>
          )}
        </span>
      </div>
      <p className="mcp-lede">The meeting apps Quorum listens to, read on this Mac. Each one is a connector; open it for details and settings.</p>
      <div className="set-card">
        {list?.map((p) => (
          <Row key={p.id}
            icon={icons[p.id] ? <img className="set-app-icon" src={icons[p.id]!} alt="" /> : <IconChat width={18} height={18} />}
            title={<><button className="mem-title" onClick={() => onConnector(CONNECTOR_FOR_APP[p.id] ?? p.id)}>{p.name}<IconChevron className="right" width={14} height={14} /></button>{ready(p) && <span className="conn-ok"><i />Listening on this Mac</span>}</>} desc={desc(p)}>
            {!p.enabled && <button className="pill" onClick={() => toggle(p, true)}>Add</button>}
            {p.enabled && p.installed && p.access === false && <button className="pill" onClick={() => window.quorum.axSettingsOpen()}>Open System Settings</button>}
            {p.enabled && (
              <span className="menu-wrap" onClick={(e) => e.stopPropagation()}>
                <button className="icon-btn" aria-label={`${p.name} options`} aria-haspopup="menu" aria-expanded={menu === p.id} data-tip="More options" onClick={() => setMenu((m) => (m === p.id ? null : p.id))}><IconMore /></button>
                {menu === p.id && (
                  <div className="menu end" role="menu">
                    <button role="menuitem" onClick={() => { setMenu(null); onConnector(CONNECTOR_FOR_APP[p.id] ?? p.id); }}><IconGrid width={15} height={15} /> View connector</button>
                    <button role="menuitem" onClick={() => { setMenu(null); setDetails(p); }}><IconInfo width={15} height={15} /> View details</button>
                    <button role="menuitem" onClick={() => { setMenu(null); window.quorum.meetingProviderCheck().then(() => setTimeout(reload, 1500)); }}><IconReset width={15} height={15} /> Check again</button>
                    <button role="menuitem" onClick={() => { setMenu(null); window.quorum.axSettingsOpen(); }}><IconLock width={15} height={15} /> Accessibility settings</button>
                    <div className="menu-sep" />
                    <button role="menuitem" className="danger" onClick={() => toggle(p, false)}><IconClose width={15} height={15} /> Remove</button>
                  </div>
                )}
              </span>
            )}
          </Row>
        ))}
      </div>
      {details && (
        <Modal titleId="prov-title" title={details.name} onClose={() => setDetails(null)}>
          <p>Quorum reads {where(details)} on this Mac. Nothing goes through {details.name}'s servers or a bot.</p>
          <dl className="about-facts">
            <dt>Status</dt><dd>{ready(details) ? (details.inCall ? 'Connected, in a call now' : details.running ? 'Connected, app open' : 'Connected') : desc(details)}</dd>
            <dt>App</dt><dd>{details.version ? `${details.name} ${details.version}` : details.name}</dd>
            <dt>Location</dt><dd>{details.path}</dd>
            <dt>Permission</dt><dd>Accessibility {details.access === false ? 'off' : details.access ? 'on' : 'unknown'}</dd>
            <dt>Reads</dt><dd>{details.chat ? "Meeting title, participant names, chat, and the app's audio" : 'Window title, participant count when the browser exposes it, and the audio it plays'}</dd>
            <dt>Posts</dt><dd>{details.chat ? "Quorum's notice when it starts, and replies to STOP and GO" : 'Nothing yet. The notice shows on this Mac and the saved note records that none was posted in the call'}</dd>
          </dl>
          <ModalActions><button className="pill primary" autoFocus onClick={() => setDetails(null)}>Done</button></ModalActions>
        </Modal>
      )}
    </>
  );
}

const LANGUAGES = [['en-US', 'English (US)'], ['en-GB', 'English (UK)'], ['en-AU', 'English (Australia)'], ['es-ES', 'Spanish (Spain)'], ['es-MX', 'Spanish (Mexico)'], ['fr-FR', 'French'], ['de-DE', 'German'], ['it-IT', 'Italian'], ['pt-BR', 'Portuguese (Brazil)'], ['ja-JP', 'Japanese']];

// what works today applies to the dictate button in every Quorum composer; the eight Soon rows are system-wide voice typing.
// With the dictation flag off the page is the Dictionary: the language and the word list, which listening uses too
function VoicePage({ settings, onSettings, dictionaryOnly = false, screenRow = false }: { settings: Settings; onSettings: (s: Settings) => void; dictionaryOnly?: boolean; screenRow?: boolean }) {
  const v = settings.voice ?? {};
  const save = async (patch: Partial<Voice>) => onSettings(await window.quorum.setSettings({ voice: patch }));
  const words = v.dictionary ?? [];
  const [heard, setHeard] = useState('');
  const [write, setWrite] = useState('');
  const addWord = () => { if (!heard.trim() || !write.trim()) return; save({ dictionary: [...words, { heard: heard.trim(), write: write.trim() }] }); setHeard(''); setWrite(''); };
  const language = (
    <Row icon={<IconGlobe width={18} height={18} />} title="Language" desc="What you speak most, transcribed on this Mac">
      <select className="set-select" value={v.locale ?? 'en-US'} onChange={(e) => save({ locale: e.target.value })}>
        {LANGUAGES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
      </select>
    </Row>
  );
  const dictionary = (
    <>
      <h3>Dictionary</h3>
      <div className="set-card">
        <p className="set-hint">{dictionaryOnly ? 'When Quorum hears a word, write it your way instead. Applies to transcripts.' : 'When Quorum hears a word, write it your way instead. Applies to dictation and meeting transcripts.'}</p>
        {words.map((w, i) => (
          <div key={`${w.heard}-${i}`} className="dict-row">
            <span className="dict-heard">{w.heard}</span><span className="muted">→</span><strong>{w.write}</strong>
            <button className="icon-btn mem-no" aria-label={`Remove ${w.heard}`} data-tip="Remove" onClick={() => save({ dictionary: words.filter((_, j) => j !== i) })}><IconClose width={14} height={14} /></button>
          </div>
        ))}
        <div className="dict-row add">
          <label className="set-field"><input value={heard} placeholder="Quorum hears" onChange={(e) => setHeard(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addWord(); }} /></label>
          <span className="muted">→</span>
          <label className="set-field"><input value={write} placeholder="Write as" onChange={(e) => setWrite(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addWord(); }} /></label>
          <button className="pill small-pill with-icon" disabled={!heard.trim() || !write.trim()} onClick={addWord}><IconPlus width={15} height={15} />Add</button>
        </div>
      </div>
    </>
  );
  // Notes: what Record from the header captures, then the language and word list the transcript uses
  if (dictionaryOnly) return (
    <>
      <h3>Recording</h3>
      <div className="set-card">
        <Row icon={<IconMic width={18} height={18} />} title="Transcription" desc="Your voice and your Mac's sound">
          <Toggle on={settings.notes?.transcription !== false} onChange={async (on) => onSettings(await window.quorum.setSettings({ notes: { transcription: on } }))} />
        </Row>
        {screenRow && <ScreenContextRow />}
      </div>
      <div className="set-card">{language}</div>
      {dictionary}
    </>
  );
  return (
    <>
      <div className="set-card">
        <Row icon={<IconKeyboard width={18} height={18} />} title={<>Voice typing in any app<Soon /></>} desc="Will let you talk instead of type in every app, outside Quorum too"><Toggle on={false} onChange={noop} disabled /></Row>
      </div>

      <h3>In Quorum</h3>
      <div className="set-card">
        <Row icon={<IconMic width={18} height={18} />} title="Dictate in the composer" desc="Press to start, press again to finish">
          <span className="keycap">⌘</span><span className="keycap">⇧</span><span className="keycap">D</span>
        </Row>
        {language}
        <Row icon={<Wave live={false} />} title="Sound effects" desc="A soft tone when dictation starts and stops"><Toggle on={v.sounds ?? false} onChange={(on) => save({ sounds: on })} /></Row>
      </div>

      {dictionary}

      <h3>Shortcuts</h3>
      <div className="set-card">
        <Row icon={<IconKeyboard width={18} height={18} />} title={<>Hold to talk<Soon /></>} desc="Will start dictation while you hold fn and finish when you release it"><span className="keycap off">fn</span></Row>
        <Row icon={<IconKeyboard width={18} height={18} />} title={<>Hands-free<Soon /></>} desc="Will start on one press of fn and finish on the next"><span className="keycap off">fn</span><span className="muted small">then</span><span className="keycap off">fn</span></Row>
      </div>

      <h3>More</h3>
      <div className="set-card">
        <Row icon={<IconMic width={18} height={18} />} title={<>Microphone<Soon /></>} desc="Will let you pick an input. Dictation uses your Mac's default input for now">
          <select className="set-select" disabled defaultValue="default"><option value="default">System default</option></select>
        </Row>
        <Row icon={<IconSliders width={18} height={18} />} title={<>Styles<Soon /></>} desc="Will apply a writing style for each kind of app"><Toggle on={false} onChange={noop} disabled /></Row>
        <Row icon={<IconNotes width={18} height={18} />} title={<>Auto-add words<Soon /></>} desc="Will add words you correct to your dictionary"><Toggle on={false} onChange={noop} disabled /></Row>
        <Row icon={<Wave live={false} />} title={<>Mute other audio<Soon /></>} desc="Will quiet your Mac while you talk"><Toggle on={false} onChange={noop} disabled /></Row>
      </div>

      <h3>Data and privacy</h3>
      <div className="set-card">
        <Row icon={<IconLock width={18} height={18} />} title="On this Mac only" desc="Audio is transcribed on-device and never saved" />
      </div>
    </>
  );
}

// a step back in the Connectors breadcrumbs; the first one gives way (ellipsis) when the row runs out of room
const CRUMB_SEP = <span className="crumb-sep" aria-hidden="true">/</span>;
function Crumb({ label, onClick }: { label: string; onClick: () => void }) {
  return <span className="crumb" role="link" tabIndex={0} onClick={onClick} onKeyDown={(e) => { if (e.key === 'Enter') onClick(); }}>{label}</span>;
}
