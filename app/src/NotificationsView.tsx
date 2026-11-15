import { useCallback, useEffect, useRef, useState } from 'react';
import markProd from '../assets/quorum-mark.png';
import { IconBell, IconSearch } from './icons';
import type { FeedKind, FeedPage, FeedRow, FeedTab } from './quorum';

const PAGE = 50;
const TABS: [FeedTab, string][] = [['review', 'Needs review'], ['unread', 'Unread'], ['all', 'All']];
// the event types the filter offers, the same list as activityFeed.js
const KINDS: [FeedKind, string][] = [
  ['note-written', 'Wrote a note'], ['note-updated', 'Updated a note'], ['filed', 'Filed and linked'], ['referenced', 'Referenced'],
  ['memory-created', 'Created a memory'], ['memory-updated', 'Updated a memory'], ['imported', 'Imported'], ['you', 'Your changes'],
];
const CHANGED = 'quorum:activity-changed';

const ago = (at: number) => {
  const s = Math.max(0, (Date.now() - at) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' });
};

// runs fn now and again whenever the activity may have changed: upkeep finished, a memory changed, a file in the vault
// changed, the Notifications switches changed, a note or memory was opened, or this view acted on a row. Once a
// minute as well, so relative times and late writes catch up
function useActivityRefresh(fn: () => void) {
  const ref = useRef(fn);
  useEffect(() => { ref.current = fn; });
  useEffect(() => {
    const go = () => ref.current();
    go();
    const offs = [window.quorum.onKeeper?.(go), window.quorum.onMemoryUpdates?.(go), window.quorum.onVaultChanged?.(go), window.quorum.onSettings?.(go)];
    window.addEventListener(CHANGED, go);
    window.addEventListener('quorum:memory-seen', go);
    const t = window.setInterval(go, 60000);
    return () => { offs.forEach((off) => off?.()); window.removeEventListener(CHANGED, go); window.removeEventListener('quorum:memory-seen', go); window.clearInterval(t); };
  }, []);
}

// the bell in the header, left of the avatar. Its blue dot shows while anything is unread or waits for review, for
// the kinds switched on in Settings > Notifications
export function NotificationBell({ active, onOpen }: { active: boolean; onOpen: () => void }) {
  const [dot, setDot] = useState(false);
  const [counts, setCounts] = useState({ review: 0, unread: 0 });
  useActivityRefresh(() => { window.quorum.activityFeed({ tab: 'all', limit: 0 }).then((p) => { setDot(p.dot); setCounts(p.counts); }).catch(() => {}); });
  const label = dot ? `Notifications, ${counts.review} to review, ${counts.unread} unread` : 'Notifications';
  return (
    <button className={`icon-btn bell-btn${active ? ' active' : ''}`} aria-label={label} data-tip="Notifications" onClick={onOpen}>
      <IconBell width={18} height={18} />{dot && <i className="tab-dot" aria-hidden="true" />}
    </button>
  );
}

// Notifications: everything Quorum's agents did across the vault (notes they wrote, updated, filed and linked or
// referenced, memories they created and updated, imports) and the person's own changes, newest first. Needs review
// holds the notes Quorum wrote and the memory updates waiting for approval; each can be approved or disapproved, one
// at a time or several at once. Opening a row's note or memory marks that file read
export function NotificationsView({ onOpenNote }: { onOpenNote: (abs: string) => void }) {
  const [tab, setTab] = useState<FeedTab>('review');
  const [kinds, setKinds] = useState<FeedKind[]>([]);
  const [q, setQ] = useState('');
  const [page, setPage] = useState<FeedPage | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = useRef(PAGE);
  const query = useRef({ tab, kinds, q });
  useEffect(() => { query.current = { tab, kinds, q }; });

  // the rows already on screen are read again together, so a refresh keeps the place in a long list
  const load = useCallback(() => {
    const cur = query.current;
    window.quorum.activityFeed({ ...cur, offset: 0, limit: shown.current }).then((p) => {
      if (JSON.stringify(query.current) !== JSON.stringify(cur)) return;
      setPage(p);
      setPicked((s) => new Set([...s].filter((id) => p.items.some((r) => r.id === id))));
    }).catch(() => {});
  }, []);
  useActivityRefresh(load);
  // a new tab, filter or search starts again at the first page; picks not in the new list drop out when it loads
  useEffect(() => { shown.current = PAGE; const t = window.setTimeout(load, q ? 150 : 0); return () => window.clearTimeout(t); }, [tab, kinds, q, load]);
  const more = () => { shown.current += PAGE; load(); };
  const changed = () => window.dispatchEvent(new Event(CHANGED));

  const items = page?.items ?? [];
  const byId = new Map(items.map((r) => [r.id, r]));
  const sel = [...picked].map((id) => byId.get(id)).filter((r): r is FeedRow => !!r);
  const selReview = sel.filter((r) => r.review);
  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allOn = items.length > 0 && items.every((r) => picked.has(r.id));

  const markRead = async (rows: FeedRow[]) => {
    const files = [...new Set(rows.filter((r) => r.unread).map((r) => r.target.abs))];
    if (!files.length) return;
    await window.quorum.activityRead(files).catch(() => 0);
    changed();
  };
  const open = (r: FeedRow, abs = r.target.abs, kind = r.target.kind) => {
    markRead([r]);
    if (kind === 'note') onOpenNote(abs);
    else window.dispatchEvent(new CustomEvent('quorum:open-memory', { detail: abs }));
  };
  const decide = async (rows: FeedRow[], verdict: 'approve' | 'reject') => {
    const list = rows.filter((r) => r.review).map((r) => ({ kind: r.review!.kind, abs: r.target.abs }));
    if (!list.length) return;
    setBusy(true);
    setError(null);
    try {
      const r = await window.quorum.activityReview(list, verdict);
      if (r.failed.length) setError(`${r.failed.length} of ${list.length} could not be ${verdict === 'approve' ? 'approved' : 'disapproved'}: ${r.failed[0].error}`);
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
    setPicked(new Set());
    changed();
  };

  const counts = page?.counts;
  const empty = tab === 'review' ? 'Nothing waits for your review. Notes Quorum writes and memory updates waiting for approval show up here.'
    : tab === 'unread' ? 'You are all caught up. New agent activity shows up here.'
      : 'No activity yet. Quorum lists what its agents do with your notes and memories here.';

  return (
    <div className="set-col notif-page">
      <h1>Notifications</h1>
      <div className="nf-bar">
        <div className="seg" role="tablist" aria-label="Show">
          {TABS.map(([id, label]) => {
            const n = id === 'review' ? counts?.review : id === 'unread' ? counts?.unread : 0;
            return <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{label}{n ? <span className="nf-count">{n}</span> : null}</button>;
          })}
        </div>
        <label className="nf-search">
          <IconSearch width={15} height={15} />
          <input value={q} placeholder="Search notifications" aria-label="Search notifications" onChange={(e) => setQ(e.target.value)} />
        </label>
      </div>
      <div className="nf-kinds" role="group" aria-label="Type of event">
        {KINDS.map(([id, label]) => {
          const on = kinds.includes(id);
          return <button key={id} className={`nf-kind${on ? ' on' : ''}`} aria-pressed={on} onClick={() => setKinds((k) => (on ? k.filter((x) => x !== id) : [...k, id]))}>{label}</button>;
        })}
        {kinds.length > 0 && <button className="text-btn" onClick={() => setKinds([])}>Clear</button>}
      </div>
      {items.length > 0 && (
        <div className="nf-bulk">
          <label className="nf-check"><input type="checkbox" checked={allOn} aria-label="Select all" onChange={() => setPicked(allOn ? new Set() : new Set(items.map((r) => r.id)))} /></label>
          <span className="muted">{sel.length ? `${sel.length} selected` : 'Select rows to act on several at once'}</span>
          <span className="nf-bulk-actions">
            <button className="act-pill primary" disabled={busy || !selReview.length} onClick={() => decide(selReview, 'approve')}>Approve</button>
            <button className="act-pill" disabled={busy || !selReview.length} data-tip="Memory updates go back to the text from before them; a note Quorum wrote is marked rejected" onClick={() => decide(selReview, 'reject')}>Disapprove</button>
            <button className="act-pill" disabled={busy || !sel.some((r) => r.unread)} onClick={async () => { await markRead(sel); setPicked(new Set()); }}>Mark read</button>
          </span>
        </div>
      )}
      {error && <p className="nf-error" role="alert">{error}</p>}
      <ol className="nn-list nf-list">
        {items.map((r) => (
          <li key={r.id} className={`nn-row nf-row${r.unread ? ' unread' : ''}`}>
            <label className="nf-check"><input type="checkbox" checked={picked.has(r.id)} aria-label="Select" onChange={() => toggle(r.id)} /></label>
            <span className="nn-who">{r.who === 'you' ? <span className="nn-you" aria-label="You">You</span> : <img src={markProd} alt="Quorum" width={22} height={22} />}</span>
            <span className="nn-body">
              <span className="nn-text">{r.text}</span>
              <span className="aa-files">
                {r.target.gone ? <span className="muted">{r.target.label} (removed)</span>
                  : <button className="keeper-link" data-tip={r.target.rel} onClick={() => open(r)}>{r.target.label}</button>}
                {r.files.map((f) => <button key={f.abs} className="keeper-link" data-tip={f.rel} onClick={() => open(r, f.abs, 'memory')}>{f.label}</button>)}
              </span>
              <span className="nn-when" title={new Date(r.at).toLocaleString()}>{ago(r.at)}</span>
            </span>
            {r.review && (
              <span className="nf-actions">
                <button className="act-pill primary" disabled={busy} onClick={() => decide([r], 'approve')}>Approve</button>
                <button className="act-pill" disabled={busy} data-tip={r.review.kind === 'memory' ? 'Put back the text from before these updates' : 'Mark this note rejected'} onClick={() => decide([r], 'reject')}>Disapprove</button>
              </span>
            )}
          </li>
        ))}
      </ol>
      {page && !items.length && <p className="muted nf-empty">{q || kinds.length ? 'No notifications match these filters.' : empty}</p>}
      {page?.more && <button className="act-pill nf-more" onClick={more}>Show more</button>}
    </div>
  );
}
