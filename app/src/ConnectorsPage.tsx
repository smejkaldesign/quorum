import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { AgentSchedule, Brain, CalendarSettings, GithubInstallations, McpInheritedServer, McpOverlap, McpOverlapServer, MeetingSourceInfo, OAuthAccount, OAuthCheck, PlatformInfo, SourceJob } from './quorum';
import { CHECKABLE, installSummary } from '../connectors/oauthApps';
import { CONNECTOR_RETURN } from './connectorsNav';
import { libraryAreas } from './libraryFilter';
import { useSession } from './session';
import { TRADEOFFS } from '../sources/agent-import';
import { AREAS, CONNECTORS_CHANGED, CONNECTOR_BY_ID, aboutFor, areaOf, areaOfCategory, connectorsFor, featuresFor, isConnected, mcpPathsOf, type LibraryConnector } from '../connectors/library';
import { BLOCKED_SENTENCE, ORG_LABEL, ORG_SENTENCE, UNAPPROVED_LABEL, approvalOf, canConnect, hasLocalPart, hiddenFromList, isGoverned, type Approval } from '../connectors/approval';
import { SyncedFolderConnections, useConnectorPolicy } from './edition';
import { useFlag } from './flags';
import { useMcpOverlap } from './McpPaths';
import { ModalActions, useMenu } from './controls';
import { IconCheck, IconChevron, IconExternal, IconGrid, IconMore, IconPlus, IconReset } from './icons';
import { BRAND_LOGOS, brandSrc } from './brandLogos';

// Settings › Connectors: the Agent OS folder, then the connectors this person connected, under their areas (meeting
// notes, calendar, files, work, AI), and the MCP servers their agent already has (Inherited MCPs). Add connector opens
// the library, every connector by area, with the ones not available to this person hidden by default. Each connector
// has a detail page. Meeting-notes sources run through sources/index.js; Apple Calendar is the macOS
// permission; Claude Code is the quorum MCP server registration; the Accounts group is the personal OAuth connectors
// (sources/accounts.js), one sign-in each through Quorum's registered apps. The meeting apps that listen on this Mac appear only
// with the meeting-capture flag on; with it off, Zoom stays as its cloud recordings import.
type Provider = Awaited<ReturnType<typeof window.quorum.meetingProviders>>[number];
type Live = { sources: MeetingSourceInfo[]; cal: CalendarSettings | null; mcp: { added: boolean; command: string } | null; providers: Provider[]; platforms: PlatformInfo[]; accounts: OAuthAccount[] };
type Act = (fn: () => Promise<unknown>) => Promise<void>;

const sourceFor = (x: LibraryConnector, live: Live) => (x.source ? live.sources.find((s) => s.id === x.source) ?? null : null);
// the meeting app behind a Meetings connector: listening means added, installed, and allowed to be read
const providerFor = (x: LibraryConnector, live: Live) => (x.kind === 'meeting-app' && x.app ? live.providers.find((p) => p.id === x.app) ?? null : null);
const listening = (p: Provider | null) => !!p && p.enabled && p.installed && p.access !== false;
// the platform account behind a meeting app's cloud import; absent in the local edition
const platformFor = (x: LibraryConnector, live: Live) => (x.kind === 'meeting-app' && x.app ? live.platforms.find((p) => p.id === x.app) ?? null : null);
// with meeting capture off (the meeting-capture flag) a meeting app offers only its cloud import (connectorsFor)
const cloudOnly = (x: LibraryConnector) => x.kind === 'meeting-app' && x.listen === false;
const capture = (x: LibraryConnector) => ({ meetingCapture: x.listen !== false });
// the library this copy shows, rebuilt when the flag changes
function useLibrary() {
  const meetingCapture = useFlag('meeting-capture');
  return useMemo(() => { const list = connectorsFor({ meetingCapture }); return { list, byId: Object.fromEntries(list.map((x) => [x.id, x])) as Record<string, LibraryConnector> }; }, [meetingCapture]);
}
const appWhere = (x: LibraryConnector) => (x.app === 'zoom' ? 'the Zoom app' : x.app === 'teams' ? 'the Teams app or a browser' : 'the browser');
// the personal OAuth account behind an Accounts row; configured is false when this build has no client id for it
const accountFor = (x: LibraryConnector, live: Live) => (x.account ? live.accounts.find((a) => a.id === x.id) ?? null : null);
// connected to the outside account the workspace governs: for a meeting app, its cloud import account only, since
// listening on this Mac is not an account
const accountConnected = (x: LibraryConnector, live: Live) => (x.kind === 'meeting-app' ? !!platformFor(x, live)?.connected : isConnected(x, live));
const unavailable = (x: LibraryConnector, live: Live) => !!x.account && accountFor(x, live)?.configured !== true;
const googleFor = (x: LibraryConnector, live: Live) => (x.id === 'google-calendar' ? live.cal?.google ?? null : null);
const connectionType = (x: LibraryConnector) =>
  x.kind === 'mcp-source' ? `${x.name} account, over its MCP server (OAuth)` : x.kind === 'macos' ? 'Permission on this Mac' : cloudOnly(x) ? `${x.name} account, through Quorum Cloud` : x.kind === 'meeting-app' ? `Reads ${appWhere(x)} on this Mac; no account` : x.kind === 'quorum-mcp' ? `The quorum MCP server, registered in ${x.name}` : x.account ? `${x.name} account (OAuth through Quorum's registered app)` : `${x.name} account (OAuth)`;

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

const PRICING = 'https://quorum.watch/#pricing';

// detail is which connector's page is open; SettingsView owns it so the page title can turn into breadcrumbs
// Quorum's app connector next to the provider's MCP: the explanation and the recommendation as the section's text, then
// the table alone. On a connector's page with no MCP in the agent, one line says so
function McpCompareSection({ connector: x, overlap, appOn }: { connector: LibraryConnector; overlap: McpOverlap; appOn: boolean }) {
  const p = mcpPathsOf(x);
  if (!p) return null;
  const has = !!overlap.matches[x.id]?.length;
  const off = !!overlap.off[x.id]?.length;
  return (
    <>
      <h4>App connector and MCP</h4>
      <p className="conn-lede conn-section-lede">{p.explain} {p.recommend}</p>
      <div className="set-card conn-table mcp-paths-card">
        {has || off ? (
          <table className="mcp-paths-table">
            <thead><tr><th /><th scope="col"><span className="mcp-col">App connector{appOn && <Dot on />}</span></th><th scope="col"><span className="mcp-col">{x.name} MCP{has && <Dot on tip="On in your agent" />}</span></th></tr></thead>
            <tbody>{p.rows.map((r) => <tr key={r.id}><th scope="row">{r.label}</th><td>{r.connector}</td><td>{r.mcp}</td></tr>)}</tbody>
          </table>
        ) : <p className="src-status">Your agent has no {x.name} MCP set up.{p.alone ? ` ${p.alone}` : ''}</p>}
      </div>
    </>
  );
}

// the breadcrumb name of a Connectors detail page: a connector, or a provider's MCP server (mcp:<connector id>)
export const MCP_PAGE = 'mcp:';
export function connectorDetailName(id: string): string | null {
  if (id.startsWith(MCP_PAGE)) { const x = CONNECTOR_BY_ID[id.slice(MCP_PAGE.length)]; return x ? `${x.name} MCP` : null; }
  return CONNECTOR_BY_ID[id]?.name ?? null;
}

export function ConnectorsPage({ detail, onDetail, library, onLibrary, brain, focus }: { detail: string | null; onDetail: (id: string | null) => void; library: boolean; onLibrary: (open: boolean) => void; brain: Brain | null; onFolder: () => void; onNotes: () => void; focus?: { cat: string | true; n: number } | null }) {
  const [live, setLive] = useState<Live>({ sources: [], cal: null, mcp: null, providers: [], platforms: [], accounts: [] });
  const { list: libraryList, byId } = useLibrary();
  // a connect refused for the wrong account opens the detail page, which offers signing in with another account
  const [refused, setRefused] = useState<{ id: string; error: string } | null>(null);
  const [icons, setIcons] = useState<Record<string, string | null>>({});
  // the first answer from the main process takes a moment (the Claude Code check shells out); until then a skeleton
  const [loaded, setLoaded] = useState(false);
  // the library area a link pointed at ("Connect a calendar"); SettingsView opens the library itself
  const [browseArea, setBrowseArea] = useState<string | null>(null);
  // Cloud on a team with "approved connectors only" on: connectors the workspace did not enable are hidden unless
  // already connected (connectors/approval.js). null everywhere else, which leaves the page as it was
  const { policy, report } = useConnectorPolicy();
  // the provider MCP servers the agent already has; a new pass each time the window gets focus
  const { overlap, checking, check } = useMcpOverlap({ refreshOnFocus: true, key: brain?.root ?? '' });
  const approval = (x: LibraryConnector): Approval => approvalOf(x, policy, accountConnected(x, live));
  const load = async () => {
    // the local edition has no platform handlers; the call fails and the list stays empty
    const [sources, cal, mcp, providers, platforms, accounts] = await Promise.all([window.quorum.sourcesList(), window.quorum.calendarStatus(), window.quorum.mcpStatus(), window.quorum.meetingProviders(), window.quorum.platformsList().catch(() => [] as PlatformInfo[]), window.quorum.oauthAccounts().catch(() => [] as OAuthAccount[])]);
    setLive({ sources, cal, mcp, providers, platforms, accounts });
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
  // the workspace counts which of its connectors this member has connected (migration 0030 member_integrations)
  useEffect(() => { if (loaded) report(libraryList.filter((x) => isGoverned(x) && accountConnected(x, live)).map((x) => x.id)); }, [loaded, live, libraryList, report]);
  // a deep link naming a library category ("Connect a calendar") opens the library at that area
  useEffect(() => {
    if (!focus || focus.cat === true) return;
    setBrowseArea(areaOfCategory(focus.cat));
  }, [focus]);
  // the MCP servers that count: on in the agent, and matching a connector Quorum offers today
  // MCPs the person disconnected from Quorum stay out of the list; their page offers Connect again
  const [ignored, setIgnored] = useState<string[]>([]);
  useEffect(() => { window.quorum.getSettings().then((st) => setIgnored(st.mcpIgnored ?? [])).catch(() => {}); }, []);
  const ignore = (id: string, on: boolean) => {
    const next = on ? [...new Set([...ignored, id])] : ignored.filter((x) => x !== id);
    setIgnored(next);
    window.quorum.setSettings({ mcpIgnored: next }).catch(() => {});
  };
  const agentMcps = (overlap?.servers ?? []).filter((m) => m.on && m.provider && byId[m.provider]?.status === 'available' && !ignored.includes(m.provider));
  if (detail?.startsWith(MCP_PAGE) && byId[detail.slice(MCP_PAGE.length)]) {
    const x = byId[detail.slice(MCP_PAGE.length)];
    return <McpDetail connector={x} icon={icons[x.id] ?? null} servers={overlap?.matches[x.id] ?? []} overlap={overlap} checking={checking} onCheck={check} appOn={isConnected(x, live)} ignored={ignored.includes(x.id)} onIgnore={(on) => ignore(x.id, on)} onOpenConnector={() => onDetail(x.id)} />;
  }
  if (detail && byId[detail]) return <ConnectorDetail mcpIgnored={ignored.includes(detail)} connector={byId[detail]} icon={icons[detail] ?? null} live={live} onChange={load} initialError={refused?.id === detail ? refused.error : ''} approval={approval(byId[detail])} overlap={overlap} checking={checking} onCheck={check} />;
  // what the library offers today (with meeting capture off, Meet and Teams are not built as imports yet), and
  // anything still connected whatever its status, so it can be disconnected
  const openRefused = (id: string, error: string) => { setRefused({ id, error }); onDetail(id); };
  if (!loaded) {
    return (
      <div className="conn-group" aria-busy="true" aria-label="Loading connectors">
        <h4 className="skel skel-h" />
        <div className="set-card conn-card">{[0, 1].map((i) => <div key={i} className="conn-line skel-row"><span className="skel skel-logo" /><span className="skel skel-title" /><span className="skel skel-meta" /></div>)}</div>
      </div>
    );
  }
  if (library) return <ConnectorLibrary list={libraryList} icons={icons} live={live} approval={approval} overlap={overlap} focusArea={browseArea} onOpen={onDetail} />;
  // the connectors this person connected, or that their workspace runs for them, by area
  const shown = (x: LibraryConnector) => (accountConnected(x, live) || isConnected(x, live) || approval(x) === 'org') && !hiddenFromList(x, approval(x));
  const areas = AREAS.map((a) => ({ ...a, items: libraryList.filter((x) => areaOf(x) === a.id && shown(x)), mcps: agentMcps.filter((m) => areaOf(byId[m.provider!]) === a.id) })).filter((a) => a.items.length || a.mcps.length);
  return (
    <>
      {/* in the page title's row, at the right */}
      <TitleActions><button className="pill primary conn-add" onClick={() => { setBrowseArea(null); onLibrary(true); }}><IconPlus width={16} height={16} /> Add connector</button></TitleActions>
      {areas.map((a) => (
        <div key={a.id} className="conn-group" data-conn-group={a.id}>
          <h4>{a.name}</h4>
          <div className="set-card conn-card">
            {a.items.map((x) => <ConnectorRow key={x.id} connector={x} icon={icons[x.id] ?? null} live={live} approval={approval(x)} mcp={overlap?.matches[x.id]} onChange={load} onOpen={() => onDetail(x.id)} onWrongAccount={(e) => openRefused(x.id, e)} />)}
            {a.mcps.map((m) => <McpRow key={m.name} connector={byId[m.provider!]} icon={icons[m.provider!] ?? null} server={m} onOpen={() => onDetail(`${MCP_PAGE}${m.provider}`)} onSync={check} onDisconnect={() => ignore(m.provider!, true)} />)}
          </div>
        </div>
      ))}
      {!areas.length && <p className="conn-empty">No connectors yet. Add one to bring in your meetings, calendar, files and work.</p>}
      {policy && <p className="conn-more">{policy.enabled.length ? 'Your workspace lists the connectors an admin approved.' : 'Your workspace allows only connectors an admin approved, and none are approved yet.'}</p>}
    </>
  );
}

const WHERE: Record<McpOverlapServer['where'][number], string> = { 'claude-list': 'Claude Code', 'claude-user': 'Claude Code', 'claude-project': 'Claude Code, this folder', vault: 'Agent OS folder' };
const whereOf = (s: McpOverlapServer) => [...new Set(s.where.map((w) => WHERE[w]))].join(' · ');
// a connection's state as a dot beside its name; the word is in the tooltip
const Dot = ({ on, tip }: { on: boolean; tip?: string }) => <i className={`conn-dot${on ? ' on' : ''}`} role="img" aria-label={tip ?? (on ? 'Connected' : 'Not connected')} data-tip={tip ?? (on ? 'Connected' : 'Not connected')} />;
// the agent has this provider's MCP server: green when it is on, grey when it is set up and turned off
function McpBadge({ connector: x, overlap }: { connector: LibraryConnector; overlap: McpOverlap | null }) {
  const on = !!overlap?.matches[x.id]?.length;
  const off = !on && !!overlap?.off[x.id]?.length;
  if (!on && !off) return null;
  return <em className={`soon ${on ? 'green' : 'grey'}`} data-tip={on ? `Your agent's ${x.name} MCP is connected` : `Your agent has ${x.name}'s MCP set up, turned off`}>Agent has MCP</em>;
}
// the library's order within an area: the most used tools first
const POPULAR = ['zoom', 'google-calendar', 'slack', 'google-drive', 'notion', 'github', 'gmail', 'granola', 'teams', 'google-meet', 'outlook', 'jira', 'linear', 'hubspot', 'salesforce', 'asana', 'google-docs', 'claude-code', 'chatgpt', 'claude', 'figma', 'trello', 'clickup', 'monday', 'onedrive', 'onenote', 'zapier', 'fireflies', 'otter', 'fathom', 'read-ai', 'tldv', 'wispr', 'apple-calendar', 'codex', 'cursor', 'gemini', 'copilot', 'attio', 'pipedrive', 'affinity', 'gainsight', 'mailchimp', 'replit', 'lovable', 'v0', 'manus', 'grok'];
const rank = (id: string) => { const i = POPULAR.indexOf(id); return i < 0 ? POPULAR.length : i; };

// A provider's own MCP server in the person's agent, listed in its connector's area. Only servers that match a connector
// Quorum offers are listed, and not ones the person disconnected from Quorum. Quorum does not call these servers: the
// agent does. The row opens the MCP's page; its menu has Sync and Disconnect like any connector
function McpRow({ connector: x, icon, server, onOpen, onSync, onDisconnect }: { connector: LibraryConnector; icon: string | null; server: McpInheritedServer; onOpen: () => void; onSync: () => void; onDisconnect: () => void }) {
  return (
    <div className="conn-row">
      <div className="conn-line" role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}>
        <Logo id={x.id} icon={icon} />
        <strong className="conn-title">{x.name} MCP</strong>
        <Dot on tip={`On in ${whereOf(server)}`} />
        <span className="conn-meta">{whereOf(server)}</span>
        <McpMenu name={`${x.name} MCP`} onSync={onSync} onDisconnect={onDisconnect} />
        <IconChevron className="right conn-chev" width={14} height={14} />
      </div>
    </div>
  );
}

const MCP_DISCONNECT = (n: string) => `Quorum stops counting your agent's ${n} MCP: it leaves your Connectors and Quorum will not route requests to it once routing ships. Quorum does not read from this MCP today, so nothing else changes. Your agent keeps the server; your Claude Code settings stay as they are.`;
function McpMenu({ name, onSync, onDisconnect, syncButton = false, syncing = false }: { name: string; onSync: () => void; onDisconnect: () => void; syncButton?: boolean; syncing?: boolean }) {
  const [open, setOpen] = useMenu();
  const [confirm, setConfirm] = useState(false);
  return (
    <span className="conn-actions" onClick={(e) => e.stopPropagation()}>
      {syncButton && <button className="pill" disabled={syncing} onClick={onSync}>{syncing ? 'Syncing…' : 'Sync'}</button>}
      <span className="menu-wrap">
        <button className="icon-btn" aria-label={`${name} options`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o: boolean) => !o)}><IconMore width={16} height={16} /></button>
        {open && (
          <div className="menu" role="menu">
            {!syncButton && <button role="menuitem" disabled={syncing} onClick={() => { setOpen(false); onSync(); }}><IconReset width={15} height={15} /> Sync</button>}
            <button role="menuitem" className="danger" onClick={() => { setOpen(false); setConfirm(true); }}>Disconnect</button>
          </div>
        )}
      </span>
      {confirm && <ConfirmDisconnect name={name} text={MCP_DISCONNECT(name.replace(/ MCP$/, ''))} busy={false} onCancel={() => setConfirm(false)} onConfirm={() => { setConfirm(false); onDisconnect(); }} />}
    </span>
  );
}

// A provider MCP's page: where the agent has it, then how it compares with Quorum's app connector
function McpDetail({ connector: x, icon, servers, overlap, checking, onCheck, appOn, ignored, onIgnore, onOpenConnector }: { connector: LibraryConnector; icon: string | null; servers: McpOverlapServer[]; overlap: McpOverlap | null; checking: boolean; onCheck: () => void; appOn: boolean; ignored: boolean; onIgnore: (on: boolean) => void; onOpenConnector: () => void }) {
  const on = servers.length > 0 && !ignored;
  return (
    <div className="conn-detail">
      <div className="set-card conn-detail-card">
        <Logo id={x.id} icon={icon} size={44} />
        <div className="conn-detail-title">
          <h3>{x.name} MCP{on && <Dot on tip="On in your agent" />}</h3>
          <p>{x.name}'s own MCP server, set up in your agent. Your agent calls it when it needs {x.name} data. Quorum sees that it is there and does not read through it.</p>
        </div>
        <div className="conn-detail-cta">
          {ignored ? <button className="pill primary" onClick={() => onIgnore(false)}>Connect</button>
            : servers.length ? <McpMenu name={`${x.name} MCP`} syncButton syncing={checking} onSync={onCheck} onDisconnect={() => onIgnore(true)} />
            : <button className="pill" disabled={checking} onClick={onCheck}>{checking ? 'Syncing…' : 'Sync'}</button>}
        </div>
      </div>
      {ignored && <div className="conn-alert" role="status"><strong>Disconnected from Quorum</strong><span>Quorum does not count this MCP. Your agent still has it. Connect counts it again.</span></div>}
      <h4>Details</h4>
      <div className="set-card conn-table">
        {!servers.length && <p className="src-status">Your agent does not have this MCP server right now.</p>}
        {servers.map((m) => (
          <div key={m.name}>
            <div className="conn-kv"><span>Server</span><span>{m.name}</span></div>
            <div className="conn-kv"><span>Set up in</span><span>{whereOf(m)}</span></div>
            <div className="conn-kv"><span>Address</span><span>{m.url ?? [m.command, ...m.args].filter(Boolean).join(' ')}</span></div>
          </div>
        ))}
        <div className="conn-kv"><span>Connector</span><span><button className="link-btn plain" onClick={onOpenConnector}>{x.name}</button></span></div>
      </div>
      {overlap && <McpCompareSection connector={x} overlap={overlap} appOn={appOn} />}
    </div>
  );
}

// Add connector: every connector by area. The connectors this person cannot connect (not built yet, not in this
// build, Cloud only on the Local edition, or not approved by their workspace) are hidden for everyone until Show
// hidden, on the title row, is checked; the choice lasts for this launch
function ConnectorLibrary({ list, icons, live, approval, overlap, focusArea, onOpen }: { list: readonly LibraryConnector[]; icons: Record<string, string | null>; live: Live; approval: (x: LibraryConnector) => Approval; overlap: McpOverlap | null; focusArea: string | null; onOpen: (id: string) => void }) {
  const [showHidden, setShowHidden] = useSession('connectorsShowHidden', false);
  const notAvailable = (x: LibraryConnector) => {
    const ap = approval(x);
    return x.status === 'soon' || unavailable(x, live) || needsCloud(x, live) || hiddenFromList(x, ap) || (!canConnect(ap) && !hasLocalPart(x) && ap !== 'org');
  };
  const ready = (x: LibraryConnector) => isConnected(x, live) || !notAvailable(x);
  useEffect(() => { if (focusArea) document.querySelector(`[data-lib-area="${focusArea}"]`)?.scrollIntoView({ block: 'start' }); }, [focusArea]);
  return (
    <>
      <TitleActions>
        <label className="conn-show-hidden"><input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />Show hidden</label>
      </TitleActions>
      {libraryAreas(list, AREAS, { areaOf, ready, rank, showHidden }).map(({ area: a, items }) => {
        return (
          <div key={a.id} className="conn-group" data-lib-area={a.id}>
            <h4>{a.name}</h4>
            <p className="conn-lede">{a.blurb}</p>
            <div className="set-card conn-card">
              {items.map((x) => {
                const on = isConnected(x, live);
                const ap = approval(x);
                const state = on ? null : x.status === 'soon' ? <em className="soon grey">Soon</em> : needsCloud(x, live) ? <em className="soon grey">Cloud</em>
                  : unavailable(x, live) ? <span className="conn-off">Not available yet</span> : ap === 'unapproved' ? <span className="conn-off">{UNAPPROVED_LABEL}</span>
                  : <span className="conn-actions"><button className="pill small-pill" onClick={(e) => { e.stopPropagation(); onOpen(x.id); }}>Connect</button></span>;
                return (
                  <div key={x.id} className={`conn-row${notAvailable(x) && !on ? ' conn-dim' : ''}`}>
                    <div className="conn-line" role="button" tabIndex={0} onClick={() => onOpen(x.id)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(x.id); } }}>
                      <Logo id={x.id} icon={icons[x.id] ?? null} />
                      <strong className="conn-title">{x.name}</strong>
                      {on && <Dot on />}
                      <McpBadge connector={x} overlap={overlap} />
                      <span className="conn-desc">{x.description}</span>
                      {state}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </>
  );
}

const home = (p: string) => p.replace(/^\/Users\/[^/]+/, '~');
const Status = ({ on }: { on: boolean }) => (on ? <span className="conn-ok"><i />Connected</span> : <span className="conn-off">Not connected</span>);

// a Cloud-only import with no Cloud account on this copy: a Cloud badge and a link to the plans
const needsCloud = (x: LibraryConnector, live: Live) => cloudOnly(x) && !platformFor(x, live);

function useAct(onChange: () => void): [boolean, string, Act] {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // every action can connect or disconnect something, so Up next hears about it (UpNext.tsx)
  const act: Act = async (fn) => { setBusy(true); setError(''); const r = (await fn()) as { error?: string } | null | undefined; setBusy(false); window.dispatchEvent(new Event(CONNECTORS_CHANGED)); if (r && r.error) setError(r.error); else onChange(); };
  return [busy, error, act];
}

// the one line of metadata that matters for this kind of connector, shown on the row's right side
const metaLine = (x: LibraryConnector, live: Live) => {
  const src = sourceFor(x, live);
  if (x.kind === 'mcp-source' && src) return src.job?.status === 'running' ? null : `${plural(src.notes, 'note')} · synced ${ago(src.lastSyncAt)}`;
  if (x.id === 'apple-calendar') return 'Upcoming meetings on Home';
  if (x.id === 'google-calendar') { const g = googleFor(x, live); return g?.connected ? `${g.account ?? 'Google account'} · ${plural(g.calendars, 'calendar')}` : null; }
  if (x.id === 'claude-code') return 'quorum MCP server added';
  if (x.account) return accountFor(x, live)?.account ?? `${x.name} account`;
  const p = providerFor(x, live);
  if (p) { const plat = platformFor(x, live); return `${p.inCall ? 'In a call now' : 'Listening on this Mac'}${plat?.connected ? ` · ${plural(plat.notes, 'recording')} imported` : ''}`; }
  const plat = platformFor(x, live);
  if (plat?.connected) return `${plural(plat.notes, 'recording')} imported`;
  return null;
};

const APP_ICON_FIRST = new Set(['zoom']);
// a connector's mark: its brand logo, drawn for a dark background, else the installed app's icon or the site icon
function Logo({ id, icon, size = 28 }: { id?: string; icon: string | null; size?: number }) {
  // Zoom's mark is a wordmark, too small at this size: its installed app icon reads better
  const brand = id && !(APP_ICON_FIRST.has(id) && icon) ? BRAND_LOGOS[id] : undefined;
  if (brand) icon = brandSrc(brand);
  return icon ? <img className="conn-logo" src={icon} alt="" style={{ width: size, height: size }} /> : <span className="conn-logo blank" style={{ width: size, height: size }}><IconGrid width={14} height={14} /></span>;
}

// What Disconnect means for each kind of connector, said in the confirm before it runs
function disconnectOf(x: LibraryConnector, live: Live): { text: string; run: () => Promise<unknown> } | null {
  const src = sourceFor(x, live);
  if (x.kind === 'mcp-source' && src) return { text: `Quorum stops importing ${x.name} notes and signs out of ${x.name}. Notes already imported stay in your vault.`, run: () => window.quorum.sourceDisconnect(src.id) };
  if (x.id === 'apple-calendar') return { text: 'Quorum stops reading the Calendar app. Upcoming meetings leave Home and new notes lose their meeting title and people.', run: () => window.quorum.calendarSet({ enabled: false }) };
  if (x.account) return { text: `Quorum removes its ${x.name} sign-in from this Mac and revokes it with ${x.name}. The ${x.name} features stop until you connect again.`, run: () => window.quorum.oauthDisconnect(x.id) };
  if (x.id === 'claude-code') return { text: 'Quorum removes its MCP server from Claude Code. Claude Code can no longer search your notes and meetings through Quorum.', run: () => window.quorum.mcpRemove() };
  if (x.kind === 'meeting-app' && x.app && platformFor(x, live)?.connected) return { text: `Quorum stops importing ${x.name} cloud recordings and signs out of your ${x.name} account. Recordings already imported stay in your vault.`, run: () => window.quorum.platformDisconnect(x.app!) };
  return null;
}
// Sync for a connector that brings things in: a meeting-notes source imports now, a meeting app imports its recordings
function syncOf(x: LibraryConnector, live: Live): { run: () => Promise<unknown>; running: boolean } | null {
  const src = sourceFor(x, live);
  if (x.kind === 'mcp-source' && src) return { run: () => window.quorum.sourceSync(src.id), running: src.job?.status === 'running' };
  const plat = platformFor(x, live);
  if (x.kind === 'meeting-app' && x.app && plat?.connected) return { run: () => window.quorum.platformSync(x.app!), running: plat.job?.status === 'running' };
  // Google Calendar reads upcoming events again
  if (x.id === 'google-calendar' && googleFor(x, live)?.connected) return { run: () => window.quorum.calendar(), running: false };
  return null;
}

// A confirm before a Disconnect: what it changes, then Cancel and Disconnect
export function ConfirmDisconnect({ name, text, busy, onCancel, onConfirm }: { name: string; text: string; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  return createPortal(
    <div className="palette-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}>
      <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="disc-title" onKeyDown={(e) => { if (e.key === 'Escape' && !busy) onCancel(); }}>
        <h2 id="disc-title">Disconnect {name}?</h2>
        <p>{text}</p>
        <ModalActions>
          <button className="pill" autoFocus disabled={busy} onClick={onCancel}>Cancel</button>
          <button className="pill danger-pill" disabled={busy} onClick={onConfirm}>{busy ? 'Disconnecting…' : 'Disconnect'}</button>
        </ModalActions>
      </div>
    </div>,
    document.body,
  );
}

// what a connected connector offers: Sync where something syncs (in the menu on a row, as a button beside the menu on
// its page), lead (Check connection on an account's page), the connector's own items, and Disconnect behind a confirm
function Actions({ connector: x, live, busy, act, syncButton = false, onSync, lead = null, manageLabel = 'Choose repositories' }: { connector: LibraryConnector; live: Live; busy: boolean; act: Act; syncButton?: boolean; onSync?: () => void; lead?: ReactNode; manageLabel?: string }) {
  const [open, setOpen] = useMenu();
  const [confirm, setConfirm] = useState(false);
  const src = sourceFor(x, live);
  const sync = syncOf(x, live);
  const disc = disconnectOf(x, live);
  const runSync = () => { onSync?.(); if (sync) act(sync.run); };
  return (
    <span className="conn-actions" onClick={(e) => e.stopPropagation()}>
      {lead}
      {syncButton && sync && <button className="pill" disabled={busy || sync.running} onClick={runSync}>{sync.running ? 'Syncing…' : 'Sync'}</button>}
      <span className="menu-wrap">
        <button className="icon-btn" aria-label={`${x.name} options`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o: boolean) => !o)}><IconMore width={16} height={16} /></button>
        {open && (
          <div className="menu" role="menu">
            {!syncButton && sync && <button role="menuitem" disabled={busy || sync.running} onClick={() => { setOpen(false); runSync(); }}><IconReset width={15} height={15} /> {sync.running ? 'Syncing…' : 'Sync'}</button>}
            {src?.folderPath && <button role="menuitem" onClick={() => { setOpen(false); window.quorum.meetingSourceOpen(src.folderPath!); }}><IconExternal width={15} height={15} /> Show notes folder</button>}
            {accountFor(x, live)?.manageUrl && <button role="menuitem" onClick={() => { setOpen(false); window.quorum.openExternal(accountFor(x, live)!.manageUrl!); }}><IconExternal width={15} height={15} /> {manageLabel}</button>}
            {x.kind === 'meeting-app' && x.app && !cloudOnly(x) && <>
              <button role="menuitem" onClick={() => { setOpen(false); act(async () => { await window.quorum.meetingProviderCheck(); await new Promise((r) => setTimeout(r, 1500)); }); }}><IconReset width={15} height={15} /> Check again</button>
              <button role="menuitem" onClick={() => { setOpen(false); window.quorum.axSettingsOpen(); }}>Accessibility settings</button>
              <button role="menuitem" className="danger" onClick={() => { setOpen(false); act(() => window.quorum.meetingProviderSet(x.app!, false)); }}>Stop listening</button>
            </>}
            {disc && <button role="menuitem" className="danger" onClick={() => { setOpen(false); setConfirm(true); }}>Disconnect</button>}
          </div>
        )}
      </span>
      {confirm && disc && <ConfirmDisconnect name={x.name} text={disc.text} busy={busy} onCancel={() => setConfirm(false)} onConfirm={() => act(async () => { await disc.run(); setConfirm(false); })} />}
    </span>
  );
}

function ConnectorRow({ connector: x, icon, live, approval, mcp, onChange, onOpen, onWrongAccount }: { connector: LibraryConnector; icon: string | null; live: Live; approval: Approval; mcp?: McpOverlapServer[]; onChange: () => void; onOpen: () => void; onWrongAccount: (error: string) => void }) {
  const [busy, error, act] = useAct(onChange);
  const src = sourceFor(x, live);
  const running = src?.job?.status === 'running';
  const [, tick] = useState(0);
  useEffect(() => { if (!running) return; const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, [running]);
  const on = isConnected(x, live);
  const cloud = needsCloud(x, live);
  // a copy built without the provider's client id cannot connect it; the row says so instead of offering it
  const off = !on && unavailable(x, live);
  // the workspace runs it with a shared identity: read-only here, with no personal Connect
  const org = approval === 'org' && !on;
  const personal = canConnect(approval) || hasLocalPart(x);
  const meta = approval === 'unapproved' ? UNAPPROVED_LABEL : on ? metaLine(x, live) : off ? 'Not available yet' : null;
  // the chevron folds the row open to its details; a click anywhere else on the row opens the connector's page
  const [open, setOpen] = useState(false);
  const mcpOn = !!mcp?.length;
  return (
    <div className="conn-row">
      <div className="conn-line" role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}>
        <Logo id={x.id} icon={icon} />
        <strong className="conn-title">{x.name}</strong>
        {org ? <Dot on tip={ORG_LABEL} /> : <Dot on={on} />}
        {cloud && <em className="soon grey">Cloud</em>}
        {approval === 'approved' && <em className="soon grey">Workspace</em>}
        <span className="conn-fill" />
        {mcpOn && <em className="soon green" data-tip={`Your agent's ${x.name} MCP is connected`}>Agent has MCP</em>}
        {on ? <Actions connector={x} live={live} busy={busy} act={act}/>
          : <span className="conn-actions" onClick={(e) => e.stopPropagation()}>{cloud ? <button className="pill" onClick={() => window.quorum.openExternal(PRICING)}>See Cloud</button> : off || !personal ? null : <ConnectButton connector={x} live={live} busy={busy} act={act} onWrongAccount={onWrongAccount} />}</span>}
        <button className={`icon-btn conn-fold${open ? ' open' : ''}`} aria-expanded={open} aria-label={open ? `Hide ${x.name} details` : `Show ${x.name} details`} onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}><IconChevron width={14} height={14} /></button>
      </div>
      {running && src?.job && <div className="conn-sub"><JobLine job={src.job} oneLine /></div>}
      {open && (
        <div className="conn-sub conn-fold-body">
          <span>{meta ?? (on ? 'Connected' : 'Not connected')}</span>
          {!running && src?.job && <JobLine job={src.job} oneLine />}
          {mcpOn && <span>Your agent also has {x.name}'s MCP: {mcp!.map((m) => m.name).join(', ')}</span>}
        </div>
      )}
      {error && <p className="set-error conn-sub one-line" title={error}>{error}</p>}
    </div>
  );
}

// Check connection on an account connector's page: the provider's identity call through the main process
function useAccountCheck(id: string) {
  // the result is kept with its connector id, so another connector's page starts without one
  const [checked, setChecked] = useState<{ id: string; result: OAuthCheck } | null>(null);
  const [checking, setChecking] = useState(false);
  const run = async () => {
    setChecking(true);
    const r = await window.quorum.oauthCheck(id).catch((err: Error) => ({ error: err.message }));
    setChecked({ id, result: 'ok' in r ? r : { ok: false, reconnect: false, error: r.error, checkedAt: new Date().toISOString() } });
    setChecking(false);
  };
  return { checked: checked?.id === id ? checked.result : null, checking, run, clear: () => setChecked(null) };
}

// where the GitHub App is installed, read again when the window gets focus and when a connector link brought the app
// forward (CONNECTOR_RETURN). A read that fails keeps what the page showed
function useGithubInstalls(on: boolean) {
  const [installs, setInstalls] = useState<GithubInstallations | null>(null);
  useEffect(() => {
    if (!on) return;
    let live = true;
    const read = () => window.quorum.oauthGithubInstallations().then((r) => {
      if (!live || !('installations' in r)) return;
      setInstalls((prev) => (r.stale ? prev ?? (r.checkedAt ? r : null) : r));
    }).catch(() => {});
    read();
    const back = (e: Event) => { if ((e as CustomEvent<string>).detail === 'github') read(); };
    window.addEventListener('focus', read);
    window.addEventListener(CONNECTOR_RETURN, back);
    return () => { live = false; window.removeEventListener('focus', read); window.removeEventListener(CONNECTOR_RETURN, back); };
  }, [on]);
  return on ? installs : null;
}

function ConnectorDetail({ connector: x, icon, live, onChange, initialError = '', approval = 'open', overlap = null, onCheck = () => {}, mcpIgnored = false }: { connector: LibraryConnector; icon: string | null; live: Live; onChange: () => Promise<void>; initialError?: string; approval?: Approval; overlap?: McpOverlap | null; checking?: boolean; onCheck?: () => void; mcpIgnored?: boolean }) {
  const blocked = approval === 'blocked';
  // a personal connect or reconnect needs an open or approved connector; listening on this Mac is never governed
  const refusal = canConnect(approval) ? null : approval === 'org' ? ORG_SENTENCE(x.name) : BLOCKED_SENTENCE;
  const personal = !refusal || hasLocalPart(x);
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
  const area = AREAS.find((a) => a.id === areaOf(x));
  const google = googleFor(x, live);
  const acct = accountFor(x, live);
  // the account connectors have nothing to sync yet: their page checks the connection instead
  const checkable = on && !!acct && CHECKABLE.has(x.id);
  const check = useAccountCheck(x.id);
  const checkFailed = check.checked && !check.checked.ok ? check.checked : null;
  const installs = useGithubInstalls(x.id === 'github' && on);
  const installed = installSummary(installs);
  const off = !on && unavailable(x, live);
  const status = soon ? 'Soon' : on ? 'Connected' : off ? 'Not available yet' : x.id === 'apple-calendar' && live.cal?.status === 'denied' ? 'Access is off in System Settings'
    : prov && !prov.enabled ? 'Not listening' : prov && !prov.installed ? `${x.name} isn't installed on this Mac` : prov && prov.access === false ? 'Needs Accessibility access' : 'Not connected';
  // one message for the page: the latest action's error wins, else the last failed import
  const alert = error || (src?.job?.status === 'failed' ? src.job.error : null) || (acct?.error ?? null) || checkFailed?.error || null;
  const accountProblem = !!alert && /No \w+ account for|account for this sign-in|different account|Use the account your/i.test(alert);
  const rows: [string, ReactNode][] = [
    ...(on ? [] : [['Status', status] as [string, ReactNode]]),
    ['Area', area?.name ?? x.category],
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
    ['Calendars', plural(google.calendars, 'calendar')],
    ['Last read', google.lastSyncAt ? `${ago(google.lastSyncAt)} (${new Date(google.lastSyncAt).toLocaleString()})` : 'not yet'],
    ['Reads', 'Upcoming events from the calendars selected in Google Calendar, read only'],
  );
  if (x.account) rows.push(
    ...(acct?.connected && acct.account ? [['Account', acct.account] as [string, ReactNode]] : []),
    ...(acct?.connected && acct.connectedAt ? [['Connected', `${ago(acct.connectedAt)} (${new Date(acct.connectedAt).toLocaleString()})`] as [string, ReactNode]] : []),
    ...(x.id === 'github' && on ? [['Repositories', installs ? installed ?? 'Not installed on any repository yet' : 'Not read yet'] as [string, ReactNode]] : []),
    ['Access', acct?.scope ?? 'Set by the provider\'s consent screen'],
    ['Tokens', x.id.startsWith('google-') ? 'Stored in this Mac\'s Keychain. Disconnect removes them, and revokes Quorum\'s Google access once no other Google connector uses the same account' : 'Stored in this Mac\'s Keychain. Disconnect revokes them with the provider and removes them'],
  );
  if (prov) rows.push(
    ['Listens to', `${x.name} calls in ${appWhere(x)} on this Mac`],
    ['App', prov.installed ? `Installed${prov.version ? ` · ${prov.version}` : ''}` : 'Not installed'],
    ['Accessibility', prov.access === false ? 'Not granted' : prov.access ? 'Granted' : 'Not needed'],
    ['In a call', prov.inCall ? 'Yes, now' : 'No'],
    ['Chat notice', prov.chat ? `Posts Quorum's notice in the ${x.name} chat when it starts listening` : 'None yet; you tell the call Quorum is listening'],
    ['Cloud recordings', (() => { const plat = platformFor(x, live); return !plat ? 'Part of Quorum Cloud: sign in to connect your account' : !plat.available ? 'Not available in this build' : plat.connected ? `Connected as ${plat.account ?? plat.accountName ?? 'your account'} · ${plural(plat.notes, 'recording')} imported · last checked ${ago(plat.lastSyncAt)}` : 'Not connected'; })()],
  );
  if (x.id === 'claude-code' && live.mcp) rows.push(['Registered with', <code>{live.mcp.command}</code>]);
  // what to do once connected: bring in what the connection reaches so far
  const plat = platformFor(x, live);
  const steps: { title: string; text: string; label: string; busyLabel: string; running: boolean; run: () => void }[] = [];
  if (plat?.connected && x.app) steps.push({ title: 'Import your recordings', text: `Bring in the ${x.name} cloud recordings made so far. New ones arrive on their own after this.`, label: 'Import', busyLabel: 'Importing…', running: plat.job?.status === 'running', run: () => act(() => window.quorum.platformSync(x.app!)) });
  if (x.kind === 'mcp-source' && src) steps.push({ title: 'Import your notes', text: `Bring in your ${x.name} notes now instead of waiting for the next sync.`, label: 'Import', busyLabel: 'Importing…', running: !!running, run: () => act(() => window.quorum.sourceSync(src.id)) });
  if (acct?.manageUrl) steps.push(installed
    ? { title: 'Change repositories', text: `${installed}. Add or remove repositories on GitHub.`, label: 'Change', busyLabel: 'Change', running: false, run: () => window.quorum.openExternal(acct.manageUrl!) }
    : { title: 'Choose repositories', text: 'Pick the repositories Quorum may read. It reads nothing until you do.', label: 'Choose', busyLabel: 'Choose', running: false, run: () => window.quorum.openExternal(acct.manageUrl!) });
  const checkButton = checkable ? <button className="pill" disabled={busy || check.checking} onClick={check.run}>{check.checking ? 'Checking…' : 'Check connection'}</button> : null;
  // a refused token: sign in again from the alert; a good sign-in clears the failed check
  const reconnect = checkFailed?.reconnect && personal
    ? <button className="pill" disabled={busy} onClick={() => act(async () => { const r = await startConnect(x); if (!r.error) check.clear(); return r; })}>{busy ? connectLabel(x, true, true) : 'Reconnect'}</button>
    : null;
  rows.push(['Website', <button className="link-btn plain" onClick={() => window.quorum.openExternal(`https://${x.domain}`)}>{x.domain}<IconExternal width={13} height={13} /></button>]);
  return (
    <div className="conn-detail">
      <div className="set-card conn-detail-card">
        <Logo id={x.id} icon={icon} size={44} />
        <div className="conn-detail-title">
          <h3>{x.name}{on && <Dot on />}{soon && <em className="soon grey">Soon</em>}</h3>
          <p>{aboutFor(x, capture(x))}</p>
        </div>
        <div className="conn-detail-cta">
          {on ? <Actions connector={x} live={live} busy={busy} act={act} syncButton onSync={onCheck} lead={checkButton} manageLabel={installed ? 'Change repositories' : 'Choose repositories'} />
            : !soon && !off && personal && !(accountProblem && x.kind === 'mcp-source') ? <ConnectButton connector={x} live={live} busy={busy} act={act} />
            : <span data-tip={soon || off ? 'Coming soon' : refusal ?? 'Not available'}><button className="pill primary" disabled>Connect</button></span>}
        </div>
      </div>
      {(blocked || approval === 'unapproved') && <div className="conn-alert" role="status"><strong>{UNAPPROVED_LABEL}</strong><span>{blocked ? BLOCKED_SENTENCE : 'You connected this yourself. It keeps working until you disconnect it. Connecting it again needs an owner or admin to approve it.'}</span></div>}
      {approval === 'org' && <div className="conn-alert" role="status"><strong>{ORG_LABEL}</strong><span>{ORG_SENTENCE(x.name)}</span></div>}
      {alert && <div className="conn-alert" role="alert"><strong>{accountProblem ? 'Sign in with a different account' : alert.split('. ')[0].replace(/\.$/, '')}</strong><span>{alert}</span>{alert === checkFailed?.error && reconnect}</div>}
      {on && steps.length > 0 && (
        <>
          <h4>Next steps</h4>
          <div className="set-card conn-steps">
            {steps.map((st) => (
              <div key={st.label} className="conn-step">
                <span><strong>{st.title}</strong><span>{st.text}</span></span>
                <button className="pill" disabled={busy || st.running} onClick={st.run}>{st.running ? st.busyLabel : st.label}</button>
              </div>
            ))}
          </div>
        </>
      )}
      {(on || (prov && !cloudOnly(x)) || (!!src?.job && src.job.status === 'running') || (accountProblem && x.kind === 'mcp-source')) && <>
      <h4>Connectivity</h4>
      <div className={`set-card conn-jobcard${on ? ' on' : ''}`}>
        {on && !prov && <span className="conn-ok conn-badge"><i />Connected{src && !src.syncNotes ? ' · sync off' : ''}</span>}
        {prov || cloudOnly(x)
          ? <Capabilities connector={x} provider={prov} platform={platformFor(x, live)} busy={busy} act={act} refusal={refusal} />
          : accountProblem && !on && x.kind === 'mcp-source' && !refusal
          ? <DifferentAccount connector={x} busy={busy} act={act} />
          : src?.job && src.job.status !== 'failed'
            ? <JobLine job={src.job} />
            : <p className="src-status" role="status">{on ? (src ? `Last sync ${ago(src.lastSyncAt)}. Next automatic sync within 30 minutes while Quorum runs.` : google ? `Connected as ${google.account ?? 'your Google account'}. Home reads upcoming events every few minutes while Quorum runs.` : acct && check.checked?.ok ? `Connected as ${check.checked.account ?? acct.account ?? `your ${x.name} account`}, checked ${ago(check.checked.checkedAt)}.` : acct && checkFailed ? `Last check failed ${ago(checkFailed.checkedAt)}.` : acct ? `Connected as ${acct.account ?? `your ${x.name} account`}. The ${x.name} features in the list below use this account as they ship.` : 'Connected on this Mac.') : soon || off ? 'Not available yet.' : 'Not connected yet.'}</p>}
      </div>
      </>}
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
      {overlap && !mcpIgnored && <McpCompareSection connector={x} overlap={overlap} appOn={on} />}
      {x.id === 'github' && <SyncedFolderConnections />}
      {x.kind === 'mcp-source' && src?.agent && src.agent.runners.length > 0 && (!on || src.agent.schedule !== 'off') && <AgentImport source={src} busy={busy} act={act} />}
      <h4>Enables</h4>
      <div className="set-card conn-features">
        <ul>{featuresFor(x, capture(x)).map((f) => <li key={f}><IconCheck width={14} height={14} />{f}</li>)}</ul>
      </div>
    </div>
  );
}

// starts the connection for whatever kind this is; the Library tiles and the detail header share it
const startConnect = async (x: LibraryConnector, fresh = false): Promise<{ ok?: boolean; error?: string; wrongAccount?: boolean }> => {
  if (x.kind === 'mcp-source' && x.source) return window.quorum.sourceConnect(x.source, fresh ? { fresh: true } : undefined);
  if (x.id === 'apple-calendar') { const c = await window.quorum.calendarConnect(); return c.status === 'granted' ? { ok: true } : c.status === 'denied' ? { error: 'Calendar access is off for Quorum in System Settings.' } : { error: 'macOS did not grant calendar access.' }; }
  if (x.id === 'claude-code') { const a = await window.quorum.mcpAdd(); return a.added ? { ok: true } : { error: a.error ?? 'Claude Code did not accept the server.' }; }
  if (x.account) { const a = await window.quorum.oauthConnect(x.id); return 'connected' in a && a.connected && !a.error ? { ok: true } : { error: a.error ?? `${x.name} did not finish the sign-in.` }; }
  if (cloudOnly(x) && x.app) return window.quorum.platformConnect(x.app).catch(() => ({ error: `${x.name} cloud recordings are part of Quorum Cloud.` }));
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
  busy ? (x.kind === 'mcp-source' || x.kind === 'oauth' ? 'Finish in your browser…' : x.kind === 'macos' ? 'Waiting for macOS…' : cloudOnly(x) ? 'Finish in your browser…' : x.kind === 'meeting-app' ? 'Checking…' : 'Adding…') : x.kind === 'meeting-app' && !cloudOnly(x) ? 'Start listening' : full ? `Connect ${x.name}` : 'Connect';

// the connector's controls live on the title row, next to the breadcrumbs, which SettingsView renders
function TitleActions({ children }: { children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => { setSlot(document.getElementById('conn-title-actions')); }, []);
  return slot ? createPortal(children, slot) : null;
}

function ConnectButton({ connector: x, live, busy, act, onWrongAccount }: { connector: LibraryConnector; live: Live; busy: boolean; act: Act; onWrongAccount?: (error: string) => void }) {
  if (x.id === 'apple-calendar' && live.cal?.status === 'denied') return <button className="pill" onClick={() => window.quorum.calendarPrivacy()}>Open System Settings</button>;
  const prov = providerFor(x, live);
  if (prov?.enabled && prov.installed && prov.access === false) return <button className="pill" onClick={() => window.quorum.axSettingsOpen()}>Open System Settings</button>;
  if (prov?.enabled && !prov.installed) return <button className="pill" disabled={busy} onClick={() => act(async () => { await window.quorum.meetingProviderCheck(); await new Promise((r) => setTimeout(r, 1500)); })}>{busy ? 'Checking…' : 'Check again'}</button>;
  const fresh = x.kind === 'mcp-source' && !!sourceFor(x, live)?.freshNext;
  return <button className="pill primary" disabled={busy} onClick={() => act(async () => { const r = await startConnect(x, fresh); if (r.wrongAccount && r.error && onWrongAccount) { onWrongAccount(r.error); return null; } return r; })}>{busy ? connectLabel(x, true, true) : fresh ? 'Connect with a different account' : connectLabel(x, false, false)}</button>;
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
function Capabilities({ connector: x, provider: p, platform: plat, busy, act, refusal = null }: { connector: LibraryConnector; provider: Provider | null; platform: PlatformInfo | null; busy: boolean; act: Act; refusal?: string | null }) {
  const live = listening(p);
  const why = !p ? '' : !p.enabled ? `Off. Quorum ignores ${x.name} calls until you start listening.`
    : !p.installed ? `${x.name} isn't installed on this Mac.`
    : p.access === false ? `Quorum needs Accessibility access to read ${x.name}.`
    : p.inCall ? `In a ${x.name} call now.`
    : `Reads ${appWhere(x)} on this Mac and starts the note when a call begins.`;
  const running = plat?.job?.status === 'running';
  return (
    <div className="conn-caps">
      {p && <div className={`conn-cap${live ? ' on' : ''}`}>
        <div className="conn-cap-head"><strong>Listen on this Mac</strong>{live ? <span className="conn-ok"><i />Connected</span> : <em className="soon grey">{!p.enabled ? 'Off' : 'Needs attention'}</em>}</div>
        <p>{why}</p>
      </div>}
      <div className={`conn-cap${plat?.connected ? ' on' : ''}`}>
        <div className="conn-cap-head"><strong>Import cloud recordings</strong>{plat?.connected ? <span className="conn-ok"><i />Connected</span> : !plat ? <em className="soon grey">Quorum Cloud</em> : !plat.available ? <em className="soon grey">Soon</em> : null}</div>
        {!plat && <p>Recordings and transcripts {x.name} makes in the cloud, for calls Quorum did not hear. Sign in to Quorum Cloud to connect your {x.name} account.</p>}
        {plat && !plat.available && <p>{x.name} account connections are not available in this build yet.</p>}
        {plat && plat.available && !plat.connected && (
          <div className="conn-cap-row">
            <p>Transcripts of your {x.name} cloud recordings become meeting notes, downloaded straight to this Mac.</p>
            {refusal ? <p className="muted">{refusal}</p> : <button className="pill primary small-pill" disabled={busy} onClick={() => act(() => window.quorum.platformConnect(x.app!))}>{busy ? 'Finish in your browser…' : `Connect ${x.name} account`}</button>}
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

