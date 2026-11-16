import { useCallback, useEffect, useRef, useState } from 'react';
import markProd from '../assets/quorum-mark.png';
import markReview from '../assets/quorum-mark-review.png';
import { IconArchive, IconBell, IconCheck, IconChevron, IconClose } from './icons';
import { PickMenu, SearchButton, SearchField } from './FilterBar';
import { Avatar } from './Speaker';
import type { FeedKind, FeedPage, FeedRow, FeedSort, FeedTab, FixRun } from './quorum';

const PAGE = 50;
const TABS: [FeedTab, string][] = [['all', 'All'], ['unread', 'Unread'], ['archived', 'Archived']];
// the event types the Type filter offers, the same list as activityFeed.js
const KINDS: [FeedKind, string][] = [
  ['note-written', 'Wrote a note'], ['note-updated', 'Updated a note'], ['filed', 'Filed and linked'], ['referenced', 'Referenced'],
  ['memory-created', 'Created a memory'], ['memory-updated', 'Updated a memory'], ['imported', 'Imported'], ['guardrail', 'Guardrail blocked'], ['memory-health', 'Memory health'], ['you', 'Your changes'],
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
    const offs = [window.quorum.onKeeper?.(go), window.quorum.onMemoryUpdates?.(go), window.quorum.onVaultChanged?.(go), window.quorum.onSettings?.(go), window.quorum.onFixRun?.(go)];
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
function Row({ row, me, picked, busy, onPick, onOpen, onOpenFile, onMark, onDecide, onArchive }: {
  row: FeedRow; me: { name: string; photo: string | null }; picked: boolean; busy: boolean; onPick: () => void; onOpen: () => void; onOpenFile: (abs: string) => void; onMark: (unread: boolean) => void; onDecide: (v: 'approve' | 'dismiss') => void; onArchive: (on: boolean) => void;
}) {
  // a fix run opens its details, so its progress and outcome are in view
  const [open, setOpen] = useState(!!row.run?.showBanner);
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const go = () => { if (!row.target.gone) onOpen(); };
  return (
    <div className={`conn-row nf-row${row.unread ? ' unread' : ''}${row.review || row.run ? ' mh-row' : ''}${row.run && (row.run.status === 'running' || row.run.status === 'queued') ? ' running' : ''}`}>
      <div className="conn-line nf-line" role="button" tabIndex={0} aria-label={row.summary.line} onClick={go} onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); go(); } }}>
        <label className="nf-check" onClick={stop}><input type="checkbox" checked={picked} aria-label="Select" onChange={onPick} /></label>
        {/* waiting for a decision shows the orange mark, Quorum's color for anything in review */}
        <span className="nf-who">{row.who === 'you' ? <span className="nf-you-avatar" aria-label="You" data-tip={me.name}><Avatar name={me.name} photo={me.photo} size={32} /></span> : <img src={row.review || row.run ? markReview : markProd} alt={row.review ? 'Quorum, needs review' : 'Quorum'} width={32} height={32} />}</span>
        <span className="nf-main">
          <span className="nf-head"><strong className="conn-title nf-title">{row.summary.line}</strong>{row.unread && <i className="nf-dot" role="img" aria-label="Unread" data-tip="Unread" />}</span>
          {!row.review && !row.run && <span className="nf-sub"><span className="nf-when" title={new Date(row.at).toLocaleString()}>{ago(row.at)}</span>{row.summary.sub && <> <span className="nf-sep" aria-hidden="true">•</span> {row.summary.sub}</>}</span>}
        </span>
        <span className={`nf-side${row.review || row.run ? ' mh-side' : ''}`}>
          {row.run && <span className="mh-swap"><span className="mh-when">{ago(row.at)}</span></span>}
          {/* a row waiting for a decision reads like a Memory health row: the date on the right, and on hover its
              answers slide in as icons */}
          {row.review && (
            <span className="mh-swap" onClick={stop} onKeyDown={stop}>
              <span className="mh-when" title={new Date(row.at).toLocaleString()}>{ago(row.at)}</span>
              <span className="mh-hover">
                <button className="icon-btn mh-icon mh-no" disabled={busy} aria-label="Dismiss" data-tip="Dismiss: mark it reviewed and change nothing" onClick={() => onDecide('dismiss')}><IconClose width={15} height={15} /></button>
                <button className="icon-btn mh-icon mh-yes" disabled={busy} aria-label="Approve" data-tip={`Approve: ${row.summary.recommendation ?? ''}`} onClick={() => onDecide('approve')}><IconCheck width={16} height={16} /></button>
              </span>
            </span>
          )}
          <span className="nf-tools" onClick={stop} onKeyDown={stop}>
            {!row.review && !row.run && (
              // the hover tools slide in from the right and back out, the way Home's row actions do
              <span className="nf-hover">
                {!row.archived && <button className="act-pill" disabled={busy} onClick={() => onMark(!row.unread)}>{row.unread ? 'Mark read' : 'Mark unread'}</button>}
                <button className="icon-btn nf-archive" disabled={busy} aria-label={row.archived ? 'Unarchive' : 'Archive'} data-tip={row.archived ? 'Unarchive' : 'Archive'} onClick={() => onArchive(!row.archived)}><IconArchive width={16} height={16} /></button>
              </span>
            )}
            <button className={`icon-btn conn-fold${open ? ' open' : ''}`} aria-expanded={open} aria-label={open ? 'Hide details' : 'Show details'} onClick={() => setOpen((o) => !o)}><IconChevron width={14} height={14} /></button>
          </span>
        </span>
      </div>
      {/* the details grow open and shut */}
      <div className={`fold-anim${open ? ' open' : ''}`} aria-hidden={!open}>
        <div className="fold-inner">
          <div className="conn-sub conn-fold-body nf-details">
            {row.run ? (
              <>
                {row.run.showBanner && <RunBanner run={row.run} />}
                <ReviewDetails recommendation={row.run.showBanner ? undefined : row.run.recommendation} problem={row.run.problem} solution={row.run.solution} value={row.run.value} meta={row.run.meta} />
              </>
            ) : row.review ? (
              <ReviewDetails recommendation={row.summary.recommendation} problem={row.summary.problem} solution={row.summary.solution} value={row.summary.value}
                meta={row.review.kind === 'link' ? row.details.filter(([k]) => k !== 'What' && k !== 'When' && k !== 'History') : row.details.filter(([k]) => k !== 'History')} />
            ) : (
              <dl>
                {row.details.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
                {row.files.length > 0 && (
                  <div><dt>Linked memories</dt><dd className="aa-files">{row.files.map((f) => <button key={f.abs} className="keeper-link" data-tip={f.rel} onClick={() => onOpenFile(f.abs)}>{f.title ?? f.label}</button>)}</dd></div>
                )}
              </dl>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// Notifications: everything Quorum's agents did across the vault (notes they wrote, updated, filed and linked or
// referenced, memories they created and updated, imports, each guardrail block) and the person's own changes. All and
// Unread are the tabs; Needs review narrows either to the items waiting for a decision. Type picks event types, each
// a chip to remove; Sort orders the list. Opening a row marks it read
// me: the person's name and photo, for the rows they made
export function NotificationsView({ me, onOpenNote, onOpenGuardrails }: { me: { name: string; photo: string | null }; onOpenNote: (abs: string) => void; onOpenGuardrails: () => void }) {
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
    else if (r.review?.kind === 'link') window.dispatchEvent(new CustomEvent('quorum:open-health', { detail: r.review.key }));
    else if (r.target.kind === 'note') onOpenNote(r.target.abs);
    else window.dispatchEvent(new CustomEvent('quorum:open-memory', { detail: r.target.abs }));
  };
  // Approve takes each row's recommendation (for a large memory rewrite that is putting back the earlier text);
  // Dismiss marks rows reviewed and changes nothing
  const decide = async (rows: FeedRow[], verdict: 'approve' | 'dismiss') => {
    const picked = rows.filter((r) => r.review);
    if (!picked.length) return;
    const groups = new Map<'approve' | 'revert' | 'dismiss', { kind: NonNullable<FeedRow['review']>['kind']; abs: string; key?: string }[]>();
    const fixes = picked.filter((r) => verdict === 'approve' && r.review!.kind === 'link').map((r) => r.review!.key!);
    if (fixes.length) await window.quorum.fixStart(fixes).catch(() => []);
    for (const r of picked) {
      if (verdict === 'approve' && r.review!.kind === 'link') continue;
      const v = verdict === 'dismiss' ? 'dismiss' : r.summary.ask?.suggest === 'reject' ? 'revert' : 'approve';
      groups.set(v, [...(groups.get(v) ?? []), { kind: r.review!.kind, abs: r.target.abs, key: r.review!.key }]);
    }
    const list = picked;
    setBusy(true);
    setError(null);
    try {
      const failed: { abs: string; error: string }[] = [];
      for (const [v, items] of groups) if (items.length) failed.push(...(await window.quorum.activityReview(items, v)).failed);
      if (failed.length) setError(`${failed.length} of ${list.length} could not be ${verdict === 'approve' ? 'approved' : 'dismissed'}: ${failed[0].error}`);
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
    setPicked(new Set());
    changed();
  };

  // archive or bring back rows; the list reloads so they leave this tab
  const archive = async (rows: FeedRow[], on: boolean) => {
    if (!rows.length) return;
    await window.quorum.activityArchive(rows.map((r) => ({ id: r.id })), on).catch(() => 0);
    changed();
  };

  const counts = page?.counts;
  const filtered = !!(q || kinds.length);
  const empty = filtered ? 'No notifications match these filters.'
    : review ? 'Nothing waits for your review. Notes Quorum writes, memory updates waiting for approval and Memory health issues show up here.'
      : tab === 'archived' ? 'Nothing archived. Archived notifications stay here, out of your list.'
      : tab === 'unread' ? 'You are all caught up. New agent activity shows up here.'
        : 'No activity yet. Quorum lists what its agents do with your notes and memories here.';

  return (
    <div className="set-col notif-page">
      <h1>Notifications</h1>
      <div className="nf-bar">
        <div className="seg" role="tablist" aria-label="Show">
          {TABS.map(([id, label]) => {
            const n = id === 'unread' ? counts?.unread : 0;
            // Archived carries no count; it is a shelf, and its number would read as more to do
            return <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{label}{n ? <span className="nf-count">{n}</span> : null}</button>;
          })}
        </div>
        <button className={`nf-toggle${review ? ' on' : ''}`} aria-pressed={review} onClick={() => setReview((r) => !r)}>
          Needs review{counts?.review ? <span className="nf-count review">{counts.review}</span> : null}
        </button>
        <span className="nf-fill" />
        <SearchButton open={searching || !!q} label="Search notifications" onToggle={() => { if (searching || q) { setQ(''); setSearching(false); } else { setSearching(true); window.setTimeout(() => searchRef.current?.focus(), 60); } }} />
        <PickMenu label="Type" count={kinds.length} multi options={KINDS} picked={kinds} onPick={(k) => setKinds(kinds.includes(k) ? kinds.filter((x) => x !== k) : [...kinds, k])} />
        <PickMenu label={SORTS.find(([id]) => id === sort)?.[1] ?? 'Sort'} options={SORTS} picked={[sort]} onPick={(v) => setSort(v)} />
      </div>
      {/* search opens below the bar from its icon button, focused; the list filters as you type */}
      <SearchField open={searching || !!q} inputRef={searchRef} value={q} placeholder="Search notifications" onChange={setQ} onClose={() => { setQ(''); setSearching(false); }} />
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
            <button className="act-pill" disabled={busy || !selReview.length} data-tip="Mark them reviewed and change nothing" onClick={() => decide(selReview, 'dismiss')}>Dismiss</button>
            <button className="act-pill" disabled={busy || !sel.some((r) => r.unread)} onClick={async () => { await mark(sel); setPicked(new Set()); }}>Mark read</button>
            <button className="act-pill" disabled={busy} onClick={async () => { await archive(sel, tab !== 'archived'); setPicked(new Set()); }}>{tab === 'archived' ? 'Unarchive' : 'Archive'}</button>
          </span>
        </div>
      )}
      {error && <p className="nf-error" role="alert">{error}</p>}
      <div className="nf-list">
        {items.map((r) => (
          <Row key={r.id} row={r} me={me} picked={picked.has(r.id)} busy={busy} onPick={() => toggle(r.id)} onOpen={() => open(r)}
            onOpenFile={(abs) => { mark([r]); window.dispatchEvent(new CustomEvent('quorum:open-memory', { detail: abs })); }}
            onMark={(unread) => mark([r], unread)} onDecide={(v) => decide([r], v)} onArchive={(on) => archive([r], on)} />
        ))}
      </div>
      {page && !items.length && <div className="nf-empty"><IconBell width={22} height={22} /><p>{empty}</p></div>}
      {page?.more && <button className="act-pill nf-more-btn" onClick={more}>Show more</button>}
    </div>
  );
}

// One review, the same block in Notifications, Memory health and the note's drawer: the recommendation in its own card,
// then the problem, solution and value that explain it, then a divider and the facts
export function ReviewDetails({ recommendation, problem, solution, value, meta }: { recommendation?: string; problem?: string; solution?: string; value?: string; meta?: [string, string][] }) {
  const why: [string, string][] = ([['Problem', problem], ['Solution', solution], ['Value', value]] as [string, string | undefined][]).filter((x): x is [string, string] => !!x[1]);
  return (
    <div className="rv-details">
      {recommendation && <div className="rv-card"><p><strong>Recommendation:</strong> {recommendation}</p></div>}
      {why.length > 0 && <IssueParts parts={why} />}
      {meta && meta.length > 0 && <dl className="mh-parts rv-meta">{meta.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>}
    </div>
  );
}

// label and text pairs, the labels lined up with the summary text
export function IssueParts({ parts }: { parts: [string, string][] }) {
  return <dl className="mh-parts">{parts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;
}

// the time a run has taken, in seconds under a minute
const took = (ms: number) => (ms < 1000 ? `${Math.max(ms, 1)} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`);

// A fix run in progress, then its outcome: the step running now (shimmering) and the time so far, with the steps folded
// under a chevron; when it ends, a short outcome in green or red with the time it took and a Dismiss button. A banner
// left alone dismisses itself a day after the run ends
export function RunBanner({ run }: { run: FixRun }) {
  const [steps, setSteps] = useState(false);
  const live = run.status === 'queued' || run.status === 'running';
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (!live) return; const t = window.setInterval(() => setNow(Date.now()), 250); return () => window.clearInterval(t); }, [live]);
  const current = run.steps[run.steps.length - 1];
  const elapsed = (run.endedAt ?? now) - (run.startedAt ?? run.queuedAt);
  const dismiss = (e: React.SyntheticEvent) => { e.stopPropagation(); window.quorum.fixDismiss([run.id]).then(() => window.dispatchEvent(new Event(CHANGED))).catch(() => {}); };
  return (
    <div className={`run-banner ${live ? 'live' : run.status}`} role="status" aria-live="polite" onClick={(e) => e.stopPropagation()}>
      <div className="run-head">
        <span className="run-icon" aria-hidden="true">{live ? <i className="run-spin" /> : run.status === 'success' ? <IconCheck width={15} height={15} /> : <IconClose width={14} height={14} />}</span>
        <span className={`run-text${live ? ' shimmer' : ''}`}>{live ? (run.status === 'queued' ? 'Waiting for the run before it' : current?.label ?? 'Starting') : run.status === 'success' ? run.outcome : run.error}</span>
        <span className="run-time">{took(elapsed)}</span>
        {run.steps.length > 0 && <button className={`icon-btn conn-fold${steps ? ' open' : ''}`} aria-expanded={steps} aria-label={steps ? 'Hide steps' : 'Show steps'} onClick={() => setSteps((o) => !o)}><IconChevron width={14} height={14} /></button>}
        {!live && <button className="act-pill run-dismiss" onClick={dismiss}>Dismiss</button>}
      </div>
      <div className={`fold-anim${steps ? ' open' : ''}`}>
        <div className="fold-inner">
          <ol className="run-steps">
            {run.steps.map((st, i) => {
              const done = !!st.endedAt || !live || i < run.steps.length - 1;
              return <li key={`${st.at}-${i}`} className={done ? 'done' : 'now'}><span>{st.label}</span><span className="run-time">{st.endedAt ? took(st.endedAt - st.at) : ''}</span></li>;
            })}
          </ol>
        </div>
      </div>
    </div>
  );
}
