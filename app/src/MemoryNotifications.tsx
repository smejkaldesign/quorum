import { useEffect, useState } from 'react';
import markProd from '../assets/quorum-mark.png';
import { IconBell } from './icons';
import type { MemoryVersion } from './quorum';

const ago = (iso: string | number) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
};
// a version written by the person is theirs; everything else (the keeper, an agent, an import, the CLI) is Quorum's
const byYou = (v: MemoryVersion) => v.who === 'you' || v.who === 'human';
const textOf = (v: MemoryVersion) => {
  const why = v.reason ? `: ${v.reason}` : '';
  if (byYou(v)) return `You ${v.created ? 'created it' : v.removed ? 'deleted it' : 'edited it'}${why}`;
  if (v.who === 'import') return `Imported${why}`;
  return `Agent ${v.created ? 'created it' : v.removed ? 'removed it' : 'updated it'}${why}`;
};

// a memory's changes and when Notifications were last opened, read again whenever the vault changes
function useMemoryActivity(rel: string) {
  const [versions, setVersions] = useState<MemoryVersion[]>([]);
  const [seenAt, setSeenAt] = useState<string | null>(null);
  const [n, setN] = useState(0);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let live = true;
    Promise.all([window.quorum.memoryVersions(rel).catch(() => []), window.quorum.memorySeen(rel, false).catch(() => null)])
      .then(([v, s]) => { if (live) { setVersions(v); setSeenAt(s); setLoaded(true); } });
    const off = window.quorum.onVaultChanged?.(() => setN((x) => x + 1));
    // the bell and the list read the same mark: one opening the list tells the other
    const seen = () => setN((x) => x + 1);
    window.addEventListener('quorum:memory-seen', seen);
    return () => { live = false; off?.(); window.removeEventListener('quorum:memory-seen', seen); };
  }, [rel, n]);
  const since = seenAt ? new Date(seenAt).getTime() : 0;
  const unseen = versions.filter((v) => !byYou(v) && new Date(v.at).getTime() > since).length;
  return { loaded, versions, seenAt, unseen, markSeen: () => window.quorum.memorySeen(rel, true).then((s) => { setSeenAt(s); window.dispatchEvent(new Event('quorum:memory-seen')); }).catch(() => {}) };
}

// the bell among a memory's details: a blue dot when Quorum changed it since Notifications were last opened
export function MemoryBell({ rel, open, onToggle }: { rel: string; open: boolean; onToggle: () => void }) {
  const { unseen } = useMemoryActivity(rel);
  return (
    <button className={`meta-pill meta-icon tab-bell${open ? ' on' : ''}`} aria-pressed={open} aria-label={unseen ? `Notifications, ${unseen} new` : 'Notifications'} data-tip="Notifications" onClick={onToggle}>
      <IconBell width={17} height={17} />{unseen > 0 && <i className="tab-dot" aria-hidden="true" />}
    </button>
  );
}

// A memory's Notifications: every change to it, newest first, with who made it and why (the keeper filing a meeting
// into it, an agent's edit, an import, the person's own edits). Opening it marks it seen; what was new keeps its dot
export function MemoryNotifications({ rel }: { rel: string; abs: string }) {
  const { loaded, versions, seenAt, markSeen } = useMemoryActivity(rel);
  // the last time it was opened, kept from before this opening so what was new keeps its dot
  const [before, setBefore] = useState<string | null | undefined>(undefined);
  useEffect(() => { if (loaded && before === undefined) { setBefore(seenAt); markSeen(); } }, [loaded]); // eslint-disable-line react-hooks/exhaustive-deps
  const since = before ? new Date(before).getTime() : 0;
  return (
    <section className="note-notifs" aria-label="Notifications">
      <ol className="nn-list">
        {versions.map((v) => (
          <li key={v.id} className={`nn-row${!byYou(v) && new Date(v.at).getTime() > since ? ' unread' : ''}`}>
            <span className="nn-who">{byYou(v) ? <span className="nn-you" aria-label="You">You</span> : <img src={markProd} alt="Quorum" width={22} height={22} />}</span>
            <span className="nn-body"><span className="nn-text">{textOf(v)}</span><span className="nn-when" title={new Date(v.at).toLocaleString()}>{ago(v.at)}</span></span>
          </li>
        ))}
      </ol>
      {!versions.length && <p className="muted">No changes recorded yet. Quorum lists every change to this memory here, with who made it and why.</p>}
    </section>
  );
}
