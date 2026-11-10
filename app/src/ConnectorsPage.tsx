import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { AgentSchedule, CalendarSettings, MeetingSourceInfo, PlatformInfo, SourceJob } from './quorum';
import { TRADEOFFS } from '../sources/agent-import';
import { CATEGORIES, CONNECTORS, CONNECTOR_BY_ID, aboutOf, featuresOf, type LibraryConnector } from '../connectors/library';
import { useMenu } from './controls';
import { IconCheck, IconChevron, IconClose, IconExternal, IconGrid, IconMore, IconPlus, IconReset } from './icons';

// Settings › Connectors: the tools Quorum is connected to, grouped by what they do; a detail page per connector with
// its metadata, the features it enables and its actions; and the library behind Add connector, where every tool
// Quorum supports or plans to is listed. Anything not built yet is subdued with a Coming soon badge and offers no
// action. Meeting-notes sources run through sources/index.js; the Calendar connector is the macOS permission;
// Claude Code is the quorum MCP server registration.
type Provider = Awaited<ReturnType<typeof window.quorum.meetingProviders>>[number];
type Live = { sources: MeetingSourceInfo[]; cal: CalendarSettings | null; mcp: { added: boolean; command: string } | null; providers: Provider[]; platforms: PlatformInfo[] };
type Act = (fn: () => Promise<unknown>) => Promise<void>;

const sourceFor = (x: LibraryConnector, live: Live) => (x.source ? live.sources.find((s) => s.id === x.source) ?? null : null);
// the meeting app behind a Meetings connector: listening means added, installed, and allowed to be read
const providerFor = (x: LibraryConnector, live: Live) => (x.kind === 'meeting-app' && x.app ? live.providers.find((p) => p.id === x.app) ?? null : null);
const listening = (p: Provider | null) => !!p && p.enabled && p.installed && p.access !== false;
// the platform account behind a meeting app's cloud import; absent in the local edition
const platformFor = (x: LibraryConnector, live: Live) => (x.kind === 'meeting-app' && x.app ? live.platforms.find((p) => p.id === x.app) ?? null : null);
const appWhere = (x: LibraryConnector) => (x.app === 'zoom' ? 'the Zoom app' : x.app === 'teams' ? 'the Teams app or a browser' : 'the browser');
const googleFor = (x: LibraryConnector, live: Live) => (x.id === 'google-calendar' ? live.cal?.google ?? null : null);
const isConnected = (x: LibraryConnector, live: Live) =>
  x.kind === 'mcp-source' ? !!sourceFor(x, live)?.connected : x.kind === 'meeting-app' ? listening(providerFor(x, live)) : x.id === 'apple-calendar' ? !!live.cal?.enabled && live.cal.status === 'granted' : x.id === 'google-calendar' ? !!googleFor(x, live)?.connected : x.id === 'claude-code' ? !!live.mcp?.added : false;
const connectionType = (x: LibraryConnector) =>
  x.kind === 'mcp-source' ? `${x.name} account, over its MCP server (OAuth)` : x.kind === 'macos' ? 'Permission on this Mac' : x.kind === 'meeting-app' ? `Reads ${appWhere(x)} on this Mac; no account` : x.kind === 'quorum-mcp' ? `The quorum MCP server, registered in ${x.name}` : `${x.name} account (OAuth)`;

const ago = (iso: string | null) => {
  if (!iso) return 'never';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ${h === 1 ? 'hour' : 'hours'} ago`;
  const d = Math.round(h / 24);
  return `${d} ${d === 1 ? 'day' : 'days'} ago`;
};
const elapsed = (from: number) => { const s = Math.max(0, Math.round((Date.now() - from) / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

// detail is which connector's page is open; SettingsView owns it so the page title can turn into breadcrumbs
export function ConnectorsPage({ detail, onDetail, openLibrary }: { detail: string | null; onDetail: (id: string | null) => void; openLibrary?: { cat: string | true; n: number } | null }) {
  const [live, setLive] = useState<Live>({ sources: [], cal: null, mcp: null, providers: [], platforms: [] });
  const [icons, setIcons] = useState<Record<string, string | null>>({});
  const [library, setLibrary] = useState(false);
  // the category the sheet opens on; a deep link from another surface names one
  const [libraryCat, setLibraryCat] = useState('all');
  useEffect(() => { if (!openLibrary) return; setLibraryCat(openLibrary.cat === true ? 'all' : openLibrary.cat); setLibrary(true); }, [openLibrary]);
  // the first answer from the main process takes a moment (the Claude Code check shells out); until then a skeleton, never the zero state
  const [loaded, setLoaded] = useState(false);
  const load = async () => {
    // the local edition has no platform handlers; the call fails and the list stays empty
    const [sources, cal, mcp, providers, platforms] = await Promise.all([window.quorum.sourcesList(), window.quorum.calendarStatus(), window.quorum.mcpStatus(), window.quorum.meetingProviders(), window.quorum.platformsList().catch(() => [] as PlatformInfo[])]);
    setLive({ sources, cal, mcp, providers, platforms });
    setLoaded(true);
  };
  useEffect(() => {
    load();
    window.quorum.libraryIcons().then(setIcons);
    const offSource = window.quorum.onSourceJob((job) => setLive((l) => ({ ...l, sources: l.sources.map((s) => (s.id === job.id ? { ...s, job } : s)) })));
    const offPlatform = window.quorum.onPlatformJob((job) => setLive((l) => ({ ...l, platforms: l.platforms.map((p) => (p.id === job.id ? { ...p, job } : p)) })));
    return () => { offSource(); offPlatform(); };
  }, []);
  useEffect(() => {
    // a finished job changes counts and the last-sync time, which only the full list carries
    const fresh = (j: SourceJob | null) => !!j && j.status !== 'running' && !!j.finishedAt && Date.now() - j.finishedAt < 2000;
    if (live.sources.some((s) => fresh(s.job)) || live.platforms.some((p) => fresh(p.job))) { const t = setTimeout(load, 500); return () => clearTimeout(t); }
  }, [live.sources, live.platforms]);
  const lastRefused = useRef<{ id: string; error: string } | null>(null);
  const openDetail = (id: string) => { setLibrary(false); onDetail(id); };
  if (detail && CONNECTOR_BY_ID[detail]) return <ConnectorDetail connector={CONNECTOR_BY_ID[detail]} icon={icons[detail] ?? null} live={live} onChange={load} initialError={lastRefused.current?.id === detail ? lastRefused.current.error : ''} />;
  const connected = CONNECTORS.filter((x) => isConnected(x, live));
  const groups = CATEGORIES.map((cat) => ({ cat, items: connected.filter((x) => x.category === cat.id) })).filter((g) => g.items.length);
  return (
    <>
      <div className="set-head">
        <h3>Your connectors</h3>
        <span className="set-head-actions"><button className="pill primary with-icon" onClick={() => { setLibraryCat('all'); setLibrary(true); }}><IconPlus width={15} height={15} />Add connector</button></span>
      </div>
      {!loaded ? (
        <div className="conn-group" aria-busy="true" aria-label="Loading connectors">
          <h4 className="skel skel-h" />
          <div className="set-card conn-card">{[0, 1].map((i) => <div key={i} className="conn-line skel-row"><span className="skel skel-logo" /><span className="skel skel-title" /><span className="skel skel-meta" /></div>)}</div>
        </div>
      ) : groups.length === 0 ? (
        <div className="set-card set-zero">
          <span className="set-zero-icon"><IconGrid width={22} height={22} /></span>
          <strong>No connectors yet</strong>
          <p>Connect the tools that record your meetings, your calendar, and the AI tools you work in. Notes flow into your folder, tagged with where they came from.</p>
          <button className="pill" onClick={() => { setLibraryCat('all'); setLibrary(true); }}>Browse the library</button>
        </div>
      ) : groups.map(({ cat, items }) => (
        <div key={cat.id} className="conn-group">
          <h4>{cat.name}</h4>
          <div className="set-card conn-card">
            {items.map((x) => <ConnectedRow key={x.id} connector={x} icon={icons[x.id] ?? null} live={live} onChange={load} onOpen={() => openDetail(x.id)} />)}
          </div>
        </div>
      ))}
      {library && <Library icons={icons} live={live} onChange={load} onOpen={openDetail} onClose={() => setLibrary(false)} lastRefused={lastRefused} initialCategory={libraryCat} />}
    </>
  );
}

function useAct(onChange: () => void): [boolean, string, Act] {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const act: Act = async (fn) => { setBusy(true); setError(''); const r = (await fn()) as { error?: string } | null | undefined; setBusy(false); if (r && r.error) setError(r.error); else onChange(); };
  return [busy, error, act];
}

// the one line of metadata that matters for this kind of connector, shown on the row's right side
const metaLine = (x: LibraryConnector, live: Live) => {
  const src = sourceFor(x, live);
  if (x.kind === 'mcp-source' && src) return src.job?.status === 'running' ? null : `${plural(src.notes, 'note')} · synced ${ago(src.lastSyncAt)}`;
  if (x.id === 'apple-calendar') return 'Upcoming meetings on Home';
  if (x.id === 'google-calendar') { const g = googleFor(x, live); return g?.connected ? `${g.account ?? 'Google account'} · ${plural(g.calendars, 'calendar')}` : null; }
  if (x.id === 'claude-code') return 'quorum MCP server added';
  const p = providerFor(x, live);
  if (p) { const plat = platformFor(x, live); return `${p.inCall ? 'In a call now' : 'Listening on this Mac'}${plat?.connected ? ` · ${plural(plat.notes, 'recording')} imported` : ''}`; }
  return null;
};

function Logo({ icon, size = 28 }: { icon: string | null; size?: number }) {
  return icon ? <img className="conn-logo" src={icon} alt="" style={{ width: size, height: size }} /> : <span className="conn-logo blank" style={{ width: size, height: size }}><IconGrid width={14} height={14} /></span>;
}

// what a connected connector offers: the row's far-right controls and the detail page's buttons
function Actions({ connector: x, live, busy, act, compact }: { connector: LibraryConnector; live: Live; busy: boolean; act: Act; compact?: boolean }) {
  const [open, setOpen] = useMenu();
  const src = sourceFor(x, live);
  const running = src?.job?.status === 'running';
  return (
    <span className="conn-actions" onClick={(e) => e.stopPropagation()}>
      {x.kind === 'mcp-source' && src && (compact
        ? <button className={`icon-btn${running ? ' conn-spin' : ''}`} aria-label="Sync now" data-tip={running ? 'Syncing' : 'Sync now'} data-tip-pos="left" disabled={busy || running} onClick={() => act(() => window.quorum.sourceSync(src.id))}><IconReset width={16} height={16} /></button>
        : <button className="pill" disabled={busy || running} onClick={() => act(() => window.quorum.sourceSync(src.id))}>{running ? 'Syncing…' : 'Sync now'}</button>)}
      <span className="menu-wrap">
        <button className="icon-btn" aria-label={`${x.name} options`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o: boolean) => !o)}><IconMore width={16} height={16} /></button>
        {open && (
          <div className="menu" role="menu">
            {src?.folderPath && <button role="menuitem" onClick={() => { setOpen(false); window.quorum.meetingSourceOpen(src.folderPath!); }}><IconExternal width={15} height={15} /> Show notes folder</button>}
            {x.kind === 'mcp-source' && src && <button role="menuitem" className="danger" onClick={() => { setOpen(false); act(() => window.quorum.sourceDisconnect(src.id)); }}>Disconnect</button>}
            {x.id === 'apple-calendar' && <button role="menuitem" className="danger" onClick={() => { setOpen(false); act(() => window.quorum.calendarSet({ enabled: false })); }}>Disconnect</button>}
            {x.id === 'google-calendar' && <button role="menuitem" className="danger" onClick={() => { setOpen(false); act(() => window.quorum.gcalDisconnect()); }}>Disconnect</button>}
            {x.id === 'claude-code' && <button role="menuitem" className="danger" onClick={() => { setOpen(false); act(() => window.quorum.mcpRemove()); }}>Remove from Claude Code</button>}
            {x.kind === 'meeting-app' && x.app && <>
              <button role="menuitem" onClick={() => { setOpen(false); act(async () => { await window.quorum.meetingProviderCheck(); await new Promise((r) => setTimeout(r, 1500)); }); }}><IconReset width={15} height={15} /> Check again</button>
              <button role="menuitem" onClick={() => { setOpen(false); window.quorum.axSettingsOpen(); }}>Accessibility settings</button>
              {platformFor(x, live)?.connected && <>
                <div className="menu-sep" />
                <button role="menuitem" onClick={() => { setOpen(false); act(() => window.quorum.platformSync(x.app!)); }}><IconReset width={15} height={15} /> Import recordings now</button>
                <button role="menuitem" className="danger" onClick={() => { setOpen(false); act(() => window.quorum.platformDisconnect(x.app!)); }}>Disconnect {x.name} account</button>
              </>}
              <button role="menuitem" className="danger" onClick={() => { setOpen(false); act(() => window.quorum.meetingProviderSet(x.app!, false)); }}>Stop listening</button>
            </>}
          </div>
        )}
      </span>
    </span>
  );
}

function ConnectedRow({ connector: x, icon, live, onChange, onOpen }: { connector: LibraryConnector; icon: string | null; live: Live; onChange: () => void; onOpen: () => void }) {
  const [busy, error, act] = useAct(onChange);
  const src = sourceFor(x, live);
  const running = src?.job?.status === 'running';
  const [, tick] = useState(0);
  useEffect(() => { if (!running) return; const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, [running]);
  const meta = metaLine(x, live);
  return (
    <div className="conn-row">
      <div className="conn-line" role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}>
        <Logo icon={icon} />
        <strong className="conn-title">{x.name}</strong>
        {meta && <span className="conn-meta">{meta}</span>}
        <Actions connector={x} live={live} busy={busy} act={act} compact />
        <IconChevron className="right conn-chev" width={14} height={14} />
      </div>
      {src?.job && <div className="conn-sub"><JobLine job={src.job} oneLine /></div>}
      {error && <p className="set-error conn-sub one-line" title={error}>{error}</p>}
    </div>
  );
}

// the detail page: header with the connect or sync controls, the details table, the features list
function ConnectorDetail({ connector: x, icon, live, onChange, initialError = '' }: { connector: LibraryConnector; icon: string | null; live: Live; onChange: () => Promise<void>; initialError?: string }) {
  const [busy, actError, act] = useAct(onChange);
  const error = actError || initialError;
  const [tab, setTab] = useState<'details' | 'settings'>('details');
  const src = sourceFor(x, live);
  const prov = providerFor(x, live);
  const on = isConnected(x, live);
  const soon = x.status === 'soon';
  const running = src?.job?.status === 'running';
  const [, tick] = useState(0);
  useEffect(() => { if (!running) return; const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, [running]);
  const cat = CATEGORIES.find((c) => c.id === x.category);
  const google = googleFor(x, live);
  const status = soon ? 'Soon' : on ? 'Connected' : x.id === 'apple-calendar' && live.cal?.status === 'denied' ? 'Access is off in System Settings'
    : google && !google.configured ? 'Needs the app\'s Google client (docs/self-hosting.md)'
    : prov && !prov.enabled ? 'Not listening' : prov && !prov.installed ? `${x.name} isn't installed on this Mac` : prov && prov.access === false ? 'Needs Accessibility access' : 'Not connected';
  // one message for the page: the latest action's error wins, else the last failed import
  const alert = error || (src?.job?.status === 'failed' ? src.job.error : null) || (google?.connected && google.error ? google.error : null) || null;
  const accountProblem = !!alert && /No \w+ account for|account for this sign-in|different account|Use the account your/i.test(alert);
  const rows: [string, ReactNode][] = [
    ...(on ? [] : [['Status', status] as [string, ReactNode]]),
    ['Category', cat?.name ?? x.category],
    ['Connection', connectionType(x)],
  ];
  if (x.kind === 'mcp-source' && src) {
    rows.push(
      ['Method', src.method === 'connect' ? 'Connected account' : 'Folder of notes'],
      ...(src.account ? [['Account', src.account] as [string, ReactNode]] : []),
      ['Notes in Quorum', String(src.notes)],
      ['Imported by this connection', String(src.imported)],
      ['Last sync', src.lastSyncAt ? `${ago(src.lastSyncAt)} (${new Date(src.lastSyncAt).toLocaleString()})` : 'never'],
      ['Sync', 'Every 30 minutes while Quorum runs, plus Sync now'],
      ...(src.extras?.includes('transcripts') ? [['Transcripts', src.syncTranscripts ? `${plural(src.transcripts, 'transcript')} saved in ${src.folderPath ? 'transcripts/' : 'a transcripts folder'}` : 'Off. Turn on under Settings to save each meeting\'s full transcript next to its note'] as [string, ReactNode]] : []),
      ['Notes folder', src.folderPath ? <button className="link-btn plain" onClick={() => window.quorum.meetingSourceOpen(src.folderPath!)}>{src.folderPath.replace(/^\/Users\/[^/]+/, '~')}</button> : 'Pick a meeting notes folder in Settings › Memory'],
      ['Server', src.url],
    );
  }
  if (x.id === 'apple-calendar') rows.push(['Permission', live.cal?.status ?? 'unknown'], ['Reads', 'The calendars in the Calendar app on this Mac; nothing leaves this Mac']);
  if (google?.connected) rows.push(
    ...(google.account ? [['Account', google.account] as [string, ReactNode]] : []),
    ['Calendars', plural(google.calendars, 'calendar')],
    ['Last read', google.lastSyncAt ? `${ago(google.lastSyncAt)} (${new Date(google.lastSyncAt).toLocaleString()})` : 'not yet'],
    ['Reads', 'Upcoming events from the calendars selected in Google Calendar, read only. Tokens stay in this Mac\'s Keychain'],
  );
  if (google && !google.connected) rows.push(['Scope', 'calendar.readonly: Quorum reads events and never writes to your calendar']);
  if (prov) rows.push(
    ['Listens to', `${x.name} calls in ${appWhere(x)} on this Mac`],
    ['App', prov.installed ? `Installed${prov.version ? ` · ${prov.version}` : ''}` : 'Not installed'],
    ['Accessibility', prov.access === false ? 'Not granted' : prov.access ? 'Granted' : 'Not needed'],
    ['In a call', prov.inCall ? 'Yes, now' : 'No'],
    ['Chat notice', prov.chat ? `Posts Quorum's notice in the ${x.name} chat when it starts listening` : 'None yet; you tell the call Quorum is listening'],
    ['Cloud recordings', (() => { const plat = platformFor(x, live); return !plat ? 'Part of Quorum Cloud: sign in to connect your account' : !plat.available ? 'Not available in this build' : plat.connected ? `Connected as ${plat.account ?? plat.accountName ?? 'your account'} · ${plural(plat.notes, 'recording')} imported · last checked ${ago(plat.lastSyncAt)}` : 'Not connected'; })()],
  );
  if (x.id === 'claude-code' && live.mcp) rows.push(['Registered with', <code>{live.mcp.command}</code>]);
  rows.push(['Website', <button className="link-btn plain" onClick={() => window.quorum.openExternal(`https://${x.domain}`)}>{x.domain}<IconExternal width={13} height={13} /></button>]);
  return (
    <div className="conn-detail">
      <div className="conn-detail-head">
        <Logo icon={icon} size={44} />
        <div className="conn-detail-title">
          <h3>{x.name}{soon && <em className="soon grey">Soon</em>}</h3>
          <p>{aboutOf(x)}</p>
        </div>
      </div>
      <TitleActions>
        {!soon && !on && !(accountProblem && x.kind === 'mcp-source') && <ConnectButton connector={x} live={live} busy={busy} act={act} />}
        {on && <Actions connector={x} live={live} busy={busy} act={act} compact />}
      </TitleActions>
      {alert && <div className="conn-alert" role="alert"><strong>{accountProblem ? 'Sign in with a different account' : alert.split('. ')[0].replace(/\.$/, '')}</strong><span>{alert}</span></div>}
      <h4>Connectivity</h4>
      <div className={`set-card conn-jobcard${on ? ' on' : ''}`}>
        {on && !prov && <span className="conn-ok conn-badge"><i />Connected{src && !src.syncNotes ? ' · sync off' : ''}</span>}
        {prov
          ? <Capabilities connector={x} provider={prov} platform={platformFor(x, live)} busy={busy} act={act} />
          : accountProblem && !on && x.kind === 'mcp-source'
          ? <DifferentAccount connector={x} busy={busy} act={act} />
          : src?.job && src.job.status !== 'failed'
            ? <JobLine job={src.job} />
            : <p className="src-status">{on ? (src ? `Last sync ${ago(src.lastSyncAt)}. Next automatic sync within 30 minutes while Quorum runs.` : google ? `Connected as ${google.account ?? 'your Google account'}. Home reads upcoming events every few minutes while Quorum runs.` : 'Connected on this Mac.') : soon ? 'Not available yet.' : 'Not connected yet.'}</p>}
      </div>
      {on ? (
        <div className="conn-tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'details'} className={tab === 'details' ? 'on' : ''} onClick={() => setTab('details')}>Details</button>
          <button role="tab" aria-selected={tab === 'settings'} className={tab === 'settings' ? 'on' : ''} onClick={() => setTab('settings')}>Settings</button>
        </div>
      ) : <h4>Details</h4>}
      {tab === 'settings' && on ? (
        <div className="set-card conn-table">
          {x.kind === 'mcp-source' && src && (
            <label className="conn-check">
              <input type="checkbox" checked={src.syncNotes} onChange={(e) => act(() => window.quorum.sourceSetOption(src.id, { syncNotes: e.target.checked }))} />
              <span><strong>Sync meeting notes folder into Quorum</strong><span>New {x.name} meetings are written into your meeting notes folder every 30 minutes while Quorum runs. Off keeps the connection and the folder; nothing new is imported until it is on again.</span></span>
            </label>
          )}
          {x.kind === 'mcp-source' && src?.extras?.includes('transcripts') && (
            <label className="conn-check">
              <input type="checkbox" checked={src.syncTranscripts} disabled={!src.syncNotes} onChange={(e) => act(() => window.quorum.sourceSetOption(src.id, { syncTranscripts: e.target.checked }))} />
              <span><strong>Also import transcripts</strong><span>Saves each meeting's full transcript in a transcripts folder next to the notes and links it from the note, for meetings already imported too. Transcripts are long: an agent that reads one spends far more tokens than on the note.</span></span>
            </label>
          )}
          {prov && x.app && (
            <label className="conn-check">
              <input type="checkbox" checked={prov.enabled} onChange={(e) => act(() => window.quorum.meetingProviderSet(x.app!, e.target.checked))} />
              <span><strong>Listen to {x.name} calls on this Mac</strong><span>Quorum notices when a {x.name} call starts and transcribes it. Off means Quorum ignores {x.name}; your notes stay where they are.</span></span>
            </label>
          )}
          {!(x.kind === 'mcp-source' && src) && !(prov && x.app) && <p className="src-status">No settings for this connector yet.</p>}
        </div>
      ) : (
        <div className="set-card conn-table">
          {rows.map(([k, v]) => <div key={k} className="conn-kv"><span>{k}</span><span>{v}</span></div>)}
        </div>
      )}
      {x.kind === 'mcp-source' && src?.agent && src.agent.runners.length > 0 && (!on || src.agent.schedule !== 'off') && <AgentImport source={src} busy={busy} act={act} />}
      <h4>Enables</h4>
      <div className="set-card conn-features">
        <ul>{featuresOf(x).map((f) => <li key={f}><IconCheck width={14} height={14} />{f}</li>)}</ul>
      </div>
    </div>
  );
}

// starts the connection for whatever kind this is; the Library tiles and the detail header share it
const startConnect = async (x: LibraryConnector, fresh = false): Promise<{ ok?: boolean; error?: string; wrongAccount?: boolean }> => {
  if (x.kind === 'mcp-source' && x.source) return window.quorum.sourceConnect(x.source, fresh ? { fresh: true } : undefined);
  if (x.id === 'apple-calendar') { const c = await window.quorum.calendarConnect(); return c.status === 'granted' ? { ok: true } : c.status === 'denied' ? { error: 'Calendar access is off for Quorum in System Settings.' } : { error: 'macOS did not grant calendar access.' }; }
  if (x.id === 'claude-code') { const a = await window.quorum.mcpAdd(); return a.added ? { ok: true } : { error: a.error ?? 'Claude Code did not accept the server.' }; }
  if (x.id === 'google-calendar') { const g = await window.quorum.gcalConnect(); return g.connected && !g.error ? { ok: true } : { error: g.error ?? 'Google did not finish the sign-in.' }; }
  if (x.kind === 'meeting-app' && x.app) {
    await window.quorum.meetingProviderSet(x.app, true);
    await window.quorum.meetingProviderCheck();
    await new Promise((r) => setTimeout(r, 1500));
    const p = (await window.quorum.meetingProviders()).find((q) => q.id === x.app);
    if (p && !p.installed) return { error: `${x.name} isn't installed on this Mac. Install it, then choose Check again.` };
    if (p && p.access === false) return { error: `Quorum needs Accessibility access to read ${x.name}. Allow it in System Settings, then choose Check again.` };
    return { ok: true };
  }
  return { error: 'Not available yet.' };
};
const connectLabel = (x: LibraryConnector, busy: boolean, full: boolean) =>
  busy ? (x.kind === 'mcp-source' || x.kind === 'oauth' ? 'Finish in your browser…' : x.kind === 'macos' ? 'Waiting for macOS…' : x.kind === 'meeting-app' ? 'Checking…' : 'Adding…') : x.kind === 'macos' ? 'Allow' : x.kind === 'quorum-mcp' ? 'Add' : x.kind === 'meeting-app' ? 'Start listening' : full ? `Connect ${x.name}` : 'Connect';

// the connector's controls live on the title row, next to the breadcrumbs, which SettingsView renders
function TitleActions({ children }: { children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => { setSlot(document.getElementById('conn-title-actions')); }, []);
  return slot ? createPortal(children, slot) : null;
}

function ConnectButton({ connector: x, live, busy, act }: { connector: LibraryConnector; live: Live; busy: boolean; act: Act }) {
  if (x.id === 'apple-calendar' && live.cal?.status === 'denied') return <button className="pill" onClick={() => window.quorum.calendarPrivacy()}>Open System Settings</button>;
  const prov = providerFor(x, live);
  if (prov?.enabled && prov.installed && prov.access === false) return <button className="pill" onClick={() => window.quorum.axSettingsOpen()}>Open System Settings</button>;
  if (prov?.enabled && !prov.installed) return <button className="pill" disabled={busy} onClick={() => act(async () => { await window.quorum.meetingProviderCheck(); await new Promise((r) => setTimeout(r, 1500)); })}>{busy ? 'Checking…' : 'Check again'}</button>;
  const fresh = x.kind === 'mcp-source' && !!sourceFor(x, live)?.freshNext;
  return <button className="pill primary" disabled={busy} onClick={() => act(() => startConnect(x, fresh))}>{busy ? connectLabel(x, true, true) : fresh ? 'Connect with a different account' : connectLabel(x, false, true)}</button>;
}

// the fallback for a source the person's agent already has: the agent imports through the source's MCP server on the
// person's own tokens. Labelled as the fallback, with the costs stated before the button
function AgentImport({ source: src, busy, act }: { source: MeetingSourceInfo; busy: boolean; act: Act }) {
  const agent = src.agent!;
  const [runnerId, setRunnerId] = useState(agent.runner ?? agent.runners[0]?.id ?? '');
  const runner = agent.runners.find((r) => r.id === runnerId) ?? agent.runners[0];
  const running = src.job?.status === 'running' && /through/i.test(src.job.label);
  if (!runner) return null;
  return (
    <>
      <h4>Import through your agent</h4>
      <div className="set-card conn-table agent-import">
        <p className="src-status">
          {src.connected ? `${src.name} is connected directly, which is the better path. ` : `The fallback when you would rather not connect ${src.name} to Quorum directly. `}
          {runner.name} on this Mac already has {src.name}'s MCP server (as "{runner.server}"); it can read your meetings there and write each one into Quorum through the quorum MCP server.
        </p>
        <ul className="agent-tradeoffs">{TRADEOFFS(runner.name, src.name).map((t: string) => <li key={t}>{t}</li>)}</ul>
        {runner.note && <p className="set-error">{runner.note}</p>}
        <div className="agent-row">
          {agent.runners.length > 1 && (
            <select className="set-select" value={runner.id} onChange={(e) => { setRunnerId(e.target.value); act(() => window.quorum.sourceSetOption(src.id, { agentRunner: e.target.value })); }}>
              {agent.runners.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          )}
          <button className="pill" disabled={busy || running || !runner.writable} onClick={() => act(() => window.quorum.sourceAgentImport(src.id, runner.id))}>{running ? 'Importing…' : `Import now through ${runner.name}`}</button>
          <label className="agent-schedule">Repeat
            <select className="set-select" value={agent.schedule} disabled={!runner.writable} onChange={(e) => act(() => window.quorum.sourceSetOption(src.id, { agentSchedule: e.target.value as AgentSchedule, agentRunner: runner.id }))}>
              <option value="off">Only when I ask</option><option value="hourly">Every hour while Quorum runs</option><option value="daily">Once a day while Quorum runs</option>
            </select>
          </label>
        </div>
        {(agent.lastRunAt || running) && <p className="src-status">{running && src.job ? <JobLine job={src.job} oneLine /> : `Last run ${ago(agent.lastRunAt)}${agent.lastResult ? `: ${agent.lastResult}` : ''}`}</p>}
      </div>
    </>
  );
}

// a meeting app has two capabilities: listening on this Mac, which needs no account, and importing its cloud
// recordings through the user's own account on the platform, which is part of Quorum Cloud
function Capabilities({ connector: x, provider: p, platform: plat, busy, act }: { connector: LibraryConnector; provider: Provider; platform: PlatformInfo | null; busy: boolean; act: Act }) {
  const live = listening(p);
  const why = !p.enabled ? `Off. Quorum ignores ${x.name} calls until you start listening.`
    : !p.installed ? `${x.name} isn't installed on this Mac.`
    : p.access === false ? `Quorum needs Accessibility access to read ${x.name}.`
    : p.inCall ? `In a ${x.name} call now.`
    : `Reads ${appWhere(x)} on this Mac and starts the note when a call begins.`;
  const running = plat?.job?.status === 'running';
  return (
    <div className="conn-caps">
      <div className={`conn-cap${live ? ' on' : ''}`}>
        <div className="conn-cap-head"><strong>Listen on this Mac</strong>{live ? <span className="conn-ok"><i />Connected</span> : <em className="soon grey">{!p.enabled ? 'Off' : 'Needs attention'}</em>}</div>
        <p>{why}</p>
      </div>
      <div className={`conn-cap${plat?.connected ? ' on' : ''}`}>
        <div className="conn-cap-head"><strong>Import cloud recordings</strong>{plat?.connected ? <span className="conn-ok"><i />Connected</span> : !plat ? <em className="soon grey">Quorum Cloud</em> : !plat.available ? <em className="soon grey">Soon</em> : null}</div>
        {!plat && <p>Recordings and transcripts {x.name} makes in the cloud, for calls Quorum did not hear. Sign in to Quorum Cloud to connect your {x.name} account.</p>}
        {plat && !plat.available && <p>{x.name} account connections are not available in this build yet.</p>}
        {plat && plat.available && !plat.connected && (
          <div className="conn-cap-row">
            <p>Transcripts of your {x.name} cloud recordings become meeting notes, downloaded straight to this Mac.</p>
            <button className="pill primary small-pill" disabled={busy} onClick={() => act(() => window.quorum.platformConnect(x.app!))}>{busy ? 'Finish in your browser…' : `Connect ${x.name} account`}</button>
          </div>
        )}
        {plat?.connected && (plat.job && plat.job.status !== 'failed' && running
          ? <JobLine job={plat.job} />
          : <p>{plat.account ?? plat.accountName ?? 'Connected'} · {plural(plat.notes, 'recording')} imported · last checked {ago(plat.lastSyncAt)}. New recordings arrive when {x.name} finishes them, and Quorum checks once a day regardless.</p>)}
        {plat?.job?.status === 'failed' && <p className="set-error one-line" title={plat.job.error ?? ''}>{plat.job.error}</p>}
      </div>
    </div>
  );
}

// the wrong account got connected: a sign-in in a private window, so the browser's session cannot answer for you
function DifferentAccount({ connector: x, busy, act }: { connector: LibraryConnector; busy: boolean; act: Act }) {
  const [link, setLink] = useState<{ url: string; opened: 'window' | null } | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => window.quorum.onSourceAuthLink((e) => { if (e.id === x.source) setLink({ url: e.url, opened: e.opened }); }), [x.source]);
  const start = () => { setLink(null); act(async () => { await window.quorum.sourceDisconnect(x.source!); return startConnect(x, true); }).then(() => setLink(null)); };
  return (
    <div className="conn-alt">
      <button className="pill primary" disabled={busy} onClick={start}>{busy ? 'Waiting for the sign-in…' : 'Connect with a different account'}</button>
      {link && (
        <div className="conn-alt-link">
          <p>{link.opened ? `A sign-in window opened with a clean session. Pick the account ${x.name} knows there. If it did not appear, open this link in a private browser window instead.` : `Open this link in a private browser window and sign in with the account ${x.name} knows.`}</p>
          <div className="conn-alt-row">
            <code>{link.url.slice(0, 64)}…</code>
            <button className="pill small-pill" onClick={() => { navigator.clipboard.writeText(link.url); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? 'Copied' : 'Copy link'}</button>
          </div>
        </div>
      )}
    </div>
  );
}

function JobLine({ job, oneLine }: { job: SourceJob; oneLine?: boolean }) {
  if (job.status === 'failed' && oneLine) return <p className="set-error one-line" title={job.error ?? ''}>{job.error}</p>;
  if (job.status === 'running') {
    const pct = job.total ? Math.min(100, Math.round((job.done / job.total) * 100)) : null;
    // time left from the import rate so far; the listing phase is too short and too bursty to estimate
    const left = job.phase === 'import' && job.phaseStartedAt && job.done > 0 && job.total ? Math.round(((Date.now() - job.phaseStartedAt) / job.done) * (job.total - job.done) / 1000) : null;
    const leftText = left === null ? null : left < 10 ? 'almost done' : left < 90 ? `about ${Math.max(10, Math.round(left / 10) * 10)} seconds left` : `about ${Math.round(left / 60)} min left`;
    return (
      <div className="src-progress" aria-live="polite">
        <div className="src-progress-text"><span>{job.message ?? job.label}{pct !== null ? ` · ${pct}%` : ''}{leftText ? ` · ${leftText}` : ''}</span><span>{elapsed(job.startedAt)}</span></div>
        <div className="src-bar"><div className={`src-bar-fill${pct === null ? ' indeterminate' : ''}`} style={pct === null ? undefined : { width: `${pct}%` }} /></div>
        {!oneLine && <p className="src-note">You can leave this page. It updates when the import finishes.</p>}
      </div>
    );
  }
  if (job.status === 'failed') return <p className="set-error">{job.error}</p>;
  const r = job.result;
  return (
    <p className="src-status done"><IconCheck width={14} height={14} />{r ? `${r.imported} imported, ${r.skipped} already in your notes${job.failed.length ? `, ${job.failed.length} failed` : ''}` : 'Done'}
      {job.failed.length > 0 && <details className="src-failed"><summary>What failed</summary><ul>{job.failed.map((f) => <li key={f.id}>{f.title || f.id}: {f.error}</li>)}</ul></details>}
    </p>
  );
}

// "Enables N features": click for the list of what the connector does for you
function Features({ connector: x }: { connector: LibraryConnector }) {
  const [open, setOpen] = useMenu();
  const list = featuresOf(x);
  if (!list.length) return null;
  return (
    <span className="menu-wrap lib-feat" onClick={(e) => e.stopPropagation()}>
      <button type="button" className="lib-feat-btn" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o: boolean) => !o)}>Enables {plural(list.length, 'feature')}</button>
      {open && <div className="lib-pop" role="dialog" aria-label={`What ${x.name} enables`}><ul>{list.map((f) => <li key={f}>{f}</li>)}</ul></div>}
    </span>
  );
}

// the library sheet: categories down the left, a search box, and a tile per connector; a tile opens the detail page
function Library({ icons, live, onChange, onOpen, onClose, lastRefused, initialCategory = 'all' }: { icons: Record<string, string | null>; live: Live; onChange: () => Promise<void>; onOpen: (id: string) => void; onClose: () => void; lastRefused: React.MutableRefObject<{ id: string; error: string } | null>; initialCategory?: string }) {
  const [cat, setCat] = useState<string>(initialCategory);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<Record<string, string>>({});
  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    // typing searches the whole library, whatever category was open
    if (needle) return CONNECTORS.filter((x) => x.name.toLowerCase().includes(needle) || x.description.toLowerCase().includes(needle));
    return CONNECTORS.filter((x) => cat === 'all' || x.category === cat);
  }, [cat, q]);
  const connect = async (x: LibraryConnector) => {
    setBusy(x.id); setError((e) => ({ ...e, [x.id]: '' }));
    const r = await startConnect(x);
    setBusy(null);
    if (r.error) { setError((e) => ({ ...e, [x.id]: r.error! })); if (r.wrongAccount) { lastRefused.current = { id: x.id, error: r.error! }; onOpen(x.id); } return; }
    await onChange();
  };
  const counts = useMemo(() => Object.fromEntries(CATEGORIES.map((c) => [c.id, CONNECTORS.filter((x) => x.category === c.id).length])), []);
  return (
    <div className="palette-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
      <div className="modal lib-modal" role="dialog" aria-modal="true" aria-labelledby="lib-title">
        <div className="lib-head">
          <div><h2 id="lib-title">Add a connector</h2><p>Everything Quorum connects to. Tools marked Soon are on the way. Click a tool for details.</p></div>
          <button className="icon-btn" aria-label="Close" onClick={onClose}><IconClose width={16} height={16} /></button>
        </div>
        <div className="lib-body">
          <nav className="lib-nav" aria-label="Connector categories">
            <input className="lib-search" type="search" placeholder="Search" aria-label="Search connectors" value={q} onChange={(e) => { setQ(e.target.value); setCat('all'); }} autoFocus />
            <button className={cat === 'all' ? 'on' : ''} onClick={() => { setCat('all'); setQ(''); }}>All<em>{CONNECTORS.length}</em></button>
            {CATEGORIES.map((c) => <button key={c.id} className={cat === c.id ? 'on' : ''} onClick={() => { setCat(c.id); setQ(''); }}>{c.name}<em>{counts[c.id]}</em></button>)}
          </nav>
          <div className="lib-main">
            {q.trim() ? <p className="lib-blurb">{items.length ? `${items.length} ${items.length === 1 ? 'match' : 'matches'} across the library` : ''}</p> : cat !== 'all' && <p className="lib-blurb">{CATEGORIES.find((c) => c.id === cat)?.blurb}</p>}
            <div className="lib-grid">
              {items.map((x) => {
                const on = isConnected(x, live);
                const soon = x.status === 'soon';
                return (
                  <div key={x.id} className={`lib-tile${soon ? ' is-soon' : ''}${on ? ' is-on' : ''}`} role="button" tabIndex={0} onClick={() => onOpen(x.id)} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(x.id); }}>
                    <div className="lib-tile-head"><span className="lib-tile-lead"><Logo icon={icons[x.id] ?? null} size={32} /><Features connector={x} /></span>{soon && <em className="soon grey">Soon</em>}{on && <span className="lib-on"><IconCheck width={13} height={13} />Connected</span>}</div>
                    <strong>{x.name}</strong>
                    <span>{x.description}</span>
                    <div className="lib-tile-foot">
                      {!soon && !on && <button className="pill small-pill primary" disabled={busy !== null} onClick={(e) => { e.stopPropagation(); connect(x); }}>{connectLabel(x, busy === x.id, false)}</button>}
                      <span className="lib-details">Details<IconChevron className="right" width={12} height={12} /></span>
                    </div>
                    {error[x.id] && <p className="set-error one-line" title={error[x.id]}>{error[x.id]}</p>}
                  </div>
                );
              })}
              {items.length === 0 && <p className="lib-empty">Nothing matches that search.</p>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
