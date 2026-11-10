import { useEffect, useMemo, useState } from 'react';
import type { CalendarSettings, MeetingSourceInfo, SourceJob } from './quorum';
import { CATEGORIES, CONNECTORS, type LibraryConnector } from '../connectors/library';
import { useMenu } from './controls';
import { IconCheck, IconClose, IconExternal, IconGrid, IconMore, IconPlus } from './icons';

// Settings › Connectors: the tools Quorum is connected to, grouped by what they do, and the library behind Add
// connector where every tool Quorum supports or plans to is listed. Anything not built yet is shown subdued with a
// Coming soon badge and offers nothing to click. Meeting-notes sources run through sources/index.js; the Calendar
// connector is the macOS permission; Claude Code is the quorum MCP server registration.
type Live = { sources: MeetingSourceInfo[]; cal: CalendarSettings | null; mcp: { added: boolean } | null };

const sourceFor = (x: LibraryConnector, live: Live) => (x.source ? live.sources.find((s) => s.id === x.source) ?? null : null);
const isConnected = (x: LibraryConnector, live: Live) =>
  x.kind === 'mcp-source' ? !!sourceFor(x, live)?.connected : x.id === 'apple-calendar' ? !!live.cal?.enabled && live.cal.status === 'granted' : x.id === 'claude-code' ? !!live.mcp?.added : false;

export function ConnectorsPage() {
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
          <div className="set-card">
            {items.map((x) => <ConnectedRow key={x.id} connector={x} icon={icons[x.id] ?? null} live={live} onChange={load} />)}
          </div>
        </div>
      ))}
      {library && <Library icons={icons} live={live} onChange={load} onClose={() => setLibrary(false)} />}
    </>
  );
}

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

function Logo({ icon, size = 28 }: { icon: string | null; size?: number }) {
  return icon ? <img className="conn-logo" src={icon} alt="" style={{ width: size, height: size }} /> : <span className="conn-logo blank" style={{ width: size, height: size }}><IconGrid width={14} height={14} /></span>;
}

function ConnectedRow({ connector: x, icon, live, onChange }: { connector: LibraryConnector; icon: string | null; live: Live; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useMenu();
  const src = sourceFor(x, live);
  const running = src?.job?.status === 'running';
  const [, tick] = useState(0);
  useEffect(() => { if (!running) return; const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, [running]);
  const act = async (fn: () => Promise<{ ok?: boolean; error?: string } | unknown>) => { setBusy(true); setError(''); const r = (await fn()) as { error?: string } | null; setBusy(false); if (r && r.error) setError(r.error); else onChange(); };
  const desc = x.kind === 'mcp-source' && src
    ? (running ? null : `${src.notes} ${src.notes === 1 ? 'note' : 'notes'} · synced ${ago(src.lastSyncAt)}`)
    : x.id === 'apple-calendar' ? 'Upcoming meetings show on Home' : x.id === 'claude-code' ? 'The quorum MCP server is in Claude Code' : x.description;
  return (
    <div className="conn-row">
      <div className="set-line conn-line">
        <div className="conn-id"><Logo icon={icon} /><div className="set-label"><strong>{x.name}</strong>{desc && <span>{desc}</span>}</div></div>
        <div className="set-line-end">
          {x.kind === 'mcp-source' && src && <button className="pill small-pill" disabled={busy || running} onClick={() => act(() => window.quorum.sourceSync(src.id))}>{running ? 'Syncing…' : 'Sync now'}</button>}
          <span className="menu-wrap" onClick={(e) => e.stopPropagation()}>
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
        </div>
      </div>
      {src?.job && <JobLine job={src.job} />}
      {error && <p className="set-error">{error}</p>}
    </div>
  );
}

function JobLine({ job }: { job: SourceJob }) {
  if (job.status === 'running') {
    const pct = job.total ? Math.round((job.done / job.total) * 100) : null;
    return (
      <div className="src-progress" aria-live="polite">
        <div className="src-progress-text"><span>{job.message ?? job.label}{job.total ? ` · ${job.done} of ${job.total}` : ''}</span><span>{elapsed(job.startedAt)}</span></div>
        <div className="src-bar"><div className={`src-bar-fill${pct === null ? ' indeterminate' : ''}`} style={pct === null ? undefined : { width: `${pct}%` }} /></div>
        <p className="src-note">You can leave this page. The row updates when the import finishes.</p>
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

// the library sheet: categories down the left, a search box, and a tile per connector
function Library({ icons, live, onChange, onClose }: { icons: Record<string, string | null>; live: Live; onChange: () => Promise<void>; onClose: () => void }) {
  const [cat, setCat] = useState<string>('all');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<Record<string, string>>({});
  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return CONNECTORS.filter((x) => (cat === 'all' || x.category === cat) && (!needle || x.name.toLowerCase().includes(needle) || x.description.toLowerCase().includes(needle)));
  }, [cat, q]);
  const connect = async (x: LibraryConnector) => {
    setBusy(x.id); setError((e) => ({ ...e, [x.id]: '' }));
    let r: { ok?: boolean; error?: string; added?: boolean } = {};
    if (x.kind === 'mcp-source' && x.source) r = await window.quorum.sourceConnect(x.source);
    else if (x.id === 'apple-calendar') { const c = await window.quorum.calendarConnect(); r = c.status === 'granted' ? { ok: true } : c.status === 'denied' ? { error: 'Calendar access is off for Quorum in System Settings.' } : { error: 'macOS did not grant calendar access.' }; }
    else if (x.id === 'claude-code') { const a = await window.quorum.mcpAdd(); r = a.added ? { ok: true } : { error: a.error ?? 'Claude Code did not accept the server.' }; }
    setBusy(null);
    if (r.error) { setError((e) => ({ ...e, [x.id]: r.error! })); return; }
    await onChange();
  };
  const counts = useMemo(() => Object.fromEntries(CATEGORIES.map((c) => [c.id, CONNECTORS.filter((x) => x.category === c.id).length])), []);
  return (
    <div className="palette-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
      <div className="modal lib-modal" role="dialog" aria-modal="true" aria-labelledby="lib-title">
        <div className="lib-head">
          <div><h2 id="lib-title">Add a connector</h2><p>Everything Quorum connects to. Tools marked Coming soon are on the way.</p></div>
          <button className="icon-btn" aria-label="Close" onClick={onClose}><IconClose width={16} height={16} /></button>
        </div>
        <div className="lib-body">
          <nav className="lib-nav" aria-label="Connector categories">
            <button className={cat === 'all' ? 'on' : ''} onClick={() => setCat('all')}>All<em>{CONNECTORS.length}</em></button>
            {CATEGORIES.map((c) => <button key={c.id} className={cat === c.id ? 'on' : ''} onClick={() => setCat(c.id)}>{c.name}<em>{counts[c.id]}</em></button>)}
          </nav>
          <div className="lib-main">
            <input className="lib-search" type="search" placeholder="Search connectors" aria-label="Search connectors" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
            {cat !== 'all' && <p className="lib-blurb">{CATEGORIES.find((c) => c.id === cat)?.blurb}</p>}
            <div className="lib-grid">
              {items.map((x) => {
                const on = isConnected(x, live);
                const soon = x.status === 'soon';
                return (
                  <div key={x.id} className={`lib-tile${soon ? ' soon' : ''}${on ? ' on' : ''}`}>
                    <div className="lib-tile-head"><Logo icon={icons[x.id] ?? null} size={32} />{soon && <em className="soon">Coming soon</em>}{on && <span className="lib-on"><IconCheck width={13} height={13} />Connected</span>}</div>
                    <strong>{x.name}</strong>
                    <span>{x.description}</span>
                    {!soon && !on && (
                      <button className="pill small-pill primary" disabled={busy !== null} onClick={() => connect(x)}>
                        {busy === x.id ? (x.kind === 'mcp-source' ? 'Finish in your browser…' : x.kind === 'macos' ? 'Waiting for macOS…' : 'Adding…') : x.kind === 'macos' ? 'Allow' : x.kind === 'quorum-mcp' ? 'Add' : 'Connect'}
                      </button>
                    )}
                    {error[x.id] && <p className="set-error">{error[x.id]}</p>}
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
