import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CalendarSettings, MeetingSourceInfo, SourceJob } from './quorum';
import { CATEGORIES, CONNECTORS, CONNECTOR_BY_ID, featuresOf, type LibraryConnector } from '../connectors/library';
import { useMenu } from './controls';
import { IconCheck, IconChevron, IconClose, IconExternal, IconGrid, IconMore, IconPlus, IconReset } from './icons';

// Settings › Connectors: the tools Quorum is connected to, grouped by what they do; a detail page per connector with
// its metadata, the features it enables and its actions; and the library behind Add connector, where every tool
// Quorum supports or plans to is listed. Anything not built yet is subdued with a Coming soon badge and offers no
// action. Meeting-notes sources run through sources/index.js; the Calendar connector is the macOS permission;
// Claude Code is the quorum MCP server registration.
type Live = { sources: MeetingSourceInfo[]; cal: CalendarSettings | null; mcp: { added: boolean; command: string } | null };
type Act = (fn: () => Promise<unknown>) => Promise<void>;

const sourceFor = (x: LibraryConnector, live: Live) => (x.source ? live.sources.find((s) => s.id === x.source) ?? null : null);
const isConnected = (x: LibraryConnector, live: Live) =>
  x.kind === 'mcp-source' ? !!sourceFor(x, live)?.connected : x.id === 'apple-calendar' ? !!live.cal?.enabled && live.cal.status === 'granted' : x.id === 'claude-code' ? !!live.mcp?.added : false;
const connectionType = (x: LibraryConnector) =>
  x.kind === 'mcp-source' ? `${x.name} account, over its MCP server (OAuth)` : x.kind === 'macos' ? 'Permission on this Mac' : x.kind === 'quorum-mcp' ? `The quorum MCP server, registered in ${x.name}` : `${x.name} account (OAuth)`;

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
export function ConnectorsPage({ detail, onDetail }: { detail: string | null; onDetail: (id: string | null) => void }) {
  const [live, setLive] = useState<Live>({ sources: [], cal: null, mcp: null });
  const [icons, setIcons] = useState<Record<string, string | null>>({});
  const [library, setLibrary] = useState(false);
  const load = async () => {
    const [sources, cal, mcp] = await Promise.all([window.quorum.sourcesList(), window.quorum.calendarStatus(), window.quorum.mcpStatus()]);
    setLive({ sources, cal, mcp });
  };
  useEffect(() => {
    load();
    window.quorum.libraryIcons().then(setIcons);
    return window.quorum.onSourceJob((job) => setLive((l) => ({ ...l, sources: l.sources.map((s) => (s.id === job.id ? { ...s, job } : s)) })));
  }, []);
  useEffect(() => {
    // a finished job changes counts and the last-sync time, which only the full list carries
    if (live.sources.some((s) => s.job && s.job.status !== 'running' && s.job.finishedAt && Date.now() - s.job.finishedAt < 2000)) { const t = setTimeout(load, 500); return () => clearTimeout(t); }
  }, [live.sources]);
  const lastRefused = useRef<{ id: string; error: string } | null>(null);
  const openDetail = (id: string) => { setLibrary(false); onDetail(id); };
  if (detail && CONNECTOR_BY_ID[detail]) return <ConnectorDetail connector={CONNECTOR_BY_ID[detail]} icon={icons[detail] ?? null} live={live} onChange={load} initialError={lastRefused.current?.id === detail ? lastRefused.current.error : ''} />;
  const connected = CONNECTORS.filter((x) => isConnected(x, live));
  const groups = CATEGORIES.map((cat) => ({ cat, items: connected.filter((x) => x.category === cat.id) })).filter((g) => g.items.length);
  return (
    <>
      <div className="set-head">
        <h3>Your connectors</h3>
        <span className="set-head-actions"><button className="pill primary with-icon" onClick={() => setLibrary(true)}><IconPlus width={15} height={15} />Add connector</button></span>
      </div>
      {groups.length === 0 ? (
        <div className="set-card set-zero">
          <span className="set-zero-icon"><IconGrid width={22} height={22} /></span>
          <strong>No connectors yet</strong>
          <p>Connect the tools that record your meetings, your calendar, and the AI tools you work in. Notes flow into your folder, tagged with where they came from.</p>
          <button className="pill" onClick={() => setLibrary(true)}>Browse the library</button>
        </div>
      ) : groups.map(({ cat, items }) => (
        <div key={cat.id} className="conn-group">
          <h4>{cat.name}</h4>
          <div className="set-card conn-card">
            {items.map((x) => <ConnectedRow key={x.id} connector={x} icon={icons[x.id] ?? null} live={live} onChange={load} onOpen={() => openDetail(x.id)} />)}
          </div>
        </div>
      ))}
      {library && <Library icons={icons} live={live} onChange={load} onOpen={openDetail} onClose={() => setLibrary(false)} lastRefused={lastRefused} />}
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
  if (x.id === 'claude-code') return 'quorum MCP server added';
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
            {x.id === 'claude-code' && <button role="menuitem" className="danger" onClick={() => { setOpen(false); act(() => window.quorum.mcpRemove()); }}>Remove from Claude Code</button>}
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
  const src = sourceFor(x, live);
  const on = isConnected(x, live);
  const soon = x.status === 'soon';
  const running = src?.job?.status === 'running';
  const [, tick] = useState(0);
  useEffect(() => { if (!running) return; const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, [running]);
  const cat = CATEGORIES.find((c) => c.id === x.category);
  const status = soon ? 'Soon' : on ? 'Connected' : x.id === 'apple-calendar' && live.cal?.status === 'denied' ? 'Access is off in System Settings' : 'Not connected';
  // one message for the page: the latest action's error wins, else the last failed import
  const alert = error || (src?.job?.status === 'failed' ? src.job.error : null) || null;
  const accountProblem = !!alert && /account for this sign-in|different account/i.test(alert);
  const rows: [string, ReactNode][] = [
    ['Status', <span className={on ? 'conn-ok' : undefined}>{on && <i />}{status}</span>],
    ['Category', cat?.name ?? x.category],
    ['Connection', connectionType(x)],
  ];
  if (x.kind === 'mcp-source' && src) {
    rows.push(
      ['Method', src.method === 'connect' ? 'Connected account' : 'Folder of notes'],
      ['Notes in Quorum', String(src.notes)],
      ['Imported by this connection', String(src.imported)],
      ['Last sync', src.lastSyncAt ? `${ago(src.lastSyncAt)} (${new Date(src.lastSyncAt).toLocaleString()})` : 'never'],
      ['Sync', 'Every 30 minutes while Quorum runs, plus Sync now'],
      ['Notes folder', src.folderPath ? <button className="link-btn plain" onClick={() => window.quorum.meetingSourceOpen(src.folderPath!)}>{src.folderPath.replace(/^\/Users\/[^/]+/, '~')}</button> : 'Pick a meeting notes folder in Settings › Memory'],
      ['Server', src.url],
    );
  }
  if (x.id === 'apple-calendar') rows.push(['Permission', live.cal?.status ?? 'unknown'], ['Reads', 'The calendars in the Calendar app on this Mac; nothing leaves this Mac']);
  if (x.id === 'claude-code' && live.mcp) rows.push(['Registered with', <code>{live.mcp.command}</code>]);
  rows.push(['Website', <button className="link-btn plain" onClick={() => window.quorum.openExternal(`https://${x.domain}`)}>{x.domain}<IconExternal width={13} height={13} /></button>]);
  return (
    <div className="conn-detail">
      <div className="conn-detail-head">
        <Logo icon={icon} size={44} />
        <div className="conn-detail-title">
          <h3>{x.name}{soon && <em className="soon grey">Soon</em>}{on && <span className="conn-ok"><i />Connected</span>}</h3>
          <p>{x.description}</p>
        </div>
        <div className="conn-detail-actions">
          {!soon && !on && <ConnectButton connector={x} live={live} busy={busy} act={act} />}
          {on && <Actions connector={x} live={live} busy={busy} act={act} />}
        </div>
      </div>
      {alert && <div className="conn-alert" role="alert"><strong>{accountProblem ? 'Sign in with a different account' : 'Something went wrong'}</strong><span>{alert}</span></div>}
      <h4>Connectivity</h4>
      <div className="set-card conn-jobcard">
        {accountProblem && !on && x.kind === 'mcp-source'
          ? <DifferentAccount connector={x} busy={busy} act={act} />
          : src?.job && src.job.status !== 'failed'
            ? <JobLine job={src.job} />
            : <p className="src-status">{on ? (src ? `Last sync ${ago(src.lastSyncAt)}. Next automatic sync within 30 minutes while Quorum runs.` : 'Connected on this Mac.') : soon ? 'Not available yet.' : 'Not connected yet.'}</p>}
      </div>
      <h4>Details</h4>
      <div className="set-card conn-table">
        {rows.map(([k, v]) => <div key={k} className="conn-kv"><span>{k}</span><span>{v}</span></div>)}
      </div>
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
  return { error: 'Not available yet.' };
};
const connectLabel = (x: LibraryConnector, busy: boolean, full: boolean) =>
  busy ? (x.kind === 'mcp-source' ? 'Finish in your browser…' : x.kind === 'macos' ? 'Waiting for macOS…' : 'Adding…') : x.kind === 'macos' ? 'Allow' : x.kind === 'quorum-mcp' ? 'Add' : full ? `Connect ${x.name}` : 'Connect';

function ConnectButton({ connector: x, live, busy, act }: { connector: LibraryConnector; live: Live; busy: boolean; act: Act }) {
  if (x.id === 'apple-calendar' && live.cal?.status === 'denied') return <button className="pill" onClick={() => window.quorum.calendarPrivacy()}>Open System Settings</button>;
  const fresh = x.kind === 'mcp-source' && !!sourceFor(x, live)?.freshNext;
  return <button className="pill primary" disabled={busy} onClick={() => act(() => startConnect(x, fresh))}>{busy ? connectLabel(x, true, true) : fresh ? 'Connect with a different account' : connectLabel(x, false, true)}</button>;
}

// the wrong account got connected: a sign-in in a private window, so the browser's session cannot answer for you
function DifferentAccount({ connector: x, busy, act }: { connector: LibraryConnector; busy: boolean; act: Act }) {
  const [link, setLink] = useState<{ url: string; opened: 'window' | null } | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => window.quorum.onSourceAuthLink((e) => { if (e.id === x.source) setLink({ url: e.url, opened: e.opened }); }), [x.source]);
  const start = () => { setLink(null); act(async () => { await window.quorum.sourceDisconnect(x.source!); return startConnect(x, true); }).then(() => setLink(null)); };
  return (
    <div className="conn-alt">
      <button className="pill" disabled={busy} onClick={start}>{busy ? 'Waiting for the sign-in…' : 'Connect with a different account'}</button>
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
function Library({ icons, live, onChange, onOpen, onClose, lastRefused }: { icons: Record<string, string | null>; live: Live; onChange: () => Promise<void>; onOpen: (id: string) => void; onClose: () => void; lastRefused: React.MutableRefObject<{ id: string; error: string } | null> }) {
  const [cat, setCat] = useState<string>('all');
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
