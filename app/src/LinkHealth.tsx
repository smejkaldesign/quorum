import { useCallback, useEffect, useRef, useState } from 'react';
import type { MissingLink } from './quorum';
// every Quorum agent row shows the blue mark; review state shows through the badges and counts
import markReview from '../assets/quorum-mark.png';
import { CATEGORIES, HEALTH_SORTS, categoryCounts, countsLine, healthList, issueMeta, type HealthCategory, type HealthSort, type Issue } from '../memoryHealth.js';
import { IconCheck, IconChevron, IconClose, IconReset } from './icons';
import { PickMenu, SearchButton, SearchField } from './FilterBar';
import { IssueParts, ReviewDetails, RowMenu, RunBanner, StatusBadge, StatusSwap, UndoMenu, ago, dismissRun, runStatus, took } from './NotificationsView';
import type { FixRun } from './quorum';
import { toast } from './Toasts';

// Memory health: links that point at a note that does not exist, one row per missing note, in the same list pattern
// as Notifications. Each row states the issue, the problem it causes, what fixing it does and the recommended action,
// with Approve (take the recommendation), Decline (leave the links as they are) and View (open the note with the issue
// marked). The same issues wait in Notifications under Needs review. Nothing changes without a click.

// declined links used to be kept in this window's storage; they move to Quorum's data folder once, so Notifications
// and the Memory tree leave them out too
const OLD_LEFT_KEY = 'quorum.linksLeft';
export async function migrateLeft() {
  let keys: string[] = [];
  try { keys = JSON.parse(localStorage.getItem(OLD_LEFT_KEY) ?? '[]'); } catch {}
  if (!Array.isArray(keys) || !keys.length) return;
  await window.quorum.vaultLinksLeft(keys.map(String), true);
  try { localStorage.removeItem(OLD_LEFT_KEY); } catch {}
}
// the declined links, from the flags main puts on each missing link
export const leftOf = (items: MissingLink[]) => new Set(items.filter((m) => m.left).map((m) => m.target.toLowerCase()));

// Approve or Decline one issue, shared with the review banner and Notifications; answers with a line saying what changed
// Approve starts the fix as a run (main.js startFixes); the answer says it started. waitFix resolves with the run once
// it has finished
export const acceptIssue = async (issue: Issue) => { await window.quorum.fixStart([issue.key]); return `Fixing “${issue.target}”`; };
export function waitFix(key: string): Promise<FixRun> {
  return new Promise((resolve) => {
    const off = window.quorum.onFixRun((r) => { if (r.key === key.toLowerCase() && (r.status === 'success' || r.status === 'error')) { off(); resolve(r); } });
  });
}
// Dismiss: marked reviewed, nothing changes, and the issue moves to Dismissed
export const dismissIssue = (issue: Issue) => window.quorum.vaultLinkDecide(issue.key, 'dismiss');
const CHANGED = 'quorum:activity-changed';

// All (the default), Accepted (the fixes Quorum carried out) and Dismissed, the same bar as Notifications; Needs review
// narrows All to the items waiting for a decision
type Tab = 'all' | 'accepted' | 'left';

export function LinkHealth({ focus, isLive, onReview, onClose, onChanged }: {
  focus: string | null; isLive: (rel: string) => boolean; onReview: (issue: Issue) => void; onClose: () => void; onChanged: () => void;
}) {
  const [items, setItems] = useState<MissingLink[] | null>(null);
  const [tab, setTab] = useState<Tab>('all');
  const [review, setReview] = useState(false);
  const [cats, setCats] = useState<HealthCategory[]>([]);
  const [sort, setSort] = useState<HealthSort>('links');
  const [q, setQ] = useState('');
  const [searching, setSearching] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);
  const [runs, setRuns] = useState<FixRun[]>([]);
  // the issues whose Approve was pressed: a spinner in place of the button until their run takes over
  const [approving, setApproving] = useState<Set<string>>(new Set());
  // a bulk Approve: the issues in it and when it began, for the progress row under the bulk bar
  const [batch, setBatch] = useState<{ keys: string[]; titles: Record<string, string>; at: number } | null>(null);
  const load = useCallback((fresh = false) => { window.quorum.fixRuns().then(setRuns).catch(() => {}); return window.quorum.vaultLinkHealth(fresh).then(setItems); }, []);
  useEffect(() => { migrateLeft().finally(() => load()); }, [load]);
  useEffect(() => window.quorum.onVaultChanged(() => { load(); }), [load]);
  // a run's progress, and the list again once it ends
  useEffect(() => window.quorum.onFixRun((r) => { setRuns((xs) => [r, ...xs.filter((x) => x.id !== r.id)]); setApproving((ks) => { if (!ks.has(r.key)) return ks; const n = new Set(ks); n.delete(r.key); return n; }); if (r.status === 'success' || r.status === 'error') load(); }), [load]);
  // an issue answered in Notifications leaves this list too: both read the same issues
  useEffect(() => { const go = () => { load(); }; window.addEventListener(CHANGED, go); return () => window.removeEventListener(CHANGED, go); }, [load]);
  useEffect(() => { if (focus) document.getElementById(`lh-${focus.toLowerCase()}`)?.scrollIntoView({ block: 'center' }); }, [focus, items]);
  useEffect(() => { setPicked(new Set()); }, [tab, review, cats, q, sort]);

  const all = items ?? [];
  const left = leftOf(all);
  const counts = categoryCounts(all, left);
  // an issue being fixed keeps its row and place, loading, until its run ends; then the run lists under Accepted
  const liveRuns = new Map(runs.filter((r) => r.status === 'queued' || r.status === 'running').map((r) => [r.key, r]));
  const open = healthList(all, { tab: 'open', categories: cats, q, sort, left });
  const openKeys = new Set(all.map((i) => i.target.toLowerCase()));
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const ended = cats.length ? [] : runs
    .filter((r) => !r.undoneAt && (r.endedAt || !openKeys.has(r.key)) && words.every((w) => r.target.toLowerCase().includes(w)))
    .sort((a, b) => (b.endedAt ?? b.queuedAt) - (a.endedAt ?? a.queuedAt));
  type Entry = { issue: Issue } | { run: FixRun };
  // All: the items to decide, then the fixes, newest first; a fixed item leaves its place without pushing the list.
  // Needs review keeps only the items
  const entries: Entry[] = tab === 'left' ? healthList(all, { tab: 'left', categories: cats, q, sort, left }).map((issue) => ({ issue }))
    : tab === 'accepted' ? ended.map((run) => ({ run }))
      : review ? open.map((issue) => ({ issue }))
        : [...open.map((issue) => ({ issue })), ...ended.map((run) => ({ run }))];
  const list = entries.flatMap((e) => ('issue' in e ? [e.issue] : []));
  const idOf = (e: Entry) => ('issue' in e ? e.issue.key : e.run.id);
  const openN = open.filter((i) => !liveRuns.has(i.key)).length;
  // a fix writes the linking notes or the matched note, so it waits while a run is writing any of them
  const locked = (i: Issue) => [...i.sources, ...(i.candidate ? [i.candidate.rel] : [])].some(isLive);

  const refresh = async () => { setBusy(true); try { await load(true); } finally { setBusy(false); } };
  const after = async (msg: string) => {
    setDone(msg);
    setPicked(new Set());
    await load();
    onChanged();
    window.dispatchEvent(new Event(CHANGED));
  };
  // one or many issues decided; the list, the tree, the button count and Notifications all read again
  const decide = async (issues: Issue[], verdict: 'approve' | 'dismiss') => {
    if (verdict === 'approve') setApproving((s) => new Set([...s, ...issues.map((i) => i.key)]));
    if (verdict === 'approve' && issues.length > 1) setBatch({ keys: issues.map((i) => i.key), titles: Object.fromEntries(issues.map((i) => [i.key, i.target])), at: Date.now() - 1000 });
    setBusy(true);
    const lines: string[] = [];
    let firstError = '';
    for (const i of issues) {
      try { lines.push(verdict === 'approve' ? await acceptIssue(i) : await dismissIssue(i)); }
      catch (e) { firstError ||= String(e).replace(/^.*Error:\s*/, ''); setApproving((ks) => { const n = new Set(ks); n.delete(i.key); return n; }); }
    }
    setBusy(false);
    const failed = issues.length - lines.length;
    const one = issues.length === 1 ? `“${issues[0].target}”` : `${issues.length} issues`;
    if (failed && !lines.length) toast(firstError || 'That did not work', 'error');
    else toast(verdict === 'approve' ? `Approved ${one}. Quorum is fixing ${issues.length === 1 ? 'it' : 'them'} now.` : `Dismissed ${one}. Nothing changed.`);
    await after(issues.length === 1 ? (lines[0] ?? firstError) : `${verdict === 'approve' ? 'Approved' : 'Dismissed'} ${lines.length} of ${issues.length}${failed ? `. ${firstError}` : ''}`);
  };
  const back = async (issues: Issue[]) => {
    await window.quorum.vaultLinksLeft(issues.map((i) => i.key), false);
    await after(issues.length === 1 ? 'Moved back to review' : `Moved ${issues.length} back to review`);
  };

  // the Approve mark stays until the issue's run reports in (see onFixRun), so the row never flickers between the two
  const sel = list.filter((i) => picked.has(i.key) && !liveRuns.has(i.key));
  const pickedRuns = entries.flatMap((e) => ('run' in e && picked.has(e.run.id) && e.run.endedAt ? [e.run] : []));
  const allOn = entries.length > 0 && entries.every((e) => picked.has(idOf(e)));
  const toggle = (k: string) => setPicked((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const catLabel = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.label])) as Record<HealthCategory, string>;

  // a row opens the note on its issue with the drawer open; the chevron folds the write-up open, closed at first
  const [unfolded, setUnfolded] = useState<Set<string>>(new Set());
  const fold = (k: string) => setUnfolded((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const row = (i: Issue) => {
    const fixRun = liveRuns.get(i.key);
    const working = approving.has(i.key) || !!fixRun;
    const waiting = fixRun ? fixRun.status === 'queued' : working && !!batch?.keys.includes(i.key);
    return (
    <div key={i.key} id={`lh-${i.key}`} className={`conn-row nf-row mh-row${focus?.toLowerCase() === i.key ? ' focus' : ''}${working ? (waiting ? ' working waiting' : ' running working') : ''}`}>
      <div className="conn-line nf-line" role="button" tabIndex={0} aria-label={i.title} onClick={() => onReview(i)} onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onReview(i); } }}>
        <label className="nf-check" onClick={stop}><input type="checkbox" checked={picked.has(i.key)} aria-label="Select" onChange={() => toggle(i.key)} /></label>
        <span className="nf-who"><img src={markReview} alt="Quorum, needs review" width={32} height={32} /></span>
        <span className="nf-main">
          <span className="nf-head"><strong className="conn-title nf-title" data-tip={i.title}>{i.title}</strong></span>
          <span className="nf-sub"><span className="nf-when" title={i.lastAt ? new Date(i.lastAt).toLocaleString() : undefined}>{i.lastAt ? ago(i.lastAt) : ''}</span></span>
        </span>
        <span className="nf-side mh-side">
          {/* the date sits on the right; on hover it slides out and the actions slide in, the way Home's rows do */}
          <span className="mh-swap" onClick={stop} onKeyDown={stop}>
            <span className="mh-when"><StatusBadge status={tab === 'left' ? 'dismissed' : waiting ? 'waiting' : 'review'} /></span>
            <span className="mh-hover">
              {tab === 'left'
                ? <RowMenu label="Undo and move back to review" onPick={() => back([i])} />
                : <>
                    <button className="icon-btn mh-icon mh-no" disabled={busy || working} aria-label="Dismiss" data-tip="Dismiss: mark it reviewed and change nothing" onClick={() => decide([i], 'dismiss')}><IconClose width={15} height={15} /></button>
                    {working
                      ? <span className="icon-btn mh-icon mh-busy" role="img" aria-label="Working"><i className="run-spin" /></span>
                      : <button className="icon-btn mh-icon mh-yes" disabled={busy || locked(i)} aria-label="Approve" data-tip={locked(i) ? 'Waits until the run writing these notes finishes' : `Approve: ${i.recommend}`} onClick={() => decide([i], 'approve')}><IconCheck width={16} height={16} /></button>}
                  </>}
            </span>
          </span>
          <span className="nf-tools" onClick={stop} onKeyDown={stop}>
            <button className={`icon-btn conn-fold${unfolded.has(i.key) ? ' open' : ''}`} aria-expanded={unfolded.has(i.key)} aria-label={unfolded.has(i.key) ? 'Hide details' : 'Show details'} onClick={() => fold(i.key)}><IconChevron width={14} height={14} /></button>
          </span>
        </span>
      </div>
      <div className={`fold-anim${unfolded.has(i.key) ? ' open' : ''}`} aria-hidden={!unfolded.has(i.key)}>
        <div className="fold-inner">
        <div className="conn-sub conn-fold-body nf-details mh-fold">
          {tab === 'left'
            ? <><IssueParts parts={[['Dismissed', 'The links stay as they are. Move it back to review to fix it later.']]} /><ReviewDetails meta={issueMeta(i)} /></>
            : <>{fixRun && <RunBanner run={{ ...fixRun, showBanner: true }} />}<ReviewDetails recommendation={fixRun ? undefined : i.recommend} problem={i.problem} solution={i.solution} value={i.value} meta={issueMeta(i)} /></>}
        </div>
        </div>
      </div>
    </div>
    );
  };

  const filtered = !!(q || cats.length);
  const empty = items === null ? 'Checking your notes…'
    : filtered ? 'No issues match these filters.'
      : tab === 'left' ? 'Nothing dismissed. Issues you dismiss stay here, out of review.'
        : tab === 'accepted' ? 'Nothing accepted yet. The fixes you approve list here once Quorum makes them.'
          : 'Every link points at a note.';

  return (
    <div className="link-health mh-page" role="region" aria-label="Memory health">
      <div className="lh-head">
        <h2>Memory health</h2>
        <span className="mh-head-actions">
          <button className={`icon-btn ${busy ? 'spinning' : ''}`} aria-label="Check again" data-tip="Check again" disabled={busy} onClick={refresh}><IconReset width={16} height={16} /></button>
          <button className="icon-btn" aria-label="Close Memory health" data-tip="Back to graph" onClick={onClose}><IconClose width={16} height={16} /></button>
        </span>
      </div>
      <p className="lh-sum">
        {items === null ? 'Checking your notes…' : !counts.length ? 'Every link points at a note.' : countsLine(counts)}
        {done && <span className="lh-done">{done}</span>}
      </p>
      <div className="nf-bar">
        <div className="seg" role="tablist" aria-label="Show">
          {([['all', 'All'], ['accepted', 'Accepted'], ['left', 'Dismissed']] as [Tab, string][]).map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => { setTab(id); if (id !== 'all') setReview(false); }}>{label}</button>
          ))}
        </div>
        <button className={`nf-toggle${review ? ' on' : ''}`} aria-pressed={review} onClick={() => { setReview((r) => !r); setTab('all'); }}>
          Needs review{openN ? <span className="nf-count review">{openN}</span> : null}
        </button>
        <span className="nf-fill" />
        <SearchButton open={searching || !!q} label="Search Memory health" onToggle={() => { if (searching || q) { setQ(''); setSearching(false); } else { setSearching(true); window.setTimeout(() => searchRef.current?.focus(), 60); } }} />
        <PickMenu label="Type" count={cats.length} multi options={CATEGORIES.map((c) => [c.id, c.label] as [HealthCategory, string])} picked={cats} onPick={(c) => setCats(cats.includes(c) ? cats.filter((x) => x !== c) : [...cats, c])} />
        <PickMenu label={HEALTH_SORTS.find(([id]) => id === sort)?.[1] ?? 'Sort'} options={HEALTH_SORTS} picked={[sort]} onPick={(v) => setSort(v)} />
      </div>
      <SearchField open={searching || !!q} inputRef={searchRef} value={q} placeholder="Search Memory health" onChange={setQ} onClose={() => { setQ(''); setSearching(false); }} />
      {cats.length > 0 && (
        <div className="nf-chips" aria-label="Type filters">
          {cats.map((c) => <span key={c} className="filter on nf-chip">{catLabel[c]}<button className="filter-x" aria-label={`Remove ${catLabel[c]}`} onClick={() => setCats(cats.filter((x) => x !== c))}>×</button></span>)}
          {cats.length > 1 && <button className="text-btn" onClick={() => setCats([])}>Clear all</button>}
        </div>
      )}
      {entries.length > 0 && (
        <div className="nf-bulk">
          <label className="nf-check"><input type="checkbox" checked={allOn} aria-label="Select all" onChange={() => setPicked(allOn ? new Set() : new Set(entries.map(idOf)))} /></label>
          <span className="muted">{picked.size ? `${picked.size} selected` : 'Select all'}</span>
          <span className={`nf-bulk-actions${picked.size ? '' : ' hidden'}`} aria-hidden={!picked.size}>
            {tab === 'left'
              ? <button className="act-pill" disabled={busy} onClick={() => back(sel)}>Move back to review</button>
              : <>
                  <button className="act-pill" disabled={busy} data-tip="Mark them reviewed and change nothing" onClick={async () => { for (const r of pickedRuns) await dismissRun(r); if (sel.length) await decide(sel, 'dismiss'); else { setPicked(new Set()); load(); } }}>Dismiss</button>
                  {sel.length > 0 && <button className="act-pill primary" disabled={busy || sel.some(locked)} onClick={() => decide(sel, 'approve')}>Approve</button>}
                </>}
          </span>
        </div>
      )}
      {batch && <BatchBanner batch={batch} runs={runs} onDismiss={() => setBatch(null)} />}
      <div className="nf-list">{entries.map((e) => ('issue' in e ? row(e.issue) : <RunRow key={e.run.id} run={e.run} picked={picked.has(e.run.id)} onPick={() => toggle(e.run.id)} />))}</div>
      {!entries.length && <div className="nf-empty"><p>{empty}</p></div>}
    </div>
  );
}

// The drawer for one Memory health issue in an open note: everything the Needs review notification has (the issue, its
// facts, the problem, what fixing it does, the recommendation, where the links come from), with Decline and Approve
export function IssueDrawer({ issue, at, total, locked, busy, onOpen, onDecide, onClose }: {
  issue: Issue; at: number; total: number; locked: boolean; busy: boolean; onOpen: (rel: string) => void; onDecide: (approve: boolean) => void; onClose: () => void;
}) {
  const shown = issue.sources.slice(0, 8);
  const c = issue.candidate;
  return (
    <aside className="mh-drawer" role="dialog" aria-label="Memory health issue" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
      <header className="mh-drawer-head">
        <img src={markReview} alt="" width={24} height={24} />
        <span className="mh-drawer-kind">Needs review · {at + 1} of {total}</span>
        <button className="icon-btn" aria-label="Close" data-tip="Close" onClick={onClose}><IconClose width={16} height={16} /></button>
      </header>
      <div className="mh-drawer-body">
        <h3>{issue.title}</h3>
        <ReviewDetails recommendation={issue.recommend} problem={issue.problem} solution={issue.solution} value={issue.value} meta={issueMeta(issue)} />
        <dl className="mh-parts mh-facts">
          <div><dt>Missing note</dt><dd>{issue.target}</dd></div>
          {c && <div><dt>Closest note</dt><dd><button className="keeper-link" onClick={() => onOpen(c.rel)}>{c.name ?? c.title}</button></dd></div>}
          <div>
            <dt>Linked from</dt>
            <dd className="mh-sources">
              {shown.map((rel) => <button key={rel} className="keeper-link" data-tip={rel} onClick={() => onOpen(rel)}>{rel.split('/').pop()!.replace(/\.md$/i, '')}</button>)}
              {issue.sources.length > shown.length && <span className="muted">and {issue.sources.length - shown.length} more</span>}
            </dd>
          </div>
          {issue.contexts.length > 0 && (
            <div>
              <dt>What the linking notes say</dt>
              <dd className="mh-quotes">{issue.contexts.map((c) => <p key={c.rel + c.text}><button className="keeper-link" data-tip={c.rel} onClick={() => onOpen(c.rel)}>{c.rel.split('/').pop()!.replace(/\.md$/i, '')}</button> {c.text}</p>)}</dd>
            </div>
          )}
        </dl>
      </div>
      <footer className="mh-drawer-foot">
        <button className="act-pill" disabled={busy || locked} data-tip="Mark it reviewed and change nothing" onClick={() => onDecide(false)}>Dismiss</button>
        <button className="act-pill primary" disabled={busy || locked} data-tip={locked ? 'Waits until the run writing this note finishes' : undefined} onClick={() => onDecide(true)}>Approve</button>
      </footer>
    </aside>
  );
}

// a fix run in Memory health: the same row as an issue, shimmering while it works, with its banner and the issue's
// details folded open below
function RunRow({ run, picked, onPick }: { run: FixRun; picked: boolean; onPick: () => void }) {
  const [open, setOpen] = useState(!!run.showBanner);
  const live = run.status === 'queued' || run.status === 'running';
  const line = run.status === 'queued' ? `Waiting to fix “${run.target}”` : live ? `Fixing “${run.target}”` : run.status === 'success' ? `Fixed “${run.target}”` : `Could not fix “${run.target}”`;
  return (
    <div className={`conn-row nf-row mh-row${live ? ' running' : ''}`}>
      <div className="conn-line nf-line">
        <label className="nf-check"><input type="checkbox" checked={picked} aria-label="Select" onChange={onPick} /></label>
        <span className="nf-who"><img src={markReview} alt="" width={32} height={32} /></span>
        <span className="nf-main">
          <span className="nf-head"><strong className="conn-title nf-title" data-tip={line}>{line}</strong></span>
          <span className="nf-sub"><span className="nf-when" title={new Date(run.endedAt ?? run.queuedAt).toLocaleString()}>{ago(run.endedAt ?? run.queuedAt)}</span></span>
        </span>
        <span className="nf-side mh-side">
          <StatusSwap status={runStatus(run)}>{run.status === 'success' && <UndoMenu run={run} />}</StatusSwap>
          <span className="nf-tools"><button className={`icon-btn conn-fold${open ? ' open' : ''}`} aria-expanded={open} aria-label={open ? 'Hide details' : 'Show details'} onClick={() => setOpen((o) => !o)}><IconChevron width={14} height={14} /></button></span>
        </span>
      </div>
      <div className={`fold-anim${open ? ' open' : ''}`} aria-hidden={!open}>
        <div className="fold-inner">
          <div className="conn-sub conn-fold-body nf-details mh-fold">
            <RunBanner run={run} />
            <ReviewDetails problem={run.problem} solution={run.solution} value={run.value} meta={run.meta} />
          </div>
        </div>
      </div>
    </div>
  );
}

// a bulk Approve's progress, full width under the bulk bar: the item being fixed shimmers here and in its row, the bar
// fills as items finish, and the fold lists every item with its state. Done, it says how many were fixed
function BatchBanner({ batch, runs, onDismiss }: { batch: { keys: string[]; titles: Record<string, string>; at: number }; runs: FixRun[]; onDismiss: () => void }) {
  const [open, setOpen] = useState(false);
  const runOf = (k: string) => runs.filter((r) => r.key === k && r.queuedAt >= batch.at).sort((a, b) => b.queuedAt - a.queuedAt)[0];
  const items = batch.keys.map((k) => ({ k, title: batch.titles[k] ?? k, run: runOf(k) }));
  const ok = items.filter((x) => x.run?.status === 'success').length;
  const bad = items.filter((x) => x.run?.status === 'error').length;
  const finished = ok + bad;
  const now = items.find((x) => x.run?.status === 'running');
  const live = finished < items.length;
  const ends = items.map((x) => x.run?.endedAt ?? 0);
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => { if (!live) return; const t = window.setInterval(() => setTick(Date.now()), 500); return () => window.clearInterval(t); }, [live]);
  const elapsed = (live ? tick : Math.max(...ends)) - batch.at;
  const text = live
    ? `Fixing ${finished + 1} of ${items.length}${now ? `: “${now.title}”${now.run?.steps.length ? `, ${now.run.steps[now.run.steps.length - 1].label.toLowerCase()}` : ''}` : ''}`
    : `Fixed ${ok} of ${items.length}${bad ? `. ${bad} could not be fixed` : ''}`;
  return (
    <div className={`run-banner mh-batch ${live ? 'live' : bad && !ok ? 'error' : 'success'}`} role="status" aria-live="polite">
      <div className="run-head">
        <span className="run-icon" aria-hidden="true">{live ? <i className="run-spin" /> : bad && !ok ? <IconClose width={17} height={17} /> : <IconCheck width={18} height={18} />}</span>
        <span className={`run-text${live ? ' shimmer' : ''}`} data-tip={text}>{text}</span>
        <span className="run-time">{took(Math.max(0, elapsed))}</span>
        <button className={`icon-btn conn-fold${open ? ' open' : ''}`} aria-expanded={open} aria-label={open ? 'Hide items' : 'Show items'} onClick={() => setOpen((o) => !o)}><IconChevron width={14} height={14} /></button>
        {!live && <button className="act-pill run-dismiss" onClick={onDismiss}>Dismiss</button>}
      </div>
      <div className="mh-batch-bar" aria-hidden="true"><i style={{ width: `${(finished / items.length) * 100}%` }} /></div>
      <div className={`fold-anim${open ? ' open' : ''}`}>
        <div className="fold-inner">
          <ol className="run-steps mh-batch-list">
            {items.map((x) => {
              const st = x.run?.status;
              return <li key={x.k} className={st === 'running' ? 'now' : st === 'success' || st === 'error' ? 'done' : ''}><span className={st === 'running' ? 'shimmer' : ''} data-tip={x.title}>{x.title}</span><span className="run-time">{st === 'success' ? 'Fixed' : st === 'error' ? 'Could not fix' : st === 'running' ? 'Fixing' : 'Waiting'}</span></li>;
            })}
          </ol>
        </div>
      </div>
    </div>
  );
}
