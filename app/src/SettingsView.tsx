import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { SetupForm, answersFrom, draftFrom, draftIsEmpty, emptyDraft, type SetupDraft } from './SetupForm';
import type { AccountState, BetaState, Brain, CalendarSettings, ClaudeStatus, DecisionProvider, DecisionsStatus, KeeperStatus, Memory, MemoryItem, OptOut, Profile, ScreenContextStatus, Settings, TeamVault, Transcription, UpdateState, Voice, Workspace } from './quorum';
import { PersonalConnectors } from './Connectors';
import { ConnectorsPage } from './ConnectorsPage';
import { GuardrailsPage } from './Guardrails';
import { CONNECTORS, CONNECTOR_BY_ID } from '../connectors/library';
import { ConnectHint } from './ConnectHint';
import { openConnectors, type ConnectorsTarget } from './connectorsNav';
import { BY_ID } from '../connectors/catalog';
import { useSession } from './session';
import { Row, Toggle, useMenu } from './controls';
import { AccountArea, BillingArea, EDITION, KnowledgeQueueArea, MembersArea, TeamsArea, WorkspaceConnectorsArea, WorkspaceGuardrailsArea, WorkspaceVoiceArea, useHostedAccounts } from './edition';
import { canAdmin, modeOf, resolvePage, workspacePages, type Page } from './settingsNav';
import { EnvSwitch } from './EnvSwitch';
import { useFlags } from './flags';
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
  { id: 'connectors', label: 'Connectors', icon: IconGrid },
  { id: 'notifications', label: 'Notifications', icon: IconBell, soon: true },
  { id: 'voice', label: 'Voice typing', icon: IconKeyboard },
  { id: 'developers', label: 'AI settings', icon: IconCode },
  { id: 'guardrails', label: 'Guardrails', icon: IconShield },
];
// the pages behind the Admin button; settingsNav.workspacePages decides which of them a build lists
const WORKSPACE: Nav[] = [
  { id: 'general', label: 'General', icon: IconBuilding },
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
  const [saved, setPage] = useSession<Page>('settingsPage', 'preferences');
  // an open connector detail page; cleared when the page changes
  const [connectorDetail, setConnectorDetail] = useState<string | null>(null);
  // the Add connector sheet, opened from outside on a category (Home's hints, the Memory page)
  const [libraryOpen, setLibraryOpen] = useState<{ cat: string | true; n: number } | null>(null);
  // a page change clears the detail, so a connector named along with a page change waits until the page has changed
  const pending = useRef<string | null>(null);
  useEffect(() => { setConnectorDetail(pending.current); pending.current = null; }, [saved]);
  const goConnector = (id: string) => { if (saved !== 'connectors') pending.current = id; setConnectorDetail(id); setPage('connectors'); };
  useEffect(() => {
    if (!open) return;
    if (open.page !== saved) pending.current = open.connector ?? null; else setConnectorDetail(open.connector ?? null);
    setPage(open.page);
    setLibraryOpen(open.library ? { cat: open.library, n: open.n } : null);
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
  const listed = workspacePages(EDITION, hosted, account?.workspace?.teamEnabled === true);
  const page = resolvePage(saved, admin, listed);
  const mode = modeOf(page);
  const quorumEmail = account?.signedIn ? account.email : null;
  const email = quorumEmail || user?.email || '';
  // in the hosted edition the identity is the Quorum account; until there is one the row holds only the photo, and the
  // sign-in card lower on the page says what signing in adds. The local edition's only identity is the Claude Code sign-in
  const emailLabel = quorumEmail ? 'Email' : EDITION === 'cloud' ? 'Photo' : 'Signed in with Claude Code';
  const showEmail = !!quorumEmail || EDITION !== 'cloud';
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onBack(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onBack]);

  const set = async (patch: Partial<Settings>) => onSettings(await window.quorum.setSettings(patch));
  const workspaceNav = WORKSPACE.filter((n) => (listed as string[]).includes(n.id));
  const all = [...ACCOUNT, ...WORKSPACE];
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
              {ACCOUNT.map(navItem)}
              {admin && <button className="set-nav admin" onClick={() => go('general')}><IconBuilding width={18} height={18} /><span>Admin</span></button>}
            </>
          ) : (
            <>
              <button className="set-menu-back" onClick={() => go('preferences')}><IconChevron width={16} height={16} />Menu</button>
              {workspaceNav.map(navItem)}
            </>
          )}
        </nav>
        <button className="set-quit" onClick={() => window.quorum.quit()}><IconPower width={18} height={18} /> Quit Quorum</button>
      </aside>

      <main className="set-main">
        <div className="set-col">
          {page === 'connectors' && connectorDetail && CONNECTOR_BY_ID[connectorDetail]
            ? <h1 className="set-title crumbs"><span className="crumb" role="link" tabIndex={0} onClick={() => setConnectorDetail(null)} onKeyDown={(e) => { if (e.key === 'Enter') setConnectorDetail(null); }}>Connectors</span><span className="crumb-sep" aria-hidden="true"> / </span><span>{CONNECTOR_BY_ID[connectorDetail].name}</span><span className="crumb-actions" id="conn-title-actions" /></h1>
            : <h1 className="set-title">{current.label}{current.soon && <Soon />}</h1>}
          {page === 'preferences' && <p className="set-lede">Quorum works best knowing a little about you. Quorum uses this when it writes your meeting notes and answers questions.</p>}
          {page === 'knowledge' && <p className="set-lede">Company knowledge for your whole workspace, chosen by admins.</p>}
          {page === 'general' && <p className="set-lede">Settings for everyone in your workspace. Quorum gives this context to every meeting summary and answer, so it's the same for each person.</p>}
          {page === 'teams' && <p className="set-lede">A workspace starts as yours alone. Turn on a team to invite members and build knowledge together.</p>}
          {page === 'billing' && <p className="set-lede">Your plan, the card it charges, and this month's usage against the hours it includes.</p>}
          {page === 'connectors' && !connectorDetail && <p className="set-lede">The tools Quorum is connected to. Meeting notes, calendars and AI tools, each tagged with where things came from.</p>}
          {page === 'developers' && <p className="set-lede">Model providers, Claude Code and Terminal access, and API keys for your own scripts.</p>}
          {page === 'preferences' ? (
            <ProfilePage settings={settings} email={showEmail ? email : ''} emailLabel={emailLabel} name={user?.name ?? ''} onSettings={onSettings}>
              <h3>General</h3>
              <div className="set-card">
                <Row icon={<IconChat width={18} height={18} />} title="Suggest answers from my notes" desc="Offers your notes when someone asks you a question">
                  <Toggle on={settings.suggestions !== false} onChange={(v) => set({ suggestions: v })} />
                </Row>
                <ScreenContextRow />
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
              <SecondBrain brain={brain} onConnect={onConnect} onDisconnect={onDisconnect} onBrain={onBrain} onViewConnector={goConnector} />
              {brain && <KeeperCard brain={brain} />}
              {brain && <MemoryScan />}
            </>
          ) : page === 'members' ? <MembersArea />
            : page === 'org-connectors' ? <WorkspaceConnectorsArea local={<OrgConnectorsLocal onGo={go} />} />
            : page === 'org-voice' ? <WorkspaceVoiceArea local={<OrgVoiceLocal onGo={go} />} />
            : page === 'org-guardrails' ? <WorkspaceGuardrailsArea local={<p className="set-lede">Workspace guardrails come with Quorum Cloud: rules an admin sets once that every member's Quorum applies and cannot turn off. Your own rules live under Settings, Guardrails.</p>} />
            : page === 'guardrails' ? <GuardrailsPage />
            : page === 'calendar' ? <CalendarPage onConnector={goConnector} />
            : page === 'meetings' ? <MeetingsPage settings={settings} onSettings={onSettings} onConnector={goConnector} />
            : page === 'developers' ? <DevelopersPage />
            : page === 'notifications' ? <NotificationsPage />
            : page === 'connectors' ? <ConnectorsPage detail={connectorDetail} onDetail={setConnectorDetail} openLibrary={libraryOpen} />
            : <VoicePage settings={settings} onSettings={onSettings} />}
        </div>
      </main>
    </div>
  );
}

// the Local edition's Workspace › Connectors and Voice typing: organization providers need a hosted workspace, so each
// page says so and points at the personal page that works on this Mac
function OrgConnectorsLocal({ onGo }: { onGo: (p: Page) => void }) {
  return (
    <div className="set-card set-zero">
      <span className="set-zero-icon"><IconGrid width={22} height={22} /></span>
      <strong>Organization connectors are a Cloud feature</strong>
      <p>In Quorum Cloud an admin adds speech, model and voice providers once, and every seat in the workspace uses them. The Local edition keeps every key on this Mac.</p>
      <button className="pill" onClick={() => onGo('connectors')}>Open your Connectors</button>
    </div>
  );
}

function OrgVoiceLocal({ onGo }: { onGo: (p: Page) => void }) {
  return (
    <div className="set-card set-zero">
      <span className="set-zero-icon"><IconKeyboard width={22} height={22} /></span>
      <strong>Organization overrides are a Cloud feature</strong>
      <p>In Quorum Cloud an admin chooses which provider handles speech to text, the running summary and the final notes for the whole workspace. The Local edition transcribes on this Mac with your own settings.</p>
      <button className="pill" onClick={() => onGo('voice')}>Open your Voice typing settings</button>
    </div>
  );
}

// the Agent OS, where Quorum saves notes, and meeting notes from other apps; Add takes a folder by hand when there's no connector for that app
function SecondBrain({ brain, onConnect, onDisconnect, onBrain, onViewConnector }: { brain: Brain | null; onConnect: () => void; onDisconnect: () => void; onBrain?: (b: Brain) => void; onViewConnector: (id: string) => void }) {
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
  return (
    <>
      <div className="set-head">
        <h3>Context</h3>
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
          <ConnectHint connector="granola" title="Meeting notes from another app" desc="Granola today, more notetakers soon. Their notes land in this folder with the source on each note.">
            <button className="pill small-pill" onClick={() => openConnectors({ library: 'meeting-notes' })}>Browse connectors</button>
          </ConnectHint>
        )}
      </div>
      {setup && (
        <div className="palette-scrim" onClick={() => setSetup(null)}>
          <div className="modal setup-modal" role="dialog" aria-label="Set up QuorumBrain again" onClick={(e) => e.stopPropagation()}>
            <h2>{creating ? 'Create your QuorumBrain' : 'Set up QuorumBrain again'}</h2>
            <p>{creating ? 'A folder of markdown notes Quorum and your AI read and write, shaped around you. Every answer is optional.' : 'New folders and notes are added; nothing you wrote is changed. The generated section of CLAUDE.md is replaced.'}</p>
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

// a yes-or-no sheet for the steps that cannot be undone from Quorum
function ConfirmModal({ title, body, action, onDone }: { title: string; body: string; action: string; onDone: (ok: boolean) => void }) {
  return (
    <div className="palette-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onDone(false); }}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onDone(false); } }}>
      <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
        <h2 id="confirm-title">{title}</h2>
        <p>{body}</p>
        <div className="modal-actions">
          <span />
          <span className="modal-actions-end">
            <button className="pill" autoFocus onClick={() => onDone(false)}>Cancel</button>
            <button className="pill danger-pill" onClick={() => onDone(true)}>{action}</button>
          </span>
        </div>
      </div>
    </div>
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
  useEffect(() => { load(); }, []);
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
        <Row icon={<IconStack width={18} height={18} />} title={<>Export your notes<Soon /></>} desc="Will save every note and meeting as one archive. They are already plain files in your Agent OS">
          <button className="pill" disabled>Export</button>
        </Row>
      </div>

      <h3>Danger zone</h3>
      <div className="set-card danger">
        <Row icon={<IconPower width={18} height={18} />} title={<>Delete my account<Soon /></>} desc="Will remove a hosted account and everything synced to it. Files on this Mac stay">
          <button className="pill danger-pill" disabled>Delete my account</button>
        </Row>
      </div>
    </>
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
  return (
    <>
      <AccountArea local={<><h3>Account</h3><p className="muted">Local edition. Everything stays on this Mac.</p></>}
        unconfigured={<><h3>Account</h3><p className="muted">Hosted accounts are not set up in this build</p></>} />
      {billing && <p className="set-note">The plan, the card on file and this month's usage live under <button className="link-btn" onClick={() => onGo('billing')}>Billing</button>.</p>}
      <EnvSwitch />
      {company}

      <h3>Connections</h3>
      <WorkspaceDecisions connectedBy={w.decisions?.by} />

      <h3>Meetings</h3>
      <div className="set-card form words">
        <div className="set-line"><div className="set-label"><strong>Stop word</strong><span>Stops Quorum and deletes the call when sent in the chat</span></div>
          <Field value={w.stopWord ?? 'STOP'} placeholder="STOP" onSave={(v) => save({ stopWord: v })} /></div>
        <div className="set-line"><div className="set-label"><strong>Go word</strong><span>Turns Quorum back on after a stop</span></div>
          <Field value={w.goWord ?? 'GO'} placeholder="GO" onSave={(v) => save({ goWord: v })} /></div>
      </div>
      <CustomerBlacklist list={w.optOuts ?? (w.neverListen ?? []).map((domain) => ({ domain }))} onChange={(optOuts) => save({ optOuts })} />
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
    <div className="palette-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="upload-title">
        <h2 id="upload-title">Upload customers</h2>
        <p>One customer per row: the name in the first column and their email domain in the second. Either can be blank. Quorum skips the header and anything it can't read.</p>
        <label className={`dropzone ${drag ? 'on' : ''}`} onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); read(e.dataTransfer.files[0]); }}>
          <IconUpload width={22} height={22} />
          <strong>{file ? file.name : 'Drop a CSV file here'}</strong>
          <span>{file ? [`${n} to add`, file.already && `${file.already} already on the list`, file.skipped && `${file.skipped} skipped`].filter(Boolean).join(' · ') : 'or click to choose one'}</span>
          <input type="file" accept=".csv,text/csv" autoFocus onChange={(e) => read(e.target.files?.[0])} />
        </label>
        <div className="modal-actions">
          <button className="link-btn" onClick={() => window.quorum.neverListTemplate()}>Download CSV template</button>
          <span className="modal-actions-end">
            <button className="pill" onClick={onClose}>Cancel</button>
            <button className="pill primary" disabled={!n} onClick={() => { onAdd(file!.add); onClose(); }}>{n ? `Add ${n}` : 'Add'}</button>
          </span>
        </div>
      </div>
    </div>
  );
}

// the ••• on an included capability: open it, read more, or take it out of Quorum (the files stay)
function MemMenu({ it, onAbout, onDelete }: { it: MemoryItem; onAbout: () => void; onDelete: () => void }) {
  const [open, setOpen] = useMenu();
  const locked = it.kind === 'guards';
  return (
    <span className="menu-wrap" onClick={(e) => e.stopPropagation()}>
      <button className="icon-btn" aria-label={`${it.label} options`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}><IconMore /></button>
      {open && (
        <div className="menu end" role="menu">
          {locked
            ? <button role="menuitem" onClick={() => { setOpen(false); window.dispatchEvent(new CustomEvent('quorum-open-settings', { detail: 'guardrails' })); }}><IconShield width={15} height={15} /> Open Guardrails</button>
            : <button role="menuitem" onClick={() => { setOpen(false); window.quorum.memoryOpen(it.id); }}><IconExternal width={15} height={15} /> View</button>}
          <button role="menuitem" onClick={() => { setOpen(false); onAbout(); }}><IconInfo width={15} height={15} /> About</button>
          <div className="menu-sep" />
          {locked
            ? <span data-tip="Rules are managed on the Guardrails page" data-tip-pos="left"><button role="menuitem" className="danger" disabled><IconTrash width={15} height={15} /> Delete</button></span>
            : <button role="menuitem" className="danger" onClick={() => { setOpen(false); onDelete(); }}><IconTrash width={15} height={15} /> Delete</button>}
        </div>
      )}
    </span>
  );
}

const ABOUT: Record<string, string[]> = {
  guards: [
    'The rules behind what Quorum\'s agent may read from your Agent OS and say about it: built-in rules, guards found in your Agent OS that you included, your own rules, and your workspace\'s rules.',
    'Review and change them on the Guardrails page. Every rule only ever denies, so the rules add up.',
  ],
  index: [
    'The catalog at the top of your Agent OS. Quorum reads it first to jump to the right folder and note instead of searching everything.',
  ],
  search: [
    "Before Quorum answers, Quorum runs your Agent OS's own search with your question and hands Quorum the best matching notes to read first.",
    'With embeddings, the matching runs on this Mac, so your question never leaves it.',
  ],
  graph: [
    'Search also follows the links between notes one step from each match, so related notes that use different words still turn up.',
  ],
  folder: [
    'Quorum can read the notes in this folder when it answers. The guards still apply to every file.',
  ],
  instructions: [
    'The operating instructions at the root of your Agent OS (CLAUDE.md or AGENTS.md). Included, they go into every answer as instructions to follow where they apply.',
  ],
  skills: [
    'Skills your Agent OS defines under .claude/skills. Included, Claude Code loads the vault\'s project settings for the run, which brings the skills and the vault\'s own hooks, and Quorum may run a skill when a question calls for it. Quorum still only reads files.',
  ],
  agents: [
    'Agent definitions under .claude/agents. Included, Quorum may hand a sub-question to one of them during an answer, under the same read-only limits.',
  ],
  mcp: [
    'MCP servers from your Agent OS\'s .mcp.json. Included, Claude Code starts them for the run with your own credentials, and their tools are available to the answer. A server\'s tools can act on the outside world; include only servers you trust Quorum with.',
  ],
};

function AboutCapability({ it, onClose }: { it: MemoryItem; onClose: () => void }) {
  const status = it.kind === 'guards' ? it.detail : it.include ? 'Included' : 'Not included yet';
  return (
    <div className="palette-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="about-title">
        <h2 id="about-title">{it.label}</h2>
        {(ABOUT[it.kind] ?? ABOUT.folder).map((t) => <p key={t}>{t}</p>)}
        <dl className="about-facts">
          <dt>Status</dt><dd>{status}</dd>
          <dt>Location</dt><dd>{it.path.replace(/^\/Users\/[^/]+/, '~')}</dd>
        </dl>
        {it.kind !== 'guards' && <p className="about-note">Deleting it takes it out of Quorum. The files stay in your Agent OS.</p>}
        <div className="modal-actions">
          <span />
          <span className="modal-actions-end">
            <button className="pill" onClick={() => window.quorum.memoryOpen(it.id)}>View</button>
            <button className="pill primary" autoFocus onClick={onClose}>Done</button>
          </span>
        </div>
      </div>
    </div>
  );
}

// kinds the scan reports but Quorum cannot act on yet; they never enter the review list
const INERT_KINDS = new Set<string>([]);
// what each roadmap kind will do once it works, next to what was found
function soonWhy(it: MemoryItem): string {
  switch (it.kind) {
    case 'instructions': return `Found ${it.detail}. Quorum will follow it when it answers`;
    case 'skills': return `${it.detail} found. Quorum will run them on request`;
    case 'agents': return `${it.detail} found. Quorum will hand work to them`;
    case 'mcp': return `${it.detail} found in .mcp.json. Quorum will reach them when it answers`;
    default: return it.detail;
  }
}

// why each kind is worth including, folded together with what the scan found
function why(it: MemoryItem): string {
  const n = it.detail.match(/\d+/)?.[0] ?? '';
  switch (it.kind) {
    case 'guards': return `${it.detail} · review and add rules on the Guardrails page`;
    case 'index': return `Quorum starts from ${it.detail.split(' · ')[0]} to find notes faster`;
    case 'search': return it.detail === 'local embeddings' ? 'Finds related notes first, with embeddings on this Mac' : 'Finds matching notes before Quorum starts';
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
function MemoryScan() {
  const [m, setM] = useState<Memory | null>(null);
  const [scanning, setScanning] = useState(false);
  const [about, setAbout] = useState<MemoryItem | null>(null);
  useEffect(() => { window.quorum.memoryGet().then(setM); }, []);
  if (!m) return null;
  // only what changes an answer is up for review: the index, search, the link graph, folders, guards. Instructions,
  // skills, agents and MCP servers are detected but unused today, so they are mentioned in one line and never offered
  const acts = (i: MemoryItem) => !INERT_KINDS.has(i.kind);
  const included = m.items.filter((i) => acts(i) && (i.include === true || i.kind === 'guards'));
  const pending = m.items.filter((i) => acts(i) && i.include === null && i.kind !== 'guards');
  const soon = m.items.filter((i) => !acts(i));
  const refresh = async () => {
    setScanning(true);
    const r = await window.quorum.memoryRefresh();
    setScanning(false);
    if (r.cancelled) return;
    setM(r);
  };
  const row = (it: MemoryItem) => {
    const Icon = KIND_ICON[it.kind] ?? IconFolder;
    const undecided = it.include === null && it.kind !== 'guards';
    const on = it.kind === 'guards' || it.include === true;
    const icon = it.kind === 'folder' && on ? <IconFolderFill width={18} height={18} className="ok" /> : <Icon width={18} height={18} {...(it.kind === 'guards' || it.kind === 'index' ? { filled: on } : {})} className={on ? 'ok' : undefined} />;
    return (
      <Row key={it.id} icon={icon} desc={why(it)}
        title={<button className="mem-title" onClick={() => (it.kind === 'guards' ? window.dispatchEvent(new CustomEvent('quorum-open-settings', { detail: 'guardrails' })) : window.quorum.memoryOpen(it.id))}>{it.label}{it.kind === 'guards' ? <IconChevron className="right" width={14} height={14} /> : <IconExternal width={14} height={14} />}</button>}>
        <span className={`mem-actions ${undecided ? '' : 'decided'}`}>
          {undecided && <span className="new-badge">New</span>}
          <button className="icon-btn mem-yes" aria-label={`Include ${it.label}`} data-tip="Include" tabIndex={undecided ? 0 : -1} aria-hidden={!undecided} onClick={async () => setM(await window.quorum.memoryInclude(it.id))}><IconCheck width={17} height={17} /></button>
          {undecided
            ? <button className="icon-btn mem-no" aria-label={`Exclude ${it.label}`} data-tip="Exclude" onClick={async () => setM(await window.quorum.memoryExclude(it.id))}><IconClose width={15} height={15} /></button>
            : <MemMenu it={it} onAbout={() => setAbout(it)} onDelete={async () => setM(await window.quorum.memoryExclude(it.id))} />}
        </span>
      </Row>
    );
  };
  return (
    <>
      <div className="set-head">
        <h3>Power-ups</h3>
        <span className="set-head-actions">
          {scanning
            ? <button className="icon-btn scan-btn scanning" aria-label="Cancel refresh" data-tip="Cancel refresh" onClick={() => window.quorum.memoryRefreshCancel()}>
                <span className="brand-spin" aria-hidden="true" /><IconClose className="scan-x-ic" width={13} height={13} />
              </button>
            : <button className="icon-btn scan-btn" aria-label="Refresh" data-tip="Find new context" onClick={refresh}><IconReset width={16} height={16} /></button>}
          <button className="pill small-pill with-icon" onClick={async () => setM(await window.quorum.memoryAdd())}><IconPlus width={15} height={15} />Add</button>
        </span>
      </div>
      {included.length > 0 && <div className="set-card mem-card">{included.map(row)}</div>}

      {pending.length > 0 && (
        <>
          <h3>Found in your Agent OS</h3>
          <div className="set-card mem-card">{pending.map(row)}</div>
        </>
      )}
      {soon.length > 0 && (
        <>
          <h3>On the roadmap</h3>
          <div className="set-card mem-card">
            {soon.map((it) => { const Icon = KIND_ICON[it.kind] ?? IconFolder; return (
              <Row key={it.id} icon={<Icon width={18} height={18} />} title={<>{it.label}<em className="soon grey">Soon</em></>} desc={soonWhy(it)}>
                <button className="icon-btn" aria-label={`About ${it.label}`} data-tip="About" onClick={() => setAbout(it)}><IconInfo width={16} height={16} /></button>
              </Row>
            ); })}
          </div>
        </>
      )}
      {!m.items.length && <p className="set-review">Nothing yet. Refresh to scan your Agent OS, or Add a folder.</p>}
      {about && <AboutCapability it={about} onClose={() => setAbout(null)} />}
    </>
  );
}

// the workspace version of Memory: one company source, reviewed by admins, applied to everyone
function KnowledgePage() {
  return (
    <>
      <h3>Company knowledge</h3>
      <div className="set-card set-zero">
        <span className="set-zero-icon"><IconBuilding width={22} height={22} /></span>
        <strong>No company knowledge source<Soon /></strong>
        <p>Admins will connect a repo, wiki or knowledge base, and Quorum will read it for everyone in the workspace.</p>
        <button className="pill" disabled>Connect to company knowledge source</button>
      </div>

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
// notes it concerns, and writes learned facts into CLAUDE.md with the person's own model source. On by default for a
// folder Quorum built; a folder the person connected themselves turns it on here
function KeeperCard({ brain }: { brain: Brain }) {
  const [k, setK] = useState<KeeperStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => window.quorum.keeperStatus().then(setK).catch(() => setK(null));
  useEffect(() => { load(); return window.quorum.onKeeper?.(() => load()); }, [brain.root]);
  if (!k) return null;
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null);
  const run = async () => { setBusy(true); try { await window.quorum.keeperRun(); } finally { setBusy(false); load(); } };
  const last = k.last && !k.last.off ? `${k.last.filed} filed${k.last.skipped ? `, ${k.last.skipped} withheld` : ''}${k.last.error ? ` · ${k.last.error}` : ''}` : null;
  const desc = !k.on ? 'Off. Quorum writes meeting notes here and changes nothing else.'
    : k.lastRunAt ? `Last run ${when(k.lastRunAt)}${last ? `: ${last}` : ''}` : 'Index, daily note, people and project notes, after each meeting';
  return (
    <>
      <h3>Upkeep</h3>
      <div className="set-card">
        <Row icon={<IconReset width={18} height={18} className={k.on ? 'ok' : undefined} />} title="Keep this folder current" desc={desc}>
          {k.on && <button className="pill small-pill" disabled={busy || k.running} onClick={run}>{busy || k.running ? 'Running…' : 'Run now'}</button>}
          <Toggle on={k.on} onChange={async (on) => setK(await window.quorum.keeperSet({ on }))} />
        </Row>
        {k.on && (
          <Row icon={<IconBrain width={18} height={18} className={k.facts && k.model ? 'ok' : undefined} />} title="Learned facts" desc={k.model ? 'Up to three facts per meeting into CLAUDE.md, with your model source' : 'Needs a model source in AI settings; index and links work without one'}>
            <Toggle on={k.facts} onChange={async (on) => setK(await window.quorum.keeperSet({ facts: on }))} />
          </Row>
        )}
      </div>
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

// what is on screen as spelling hints, for calls and dictation: one screenshot of the front window at each start, read on
// this Mac. Needs the Screen Recording permission, asked for once when the toggle goes on
function ScreenContextRow() {
  const [s, setS] = useState<ScreenContextStatus | null>(null);
  useEffect(() => { window.quorum.screenContextStatus().then(setS).catch(() => setS(null)); }, []);
  if (!s) return null;
  const desc = !s.on ? 'Names and product words on your screen, read on this Mac, spelled right in transcripts and dictation'
    : s.granted === false ? 'On, but macOS has not allowed Screen Recording for Quorum yet'
    : 'On. The front window is read once at each start; nothing is stored or sent';
  return (
    <Row icon={<IconStack width={18} height={18} className={s.on && s.granted !== false ? 'ok' : undefined} />} title="Use what's on screen for spelling" desc={desc}>
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
          <select className="set-select" disabled={!on} value={cal.days} onChange={async (e) => setCal({ ...(await window.quorum.calendarSet({ days: Number(e.target.value) })), status: cal.status })}>
            {[1, 2, 3, 5, 7, 14].map((d) => <option key={d} value={d}>{d === 1 ? 'Next 1 day' : `Next ${d} days`}</option>)}
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
function NotificationsPage() {
  const channel = (v: string) => (
    <select className="set-select" disabled defaultValue={v}><option value="notification">Notification</option><option value="email">Email</option><option value="off">Off</option></select>
  );
  return (
    <>
      <p className="mcp-lede">Quorum sends no notifications yet. These rows show what each one will do, and the defaults it will start with.</p>
      <h3>Meeting notifications</h3>
      <div className="set-card">
        <Row icon={<IconCalendar width={18} height={18} />} title={<>Scheduled meetings<Soon /></>} desc="Will notify you 1 minute before a meeting on your calendar starts"><Toggle on onChange={noop} disabled /></Row>
        <Row icon={<Wave live={false} />} title={<>Detected meetings<Soon /></>} desc="Will notify you when Quorum sees a call start"><Toggle on onChange={noop} disabled /></Row>
        <div className="set-nested">
          <strong>Don't notify me when a call starts in these apps<Soon /></strong>
          <select className="set-select full" disabled defaultValue=""><option value="">Select apps</option></select>
        </div>
      </div>

      <h3>From Quorum</h3>
      <div className="set-card">
        <Row icon={<IconNotes width={18} height={18} />} title={<>Notes are ready<Soon /></>} desc="Will tell you right after a meeting ends">{channel('notification')}</Row>
        <Row icon={<IconChat width={18} height={18} />} title={<>Suggested answers<Soon /></>} desc="Will tell you when someone asks you a question in a call">{channel('notification')}</Row>
        <Row icon={<IconCalendar width={18} height={18} />} title={<>Follow-ups due<Soon /></>} desc="Will remind you the morning a follow-up is due">{channel('off')}</Row>
      </div>

      <h3>Sharing notifications</h3>
      <div className="set-card">
        <Row icon={<IconPeople width={18} height={18} />} title={<>Note shared with you<Soon /></>} desc="Will tell you when a teammate shares a note">{channel('email')}</Row>
        <Row icon={<IconStack width={18} height={18} />} title={<>Company knowledge changes<Soon /></>} desc="Will tell you when an admin includes or removes something">{channel('off')}</Row>
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
    <div className="palette-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onDone(false); }}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onDone(false); } }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="dk-title">
        <h2 id="dk-title">Connect {info.name}</h2>
        <p>Paste your {info.keyHint}. Quorum keeps it in your Mac's Keychain.</p>
        <label className="set-field wide"><input type="password" autoFocus aria-label={info.keyHint} placeholder={info.placeholder} value={key} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && key.trim()) save(); }} /></label>
        {error && <p className="set-error">{error}</p>}
        <div className="modal-actions">
          <span />
          <span className="modal-actions-end">
            <button className="pill" onClick={() => onDone(false)}>Cancel</button>
            <button className="pill primary" disabled={!key.trim() || busy} onClick={save}>{busy ? 'Checking…' : 'Connect'}</button>
          </span>
        </div>
      </div>
    </div>
  );
}

// Quorum reached from outside: the MCP server in Claude Code and the quorum command in Terminal. Claude Code as a model
// provider is a row in PersonalConnectors above
function ClaudeCard() {
  const [c, setC] = useState<ClaudeStatus | null>(null);
  useEffect(() => { window.quorum.claudeStatus().then(setC); }, []);
  return (
    <>
      <div className="set-head"><h3>Connect to AI tools</h3></div>
      <p className="mcp-lede">Give Claude Code and Terminal access to your notes and meetings through the quorum MCP server and command.</p>
      <div className="set-card">
        <McpRows claude={c} />
      </div>
    </>
  );
}

// Quorum outside the app: the quorum MCP server in Claude Code (claude mcp add, read back with claude mcp get) and the
// quorum command in Terminal. Both run the CLI that ships beside the app; nothing listens on a port
function McpRows({ claude }: { claude: ClaudeStatus | null }) {
  const [mcp, setMcp] = useState<Awaited<ReturnType<typeof window.quorum.mcpStatus>> | null>(null);
  const [mcpBusy, setMcpBusy] = useState(false);
  const [mcpMsg, setMcpMsg] = useState('');
  const [cli, setCli] = useState<Awaited<ReturnType<typeof window.quorum.cliStatus>> | null>(null);
  const [command, setCommand] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [more, setMore] = useMenu();
  const [access, setAccess] = useState<'read' | 'write'>('write');
  const loadMcp = () => window.quorum.mcpStatus().then((st) => { setMcp(st); setCommand(st.command ? `alias quorum='${st.command.replace(/"/g, '')}'` : ''); });
  useEffect(() => {
    window.quorum.getSettings().then((st) => setAccess(st.access ?? 'write'));
    window.quorum.cliStatus().then(setCli);
    loadMcp();
  }, []);
  const addMcp = async () => { setMcpBusy(true); setMcpMsg(''); const r = await window.quorum.mcpAdd(); if (r.error) setMcpMsg(r.error); await loadMcp(); setMcpBusy(false); };
  const removeMcp = async () => { setMcpBusy(true); setMcpMsg(''); await window.quorum.mcpRemove(); await loadMcp(); setMcpBusy(false); };
  const noClaude = !!claude && !claude.installed;
  const mcpDesc = !mcp ? 'Checking…'
    : noClaude ? 'Install Claude Code first. Quorum then adds itself as an MCP server'
    : mcp.added ? 'Added. claude mcp get quorum finds it, so Claude can read your meetings and notes'
    : !mcp.command ? 'Node.js is needed to run the Quorum MCP server'
    : 'Adds Quorum as an MCP server in Claude Code, so you can ask Claude about your meetings and notes';
  const addCli = async () => { setBusy(true); setMsg(''); const r = await window.quorum.cliAdd(); if (r.error) setMsg(r.error); setCli(await window.quorum.cliStatus()); setBusy(false); };
  const removeCli = async () => { setBusy(true); await window.quorum.cliRemove(); setCli(await window.quorum.cliStatus()); setBusy(false); };
  const connected = !!cli?.added;
  // connected shows as a green icon, broken as a red one; the line under it says what to do
  const state = !connected ? 'Adds the quorum command to Terminal on this Mac'
    : cli?.error ? `${cli.error}. Fix it from the menu.`
    : 'Open a new Terminal window and type quorum';
  return (
    <>
        <Row icon={<ProviderMark provider="anthropic" />} title="Claude Code MCP" desc={mcpDesc}>
          {mcp?.added
            ? <button className="pill" disabled={mcpBusy} onClick={removeMcp}>{mcpBusy ? 'Removing…' : 'Remove'}</button>
            : <button className="pill" disabled={mcpBusy || !mcp || noClaude || !mcp.command} onClick={addMcp}>{mcpBusy ? 'Adding…' : 'Add'}</button>}
        </Row>
        {mcpMsg && <p className="set-note mcp-msg">{mcpMsg}</p>}
        <Row icon={<IconCode width={18} height={18} className={!connected ? undefined : cli?.error ? 'err' : 'ok'} />} title="Quorum CLI" desc={state}>
          {connected
            ? <span className="menu-wrap">
                <button className="icon-btn" aria-label="Terminal options" aria-haspopup="menu" aria-expanded={more} onClick={(e) => { e.stopPropagation(); setMore((o) => !o); }}><IconMore width={16} height={16} /></button>
                {more && (
                  <div className="menu end" role="menu">
                    {cli?.error && <button role="menuitem" disabled={busy} onClick={async () => { await removeCli(); await addCli(); }}><IconReset width={15} height={15} /> Fix connection</button>}
                    <button role="menuitem" className="danger" disabled={busy} onClick={removeCli}><IconClose width={15} height={15} /> Disconnect</button>
                  </div>
                )}
              </span>
            : <button className="pill" disabled={busy || !command} onClick={addCli}>{busy ? 'Connecting…' : 'Connect'}</button>}
        </Row>
        {!connected && command && (
          <div className="row-extra">
            <p className="copy-label">Or set it up yourself: paste this line at the end of your .zshrc file</p>
            <CopyField value={command} />
          </div>
        )}
        <Row icon={<IconLock width={18} height={18} />} title="Access" desc="Your workspace admin will set this later">
          <select className="set-select" aria-label="Access" value={access} onChange={async (e) => { const v = e.target.value as 'read' | 'write'; setAccess(v); await window.quorum.setSettings({ access: v }); }}>
            <option value="write">Read and write</option>
            <option value="read">Read only</option>
          </select>
        </Row>
        {msg && <p className="set-note mcp-msg">{msg}</p>}
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

function MeetingsPage({ settings, onSettings, onConnector }: { settings: Settings; onSettings: (s: Settings) => void; onConnector: (id: string) => void }) {
  const t = settings.transcription ?? {};
  const saveTx = async (patch: Transcription) => onSettings(await window.quorum.setSettings({ transcription: patch }));
  return (
    <>
      <h3>Listening</h3>
      <div className="set-card">
        <Row icon={<Wave live={false} />} title="Listen automatically" desc="Starts transcribing when a meeting begins in Zoom, Google Meet or Teams">
          <Toggle on={settings.autoListen} onChange={async (v) => onSettings(await window.quorum.setSettings({ autoListen: v }))} />
        </Row>
      </div>
      <MeetingProviders onConnector={onConnector} />
      <div className="set-card">
        <ConnectHint connector="zoom" title="Cloud recordings" desc="Zoom's cloud recordings and transcripts import through the Zoom connector in Quorum Cloud. Google Meet and Teams recordings are next.">
          <button className="pill small-pill" onClick={() => onConnector('zoom')}>Open Zoom connector</button>
        </ConnectHint>
      </div>
      <h3>Transcribing</h3>
      <p className="mcp-lede">How Quorum turns call audio into text.</p>
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
      <p className="mcp-lede">Switches set in the admin app. This copy reads them on launch and every hour{state.fetchedAt ? `; last read ${new Date(state.fetchedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : '; not read from the relay yet'}.</p>
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
        <div className="palette-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) setDetails(null); }}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setDetails(null); } }}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="prov-title">
            <h2 id="prov-title">{details.name}</h2>
            <p>Quorum reads {where(details)} on this Mac. Nothing goes through {details.name}'s servers or a bot.</p>
            <dl className="about-facts">
              <dt>Status</dt><dd>{ready(details) ? (details.inCall ? 'Connected, in a call now' : details.running ? 'Connected, app open' : 'Connected') : desc(details)}</dd>
              <dt>App</dt><dd>{details.version ? `${details.name} ${details.version}` : details.name}</dd>
              <dt>Location</dt><dd>{details.path}</dd>
              <dt>Permission</dt><dd>Accessibility {details.access === false ? 'off' : details.access ? 'on' : 'unknown'}</dd>
              <dt>Reads</dt><dd>{details.chat ? "Meeting title, participant names, chat, and the app's audio" : 'Window title, participant count when the browser exposes it, and the audio it plays'}</dd>
              <dt>Posts</dt><dd>{details.chat ? "Quorum's notice when it starts, and replies to STOP and GO" : 'Nothing yet. The notice shows on this Mac and the saved note records that none was posted in the call'}</dd>
            </dl>
            <div className="modal-actions">
              <span />
              <span className="modal-actions-end"><button className="pill primary" autoFocus onClick={() => setDetails(null)}>Done</button></span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

const LANGUAGES = [['en-US', 'English (US)'], ['en-GB', 'English (UK)'], ['en-AU', 'English (Australia)'], ['es-ES', 'Spanish (Spain)'], ['es-MX', 'Spanish (Mexico)'], ['fr-FR', 'French'], ['de-DE', 'German'], ['it-IT', 'Italian'], ['pt-BR', 'Portuguese (Brazil)'], ['ja-JP', 'Japanese']];

// what works today applies to the dictate button in every Quorum composer; the eight Soon rows are system-wide voice typing
function VoicePage({ settings, onSettings }: { settings: Settings; onSettings: (s: Settings) => void }) {
  const v = settings.voice ?? {};
  const save = async (patch: Partial<Voice>) => onSettings(await window.quorum.setSettings({ voice: patch }));
  const words = v.dictionary ?? [];
  const [heard, setHeard] = useState('');
  const [write, setWrite] = useState('');
  const addWord = () => { if (!heard.trim() || !write.trim()) return; save({ dictionary: [...words, { heard: heard.trim(), write: write.trim() }] }); setHeard(''); setWrite(''); };
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
        <Row icon={<IconGlobe width={18} height={18} />} title="Language" desc="What you speak most, transcribed on this Mac">
          <select className="set-select" value={v.locale ?? 'en-US'} onChange={(e) => save({ locale: e.target.value })}>
            {LANGUAGES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
        </Row>
        <Row icon={<Wave live={false} />} title="Sound effects" desc="A soft tone when dictation starts and stops"><Toggle on={v.sounds ?? false} onChange={(on) => save({ sounds: on })} /></Row>
      </div>

      <h3>Dictionary</h3>
      <div className="set-card">
        <p className="set-hint">When Quorum hears a word, write it your way instead. Applies to dictation and meeting transcripts.</p>
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
