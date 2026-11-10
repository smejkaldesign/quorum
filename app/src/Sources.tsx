import { useEffect, useState } from 'react';
import type { MeetingSourceInfo, SourceJob } from './quorum';
import { useMenu } from './controls';
import { IconCheck, IconExternal, IconFolder, IconMore } from './icons';

// Settings › Sources: the tools that already record your meetings. One card per source, one active method per card.
// Connect is recommended and says why; Folder points Quorum at notes the other app already writes. Imports run in the
// background and the card keeps showing progress, so leaving the page is fine.
export function SourcesPage() {
  const [sources, setSources] = useState<MeetingSourceInfo[] | null>(null);
  const [icons, setIcons] = useState<Record<string, string | null>>({});
  const load = () => window.quorum.sourcesList().then(setSources);
  useEffect(() => {
    load();
    window.quorum.sourceIcons().then(setIcons);
    return window.quorum.onSourceJob((job) => setSources((list) => list?.map((s) => (s.id === job.id ? { ...s, job } : s)) ?? list));
  }, []);
  useEffect(() => {
    // a finished job changes counts and the last-sync time, which only the full list carries
    if (sources?.some((s) => s.job && s.job.status !== 'running' && s.job.finishedAt && Date.now() - s.job.finishedAt < 2000)) { const t = setTimeout(load, 500); return () => clearTimeout(t); }
  }, [sources]);
  if (!sources) return null;
  return (
    <>
      <div className="set-head"><h3>Meeting sources</h3></div>
      {sources.map((s) => <SourceCard key={s.id} source={s} icon={icons[s.id] ?? null} onChange={load} />)}
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

function SourceCard({ source: s, icon, onChange }: { source: MeetingSourceInfo; icon: string | null; onChange: () => void }) {
  const [busy, setBusy] = useState<'connect' | 'sync' | 'disconnect' | null>(null);
  const [error, setError] = useState('');
  const [, tick] = useState(0);
  const [open, setOpen] = useMenu();
  const running = s.job?.status === 'running';
  useEffect(() => { if (!running) return; const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, [running]);
  const act = async (what: 'connect' | 'sync' | 'disconnect', fn: () => Promise<{ ok?: boolean; error?: string }>) => {
    setBusy(what); setError('');
    const r = await fn();
    setBusy(null);
    if (r.error) setError(r.error); else onChange();
  };
  const setMethod = async (method: 'connect' | 'folder') => { const r = await window.quorum.sourceSetMethod(s.id, method); if (r.error) setError(r.error); else onChange(); };
  const status = running ? null : s.connected ? `Connected · ${s.notes} ${s.notes === 1 ? 'note' : 'notes'} · synced ${ago(s.lastSyncAt)}` : s.notes ? `${s.notes} ${s.notes === 1 ? 'note' : 'notes'} in your folder · not connected` : 'Not connected';
  return (
    <div className="set-card src-card">
      <div className="set-line src-head">
        <div className="src-id">
          {icon ? <img className="set-app-icon" src={icon} alt="" /> : <IconFolder width={18} height={18} />}
          <div className="set-label"><strong>{s.name}</strong><span>{s.description}</span></div>
        </div>
        <div className="set-line-end">
          {s.connected
            ? <button className="pill small-pill" disabled={busy !== null || running} onClick={() => act('sync', () => window.quorum.sourceSync(s.id))}>{running ? 'Syncing…' : 'Sync now'}</button>
            : s.method === 'connect' && <button className="pill primary" disabled={busy !== null} onClick={() => act('connect', () => window.quorum.sourceConnect(s.id))}>{busy === 'connect' ? 'Finish in your browser…' : `Connect ${s.name}`}</button>}
          {(s.connected || s.folderPath) && (
            <span className="menu-wrap" onClick={(e) => e.stopPropagation()}>
              <button className="icon-btn" aria-label={`${s.name} options`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o: boolean) => !o)}><IconMore width={16} height={16} /></button>
              {open && (
                <div className="menu" role="menu">
                  {s.folderPath && <button role="menuitem" onClick={() => { setOpen(false); window.quorum.meetingSourceOpen(s.folderPath!); }}><IconExternal width={15} height={15} /> Show notes folder</button>}
                  {s.connected && <button role="menuitem" className="danger" onClick={() => { setOpen(false); act('disconnect', () => window.quorum.sourceDisconnect(s.id)); }}>Disconnect</button>}
                </div>
              )}
            </span>
          )}
        </div>
      </div>
      {busy === 'connect' && <p className="src-note">A browser window opened. Sign in to {s.name} there and approve Quorum. Your meetings start importing as soon as it lands.</p>}
      {!s.connected && (
        <div className="src-methods" role="radiogroup" aria-label={`How Quorum gets ${s.name} meetings`}>
          <label className={`src-method${s.method === 'connect' ? ' on' : ''}`}>
            <input type="radio" name={`${s.id}-method`} checked={s.method === 'connect'} onChange={() => setMethod('connect')} />
            <span className="src-method-body"><strong>Connect {s.name}{s.recommended === 'connect' && <em className="src-rec">Recommended</em>}</strong><span>Sign in to {s.name} once. {s.why} New meetings appear in your notes while Quorum runs.</span></span>
          </label>
          <label className={`src-method${s.method === 'folder' ? ' on' : ''}`}>
            <input type="radio" name={`${s.id}-method`} checked={s.method === 'folder'} onChange={() => setMethod('folder')} />
            <span className="src-method-body"><strong>Use a folder</strong><span>Point Quorum at notes {s.name} already writes to disk. Nothing is imported or changed. Add the folder under Settings › Memory.</span></span>
          </label>
        </div>
      )}
      {s.job && <JobLine job={s.job} />}
      {status && !s.job && <p className="src-status">{status}</p>}
      {status && s.job && s.job.status !== 'running' && <p className="src-status">{status}</p>}
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
        <p className="src-note">You can leave this page. The card updates when the import finishes.</p>
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
