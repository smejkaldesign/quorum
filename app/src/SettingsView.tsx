import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import type { Brain, CalendarSettings, ClaudeStatus, Memory, MemoryItem, OptOut, Profile, Settings, Voice, Workspace, Transcription, DecisionProvider, DecisionsStatus, AccountState } from './quorum';
import { PersonalConnectors } from './Connectors';
import { BY_ID } from '../connectors/catalog';
import { useSession } from './session';
import { Row, Toggle, useMenu } from './controls';
import { AccountArea, BillingArea, EDITION, KnowledgeQueueArea, MembersArea, PlatformArea, WorkspaceConnectorsArea, WorkspaceVoiceArea, useHostedAccounts } from './edition';
import { canAdmin, modeOf, resolvePage, workspacePages, type Page } from './settingsNav';
import { EnvSwitch } from './EnvSwitch';
import {
  IconBell, IconBrain, IconBuilding, IconCalendar, IconChat, IconFolder, IconGrid, IconKeyboard, IconLock,
  IconChevron, IconCode, IconExternal, IconGlobe, ProviderMark, IconMic, IconMore, IconNotes, IconPeople, IconPerson, IconPlus, IconPower, IconReset, IconSliders, IconStack, IconCheck, IconCopy, IconFolderFill, IconFork, IconShield, IconGraph, IconSearch, IconClose, Wave,
  IconInfo, IconQuorum, IconUpload, IconListCheck, IconTrash,
} from './icons';

type Nav = { id: Page; label: string; icon: (p: { width?: number; height?: number }) => ReactNode; soon?: boolean };

const ACCOUNT: Nav[] = [
  { id: 'preferences', label: 'Preferences', icon: IconSliders },
  { id: 'memory', label: 'Memory', icon: IconBrain },
  { id: 'calendar', label: 'Calendar', icon: IconCalendar },
  { id: 'meetings', label: 'Meetings', icon: IconMic },
  { id: 'notifications', label: 'Notifications', icon: IconBell, soon: true },
  { id: 'connectors', label: 'Connectors', icon: IconGrid },
  { id: 'voice', label: 'Voice typing', icon: IconKeyboard },
];
// the pages behind the Admin button; settingsNav.workspacePages decides which of them a build lists
const WORKSPACE: Nav[] = [
  { id: 'general', label: 'General', icon: IconBuilding },
  { id: 'knowledge', label: 'Knowledge', icon: IconBrain },
  { id: 'members', label: 'Members', icon: IconPeople },
  { id: 'org-connectors', label: 'Connectors', icon: IconGrid },
  { id: 'org-voice', label: 'Voice typing', icon: IconKeyboard },
  { id: 'platform', label: 'Platform', icon: IconShield },
];

// the chip on every row whose control is disabled on purpose: the feature is planned and the row shows what it will do
const Soon = () => <em className="soon">Soon</em>;

export function SettingsView({ open, brain, settings, onSettings, onConnect, onBack }: {
  open?: { page: Page; n: number } | null; brain: Brain | null; settings: Settings; onSettings: (s: Settings) => void; onConnect: () => void; onBack: () => void;
}) {
  const [saved, setPage] = useSession<Page>('settingsPage', 'preferences');
  useEffect(() => { if (open) setPage(open.page); }, [open, setPage]);
  const [user, setUser] = useState<{ name: string; email: string; photo: string | null } | null>(null);
  useEffect(() => { window.quorum.user().then(setUser); }, [settings.profile]);
  // the Quorum account comes first; without one, the Claude sign-in on this Mac is the only identity there is
  const [account, setAccount] = useState<AccountState | null>(null);
  useEffect(() => { let live = true; window.quorum.accountStatus().then((a) => { if (live) setAccount(a); }).catch(() => {}); return () => { live = false; }; }, [settings.profile]);
  useEffect(() => { if (!window.quorum.onAccount) return; return window.quorum.onAccount(setAccount); }, []);
  const owner = account?.platformOwner === true;
  const admin = canAdmin(EDITION, account?.workspace?.role, owner);
  const page = resolvePage(saved, admin, owner);
  const mode = modeOf(page);
  const quorumEmail = account?.signedIn ? account.email : null;
  const email = quorumEmail || user?.email || '';
  const emailLabel = quorumEmail ? 'Email' : 'Claude sign-in';
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onBack(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onBack]);

  const set = async (patch: Partial<Settings>) => onSettings(await window.quorum.setSettings(patch));
  // a cloud build without hosted account config has no members to list, so the page leaves the nav
  const hosted = useHostedAccounts();
  const listed = workspacePages(EDITION, hosted, owner);
  const workspaceNav = WORKSPACE.filter((n) => (listed as string[]).includes(n.id));
  const all = [...ACCOUNT, ...WORKSPACE];
  const current = all.find((n) => n.id === page)!;

  const navItem = (n: Nav) => (
    <button key={n.id} className={`set-nav ${page === n.id ? 'on' : ''}`} onClick={() => setPage(n.id)}>
      <n.icon width={18} height={18} /><span>{n.label}</span>
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
          <h1 className="set-title">{current.label}{current.soon && <Soon />}</h1>
          {page === 'preferences' && <p className="set-lede">Quorum works best knowing a little about you. Quorum uses this when it writes your meeting notes and answers questions.</p>}
          {page === 'knowledge' && <p className="set-lede">Company knowledge for your whole workspace, chosen by admins.</p>}
          {page === 'general' && <p className="set-lede">Settings for everyone in your workspace. Quorum gives this context to every meeting summary and answer, so it's the same for each person.</p>}
          {page === 'platform' && <p className="set-lede">Every workspace on this Quorum. Plans are set by hand here until the admin web app exists.</p>}
          {page === 'preferences' ? (
            <ProfilePage settings={settings} email={email} emailLabel={emailLabel} name={user?.name ?? ''} onSettings={onSettings}>
              <h3>General</h3>
              <div className="set-card">
                <Row icon={<Wave live={false} />} title="Listen automatically" desc="Starts transcribing when a meeting begins in Zoom, Google Meet or Teams">
                  <Toggle on={settings.autoListen} onChange={(v) => set({ autoListen: v })} />
                </Row>
                <Row icon={<IconChat width={18} height={18} />} title="Suggest answers from my notes" desc="Offers your notes when someone asks you a question">
                  <Toggle on={settings.suggestions !== false} onChange={(v) => set({ suggestions: v })} />
                </Row>
                <Row icon={<IconLock width={18} height={18} />} title="Data" desc="Transcribed on this Mac, answered by Claude Enterprise" />
              </div>
            </ProfilePage>
          ) : page === 'knowledge' ? (
            <KnowledgePage />
          ) : page === 'general' ? (
            <><WorkspacePage settings={settings} onSettings={onSettings} /><BillingArea /></>
          ) : page === 'memory' ? (
            <>
              <SecondBrain brain={brain} onConnect={onConnect} />
              {brain && <MemoryScan />}
            </>
          ) : page === 'members' ? <MembersArea />
            : page === 'org-connectors' ? <WorkspaceConnectorsArea local={<OrgConnectorsLocal onGo={go} />} />
            : page === 'org-voice' ? <WorkspaceVoiceArea local={<OrgVoiceLocal onGo={go} />} />
            : page === 'platform' ? <PlatformArea />
            : page === 'calendar' ? <CalendarPage />
            : page === 'meetings' ? <MeetingsPage settings={settings} onSettings={onSettings} />
            : page === 'notifications' ? <NotificationsPage />
            : page === 'connectors' ? <ConnectorsPage />
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
function SecondBrain({ brain, onConnect }: { brain: Brain | null; onConnect: () => void }) {
  type Source = Awaited<ReturnType<typeof window.quorum.meetingSources>>[number];
  const [sources, setSources] = useState<Source[]>([]);
  const [icons, setIcons] = useState<Record<string, string | null>>({});
  const load = () => window.quorum.meetingSources().then(setSources);
  useEffect(() => { if (brain) load(); window.quorum.sourceIcons().then(setIcons); }, [brain]);
  return (
    <>
      <div className="set-head">
        <h3>Context</h3>
        {brain && <span className="set-head-actions"><button className="pill small-pill with-icon" onClick={async () => { if (await window.quorum.meetingSourceAdd()) load(); }}><IconPlus width={15} height={15} />Add</button></span>}
      </div>
      <div className="set-card">
        <Row icon={brain ? <IconFolderFill width={18} height={18} className="ok" /> : <IconFolder width={18} height={18} className="err" />}
          title={brain ? <button className="mem-title" onClick={() => window.quorum.openBrain('finder')}>{brain.name}<IconExternal width={14} height={14} /></button> : 'Not connected'}
          desc={brain ? `${brain.root.replace(/^\/Users\/[^/]+/, '~')}` : 'Pick the root folder of your notes'}>
          <button className="pill" onClick={onConnect}>{brain ? 'Change' : 'Connect'}</button>
        </Row>
        {brain && <MeetingsRow />}
        {brain && sources.map((src) => (
          <Row key={src.id} icon={icons[src.key] ? <img className="set-app-icon" src={icons[src.key]!} alt="" /> : <IconFolder width={18} height={18} />}
            title={<button className="mem-title" onClick={() => window.quorum.meetingSourceOpen(src.id)}>{src.name} meeting notes<IconExternal width={14} height={14} /></button>}
            desc={`${src.rel} · ${src.notes} ${src.notes === 1 ? 'note' : 'notes'}`}>
            <button className="icon-btn mem-no" aria-label={`Remove ${src.name} meeting notes from Quorum`} data-tip="Remove from Quorum. Notes stay in the folder." data-tip-pos="left"
              onClick={async () => { if (await window.quorum.meetingSourceRemove(src.id)) load(); }}><IconClose width={15} height={15} /></button>
          </Row>
        ))}
      </div>
    </>
  );
}

// where meeting notes live; past meetings you bring in land here too, so it's the same folder Quorum lists in History
function MeetingsRow() {
  const [dir, setDir] = useState<Awaited<ReturnType<typeof window.quorum.meetingsDir>> | undefined>();
  const load = () => window.quorum.meetingsDir().then(setDir);
  useEffect(() => { load(); }, []);
  const pick = async () => { if (await window.quorum.pickMeetingsDir()) load(); };
  if (dir === undefined) return null;
  if (!dir) return (
    <Row icon={<IconQuorum width={18} height={18} />} title="Quorum meeting notes" desc="Choose a folder for notes. Past meetings you import go here too.">
      <button className="pill" onClick={pick}>Choose folder</button>
    </Row>
  );
  return (
    <Row icon={<IconQuorum width={18} height={18} className="ok" />}
      title={<button className="mem-title" onClick={() => window.quorum.openBrain('meetings')}>Quorum meeting notes<IconExternal width={14} height={14} /></button>}
      desc={`${dir.rel} · ${dir.notes} ${dir.notes === 1 ? 'note' : 'notes'}`}>
      <button className="pill" onClick={pick}>Change</button>
    </Row>
  );
}

// saves a field when you leave it, so typing never fights a round trip
function Field({ value, placeholder, onSave }: { value: string; placeholder?: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <label className="set-field">
      <input value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)} onBlur={() => { if (v !== value) onSave(v.trim()); }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
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
            <span className="muted">{email || 'Not signed in to Claude'}</span>
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

function WorkspacePage({ settings, onSettings }: { settings: Settings; onSettings: (s: Settings) => void }) {
  const w = settings.workspace ?? {};
  const save = async (patch: Partial<Workspace>) => onSettings(await window.quorum.setSettings({ workspace: patch }));
  const [about, setAbout] = useState(w.companyDescription ?? '');
  useEffect(() => setAbout(w.companyDescription ?? ''), [w.companyDescription]);
  return (
    <>
      <AccountArea local={<><h3>Account</h3><p className="muted">Local edition. Everything stays on this Mac.</p></>}
        unconfigured={<><h3>Account</h3><p className="muted">Hosted accounts are not set up in this build</p></>} />
      <EnvSwitch />
      <h3>Company</h3>
      <div className="set-card form">
        <div className="set-line"><strong>Company name</strong><Field value={w.company ?? ''} placeholder="Company" onSave={(v) => save({ company: v })} /></div>
        <div className="set-line stacked">
          <div className="set-label"><strong>Company description</strong><span>Quorum takes this into account when it summarizes meetings and answers questions</span></div>
          <textarea className="set-area" value={about} maxLength={1000} placeholder="What the company does, who it serves, words people use internally" onChange={(e) => setAbout(e.target.value)} onBlur={() => { if (about !== (w.companyDescription ?? '')) save({ companyDescription: about.trim() }); }} />
        </div>
      </div>

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
          <button role="menuitem" onClick={() => { setOpen(false); window.quorum.memoryOpen(it.id); }}><IconExternal width={15} height={15} /> View</button>
          <button role="menuitem" onClick={() => { setOpen(false); onAbout(); }}><IconInfo width={15} height={15} /> About</button>
          <div className="menu-sep" />
          {locked
            ? <span data-tip="Disabled until org controls" data-tip-pos="left"><button role="menuitem" className="danger" disabled><IconTrash width={15} height={15} /> Delete</button></span>
            : <button role="menuitem" className="danger" onClick={() => { setOpen(false); onDelete(); }}><IconTrash width={15} height={15} /> Delete</button>}
        </div>
      )}
    </span>
  );
}

const ABOUT: Record<string, string[]> = {
  guards: [
    'Hooks from your Agent OS that run on every file Quorum reads. They hide secrets, and anything naming a customer who opted out of AI, before Quorum sees it.',
    "They're always on and can't be deleted here. Your workspace admin will control them.",
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
    'The operating instructions at the root of your Agent OS (CLAUDE.md or AGENTS.md). Quorum found them; a later version will let Quorum follow them when it answers.',
  ],
  skills: [
    'Skills your Agent OS defines. Quorum lists them so you can see what is available; running them from Quorum comes later.',
  ],
  agents: [
    'Agent definitions in your Agent OS. Listed for now; delegating to them from Quorum comes later.',
  ],
  mcp: [
    'MCP servers your Agent OS connects to. Listed for now; Quorum does not start them.',
  ],
};

function AboutCapability({ it, onClose }: { it: MemoryItem; onClose: () => void }) {
  const status = it.kind === 'guards' ? 'Always on' : it.include ? 'Included' : 'Not included yet';
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

// why each kind is worth including, folded together with what the scan found
function why(it: MemoryItem): string {
  const n = it.detail.match(/\d+/)?.[0] ?? '';
  switch (it.kind) {
    case 'guards': return `Always on · ${n} guards keep opted-out data and secrets out`;
    case 'index': return `Quorum starts from ${it.detail.split(' · ')[0]} to find notes faster`;
    case 'search': return it.detail === 'local embeddings' ? 'Finds related notes first, with embeddings on this Mac' : 'Finds matching notes before Quorum starts';
    case 'graph': return 'Search also pulls in notes linked to each match';
    case 'instructions': return `Found ${it.detail}; following it from Quorum comes later`;
    case 'skills': return `${it.detail} found; running them from Quorum comes later`;
    case 'agents': return `${it.detail} found; delegating to them comes later`;
    case 'mcp': return `${it.detail} found in .mcp.json; Quorum does not start them`;
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
  const included = m.items.filter((i) => i.include === true || i.kind === 'guards');
  const pending = m.items.filter((i) => i.include === null && i.kind !== 'guards');
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
        title={<button className="mem-title" onClick={() => window.quorum.memoryOpen(it.id)}>{it.label}<IconExternal width={14} height={14} /></button>}>
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
            <Row icon={<IconStack width={18} height={18} />} title={<>Team vault<Soon /></>} desc="A Quorum Cloud workspace shares the notes you mark public with your team, after an admin includes them" />
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

// the pages below are real layouts with every control disabled until the feature behind them exists
const noop = () => {};

// the source is the Calendar app on this Mac for now; Google Calendar comes later as a second source
function CalendarPage() {
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
        <Row icon={<IconGlobe width={18} height={18} />} title={<>Google Calendar<Soon /></>} desc="Will connect a Google account directly so its meetings show on Home">
          <button className="pill" disabled>Connect</button>
        </Row>
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
      <div className="set-head"><h3>Claude Code and Terminal</h3></div>
      <p className="mcp-lede">How Claude and Terminal reach Quorum.</p>
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
  auto: 'Cancels echo on the built-in speakers, does nothing with headphones',
  filter: 'Drops your lines that repeat what the call just said',
  aec: 'Always cancels echo in the microphone',
  off: 'Call audio can show as you on speakers',
};

function MeetingsPage({ settings, onSettings }: { settings: Settings; onSettings: (s: Settings) => void }) {
  const t = settings.transcription ?? {};
  const saveTx = async (patch: Transcription) => onSettings(await window.quorum.setSettings({ transcription: patch }));
  return (
    <>
      <MeetingProviders />
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

function ConnectorsPage() {
  return (
    <>
      <PersonalConnectors />
      <ClaudeCard />
      <h3>Integrations</h3>
      <p className="mcp-lede">Tools Quorum reads from and sends notes to.</p>
      <div className="set-card set-zero">
        <span className="set-zero-icon"><IconGrid width={22} height={22} /></span>
        <strong>No integrations yet</strong>
        <p>Tools Quorum can read from and send notes to will show here.</p>
      </div>

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

// the meeting apps the workspace uses, read on this Mac. Zoom gets the notice in its chat; Meet and Teams are detected and captured
function MeetingProviders() {
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
      <p className="mcp-lede">The meeting apps Quorum listens to, read on this Mac.</p>
      <div className="set-card">
        {list?.map((p) => (
          <Row key={p.id}
            icon={icons[p.id] ? <img className="set-app-icon" src={icons[p.id]!} alt="" /> : <IconChat width={18} height={18} />}
            title={<>{p.name}{ready(p) && <span className="conn-ok"><i />Connected</span>}</>} desc={desc(p)}>
            {!p.enabled && <button className="pill" onClick={() => toggle(p, true)}>Connect</button>}
            {p.enabled && p.installed && p.access === false && <button className="pill" onClick={() => window.quorum.axSettingsOpen()}>Open System Settings</button>}
            {p.enabled && (
              <span className="menu-wrap" onClick={(e) => e.stopPropagation()}>
                <button className="icon-btn" aria-label={`${p.name} options`} aria-haspopup="menu" aria-expanded={menu === p.id} data-tip="More options" onClick={() => setMenu((m) => (m === p.id ? null : p.id))}><IconMore /></button>
                {menu === p.id && (
                  <div className="menu end" role="menu">
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
        <Row icon={<IconStack width={18} height={18} />} title={<>Screen context<Soon /></>} desc="Will read text on screen to spell names right"><Toggle on={false} onChange={noop} disabled /></Row>
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
