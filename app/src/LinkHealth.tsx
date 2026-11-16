import { useCallback, useEffect, useRef, useState } from 'react';
import type { MissingLink } from './quorum';
import markReview from '../assets/quorum-mark-review.png';
import { CATEGORIES, HEALTH_SORTS, categoryCounts, countsLine, healthList, issueMeta, type HealthCategory, type HealthSort, type Issue } from '../memoryHealth.js';
import { IconCheck, IconChevron, IconClose, IconReset } from './icons';
import { PickMenu, SearchButton, SearchField } from './FilterBar';
import { IssueParts, ReviewDetails, RunBanner } from './NotificationsView';
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

type Tab = 'open' | 'left';

export function LinkHealth({ focus, isLive, onReview, onClose, onChanged }: {
  focus: string | null; isLive: (rel: string) => boolean; onReview: (issue: Issue) => void; onClose: () => void; onChanged: () => void;
}) {
  const [items, setItems] = useState<MissingLink[] | null>(null);
  const [tab, setTab] = useState<Tab>('open');
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
  const load = useCallback((fresh = false) => { window.quorum.fixRuns().then(setRuns).catch(() => {}); return window.quorum.vaultLinkHealth(fresh).then(setItems); }, []);
  useEffect(() => { migrateLeft().finally(() => load()); }, [load]);
  useEffect(() => window.quorum.onVaultChanged(() => { load(); }), [load]);
  // a run's progress, and the list again once it ends
  useEffect(() => window.quorum.onFixRun((r) => { setRuns((xs) => [r, ...xs.filter((x) => x.id !== r.id)]); if (r.status === 'success' || r.status === 'error') load(); }), [load]);
  // an issue answered in Notifications leaves this list too: both read the same issues
  useEffect(() => { const go = () => { load(); }; window.addEventListener(CHANGED, go); return () => window.removeEventListener(CHANGED, go); }, [load]);
  useEffect(() => { if (focus) document.getElementById(`lh-${focus.toLowerCase()}`)?.scrollIntoView({ block: 'center' }); }, [focus, items]);
  useEffect(() => { setPicked(new Set()); }, [tab, cats, q, sort]);

  const all = items ?? [];
  const left = leftOf(all);
  const counts = categoryCounts(all, left);
  // the issues being fixed leave the list; their runs show above it until their banner is dismissed
  const liveRuns = runs.filter((r) => r.status === 'queued' || r.status === 'running');
  const fixing = new Set(liveRuns.map((r) => r.key));
  const shownRuns = tab === 'open' ? runs.filter((r) => r.showBanner) : [];
  const list = healthList(all, { tab, categories: cats, q, sort, left }).filter((i) => !fixing.has(i.key));
  const openN = all.length - left.size;
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
    if (verdict === 'approve') setApproving(new Set(issues.map((i) => i.key)));
    setBusy(true);
    const lines: string[] = [];
    let firstError = '';
    for (const i of issues) {
      try { lines.push(verdict === 'approve' ? await acceptIssue(i) : await dismissIssue(i)); }
      catch (e) { firstError ||= String(e).replace(/^.*Error:\s*/, ''); }
    }
    setBusy(false);
    setApproving(new Set());
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

  const sel = list.filter((i) => picked.has(i.key));
  const allOn = list.length > 0 && list.every((i) => picked.has(i.key));
  const toggle = (k: string) => setPicked((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const catLabel = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.label])) as Record<HealthCategory, string>;

  // a row opens the note on its issue with the drawer open; the chevron folds the write-up open, closed at first
  const [unfolded, setUnfolded] = useState<Set<string>>(new Set());
  const fold = (k: string) => setUnfolded((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const row = (i: Issue) => (
    <div key={i.key} id={`lh-${i.key}`} className={`conn-row nf-row mh-row${focus?.toLowerCase() === i.key ? ' focus' : ''}${approving.has(i.key) ? ' running working' : ''}`}>
      <div className="conn-line nf-line" role="button" tabIndex={0} aria-label={i.title} onClick={() => onReview(i)} onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onReview(i); } }}>
        <label className="nf-check" onClick={stop}><input type="checkbox" checked={picked.has(i.key)} aria-label="Select" onChange={() => toggle(i.key)} /></label>
        <span className="nf-who"><img src={markReview} alt="Quorum, needs review" width={32} height={32} /></span>
        <span className="nf-main">
          <span className="nf-head"><strong className="conn-title nf-title">{i.title}</strong></span>
        </span>
        <span className="nf-side mh-side">
          {/* the date sits on the right; on hover it slides out and the actions slide in, the way Home's rows do */}
          <span className="mh-swap" onClick={stop} onKeyDown={stop}>
            <span className="mh-when" title={i.lastAt ? new Date(i.lastAt).toLocaleString() : undefined}>{i.lastAt ? new Date(i.lastAt).toLocaleDateString([], { month: 'short', day: 'numeric' }) : ''}</span>
            <span className="mh-hover">
              {tab === 'left'
                ? <button className="act-pill" disabled={busy} onClick={() => back([i])}>Move back to review</button>
                : <>
                    <button className="icon-btn mh-icon mh-no" disabled={busy} aria-label="Dismiss" data-tip="Dismiss: mark it reviewed and change nothing" onClick={() => decide([i], 'dismiss')}><IconClose width={15} height={15} /></button>
                    {approving.has(i.key)
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
            : <ReviewDetails recommendation={i.recommend} problem={i.problem} solution={i.solution} value={i.value} meta={issueMeta(i)} />}
        </div>
        </div>
      </div>
    </div>
  );

  const filtered = !!(q || cats.length);
  const empty = items === null ? 'Checking your notes…'
    : filtered ? 'No issues match these filters.'
      : tab === 'left' ? 'Nothing dismissed. Issues you dismiss stay here, out of review.'
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
          <button role="tab" aria-selected={tab === 'open'} className={tab === 'open' ? 'on' : ''} onClick={() => setTab('open')}>Needs review{openN ? <span className="nf-count review">{openN}</span> : null}</button>
          <button role="tab" aria-selected={tab === 'left'} className={tab === 'left' ? 'on' : ''} onClick={() => setTab('left')}>Dismissed</button>
        </div>
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
      {list.length > 0 && (
        <div className="nf-bulk">
          <label className="nf-check"><input type="checkbox" checked={allOn} aria-label="Select all" onChange={() => setPicked(allOn ? new Set() : new Set(list.map((i) => i.key)))} /></label>
          <span className="muted">{sel.length ? `${sel.length} selected` : 'Select all'}</span>
          <span className={`nf-bulk-actions${sel.length ? '' : ' hidden'}`} aria-hidden={!sel.length}>
            {tab === 'left'
              ? <button className="act-pill" disabled={busy} onClick={() => back(sel)}>Move back to review</button>
              : <>
                  <button className="act-pill" disabled={busy} data-tip="Mark them reviewed and change nothing" onClick={() => decide(sel, 'dismiss')}>Dismiss</button>
                  <button className="act-pill primary" disabled={busy || sel.some(locked)} onClick={() => decide(sel, 'approve')}>Approve</button>
                </>}
          </span>
        </div>
      )}
      <div className="nf-list">{shownRuns.map((r) => <RunRow key={r.id} run={r} />)}{list.map(row)}</div>
      {!list.length && <div className="nf-empty"><p>{empty}</p></div>}
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
function RunRow({ run }: { run: FixRun }) {
  const [open, setOpen] = useState(true);
  const live = run.status === 'queued' || run.status === 'running';
  const line = run.status === 'queued' ? `Waiting to fix “${run.target}”` : live ? `Fixing “${run.target}”` : run.status === 'success' ? `Fixed “${run.target}”` : `Could not fix “${run.target}”`;
  return (
    <div className={`conn-row nf-row mh-row${live ? ' running' : ''}`}>
      <div className="conn-line nf-line">
        <span className="nf-check" />
        <span className="nf-who"><img src={markReview} alt="" width={32} height={32} /></span>
        <span className="nf-main"><span className="nf-head"><strong className="conn-title nf-title">{line}</strong></span></span>
        <span className="nf-side mh-side">
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
