import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import type { Brain, CalendarSettings, Memory, MemoryItem, OptOut, Profile, Settings, Voice, Workspace, Transcription, DecisionProvider, DecisionsStatus } from './quorum';
import { useSession } from './session';
import {
  IconBell, IconBrain, IconBuilding, IconCalendar, IconChat, IconFolder, IconGrid, IconKeyboard, IconLock,
  IconChevron, IconCode, IconExternal, IconGlobe, ProviderMark, IconMic, IconMore, IconNotes, IconPeople, IconPerson, IconPlus, IconPower, IconReset, IconSliders, IconStack, IconCheck, IconCopy, IconFolderFill, IconFork, IconShield, IconGraph, IconSearch, IconClose, Wave,
  IconInfo, IconQuorum, IconUpload, IconListCheck, IconTrash,
} from './icons';

type Page = 'preferences' | 'memory' | 'calendar' | 'meetings' | 'notifications' | 'connectors' | 'voice' | 'general' | 'knowledge' | 'members';
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
const WORKSPACE: Nav[] = [
  { id: 'general', label: 'General', icon: IconBuilding },
  { id: 'knowledge', label: 'Knowledge', icon: IconBrain },
  { id: 'members', label: 'Members', icon: IconPeople, soon: true },
];


export function SettingsView({ open, brain, settings, onSettings, onConnect, onBack }: {
  open?: { page: Page; n: number } | null; brain: Brain | null; settings: Settings; onSettings: (s: Settings) => void; onConnect: () => void; onBack: () => void;
}) {
  const [saved, setPage] = useSession<Page>('settingsPage', 'preferences');
  // Profile folded into Preferences; an older session may still remember it
  const page = (saved as string) === 'profile' ? 'preferences' : saved;
  useEffect(() => { if (open) setPage(open.page); }, [open, setPage]);
  const [user, setUser] = useState<{ name: string; email: string; photo: string | null } | null>(null);
  useEffect(() => { window.quorum.user().then(setUser); }, [settings.profile]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onBack(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onBack]);

  const set = async (patch: Partial<Settings>) => onSettings(await window.quorum.setSettings(patch));
  const all = [...ACCOUNT, ...WORKSPACE];
  const current = all.find((n) => n.id === page)!;

  const navItem = (n: Nav) => (
    <button key={n.id} className={`set-nav ${page === n.id ? 'on' : ''}`} onClick={() => setPage(n.id)}>
      <n.icon width={18} height={18} /><span>{n.label}</span>
    </button>
  );

  return (
    <div className="settings-shell">
      <aside className="set-side">
        <div className="set-user">
          <span className="set-avatar">{user?.photo ? <img src={user.photo} alt="" /> : (user?.name ?? 'H')[0]}</span>
          <strong>{user?.name ?? ' '}</strong>
          <span>{user?.email || 'Not signed in to Claude'}</span>
        </div>
        <nav className="set-navs">
          {ACCOUNT.map(navItem)}
          <h4>Workspace</h4>
          {WORKSPACE.map(navItem)}
        </nav>
        <button className="set-quit" onClick={() => window.quorum.quit()}><IconPower width={18} height={18} /> Quit Quorum</button>
      </aside>

      <main className="set-main">
        <div className="set-col">
          <h1 className="set-title">{current.label}{current.soon && <em className="soon">Coming soon</em>}</h1>
          {page === 'preferences' && <p className="set-lede">Quorum works best knowing a little about you. Quorum uses this when it writes your meeting notes and answers questions.</p>}
          {page === 'knowledge' && <p className="set-lede">Company knowledge for your whole workspace, chosen by admins.</p>}
          {page === 'general' && <p className="set-lede">Settings for everyone in your workspace. Quorum gives this context to every meeting summary and answer, so it's the same for each person.</p>}
          {page === 'preferences' ? (
            <ProfilePage settings={settings} email={user?.email ?? ''} name={user?.name ?? ''} onSettings={onSettings}>
              <h3>General</h3>
              <div className="set-card">
                <Row icon={<Wave live={false} />} title="Listen automatically" desc="Starts transcribing when a Zoom meeting begins">
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
            <WorkspacePage settings={settings} onSettings={onSettings} />
          ) : page === 'memory' ? (
            <>
              <SecondBrain brain={brain} onConnect={onConnect} />
              {brain && <MemoryScan />}
            </>
          ) : page === 'members' ? <MembersPage user={user} />
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

function Row({ icon, title, desc, children }: { icon: ReactNode; title: ReactNode; desc: ReactNode; children?: ReactNode }) {
  return (
    <div className="set-row">
      <span className="set-icon">{icon}</span>
      <div className="set-text"><strong>{title}</strong><span>{desc}</span></div>
      {children && <div className="set-ctrl">{children}</div>}
    </div>
  );
}

function Toggle({ on, onChange, disabled }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className={`switch ${disabled ? 'off' : ''}`}>
      <input type="checkbox" checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="track"><span className="thumb" /></span>
    </label>
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

function ProfilePage({ settings, email, name, onSettings, children }: { settings: Settings; email: string; name: string; onSettings: (s: Settings) => void; children?: ReactNode }) {
  const p = settings.profile ?? {};
  const save = async (patch: Partial<Profile>) => onSettings(await window.quorum.setSettings({ profile: patch }));
  return (
    <>
      <h3>Account</h3>
      <div className="set-card form">
        <div className="set-line">
          <strong>Email</strong>
          <div className="set-line-end">
            <span className="muted">{email || 'Not signed in to Claude'}</span>
            <button className="photo-btn" aria-label={p.photo ? 'Change photo' : 'Add photo'} data-tip={p.photo ? 'Change photo' : 'Add photo'} onClick={async () => onSettings(await window.quorum.pickPhoto())}>
              {p.photo ? <img src={p.photo} alt="" /> : <IconPerson width={18} height={18} />}
            </button>
            {p.photo && <button className="pill small-pill" onClick={async () => onSettings(await window.quorum.removePhoto())}>Remove</button>}
          </div>
        </div>
        <div className="set-line"><strong>Full name</strong><Field value={p.name || name} onSave={(v) => save({ name: v })} /></div>
        <div className="set-line"><strong>Job title</strong><Field value={p.title ?? ''} onSave={(v) => save({ title: v })} /></div>
        <div className="set-line"><strong>LinkedIn URL</strong><Field value={p.linkedin ? `linkedin.com/in/${p.linkedin}` : ''} placeholder="linkedin.com/in/username" onSave={(v) => save({ linkedin: v.trim().replace(/^.*linkedin\.com\/in\//, '').replace(/[/?#].*$/, '') })} /></div>
      </div>
      {children}

      <h3>Account management</h3>
      <div className="set-card form">
        <Row icon={<IconStack width={18} height={18} />} title={<>Export your notes <em className="stub">Coming soon</em></>} desc="Your notes are already plain files in your Agent OS">
          <button className="pill" disabled>Export</button>
        </Row>
      </div>

      <h3>Danger zone</h3>
      <div className="set-card danger">
        <Row icon={<IconPower width={18} height={18} />} title="Delete my account" desc="Delete your account, notes and all associated data. This can't be undone.">
          <button className="pill danger-pill" disabled data-tip="Not available while you're the only user">Delete my account</button>
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
    default: return 'Quorum can read this folder when it answers';
  }
}

const KIND_ICON: Record<string, (p: { width?: number; height?: number; filled?: boolean; className?: string }) => ReactNode> = {
  instructions: IconBrain, agents: IconPeople, skills: IconGrid, guards: IconShield, vault: IconStack, meetings: IconFolder, index: IconFork, folder: IconFolder, search: IconSearch, graph: IconGraph, decisions: IconListCheck,
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
        <h3>Memory capabilities</h3>
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
          <h3>Identified capabilities</h3>
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
        <strong>No company knowledge source</strong>
        <p>Connect a repo, wiki or knowledge base your team uses.</p>
        <span data-tip="Coming soon"><button className="pill" disabled>Connect to company knowledge source</button></span>
      </div>

      <h3>Shared with your team</h3>
      <div className="set-card">
        <Row icon={<IconStack width={18} height={18} />} title={<>Team vault<em className="soon">Coming soon</em></>} desc="Share approved notes with your team's agents" />
      </div>

      <div className="set-head">
        <h3>Additional context</h3>
        <span className="set-head-actions">
          <button className="pill small-pill with-icon" disabled><IconPlus width={15} height={15} />Add</button>
          <button className="pill small-pill with-icon" disabled><IconReset width={15} height={15} />Refresh</button>
        </span>
      </div>
      <div className="set-card set-zero">
        <span className="set-zero-icon"><IconStack width={22} height={22} /></span>
        <strong>Nothing to review yet</strong>
        <p>Admins review what Quorum finds once a source is connected.</p>
      </div>

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

function MembersPage({ user }: { user: { name: string; email: string; photo: string | null } | null }) {
  const [invitee, setInvitee] = useState('');
  const hasInvitee = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(invitee.trim());
  return (
    <>
      <h3>Invite teammates</h3>
      <div className="set-card form">
        <div className="set-line">
          <label className="set-field wide"><input type="email" placeholder="name@company.com" value={invitee} onChange={(e) => setInvitee(e.target.value)} /></label>
          <div className="set-line-end">
            <select className="set-select" disabled={!hasInvitee} defaultValue="member" aria-label="Role"><option value="member">Member</option><option value="admin">Admin</option></select>
            <span data-tip="Coming soon"><button className="pill" disabled>Invite</button></span>
          </div>
        </div>
      </div>

      <h3>1 member</h3>
      <div className="set-card">
        <div className="member-row">
          <span className="member-avatar">{user?.photo ? <img src={user.photo} alt="" /> : (user?.name ?? 'Y')[0]}</span>
          <div className="set-text"><strong>{user?.name ?? 'You'}<em className="stub">You</em></strong><span>{user?.email || 'Not signed in to Claude'}</span></div>
          <select className="set-select" disabled defaultValue="owner"><option value="owner">Owner</option></select>
          <button className="icon-btn" disabled aria-label="Member options"><IconMore width={16} height={16} /></button>
        </div>
      </div>
    </>
  );
}

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
        <Row icon={<IconGlobe width={18} height={18} />} title={<>Google Calendar<em className="soon">Coming soon</em></>} desc="Connect your Google account directly">
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
        <Row icon={<IconNotes width={18} height={18} />} title={<>Name notes after the event<em className="soon">Coming soon</em></>} desc="Uses the calendar title instead of the Zoom topic"><Toggle on onChange={noop} disabled /></Row>
        <Row icon={<IconPeople width={18} height={18} />} title={<>Add attendees to notes<em className="soon">Coming soon</em></>} desc="Lists everyone invited, even if they don't speak"><Toggle on onChange={noop} disabled /></Row>
        <Row icon={<Wave live={false} />} title={<>Only listen to my meetings<em className="soon">Coming soon</em></>} desc="Skips events you weren't invited to"><Toggle on={false} onChange={noop} disabled /></Row>
      </div>
    </>
  );
}

function NotificationsPage() {
  const channel = (v: string) => (
    <select className="set-select" disabled defaultValue={v}><option value="notification">Notification</option><option value="email">Email</option><option value="off">Off</option></select>
  );
  return (
    <>
      <h3>Meeting notifications</h3>
      <div className="set-card">
        <Row icon={<IconCalendar width={18} height={18} />} title="Scheduled meetings" desc="1 minute before a meeting on your calendar starts"><Toggle on onChange={noop} disabled /></Row>
        <Row icon={<Wave live={false} />} title="Detected meetings" desc="When Quorum sees a call start"><Toggle on onChange={noop} disabled /></Row>
        <div className="set-nested">
          <strong>Don't notify me when a call starts in these apps</strong>
          <select className="set-select full" disabled defaultValue=""><option value="">Select apps</option></select>
        </div>
      </div>

      <h3>From Quorum</h3>
      <div className="set-card">
        <Row icon={<IconNotes width={18} height={18} />} title="Notes are ready" desc="Right after a meeting ends">{channel('notification')}</Row>
        <Row icon={<IconChat width={18} height={18} />} title="Suggested answers" desc="When someone asks you a question in a call">{channel('notification')}</Row>
        <Row icon={<IconCalendar width={18} height={18} />} title="Follow-ups due" desc="The morning a follow-up is due">{channel('off')}</Row>
      </div>

      <h3>Sharing notifications</h3>
      <div className="set-card">
        <Row icon={<IconPeople width={18} height={18} />} title="Note shared with you" desc="When a teammate shares a note">{channel('email')}</Row>
        <Row icon={<IconStack width={18} height={18} />} title="Company knowledge changes" desc="When an admin includes or removes something">{channel('off')}</Row>
      </div>
    </>
  );
}

// a small ••• or + dropdown that closes on any outside click
function useMenu() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [open]);
  return [open, setOpen] as const;
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

// what Quorum runs on. Quorum finds the Claude Code already signed in on this Mac; it never holds a login of its own
function ClaudeCard() {
  const [c, setC] = useState<Awaited<ReturnType<typeof window.quorum.claudeStatus>> | null>(null);
  const [more, setMore] = useMenu();
  const [adding, setAdding] = useMenu();
  const check = () => { setC(null); window.quorum.claudeStatus().then(setC); };
  useEffect(() => { window.quorum.claudeStatus().then(setC); }, []);
  const plan = c?.plan ? c.plan[0].toUpperCase() + c.plan.slice(1) : '';
  const desc = !c ? 'Checking…'
    : !c.installed ? 'Install Claude Code to use Quorum'
    : !c.loggedIn ? 'Signed out. Sign in to use Quorum'
    : ['AI usage', c.email, c.org, plan && `${plan} plan`].filter(Boolean).join(' · ');
  return (
    <>
      <div className="set-head">
        <h3>AI</h3>
        <span className="set-head-actions menu-wrap" onClick={(e) => e.stopPropagation()}>
          <button className="pill small-pill with-icon" aria-haspopup="menu" aria-expanded={adding} onClick={() => setAdding((o) => !o)}><IconPlus width={15} height={15} />Add</button>
          {adding && (
            <div className="menu end" role="menu">
              <button role="menuitem" disabled><ProviderMark provider="openai" /> Codex <em className="soon">Coming soon</em></button>
              <button role="menuitem" disabled><ProviderMark provider="google" /> Gemini CLI <em className="soon">Coming soon</em></button>
            </div>
          )}
        </span>
      </div>
      <p className="mcp-lede">The model Quorum uses, and how Claude and Terminal reach Quorum.</p>
      <div className="set-card">
        <Row icon={<ProviderMark provider="anthropic" />} title={<>Claude Code{c?.version && <em className="muted ver">v{c.version}</em>}</>} desc={desc}>
          <span className="menu-wrap" onClick={(e) => e.stopPropagation()}>
            <button className="icon-btn" aria-label="More options" aria-haspopup="menu" aria-expanded={more} data-tip="More options" onClick={() => setMore((o) => !o)}><IconMore /></button>
            {more && (
              <div className="menu end" role="menu">
                <button role="menuitem" onClick={() => { setMore(false); check(); }}><IconReset width={15} height={15} /> Check again</button>
                <button role="menuitem" onClick={() => { setMore(false); window.quorum.claudeLogin(); }}><IconPerson width={15} height={15} /> {c?.loggedIn ? 'Switch account' : 'Sign in'}</button>
                <div className="menu-sep" />
                <span data-tip="Quorum needs one AI connection" data-tip-pos="left"><button role="menuitem" className="danger" disabled><IconClose width={15} height={15} /> Disconnect</button></span>
              </div>
            )}
          </span>
        </Row>
        <McpRows />
      </div>
    </>
  );
}

// Quorum outside the app: the quorum command in Terminal works now; Claude Code waits on the Security check of the Ultra proxy route
function McpRows() {
  const [cli, setCli] = useState<Awaited<ReturnType<typeof window.quorum.cliStatus>> | null>(null);
  const [command, setCommand] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [more, setMore] = useMenu();
  const [access, setAccess] = useState<'read' | 'write'>('write');
  useEffect(() => {
    window.quorum.getSettings().then((st) => setAccess(st.access ?? 'write'));
    window.quorum.cliStatus().then(setCli);
    window.quorum.mcpStatus().then((st) => setCommand(st.command ? `alias quorum='${st.command.replace(/"/g, '')}'` : ''));
  }, []);
  const addCli = async () => { setBusy(true); setMsg(''); const r = await window.quorum.cliAdd(); if (r.error) setMsg(r.error); setCli(await window.quorum.cliStatus()); setBusy(false); };
  const removeCli = async () => { setBusy(true); await window.quorum.cliRemove(); setCli(await window.quorum.cliStatus()); setBusy(false); };
  const connected = !!cli?.added;
  // connected shows as a green icon, broken as a red one; the line under it says what to do
  const state = !connected ? 'Adds the quorum command to Terminal on this Mac'
    : cli?.error ? `${cli.error}. Fix it from the menu.`
    : 'Open a new Terminal window and type quorum';
  return (
    <>
        <Row icon={<ProviderMark provider="anthropic" />} title={<>Claude Code MCP<em className="soon">Coming soon</em></>} desc="Ask Claude about your meetings and chats">
          <span data-tip="Waiting on a Security check" data-tip-pos="left"><button className="pill" disabled>Connect</button></span>
        </Row>
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
function MeetingsPage({ settings, onSettings }: { settings: Settings; onSettings: (s: Settings) => void }) {
  const t = settings.transcription ?? {};
  const saveTx = async (patch: Transcription) => onSettings(await window.quorum.setSettings({ transcription: patch }));
  return (
    <>
      <MeetingProviders />
      <h3>Transcribing</h3>
      <p className="mcp-lede">How Quorum turns call audio into text.</p>
      <div className="set-card even">
        <Row icon={<IconKeyboard width={18} height={18} />} title="Show words as they're heard" desc="Unconfirmed words appear dimmed"><Toggle on={t.live ?? true} onChange={(on) => saveTx({ live: on })} /></Row>
        <Row icon={<Wave live={false} />} title="Echo handling" desc="Keeps call audio from showing as you">
          <select className="set-select" value={t.echo ?? 'filter'} onChange={(e) => saveTx({ echo: e.target.value as Transcription['echo'] })}>
            <option value="filter">Filter repeats</option><option value="aec">Cancel echo</option><option value="off">Off</option>
          </select>
        </Row>
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
        <Row icon={<IconCode width={18} height={18} />} title={<>Personal API keys<em className="soon">Coming soon</em></>} desc="Programmatic access to your notes">
          <button className="icon-btn" disabled aria-label="Manage API keys"><IconChevron className="right" /></button>
        </Row>
      </div>
    </>
  );
}

// the meeting apps the workspace uses; Zoom works today by reading the app on this Mac, the rest are on the way
const PROVIDERS_NEXT = ['Google Meet', 'Microsoft Teams'];
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
  const desc = (p: Provider) => !p.enabled ? `Removed. Quorum won't notice ${p.name} calls`
    : !p.installed ? `${p.name} isn't installed on this Mac`
    : p.access === false ? `Quorum needs Accessibility access to read ${p.name}`
    : p.inCall ? 'In a call now' : `Experimental: reads ${p.name} on this Mac and posts Quorum's notice in the chat`;
  return (
    <>
      <div className="set-head">
        <h3>Providers</h3>
        <span className="set-head-actions menu-wrap" onClick={(e) => e.stopPropagation()}>
          <button className="pill small-pill with-icon" aria-haspopup="menu" aria-expanded={adding} onClick={() => setAdding((o) => !o)}><IconPlus width={15} height={15} />Add</button>
          {adding && (
            <div className="menu end" role="menu">
              {PROVIDERS_NEXT.map((n) => <button key={n} role="menuitem" disabled>{n}<em className="soon">Coming soon</em></button>)}
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
            <p>Quorum reads the {details.name} app on this Mac. Nothing goes through {details.name}'s servers or a bot.</p>
            <dl className="about-facts">
              <dt>Status</dt><dd>{ready(details) ? (details.inCall ? 'Connected, in a call now' : 'Connected') : desc(details)}</dd>
              <dt>App</dt><dd>{details.version ? `${details.name} ${details.version}` : details.name}</dd>
              <dt>Location</dt><dd>{details.path}</dd>
              <dt>Permission</dt><dd>Accessibility {details.access === false ? 'off' : details.access ? 'on' : 'unknown'}</dd>
              <dt>Reads</dt><dd>Meeting title, participant names, chat, and the app's audio</dd>
              <dt>Posts</dt><dd>Quorum's notice when it starts, and replies to STOP and GO</dd>
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
const Soon = () => <em className="soon">Coming soon</em>;

// what works today applies to the dictate button in every Quorum composer; the rest waits for system-wide voice typing
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
        <Row icon={<IconKeyboard width={18} height={18} />} title={<>Voice typing in any app<Soon /></>} desc="Talk instead of type, outside Quorum too"><Toggle on={false} onChange={noop} disabled /></Row>
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
        <Row icon={<IconKeyboard width={18} height={18} />} title={<>Hold to talk<Soon /></>} desc="Hold to start, release to finish"><span className="keycap off">fn</span></Row>
        <Row icon={<IconKeyboard width={18} height={18} />} title={<>Hands-free<Soon /></>} desc="Press to start, press again to finish"><span className="keycap off">fn</span><span className="muted small">then</span><span className="keycap off">fn</span></Row>
      </div>

      <h3>More</h3>
      <div className="set-card">
        <Row icon={<IconMic width={18} height={18} />} title={<>Microphone<Soon /></>} desc="Uses your Mac's default input for now">
          <select className="set-select" disabled defaultValue="default"><option value="default">System default</option></select>
        </Row>
        <Row icon={<IconSliders width={18} height={18} />} title={<>Styles<Soon /></>} desc="A writing style for each kind of app"><Toggle on={false} onChange={noop} disabled /></Row>
        <Row icon={<IconStack width={18} height={18} />} title={<>Screen context<Soon /></>} desc="Uses text on screen to spell names right"><Toggle on={false} onChange={noop} disabled /></Row>
        <Row icon={<IconNotes width={18} height={18} />} title={<>Auto-add words<Soon /></>} desc="Adds words you correct to your dictionary"><Toggle on={false} onChange={noop} disabled /></Row>
        <Row icon={<Wave live={false} />} title={<>Mute other audio<Soon /></>} desc="Quiets your Mac while you talk"><Toggle on={false} onChange={noop} disabled /></Row>
      </div>

      <h3>Data and privacy</h3>
      <div className="set-card">
        <Row icon={<IconLock width={18} height={18} />} title="On this Mac only" desc="Audio is transcribed on-device and never saved" />
      </div>
    </>
  );
}
