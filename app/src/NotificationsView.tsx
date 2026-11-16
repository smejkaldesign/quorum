import { useCallback, useEffect, useRef, useState } from 'react';
import markProd from '../assets/quorum-mark.png';
import { IconBell, IconChevron, IconMore, IconSearch } from './icons';
import type { FeedKind, FeedPage, FeedRow, FeedSort, FeedTab } from './quorum';

const PAGE = 50;
const TABS: [FeedTab, string][] = [['all', 'All'], ['unread', 'Unread']];
// the event types the Type filter offers, the same list as activityFeed.js
const KINDS: [FeedKind, string][] = [
  ['note-written', 'Wrote a note'], ['note-updated', 'Updated a note'], ['filed', 'Filed and linked'], ['referenced', 'Referenced'],
  ['memory-created', 'Created a memory'], ['memory-updated', 'Updated a memory'], ['imported', 'Imported'], ['guardrail', 'Guardrail blocked'], ['you', 'Your changes'],
];
const KIND_LABEL = Object.fromEntries(KINDS) as Record<FeedKind, string>;
// Urgency is a future sort; it waits for a score per row (activityFeed.js)
const SORTS: [FeedSort, string][] = [['unread', 'Unread first'], ['recent', 'Recent'], ['az', 'A to Z']];
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

// the row's ⋯ menu: Open, Mark read or unread, and Approve and Disapprove on a row waiting for a decision. It closes on
// a click anywhere else or Escape
function RowMenu({ row, busy, onOpen, onMark, onDecide }: { row: FeedRow; busy: boolean; onOpen: () => void; onMark: (unread: boolean) => void; onDecide: (v: 'approve' | 'reject') => void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', key); };
  }, [open]);
  const pick = (fn: () => void) => () => { setOpen(false); fn(); };
  return (
    <span className={`menu-wrap nf-more${open ? ' open' : ''}`} ref={wrap}>
      <button className="icon-btn" aria-label="More" aria-haspopup="menu" aria-expanded={open} data-tip="More" onClick={() => setOpen((o) => !o)}><IconMore width={16} height={16} /></button>
      {open && (
        <div className="menu" role="menu">
          {!row.target.gone && <button role="menuitem" onClick={pick(onOpen)}>Open</button>}
          <button role="menuitem" onClick={pick(() => onMark(!row.unread))}>{row.unread ? 'Mark read' : 'Mark unread'}</button>
          {row.review && <button role="menuitem" disabled={busy} onClick={pick(() => onDecide('approve'))}>Approve</button>}
          {row.review && <button role="menuitem" disabled={busy} onClick={pick(() => onDecide('reject'))}>Disapprove</button>}
        </div>
      )}
    </span>
  );
}

// one notification, laid out like a connector row: the mark of who did it, the summary with its unread dot, the time
// at the top right, the actions, and a chevron that folds the row open to everything known about the event. A click
// anywhere else on the row opens its note, memory or the Guardrails page
function Row({ row, picked, busy, onPick, onOpen, onOpenFile, onMark, onDecide }: {
  row: FeedRow; picked: boolean; busy: boolean; onPick: () => void; onOpen: () => void; onOpenFile: (abs: string) => void; onMark: (unread: boolean) => void; onDecide: (v: 'approve' | 'reject') => void;
}) {
  const [open, setOpen] = useState(false);
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const go = () => { if (!row.target.gone) onOpen(); };
  return (
    <div className={`conn-row nf-row${row.unread ? ' unread' : ''}`}>
      <div className="conn-line nf-line" role="button" tabIndex={0} aria-label={row.summary.line} onClick={go} onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); go(); } }}>
        <label className="nf-check" onClick={stop}><input type="checkbox" checked={picked} aria-label="Select" onChange={onPick} /></label>
        <span className="nf-who">{row.who === 'you' ? <span className="nf-you" aria-label="You">You</span> : <img src={markProd} alt="Quorum" width={32} height={32} />}</span>
        <span className="nf-main">
          <span className="nf-head"><strong className="conn-title nf-title">{row.summary.line}</strong>{row.unread && <i className="nf-dot" role="img" aria-label="Unread" data-tip="Unread" />}</span>
          {row.summary.sub && <span className="nf-sub">{row.summary.sub}</span>}
        </span>
        <span className="nf-side">
          <span className="nf-when" title={new Date(row.at).toLocaleString()}>{ago(row.at)}</span>
          <span className="nf-tools" onClick={stop} onKeyDown={stop}>
            {row.review && (
              <>
                <button className={`act-pill${row.summary.ask?.suggest === 'approve' ? ' primary' : ''}`} disabled={busy} onClick={() => onDecide('approve')}>Approve</button>
                <button className={`act-pill${row.summary.ask?.suggest === 'reject' ? ' primary' : ''}`} disabled={busy} data-tip={row.review.kind === 'memory' ? 'Put back the text from before these updates' : 'Mark this note rejected'} onClick={() => onDecide('reject')}>Disapprove</button>
              </>
            )}
            <RowMenu row={row} busy={busy} onOpen={go} onMark={onMark} onDecide={onDecide} />
            <button className={`icon-btn conn-fold${open ? ' open' : ''}`} aria-expanded={open} aria-label={open ? 'Hide details' : 'Show details'} onClick={() => setOpen((o) => !o)}><IconChevron width={14} height={14} /></button>
          </span>
        </span>
      </div>
      {open && (
        <div className="conn-sub conn-fold-body nf-details">
          <dl>
            {row.details.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
            {row.files.length > 0 && (
              <div><dt>Linked memories</dt><dd className="aa-files">{row.files.map((f) => <button key={f.abs} className="keeper-link" data-tip={f.rel} onClick={() => onOpenFile(f.abs)}>{f.title ?? f.label}</button>)}</dd></div>
            )}
          </dl>
        </div>
      )}
    </div>
  );
}

// Notifications: everything Quorum's agents did across the vault (notes they wrote, updated, filed and linked or
// referenced, memories they created and updated, imports, each guardrail block) and the person's own changes. All and
// Unread are the tabs; Needs review narrows either to the items waiting for a decision. Type picks event types, each
// a chip to remove; Sort orders the list. Opening a row marks it read
export function NotificationsView({ onOpenNote, onOpenGuardrails }: { onOpenNote: (abs: string) => void; onOpenGuardrails: () => void }) {
  const [tab, setTab] = useState<FeedTab>('all');
  const [review, setReview] = useState(false);
  const [kinds, setKinds] = useState<FeedKind[]>([]);
  const [sort, setSort] = useState<FeedSort>('unread');
  const [q, setQ] = useState('');
  const [searching, setSearching] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const [page, setPage] = useState<FeedPage | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = useRef(PAGE);
  const query = useRef({ tab, review, kinds, sort, q });
  useEffect(() => { query.current = { tab, review, kinds, sort, q }; });

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
  // a new tab, filter, sort or search starts again at the first page; picks not in the new list drop out when it loads
  useEffect(() => { shown.current = PAGE; const t = window.setTimeout(load, q ? 150 : 0); return () => window.clearTimeout(t); }, [tab, review, kinds, sort, q, load]);
  const more = () => { shown.current += PAGE; load(); };
  const changed = () => window.dispatchEvent(new Event(CHANGED));

  const items = page?.items ?? [];
  const byId = new Map(items.map((r) => [r.id, r]));
  const sel = [...picked].map((id) => byId.get(id)).filter((r): r is FeedRow => !!r);
  const selReview = sel.filter((r) => r.review);
  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allOn = items.length > 0 && items.every((r) => picked.has(r.id));

  const mark = async (rows: FeedRow[], unread = false) => {
    const list = rows.filter((r) => r.unread !== unread).map((r) => ({ id: r.id, abs: r.target.abs }));
    if (!list.length) return;
    await window.quorum.activityMark(list, unread).catch(() => 0);
    changed();
  };
  const open = (r: FeedRow) => {
    mark([r]);
    if (r.target.kind === 'guardrail') onOpenGuardrails();
    else if (r.target.kind === 'note') onOpenNote(r.target.abs);
    else window.dispatchEvent(new CustomEvent('quorum:open-memory', { detail: r.target.abs }));
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
  const filtered = !!(q || kinds.length);
  const empty = filtered ? 'No notifications match these filters.'
    : review ? 'Nothing waits for your review. Notes Quorum writes and memory updates waiting for approval show up here.'
      : tab === 'unread' ? 'You are all caught up. New agent activity shows up here.'
        : 'No activity yet. Quorum lists what its agents do with your notes and memories here.';

  return (
    <div className="set-col notif-page">
      <h1>Notifications</h1>
      <div className="nf-bar">
        <div className="seg" role="tablist" aria-label="Show">
          {TABS.map(([id, label]) => {
            const n = id === 'unread' ? counts?.unread : 0;
            return <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{label}{n ? <span className="nf-count">{n}</span> : null}</button>;
          })}
        </div>
        <button className={`nf-toggle${review ? ' on' : ''}`} aria-pressed={review} onClick={() => setReview((r) => !r)}>
          Needs review{counts?.review ? <span className="nf-count">{counts.review}</span> : null}
        </button>
        <span className="nf-fill" />
        <button className={`icon-btn nf-search-btn${searching ? ' on' : ''}`} aria-label="Search notifications" aria-expanded={searching} data-tip="Search" onClick={() => { if (searching && !q) setSearching(false); else { setSearching(true); requestAnimationFrame(() => searchRef.current?.focus()); } }}><IconSearch width={16} height={16} /></button>
        <select className="nf-select" aria-label="Type" value="" onChange={(e) => { const k = e.target.value as FeedKind; if (k && !kinds.includes(k)) setKinds([...kinds, k]); }}>
          <option value="">Type</option>
          {KINDS.filter(([id]) => !kinds.includes(id)).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
        <select className="nf-select" aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value as FeedSort)}>
          {SORTS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
      </div>
      {/* search opens below the bar from its icon button, focused; the list filters as you type */}
      {(searching || !!q) && (
        <label className="nf-search">
          <IconSearch width={15} height={15} />
          <input ref={searchRef} value={q} placeholder="Search notifications" aria-label="Search notifications" onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') { setQ(''); setSearching(false); } }} />
        </label>
      )}
      {kinds.length > 0 && (
        <div className="nf-chips" aria-label="Type filters">
          {kinds.map((k) => (
            <span key={k} className="filter on nf-chip">{KIND_LABEL[k]}<button className="filter-x" aria-label={`Remove ${KIND_LABEL[k]}`} onClick={() => setKinds(kinds.filter((x) => x !== k))}>×</button></span>
          ))}
          {kinds.length > 1 && <button className="text-btn" onClick={() => setKinds([])}>Clear all</button>}
        </div>
      )}
      {items.length > 0 && (
        <div className="nf-bulk">
          <label className="nf-check"><input type="checkbox" checked={allOn} aria-label="Select all" onChange={() => setPicked(allOn ? new Set() : new Set(items.map((r) => r.id)))} /></label>
          <span className="muted">{sel.length ? `${sel.length} selected` : 'Select all'}</span>
          {/* the actions appear once something is picked; the bar keeps its height either way */}
          <span className={`nf-bulk-actions${sel.length ? '' : ' hidden'}`} aria-hidden={!sel.length}>
            <button className="act-pill primary" disabled={busy || !selReview.length} onClick={() => decide(selReview, 'approve')}>Approve</button>
            <button className="act-pill" disabled={busy || !selReview.length} data-tip="Memory updates go back to the text from before them; a note Quorum wrote is marked rejected" onClick={() => decide(selReview, 'reject')}>Disapprove</button>
            <button className="act-pill" disabled={busy || !sel.some((r) => r.unread)} onClick={async () => { await mark(sel); setPicked(new Set()); }}>Mark read</button>
          </span>
        </div>
      )}
      {error && <p className="nf-error" role="alert">{error}</p>}
      <div className="nf-list">
        {items.map((r) => (
          <Row key={r.id} row={r} picked={picked.has(r.id)} busy={busy} onPick={() => toggle(r.id)} onOpen={() => open(r)}
            onOpenFile={(abs) => { mark([r]); window.dispatchEvent(new CustomEvent('quorum:open-memory', { detail: abs })); }}
            onMark={(unread) => mark([r], unread)} onDecide={(v) => decide([r], v)} />
        ))}
      </div>
      {page && !items.length && <div className="nf-empty"><IconBell width={22} height={22} /><p>{empty}</p></div>}
      {page?.more && <button className="act-pill nf-more-btn" onClick={more}>Show more</button>}
    </div>
  );
}
