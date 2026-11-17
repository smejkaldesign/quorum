import { DraftEvidence } from './MemoryDraft';
import { useCallback, useEffect, useRef, useState } from 'react';
import markProd from '../assets/quorum-mark.png';

import { IconArchive, IconBell, IconCheck, IconChevron, IconClose, IconExternal, IconMore, IconReset } from './icons';

// the View and Dismiss buttons every review row shows, here and in Memory health
export function ViewButton({ disabled, onView }: { disabled?: boolean; onView: () => void }) {
  return <button className="icon-btn mh-icon mh-view" disabled={disabled} aria-label="View" data-tip="View the note" onClick={(e) => { e.stopPropagation(); onView(); }}><IconExternal width={16} height={16} /></button>;
}
export function DismissButton({ disabled, onDismiss }: { disabled?: boolean; onDismiss: () => void }) {
  return <button className="icon-btn mh-icon mh-no" disabled={disabled} aria-label="Dismiss" data-tip="Dismiss: Archive and keep as is" onClick={onDismiss}><IconClose width={16} height={16} /></button>;
}
import { PickMenu, SearchButton, SearchField } from './FilterBar';
import { Avatar } from './Speaker';
import { toast } from './Toasts';
import { toastWhenFixed, waitFix } from './fixToast';
import type { FeedKind, FeedPage, FeedRow, FeedSort, FeedTab, FixRun } from './quorum';
import { Segmented } from './controls';
import { BulkPlan } from './BulkPlan';
import { NO_SELECTION, bulkView, dropAcross, keepOnPage, toggleAcross, toggleOne, togglePage, type BulkSel, type BulkView } from './bulkSelect';

// the left of the bulk bar, here and in Memory health: the checkbox for the page, the count (read out as it changes),
// and Select all once the whole page is picked and more items match
export function BulkPick({ view, across, onPage, onAcross }: { view: BulkView; across: boolean; onPage: () => void; onAcross: () => void }) {
  return (
    <>
      <label className="nf-check"><input type="checkbox" checked={view.pageOn} aria-label={view.checkLabel} onChange={onPage} /></label>
      <span className="muted" role="status" aria-live="polite">{view.text}</span>
      {view.offerAll && <button className={`nf-toggle nf-select-all${across ? ' on' : ''}`} aria-pressed={across} onClick={onAcross}>{view.allLabel}</button>}
    </>
  );
}

const PAGE = 50;
// the most rows Select all reads from main in one go
const EVERY = 100000;
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

export const ago = (at: number) => {
  const s = Math.max(0, (Date.now() - at) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
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
export function Row({ row, me, picked, busy, onPick, onOpen, onOpenFile, onMark, onDecide, onArchive }: {
  row: FeedRow; me: { name: string; photo: string | null }; picked: boolean; busy: boolean; onPick: () => void; onOpen: () => void; onOpenFile: (abs: string) => void; onMark: (unread: boolean) => void; onDecide: (v: 'approve' | 'dismiss') => void | Promise<void>; onArchive: (on: boolean) => void;
}) {
  // a fix run opens its details, so its progress and outcome are in view
  const [open, setOpen] = useState(!!row.run?.showBanner);
  // Approve pressed: the button turns into a spinner and the title shimmers until the fix starts; the run's own state
  // takes over from there, so a fix that fails or never starts does not leave the spinner on
  const [pressed, setWorking] = useState(false);
  // the row stays where it is, its buttons showing and the spinner on, until the fix ends
  const working = pressed || !!row.fixRun;
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const go = () => { if (!row.target.gone) onOpen(); };
  // a review row opens its note from View; a click on the row folds its details open and shut
  // opening a row's details counts as reading it
  const toggle = () => { if (!open && row.unread) onMark(false); setOpen(!open); };
  const press = () => { if (row.review) toggle(); else go(); };
  return (
    <div className={`conn-row nf-row${row.unread ? ' unread' : ''}${row.review || row.run ? ' mh-row' : ''}${(row.run && (row.run.status === 'running' || row.run.status === 'queued')) || working ? ' running' : ''}${working ? ' working' : ''}`}>
      <div className="conn-line nf-line" role="button" tabIndex={0} aria-label={row.summary.line} aria-expanded={row.review ? open : undefined} onClick={press} onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); press(); } }}>
        <label className="nf-check" onClick={stop}><input type="checkbox" checked={picked} aria-label="Select" onChange={onPick} /></label>
        {/* waiting for a decision shows the orange mark, Quorum's color for anything in review */}
        <span className="nf-who">{row.who === 'you' ? <span className="nf-you-avatar" aria-label="You" data-tip={me.name}><Avatar name={me.name} photo={me.photo} size={32} /></span> : <img src={markProd} alt={row.review ? 'Quorum, needs review' : 'Quorum'} width={32} height={32} />}</span>
        <span className="nf-main">
          <span className="nf-head"><strong className="conn-title nf-title" data-tip={row.review || row.run ? row.summary.line : undefined}>{row.summary.line}</strong>{row.unread && !row.archived && <i className="nf-dot" role="img" aria-label="Unread" data-tip="Unread" />}</span>
          {(row.review || row.run) && <span className="nf-sub"><span className="nf-when" title={new Date(row.at).toLocaleString()}>{ago(row.at)}</span></span>}
          {!row.review && !row.run && <span className="nf-sub"><span className="nf-when" title={new Date(row.at).toLocaleString()}>{ago(row.at)}</span>{row.summary.sub && <> <span className="nf-sep" aria-hidden="true">•</span> {row.summary.sub}</>}</span>}
        </span>
        <span className={`nf-side${row.review || row.run ? ' mh-side' : ''}`}>
          {/* the item's state on the right; on hover its actions slide in over it */}
          {row.run && (
            <StatusSwap status={runStatus(row.run)}>
              {row.run.status === 'success' && <UndoMenu run={row.run} />}
            </StatusSwap>
          )}
          {/* every review row: View opens the note, left of Dismiss and Approve */}
          {row.review && row.archived && (
            <StatusSwap status={row.done ? 'accepted' : 'dismissed'}><span onClick={stop} onKeyDown={stop}><ViewButton disabled={!!row.target.gone} onView={go} /></span><RowMenu label="Move back to review" onPick={() => onArchive(false)} /></StatusSwap>
          )}
          {row.review && !row.archived && (
            <span className="mh-swap" onClick={stop} onKeyDown={stop}>
              <span className="mh-when"><StatusBadge status={row.fixRun?.status === 'queued' ? 'waiting' : 'review'} /></span>
              <span className="mh-hover">
                <ViewButton disabled={!!row.target.gone} onView={go} />
                <DismissButton disabled={busy || working} onDismiss={() => onArchive(true)} />
                {working
                  ? <span className="icon-btn mh-icon mh-busy" role="img" aria-label="Working"><i className="run-spin" /></span>
                  : <button className="icon-btn mh-icon mh-yes" disabled={busy} aria-label="Approve" data-tip={`Approve: ${row.summary.recommendation ?? ''}`} onClick={() => { setWorking(true); Promise.resolve(onDecide('approve')).finally(() => setWorking(false)); }}><IconCheck width={16} height={16} /></button>}
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
            <button className={`icon-btn conn-fold${open ? ' open' : ''}`} aria-expanded={open} aria-label={open ? 'Hide details' : 'Show details'} onClick={toggle}><IconChevron width={14} height={14} /></button>
          </span>
        </span>
      </div>
      {/* the details grow open and shut */}
      <div className={`fold-anim${open ? ' open' : ''}`} aria-hidden={!open}>
        <div className="fold-inner">
          <div className="conn-sub conn-fold-body nf-details">
            {row.run ? (
              <>
                <RunBanner run={row.run} />
                <ReviewDetails problem={row.run.problem} solution={row.run.solution} value={row.run.value} meta={row.run.meta} />
              </>
            ) : row.review ? (
              <>
                {row.fixRun && <RunBanner run={row.fixRun} />}
                <ReviewDetails recommendation={row.fixRun ? undefined : row.summary.recommendation} problem={row.summary.problem} solution={row.summary.solution} value={row.summary.value}
                  meta={row.review.kind === 'link' ? row.details.filter(([k]) => k !== 'What' && k !== 'When' && k !== 'History') : row.details.filter(([k]) => k !== 'History')} />
                {row.draft && <DraftEvidence draft={row.draft} />}
              </>
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
  const [bulk, setBulk] = useState<BulkSel>(NO_SELECTION);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // the bulk plan sheet, for Approve on several Memory health items (their row ids)
  const [plan, setPlan] = useState<string[] | null>(null);
  const shown = useRef(PAGE);
  const query = useRef({ tab, review, kinds, sort, q });
  useEffect(() => { query.current = { tab, review, kinds, sort, q }; });

  // the rows already on screen are read again together, so a refresh keeps the place in a long list
  const load = useCallback(() => {
    const cur = query.current;
    window.quorum.activityFeed({ ...cur, offset: 0, limit: shown.current }).then((p) => {
      if (JSON.stringify(query.current) !== JSON.stringify(cur)) return;
      setPage(p);
      setBulk((s) => keepOnPage(s, p.items.map((r) => r.id)));
    }).catch(() => {});
  }, []);
  useActivityRefresh(load);
  // a new tab, filter, sort or search ends Select all in the same render, so no action can take the old list's rows
  const queryKey = JSON.stringify([tab, review, kinds, sort, q]);
  const [bulkKey, setBulkKey] = useState(queryKey);
  if (bulkKey !== queryKey) { setBulkKey(queryKey); setBulk(dropAcross); }
  // and starts again at the first page; picks not in the new list drop out when it loads
  useEffect(() => { shown.current = PAGE; const t = window.setTimeout(load, q ? 150 : 0); return () => window.clearTimeout(t); }, [tab, review, kinds, sort, q, load]);
  const more = () => { shown.current += PAGE; setBulk(dropAcross); load(); };
  const changed = () => window.dispatchEvent(new Event(CHANGED));

  const items = page?.items ?? [];
  const pageIds = items.map((r) => r.id);
  const view = bulkView(pageIds, bulk, page?.total ?? items.length);
  const isPicked = (id: string) => bulk.across || bulk.picked.has(id);
  const sel = items.filter((r) => isPicked(r.id));
  const toggle = (id: string) => setBulk((s) => toggleOne(id, s, pageIds));
  const clear = () => setBulk(NO_SELECTION);
  // the rows a bulk action takes: the picks on screen, or with Select all on, every row that matches, read from main
  const withRows = async (fn: (rows: FeedRow[]) => Promise<unknown> | void) => {
    let rows = sel;
    if (bulk.across) {
      setBusy(true);
      try { rows = (await window.quorum.activityFeed({ ...query.current, offset: 0, limit: EVERY })).items; }
      catch (e) { setError((e as Error).message); rows = []; }
      setBusy(false);
    }
    if (rows.length) await fn(rows);
  };

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
    // a link fix is announced once it ends (toastWhenFixed), and only the fixes that started
    const waits = fixes.map((k) => waitFix(k));
    const started = fixes.length ? await window.quorum.fixStart(fixes).catch(() => [] as FixRun[]) : [];
    const ran = (k: string) => started.some((r) => r.key === k.toLowerCase() || !!r.items?.some((i) => i.kind === 'link' && i.key === k.toLowerCase()));
    waits.forEach((w, n) => { if (!ran(fixes[n])) w.off(); });
    if (fixes.length && !started.length) toast(fixes.length === 1 ? 'That item no longer needs a fix' : 'None of those items could start a fix', 'error');
    toastWhenFixed(fixes.flatMap((k, n) => (ran(k) ? [{ key: k, target: picked.find((r) => r.review!.key === k)!.target.title, done: waits[n] }] : [])));
    for (const r of picked) {
      if (verdict === 'approve' && r.review!.kind === 'link') continue;
      const v = verdict === 'dismiss' ? 'dismiss' : r.summary.ask?.suggest === 'reject' ? 'revert' : 'approve';
      groups.set(v, [...(groups.get(v) ?? []), { kind: r.review!.kind, abs: r.target.abs, key: r.review!.key }]);
    }
    const list = picked;
    setBusy(true);
    setError(null);
    let failedN = 0;
    try {
      const failed: { abs: string; error: string }[] = [];
      for (const [v, items] of groups) if (items.length) failed.push(...(await window.quorum.activityReview(items, v)).failed);
      failedN = failed.length;
      if (failed.length) setError(`${failed.length} of ${list.length} could not be ${verdict === 'approve' ? 'approved' : 'dismissed'}: ${failed[0].error}`);
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
    clear();
    changed();
    const one = picked.length === 1 ? `“${picked[0].target.title}”` : `${picked.length} items`;
    const undoing = picked.every((r) => r.review!.kind === 'past-fix');
    // Approve on an item Quorum keeps as it is changes nothing and marks it done
    const keeping = verdict === 'approve' && picked.every((r) => r.review!.approve === 'keep' || (r.review!.kind === 'finding' && r.detail?.keep));
    if (undoing && failedN) return;
    // only link fixes picked: their toast comes when they end
    if (fixes.length && fixes.length === picked.length) return;
    toast(keeping ? `Kept ${one} as ${picked.length === 1 ? 'it is' : 'they are'} and marked ${picked.length === 1 ? 'it' : 'them'} done.` : undoing ? (verdict === 'dismiss' ? `Kept the fix on ${one}.` : `Approved the corrective fix on ${one}. Quorum is applying it now.`) : verdict === 'dismiss' ? `Dismissed ${one}. Nothing changed.` : `Approved ${one}.`);
  };

  // archive or bring back rows; the list reloads so they leave this tab
  const archive = async (rows: FeedRow[], on: boolean) => {
    if (!rows.length) return;
    await window.quorum.activityArchive(rows.map((r) => ({ id: r.id })), on).catch(() => 0);
    changed();
    // archiving a review item sets it aside without fixing it; it waits under Archived until it is moved back
    const reviews = rows.filter((r) => r.review);
    const one = (xs: FeedRow[]) => (xs.length === 1 ? `“${xs[0].target.title}”` : `${xs.length} items`);
    const kept = reviews.length > 0 && reviews.every((r) => r.review!.kind === 'past-fix');
    if (reviews.length) toast(on ? (kept ? `Kept the fix on ${one(reviews)}. It is under Archived when you want it again.` : `Archived ${one(reviews)} without fixing it. It is under Archived when you want it again.`) : `Moved ${one(reviews)} back to review.`);
  };

  const counts = page?.counts;
  const filtered = !!(q || kinds.length);
  const empty = filtered ? 'No notifications match these filters.'
    : review ? 'Nothing waits for your review. The Quorum agent keeps watching your memories and lists new ways to improve them here as they come up.'
      : tab === 'archived' ? 'Nothing archived. Archived notifications stay here, out of your list.'
      : tab === 'unread' ? 'You are all caught up. New agent activity shows up here.'
        : 'No activity yet. Quorum lists what its agents do with your notes and memories here.';

  return (
    <div className="set-col notif-page">
      <h1>Notifications</h1>
      <div className="nf-bar">
        <Segmented kind="tabs" label="Show" value={tab} onChange={setTab} options={TABS.map(([id, label]) => {
          const n = id === 'unread' ? counts?.unread : 0;
          // Archived carries no count; it is a shelf, and its number would read as more to do
          return { id, label: <>{label}{n ? <span className="nf-count">{n}</span> : null}</> };
        })} />
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
          <BulkPick view={view} across={bulk.across} onPage={() => setBulk((s) => togglePage(pageIds, s))} onAcross={() => setBulk((s) => toggleAcross(pageIds, s))} />
          {/* the actions appear once something is picked; the bar keeps its height either way */}
          <span className={`nf-bulk-actions${view.count ? '' : ' hidden'}`} aria-hidden={!view.count}>
            {/* left to right: Archive, Mark read, Dismiss, and Approve as the primary action on the far right */}
            <button className="icon-btn mh-icon" disabled={busy} aria-label={tab === 'archived' ? 'Unarchive' : 'Archive'} data-tip={tab === 'archived' ? 'Unarchive' : 'Archive'} onClick={() => withRows(async (rows) => { await archive(rows, tab !== 'archived'); clear(); })}><IconArchive width={16} height={16} /></button>
            <button className="act-pill" disabled={busy || !(bulk.across ? counts?.unread : sel.some((r) => r.unread))} onClick={() => withRows(async (rows) => { await mark(rows); clear(); })}>Mark read</button>
            <button className="act-pill primary" disabled={busy || !(bulk.across ? tab !== 'archived' && counts?.review : sel.some((r) => r.review))} onClick={() => withRows((rows) => {
              // Memory health items go through the bulk plan sheet when there are several; the rest are approved here
              const selReview = rows.filter((r) => r.review);
              const planned = selReview.filter((r) => r.review!.kind === 'link' || r.review!.kind === 'past-fix' || r.review!.kind === 'finding');
              if (planned.length < 2) { decide(selReview, 'approve'); return; }
              const rest = selReview.filter((r) => !planned.includes(r));
              if (rest.length) decide(rest, 'approve');
              setPlan(planned.map((r) => r.id));
            })}>Approve</button>
          </span>
        </div>
      )}
      {error && <p className="nf-error" role="alert">{error}</p>}
      <div className="nf-list">
        {items.map((r) => (
          <Row key={r.id} row={r} me={me} picked={isPicked(r.id)} busy={busy} onPick={() => toggle(r.id)} onOpen={() => open(r)}
            onOpenFile={(abs) => { mark([r]); window.dispatchEvent(new CustomEvent('quorum:open-memory', { detail: abs })); }}
            onMark={(unread) => mark([r], unread)} onDecide={(v) => decide([r], v)} onArchive={(on) => archive([r], on)} />
        ))}
      </div>
      {page && !items.length && <div className="nf-empty"><IconBell width={22} height={22} /><p>{empty}</p></div>}
      {page?.more && <button className="act-pill nf-more-btn" onClick={more}>Show more</button>}
      {plan && <BulkPlan ids={plan} onClose={() => setPlan(null)} onApplied={() => { clear(); changed(); }} />}
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
// how long work took: ms, s, min and s, then h and min from an hour on
export const took = (ms: number) => (ms < 1000 ? `${Math.max(ms, 1)} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : ms < 3600000 ? `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s` : `${Math.floor(ms / 3600000)} h ${Math.floor((ms % 3600000) / 60000)} min`);

// A fix run in progress, then its outcome: the step running now (shimmering) and the time so far, with the steps folded
// under a chevron; when it ends, a short outcome in green or red with the time it took and a Dismiss button. A banner
// left alone dismisses itself a day after the run ends
export function RunBanner({ run }: { run: FixRun }) {
  const [steps, setSteps] = useState(false);
  const live = run.status === 'queued' || run.status === 'running';
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (!live) return; const t = window.setInterval(() => setNow(Date.now()), 250); return () => window.clearInterval(t); }, [live]);
  const current = run.steps[run.steps.length - 1];
  const elapsed = run.startedAt || run.queuedAt ? (run.endedAt ?? now) - (run.startedAt ?? run.queuedAt) : 0;
  return (
    <div className={`run-banner ${live ? 'live' : run.status}`} role="status" aria-live="polite" onClick={(e) => e.stopPropagation()}>
      <div className="run-head">
        <span className="run-icon" aria-hidden="true">{live ? <i className="run-spin" /> : run.status === 'success' ? <IconCheck width={18} height={18} /> : <IconClose width={17} height={17} />}</span>
        {(() => { const t = live ? (run.status === 'queued' ? 'Waiting for the run before it' : current?.label ?? 'Starting') : run.status === 'success' ? run.outcome : run.error; return <span className={`run-text${live ? ' shimmer' : ''}`} data-tip={t ?? undefined}>{t}</span>; })()}
        <span className="run-time">{took(elapsed)}</span>
        {run.steps.length > 0 && <button className={`icon-btn conn-fold${steps ? ' open' : ''}`} aria-expanded={steps} aria-label={steps ? 'Hide steps' : 'Show steps'} onClick={() => setSteps((o) => !o)}><IconChevron width={14} height={14} /></button>}
      </div>
      <div className={`fold-anim${steps ? ' open' : ''}`}>
        <div className="fold-inner">
          <ol className="run-steps">
            {run.steps.map((st, i) => {
              const done = !!st.endedAt || !live || i < run.steps.length - 1;
              return <li key={`${st.at}-${i}`} className={done ? 'done' : 'now'}><span data-tip={st.label}>{st.label}</span><span className="run-time">{st.endedAt ? took(st.endedAt - st.at) : ''}</span></li>;
            })}
          </ol>
        </div>
      </div>
    </div>
  );
}

// Dismiss on a finished fix: its banner is dismissed and its notification leaves the list. It stays under Archived as
// history, with its outcome
export async function dismissRun(run: FixRun) {
  await window.quorum.fixDismiss([run.id]).catch(() => 0);
  await window.quorum.activityArchive([{ id: `f:${run.id}` }], true).catch(() => 0);
  window.dispatchEvent(new Event(CHANGED));
}

// the answer an item got: Accepted (green) when its fix ran, Failed (red) when the fix did not work, Declined (red) when
// it was dismissed
export type ItemStatus = 'review' | 'waiting' | 'accepted' | 'failed' | 'dismissed';
const STATUS_TEXT: Record<ItemStatus, string> = { review: 'Needs review', waiting: 'Waiting', accepted: 'Accepted', failed: 'Failed', dismissed: 'Dismissed' };
export function StatusBadge({ status }: { status: ItemStatus }) {
  return <span className={`nf-status ${status}`}>{STATUS_TEXT[status]}</span>;
}
export const runStatus = (r: FixRun): ItemStatus => (r.status === 'success' ? 'accepted' : r.status === 'error' ? 'failed' : 'waiting');

// a row's state badge on the right; when the row has actions, hovering slides the badge out and the actions in
export function StatusSwap({ status, children }: { status: ItemStatus; children?: React.ReactNode }) {
  const has = !!children && (!Array.isArray(children) || children.some(Boolean));
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  return (
    <span className={`mh-swap${has ? '' : ' mh-still'}`} onClick={stop} onKeyDown={stop}>
      <span className="mh-when"><StatusBadge status={status} /></span>
      {has && <span className="mh-hover">{children}</span>}
    </span>
  );
}

// the ⋯ menu on an answered item: Undo takes it back to Needs review. For a fix, the notes the agent changed go back to
// how they were and a note it wrote goes to the Trash; for a dismissed item, it simply returns to review
export function RowMenu({ label, tip, onPick }: { label: string; tip?: string; onPick: () => Promise<void> | void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', off);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('mousedown', off); window.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <span ref={wrap} className={`menu-wrap mh-menu${open ? ' open' : ''}`}>
      <button className="icon-btn mh-icon" aria-label="More" aria-haspopup="menu" aria-expanded={open} data-tip="More" onClick={() => setOpen((o) => !o)}><IconMore width={16} height={16} /></button>
      {open && (
        <div className="menu end" role="menu">
          <button role="menuitem" disabled={!!tip} data-tip={tip} onClick={async () => { setOpen(false); await onPick(); }}><IconReset width={15} height={15} /> {label}</button>
        </div>
      )}
    </span>
  );
}
export function UndoMenu({ run }: { run: FixRun }) {
  return (
    <RowMenu label="Undo and move back to review" tip={run.undoable ? undefined : 'This fix ran before Quorum kept a copy of the notes it changed, so it cannot be undone here'}
      onPick={async () => {
        try { toast(await window.quorum.fixUndo(run.id)); } catch (e) { toast(String(e).replace(/^.*Error:\s*/, ''), 'error'); }
        window.dispatchEvent(new Event(CHANGED));
      }} />
  );
}
