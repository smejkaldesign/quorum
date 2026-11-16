import { useEffect, useRef, useState } from 'react';
import type { MissingLink } from './quorum';
import markReview from '../assets/quorum-mark-review.png';
import { CATEGORIES, HEALTH_SORTS, categoryCounts, countsLine, footerFacts, healthList, type HealthCategory, type HealthSort, type Issue } from '../memoryHealth.js';
import { IconChevron, IconClose, IconReset } from './icons';
import { PickMenu, SearchButton, SearchField } from './FilterBar';
import { IssueParts } from './NotificationsView';

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
export const acceptIssue = (issue: Issue) => window.quorum.vaultLinkDecide(issue.key, 'approve');
export const rejectIssue = (issue: Issue) => window.quorum.vaultLinkDecide(issue.key, 'reject');
export const ignoreIssue = (issue: Issue) => window.quorum.vaultLinkDecide(issue.key, 'ignore');
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
  const load = (fresh = false) => window.quorum.vaultLinkHealth(fresh).then(setItems);
  useEffect(() => { migrateLeft().finally(() => load()); }, []);
  useEffect(() => window.quorum.onVaultChanged(() => { load(); }), []);
  useEffect(() => { if (focus) document.getElementById(`lh-${focus.toLowerCase()}`)?.scrollIntoView({ block: 'center' }); }, [focus, items]);
  useEffect(() => { setPicked(new Set()); }, [tab, cats, q, sort]);

  const all = items ?? [];
  const left = leftOf(all);
  const counts = categoryCounts(all, left);
  const list = healthList(all, { tab, categories: cats, q, sort, left });
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
  const decide = async (issues: Issue[], verdict: 'approve' | 'reject' | 'ignore') => {
    setBusy(true);
    const lines: string[] = [];
    let firstError = '';
    for (const i of issues) {
      try { lines.push(verdict === 'approve' ? await acceptIssue(i) : verdict === 'ignore' ? await ignoreIssue(i) : await rejectIssue(i)); }
      catch (e) { firstError ||= String(e).replace(/^.*Error:\s*/, ''); }
    }
    setBusy(false);
    const failed = issues.length - lines.length;
    await after(issues.length === 1 ? (lines[0] ?? firstError) : `${verdict === 'approve' ? 'Approved' : verdict === 'ignore' ? 'Ignored' : 'Declined'} ${lines.length} of ${issues.length}${failed ? `. ${firstError}` : ''}`);
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
    <div key={i.key} id={`lh-${i.key}`} className={`conn-row nf-row mh-row${focus?.toLowerCase() === i.key ? ' focus' : ''}`}>
      <div className="conn-line nf-line" role="button" tabIndex={0} aria-label={i.title} onClick={() => onReview(i)} onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onReview(i); } }}>
        <label className="nf-check" onClick={stop}><input type="checkbox" checked={picked.has(i.key)} aria-label="Select" onChange={() => toggle(i.key)} /></label>
        <span className="nf-who"><img src={markReview} alt="Quorum, needs review" width={32} height={32} /></span>
        <span className="nf-main">
          <span className="nf-head"><strong className="conn-title nf-title">{i.title}</strong></span>
          <span className="nf-sub">{footerFacts(i).map((f, n) => <span key={f}>{n > 0 && <span className="nf-sep" aria-hidden="true"> • </span>}{f}</span>)}</span>
        </span>
        <span className="nf-side">
          <span className="nf-tools" onClick={stop} onKeyDown={stop}>
            {tab === 'left'
              ? <button className="act-pill" disabled={busy} onClick={() => back([i])}>Move back to review</button>
              : <>
                  <button className="mh-plain" disabled={busy} data-tip="Leave the link as it is and stop flagging it" onClick={() => decide([i], 'ignore')}>Ignore</button>
                  {i.action !== 'leave' && <button className="act-pill" disabled={busy} data-tip={i.decline} onClick={() => decide([i], 'reject')}>Decline</button>}
                  <button className="act-pill primary" disabled={busy || locked(i)} data-tip={locked(i) ? 'Waits until the run writing these notes finishes' : i.recommend} onClick={() => decide([i], 'approve')}>Approve</button>
                </>}
            <button className={`icon-btn conn-fold${unfolded.has(i.key) ? ' open' : ''}`} aria-expanded={unfolded.has(i.key)} aria-label={unfolded.has(i.key) ? 'Hide details' : 'Show details'} onClick={() => fold(i.key)}><IconChevron width={14} height={14} /></button>
          </span>
        </span>
      </div>
      {unfolded.has(i.key) && (
        <div className="conn-sub conn-fold-body nf-details mh-fold">
          {tab === 'left'
            ? <IssueParts parts={[['Left as is', 'The links stay as they are. Move it back to review to fix it later.']]} />
            : <IssueParts parts={[['Problem', i.problem], ['If fixed', i.effect], ['Approving this (Recommended)', i.recommend], ['Declining this', i.decline]]} />}
        </div>
      )}
    </div>
  );

  const filtered = !!(q || cats.length);
  const empty = items === null ? 'Checking your notes…'
    : filtered ? 'No issues match these filters.'
      : tab === 'left' ? 'Nothing left as is. Issues you decline stay here, out of review.'
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
          <button role="tab" aria-selected={tab === 'left'} className={tab === 'left' ? 'on' : ''} onClick={() => setTab('left')}>Left as is</button>
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
                  <button className="mh-plain" disabled={busy} onClick={() => decide(sel, 'ignore')}>Ignore</button>
                  <button className="act-pill" disabled={busy} onClick={() => decide(sel, 'reject')}>Decline</button>
                  <button className="act-pill primary" disabled={busy || sel.some(locked)} onClick={() => decide(sel, 'approve')}>Approve</button>
                </>}
          </span>
        </div>
      )}
      <div className="nf-list">{list.map(row)}</div>
      {!list.length && <div className="nf-empty"><p>{empty}</p></div>}
    </div>
  );
}

// The drawer for one Memory health issue in an open note: everything the Needs review notification has (the issue, its
// facts, the problem, what fixing it does, the recommendation, where the links come from), with Decline and Approve
export function IssueDrawer({ issue, at, total, locked, busy, onOpen, onDecide, onClose }: {
  issue: Issue; at: number; total: number; locked: boolean; busy: boolean; onOpen: (rel: string) => void; onDecide: (verdict: boolean | 'ignore') => void; onClose: () => void;
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
        <p className="nf-sub">{footerFacts(issue).join(' • ')}</p>
        <IssueParts parts={[['Problem', issue.problem], ['If fixed', issue.effect], ['Approving this (Recommended)', issue.recommend], ['Declining this', issue.decline]]} />
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
        <button className="mh-plain" disabled={busy || locked} data-tip="Leave the link as it is and stop flagging it" onClick={() => onDecide('ignore')}>Ignore</button>
        {issue.action !== 'leave' && <button className="act-pill" disabled={busy || locked} onClick={() => onDecide(false)}>Decline</button>}
        <button className="act-pill primary" disabled={busy || locked} data-tip={locked ? 'Waits until the run writing this note finishes' : undefined} onClick={() => onDecide(true)}>Approve</button>
      </footer>
    </aside>
  );
}
