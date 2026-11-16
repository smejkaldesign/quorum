import { useCallback, useEffect, useRef, useState } from 'react';
import type { MissingLink } from './quorum';
// every Quorum agent row shows the blue mark; review state shows through the badges and counts
import markReview from '../assets/quorum-mark.png';
import { CATEGORIES, HEALTH_SORTS, categoryCounts, countsLine, healthList, issueMeta, type HealthCategory, type HealthSort, type Issue } from '../memoryHealth.js';
import { IconArchive, IconCheck, IconChevron, IconClose, IconReset } from './icons';
import { PickMenu, SearchButton, SearchField } from './FilterBar';
import { BulkPick, DismissButton, IssueParts, ReviewDetails, RowMenu, RunBanner, StatusBadge, StatusSwap, UndoMenu, ViewButton, ago, runStatus } from './NotificationsView';
import type { FixRun, GateHold, MemoryDraft, MemoryFinding } from './quorum';
import { MemoryFindings } from './MemoryFindings';
import { toast } from './Toasts';
import { Segmented } from './controls';
import { BulkPlan } from './BulkPlan';
import { AgentActivityBanner, WorkBanner } from './WorkBanner';
import { NO_SELECTION, bulkView, dropAcross, selectedIds, toggleAcross, toggleOne, togglePage, type BulkSel } from './bulkSelect';

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
// Archive on an issue sets it aside without fixing it; it lists under Archived, read Dismissed, until moved back
export const dismissIssue = async (issue: Issue) => { await window.quorum.activityArchive([{ id: `r:link:${issue.key}` }], true); return 'Archived without fixing it'; };
const CHANGED = 'quorum:activity-changed';

// All (the default), Unread and Archived, the same bar and the same read and archive marks as Notifications; Needs
// review narrows All to the items waiting for a decision. Decided items list under Archived: a fix once it finished
// (Accepted or Failed), an issue archived without fixing it (Dismissed). Not shown yet lists what the quality gate
// (qualityGate.js) holds back, each with its reason; it shows only while there is something in it
type Tab = 'all' | 'unread' | 'archived' | 'held';
const issueId = (key: string) => `r:link:${key}`;
const runId = (r: FixRun) => `f:${r.id}`;
// the rows listed at first; Show more adds as many again
const PAGE = 50;

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
  const [bulk, setBulk] = useState<BulkSel>(NO_SELECTION);
  const [shownN, setShownN] = useState(PAGE);
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);
  const [runs, setRuns] = useState<FixRun[]>([]);
  // the review rules' findings (rules/index.js), listed under the link issues
  const [findings, setFindings] = useState<MemoryFinding[]>([]);
  const [drafts, setDrafts] = useState<Record<string, MemoryDraft>>({});
  // the quality gate: whether a vault's first check is still running, and the items it holds back
  const [gate, setGate] = useState<{ checking: boolean; held: (GateHold & { id: string })[] }>({ checking: false, held: [] });
  // the issues whose Approve was pressed: a spinner in place of the button until their run takes over
  const [approving, setApproving] = useState<Set<string>>(new Set());
  // a bulk Approve: the issues in it and when it began, for the progress row under the bulk bar
  // the read and archive marks Notifications keeps for these items
  const [marks, setMarks] = useState<{ unread: Set<string>; archived: Set<string> }>({ unread: new Set(), archived: new Set() });
  // the latest bulk Approve, read from the runs Quorum keeps, so its progress shows again after leaving and coming back.
  // Dismiss hides it on this Mac
  const [hiddenBatch, setHiddenBatch] = useState<string | null>(() => { try { return localStorage.getItem('quorum.hiddenBatch'); } catch { return null; } });
  // the bulk plan sheet: Approve on several issues (their row ids), or Review everything (null: all of Needs review)
  const [plan, setPlan] = useState<{ ids: string[] | null; everything: boolean } | null>(null);
  const load = useCallback((fresh = false) => {
    window.quorum.fixRuns().then(setRuns).catch(() => {});
    window.quorum.memoryFindings().then((r) => { setFindings(r.findings.filter((f) => !f.held)); setDrafts(r.drafts ?? {}); }).catch(() => {});
    window.quorum.memoryGate().then((g) => setGate({ checking: g.checking, held: g.held })).catch(() => {});
    const q = { kinds: ['memory-health' as const], limit: 5000, idsOnly: true as const };
    Promise.all([window.quorum.activityFeed({ ...q, tab: 'all' }), window.quorum.activityFeed({ ...q, tab: 'archived' })])
      .then(([a, z]) => setMarks({ unread: new Set(a.items.filter((r) => r.unread).map((r) => r.id)), archived: new Set(z.items.map((r) => r.id)) })).catch(() => {}); return window.quorum.vaultLinkHealth(fresh).then(setItems); }, []);
  useEffect(() => { migrateLeft().finally(() => load()); }, [load]);
  useEffect(() => window.quorum.onVaultChanged(() => { load(); }), [load]);
  // a run's progress, and the list again once it ends
  useEffect(() => window.quorum.onFixRun((r) => { setRuns((xs) => [r, ...xs.filter((x) => x.id !== r.id)]); setApproving((ks) => { if (!ks.has(r.key)) return ks; const n = new Set(ks); n.delete(r.key); return n; }); if (r.status === 'success' || r.status === 'error') { load(); window.setTimeout(() => load(), 8300); } }), [load]);
  // an issue answered in Notifications leaves this list too: both read the same issues
  useEffect(() => { const go = () => { load(); }; window.addEventListener(CHANGED, go); return () => window.removeEventListener(CHANGED, go); }, [load]);
  useEffect(() => { if (focus) document.getElementById(`lh-${focus.toLowerCase()}`)?.scrollIntoView({ block: 'center' }); }, [focus, items]);
  // a new tab, filter, sort or search starts again at the first page with nothing picked
  useEffect(() => { setBulk(NO_SELECTION); setShownN(PAGE); }, [tab, review, cats, q, sort]);

  const all = (items ?? []).filter((m) => !m.held);
  const left = leftOf(all);
  const counts = categoryCounts(all, left);
  // an issue being fixed keeps its row and place, loading, until its run ends; then the run lists under Accepted
  // a batch is live for each link issue in it
  const liveRuns = new Map(runs.filter((r) => r.status === 'queued' || r.status === 'running').flatMap((r) => (r.kind === 'batch' ? (r.items ?? []).filter((i) => i.kind === 'link').map((i) => [i.key, r] as const) : [[r.key, r] as const])));
  const open = healthList(all, { tab: 'open', categories: cats, q, sort, left });
  const openKeys = new Set(all.map((i) => i.target.toLowerCase()));
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const ended = cats.length ? [] : runs
    .filter((r) => !r.undoneAt && (r.endedAt || !openKeys.has(r.key)) && words.every((w) => r.target.toLowerCase().includes(w)))
    .sort((a, b) => (b.endedAt ?? b.queuedAt) - (a.endedAt ?? a.queuedAt));
  const shelved = ended.filter((r) => marks.archived.has(runId(r)));
  const showing = ended.filter((r) => !marks.archived.has(runId(r)));
  const unreadOf = (e: Entry) => marks.unread.has('issue' in e ? issueId(e.issue.key) : runId(e.run));
  type Entry = { issue: Issue } | { run: FixRun };
  // All: the items to decide, then the fixes, newest first; a fixed item leaves its place without pushing the list.
  // Needs review keeps only the items
  const lively: Entry[] = [...open.map((issue) => ({ issue })), ...showing.map((run) => ({ run }))];
  const entries: Entry[] = tab === 'held' || gate.checking ? [] : tab === 'archived'
    ? [...shelved.map((run) => ({ run })), ...healthList(all, { tab: 'left', categories: cats, q, sort, left }).map((issue) => ({ issue }))]
    : review ? open.map((issue) => ({ issue })).filter((e) => tab !== 'unread' || unreadOf(e))
      : tab === 'unread' ? lively.filter(unreadOf) : lively;
  const unreadN = lively.filter(unreadOf).length;
  const list = entries.flatMap((e) => ('issue' in e ? [e.issue] : []));
  const idOf = (e: Entry) => ('issue' in e ? e.issue.key : e.run.id);
  const openN = open.filter((i) => !liveRuns.has(i.key)).length + findings.filter((f) => !f.archived).length;
  // findings show under All, Needs review and Archived, and only when no link type filter is on
  const findingsShown = !cats.length && tab !== 'unread' && tab !== 'held' && !gate.checking && findings.some((f) => f.archived === (tab === 'archived'));
  // a fix writes the linking notes or the matched note, so it waits while a run is writing any of them
  const locked = (i: Issue) => [...i.sources, ...(i.candidate ? [i.candidate.rel] : [])].some(isLive);

  const refresh = async () => { setBusy(true); try { await window.quorum.memorySweepNow().catch(() => null); await load(true); } finally { setBusy(false); } };
  const archiveFindings = async (keys: string[], on: boolean) => {
    await window.quorum.memoryFindingsArchive(keys, on);
    toast(on ? (keys.length === 1 ? 'Archived. It comes back if its evidence changes.' : `Archived ${keys.length}. They come back if their evidence changes.`) : keys.length === 1 ? 'Moved back' : `Moved ${keys.length} back`);
    await after(on ? `Archived ${keys.length === 1 ? 'it' : keys.length}` : 'Moved back to review');
  };
  // Approve on a finding runs through the planner as one batch: its fix, the change its rule allows, or keep as is
  const approveFinding = async (f: MemoryFinding) => {
    const { failed } = await window.quorum.activityReview([{ kind: 'finding', abs: f.abs, key: f.key }], 'approve');
    if (failed.length) { toast(failed[0].error, 'error'); return; }
    toast(f.approve?.kind === 'keep' || (!f.approve && !f.fix) ? `Kept “${f.title}” as it is and marked it done.` : `Approved “${f.title}”. Quorum is applying it now.`);
    await after('Approved');
  };
  const after = async (msg: string) => {
    setDone(msg);
    setBulk(NO_SELECTION);
    await load();
    onChanged();
    window.dispatchEvent(new Event(CHANGED));
  };
  // one or many issues decided; the list, the tree, the button count and Notifications all read again
  const decide = async (issues: Issue[], verdict: 'approve' | 'dismiss') => {
    if (verdict === 'approve') setApproving((s) => new Set([...s, ...issues.map((i) => i.key)]));
    setBusy(true);
    const lines: string[] = [];
    let firstError = '';
    // several approved at once go through the bulk plan sheet (BulkPlan.tsx), which runs them as one batch
    for (const i of issues) {
      try { lines.push(verdict === 'approve' ? await acceptIssue(i) : (await window.quorum.activityArchive([{ id: issueId(i.key) }], true), 'Archived without fixing it')); }
      catch (e) { firstError ||= String(e).replace(/^.*Error:\s*/, ''); setApproving((ks) => { const n = new Set(ks); n.delete(i.key); return n; }); }
    }
    setBusy(false);
    const failed = issues.length - lines.length;
    const one = issues.length === 1 ? `“${issues[0].target}”` : `${issues.length} issues`;
    if (failed && !lines.length) toast(firstError || 'That did not work', 'error');
    else toast(verdict === 'approve' ? `Approved ${one}. Quorum is fixing ${issues.length === 1 ? 'it' : 'them'} now.` : `Archived ${one} without fixing ${issues.length === 1 ? 'it' : 'them'}. ${issues.length === 1 ? 'It is' : 'They are'} under Archived when you want ${issues.length === 1 ? 'it' : 'them'} again.`);
    await after(issues.length === 1 ? (lines[0] ?? firstError) : `${verdict === 'approve' ? 'Approved' : 'Archived'} ${lines.length} of ${issues.length}${failed ? `. ${firstError}` : ''}`);
  };
  const back = async (issues: Issue[], fixes: FixRun[] = []) => {
    await window.quorum.activityArchive([...issues.map((i) => ({ id: issueId(i.key) })), ...fixes.map((r) => ({ id: runId(r) }))], false);
    toast(issues.length + fixes.length === 1 ? 'Moved back' : `Moved ${issues.length + fixes.length} back`);
    await after(issues.length === 1 ? 'Moved back to review' : `Moved ${issues.length} back to review`);
  };

  // the first pages of the list, and far enough to show the issue a link opened here for
  const focusAt = focus ? entries.findIndex((e) => 'issue' in e && e.issue.key === focus.toLowerCase()) : -1;
  const pageEntries = entries.slice(0, Math.max(shownN, focusAt + 1));
  const pageIds = pageEntries.map(idOf);
  const view = bulkView(pageIds, bulk, entries.length);
  // with Select all on, every entry that matches counts as picked, on this page or not
  const picked = new Set(selectedIds(bulk, pageIds, entries.map(idOf)));
  // the Approve mark stays until the issue's run reports in (see onFixRun), so the row never flickers between the two
  const sel = list.filter((i) => picked.has(i.key) && !liveRuns.has(i.key));
  const pickedRuns = entries.flatMap((e) => ('run' in e && picked.has(e.run.id) && e.run.endedAt ? [e.run] : []));
  const pickedLeft = tab === 'archived' ? entries.flatMap((e) => ('issue' in e && picked.has(e.issue.key) ? [e.issue] : [])) : [];
  const markRead = async (ids: string[]) => { await window.quorum.activityMark(ids.map((id) => ({ id, abs: "" })), false).catch(() => 0); load(); window.dispatchEvent(new Event(CHANGED)); };
  const toggle = (k: string) => setBulk((s) => toggleOne(k, s, pageIds));
  const clear = () => setBulk(NO_SELECTION);
  const catLabel = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.label])) as Record<HealthCategory, string>;

  // View opens the note on its issue with the drawer open; a click on the row or the chevron folds the write-up open
  const [unfolded, setUnfolded] = useState<Set<string>>(new Set());
  const fold = (k: string) => setUnfolded((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const row = (i: Issue) => {
    const fixRun = liveRuns.get(i.key);
    const working = approving.has(i.key) || !!fixRun;
    const waiting = fixRun ? fixRun.status === 'queued' : false;
    return (
    <div key={i.key} id={`lh-${i.key}`} className={`conn-row nf-row mh-row${focus?.toLowerCase() === i.key ? ' focus' : ''}${working ? (waiting ? ' working waiting' : ' running working') : ''}`}>
      <div className="conn-line nf-line" role="button" tabIndex={0} aria-label={i.title} aria-expanded={unfolded.has(i.key)} onClick={() => fold(i.key)} onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); fold(i.key); } }}>
        <label className="nf-check" onClick={stop}><input type="checkbox" checked={picked.has(i.key)} aria-label="Select" onChange={() => toggle(i.key)} /></label>
        <span className="nf-who"><img src={markReview} alt="Quorum, needs review" width={32} height={32} /></span>
        <span className="nf-main">
          <span className="nf-head"><strong className="conn-title nf-title" data-tip={i.title}>{i.title}</strong>{tab !== 'archived' && marks.unread.has(issueId(i.key)) && <i className="nf-dot" role="img" aria-label="Unread" data-tip="Unread" />}</span>
          <span className="nf-sub"><span className="nf-when" title={i.lastAt ? new Date(i.lastAt).toLocaleString() : undefined}>{i.lastAt ? ago(i.lastAt) : ''}</span></span>
        </span>
        <span className="nf-side mh-side">
          {/* the date sits on the right; on hover it slides out and the actions slide in, the way Home's rows do */}
          <span className="mh-swap" onClick={stop} onKeyDown={stop}>
            <span className="mh-when"><StatusBadge status={tab === 'archived' ? 'dismissed' : waiting ? 'waiting' : 'review'} /></span>
            <span className="mh-hover">
              {/* View opens the note on its issue with the drawer open */}
              <ViewButton onView={() => { if (marks.unread.has(issueId(i.key))) markRead([issueId(i.key)]); onReview(i); }} />
              {tab === 'archived'
                ? <RowMenu label="Move back to review" onPick={() => back([i])} />
                : <>
                    <DismissButton disabled={busy || working} onDismiss={() => decide([i], 'dismiss')} />
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
          {tab === 'archived'
            ? <><IssueParts parts={[['Dismissed', 'Archived without fixing it. The links stay as they are; move it back to review to fix it later.']]} /><ReviewDetails meta={issueMeta(i)} /></>
            : <>{fixRun && <RunBanner run={{ ...fixRun, showBanner: true }} />}<ReviewDetails recommendation={fixRun ? undefined : i.recommend} problem={i.problem} solution={i.solution} value={i.value} meta={issueMeta(i)} /></>}
        </div>
        </div>
      </div>
    </div>
    );
  };

  const filtered = !!(q || cats.length);
  const empty = items === null ? 'Checking your notes…'
    : gate.checking ? 'Checking your memory, this takes a minute. Quorum checks every suggestion several times before it shows it.'
    : filtered ? 'No issues match these filters.'
      : tab === 'archived' ? 'Nothing archived. Fixes list here once they finish, and so do items you archive without fixing.'
        : tab === 'unread' ? 'Nothing unread.'
          : 'Every link points at a note. The Quorum agent keeps watching your memories and lists new ways to improve them here as they come up.';

  return (
    <div className="link-health mh-page" role="region" aria-label="Memory health">
      <div className="lh-head">
        <h2>Memory health</h2>
        <span className="mh-head-actions">
          <button className="act-pill" disabled={busy || !openN} data-tip="Plan a fix for everything in Needs review, then choose what runs" onClick={() => setPlan({ ids: null, everything: true })}>Review everything</button>
          <button className={`icon-btn ${busy ? 'spinning' : ''}`} aria-label="Check again" data-tip="Check again" disabled={busy} onClick={refresh}><IconReset width={16} height={16} /></button>
          <button className="icon-btn" aria-label="Close Memory health" data-tip="Back to graph" onClick={onClose}><IconClose width={16} height={16} /></button>
        </span>
      </div>
      <p className="lh-sum">
        {items === null ? 'Checking your notes…' : gate.checking ? 'Checking your memory, this takes a minute' : !counts.length ? 'Every link points at a note.' : countsLine(counts)}
        {!gate.checking && gate.held.length > 0 && <span>{gate.held.length} {gate.held.length === 1 ? 'suggestion' : 'suggestions'} not shown yet. Quorum shows a suggestion once it is sure enough of it.</span>}
        {done && <span className="lh-done">{done}</span>}
      </p>
      <div className="nf-bar">
        <Segmented kind="tabs" label="Show" value={tab} onChange={(id) => { setTab(id); if (id === 'archived' || id === 'held') setReview(false); }}
          options={([['all', 'All'], ['unread', 'Unread'], ['archived', 'Archived'], ...(gate.held.length || tab === 'held' ? [['held', 'Not shown yet']] : [])] as [Tab, string][]).map(([id, label]) => ({ id, label: <>{label}{id === 'unread' && unreadN ? <span className="nf-count">{unreadN}</span> : id === 'held' && gate.held.length ? <span className="nf-count">{gate.held.length}</span> : null}</> }))} />
        <button className={`nf-toggle${review ? ' on' : ''}`} aria-pressed={review} onClick={() => { setReview((r) => !r); if (tab === 'archived' || tab === 'held') setTab('all'); }}>
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
          <BulkPick view={view} across={bulk.across} onPage={() => setBulk((s) => togglePage(pageIds, s))} onAcross={() => setBulk((s) => toggleAcross(pageIds, s))} />
          <span className={`nf-bulk-actions${view.count ? '' : ' hidden'}`} aria-hidden={!view.count}>
            {tab === 'archived'
              ? <button className="act-pill" disabled={busy} onClick={async () => { await back(pickedLeft, pickedRuns); clear(); await load(); window.dispatchEvent(new Event(CHANGED)); }}>Move back</button>
              : <>
                  {/* left to right: Archive, Mark read, and Approve as the primary action on the far right */}
                  <button className="icon-btn mh-icon" disabled={busy} aria-label="Archive" data-tip="Archive: set them aside without fixing them" onClick={async () => { if (pickedRuns.length) { await window.quorum.activityArchive(pickedRuns.map((r) => ({ id: runId(r) })), true); for (const r of pickedRuns) await window.quorum.fixDismiss([r.id]).catch(() => 0); } if (sel.length) await decide(sel, 'dismiss'); else { clear(); load(); } }}><IconArchive width={16} height={16} /></button>
                  <button className="act-pill" disabled={busy || !entries.some((e) => picked.has(idOf(e)) && unreadOf(e))} onClick={async () => { await markRead(entries.filter((e) => picked.has(idOf(e)) && unreadOf(e)).map((e) => ('issue' in e ? issueId(e.issue.key) : runId(e.run)))); clear(); }}>Mark read</button>
                  <button className="act-pill primary" disabled={busy || !sel.length || sel.some(locked)} onClick={() => (sel.length > 1 ? setPlan({ ids: sel.map((i) => issueId(i.key)), everything: false }) : decide(sel, 'approve'))}>Approve</button>
                </>}
          </span>
        </div>
      )}
      {/* long agent work on the memory (the first check, a full sweep, a batch, drafting), the same banner as on Home */}
      <AgentActivityBanner />
      {(() => {
        const last = runs.filter((r) => r.batch).sort((a, b) => b.queuedAt - a.queuedAt)[0]?.batch;
        if (!last || last === hiddenBatch) return null;
        const list = runs.filter((r) => r.batch === last && !r.undoneAt).flatMap((r) => (r.kind === 'batch' ? batchItems(r) : [r]));
        const one = runs.find((r) => r.batch === last && r.kind === 'batch');
        if (!list.length) return null;
        return <BatchBanner runs={list} error={one?.status === 'error' ? one.error : null} onDismiss={() => { setHiddenBatch(last); try { localStorage.setItem('quorum.hiddenBatch', last); } catch { /* the banner just shows again next time */ } }} />;
      })()}
      <div className="nf-list">{pageEntries.map((e) => ('issue' in e ? row(e.issue) : <RunRow key={e.run.id} run={e.run} unread={tab !== 'archived' && unreadOf(e)} picked={picked.has(e.run.id)} onPick={() => toggle(e.run.id)} />))}</div>
      {entries.length > pageEntries.length && <button className="act-pill nf-more-btn" onClick={() => { setShownN(pageEntries.length + PAGE); setBulk(dropAcross); }}>Show more</button>}
      {findingsShown && <MemoryFindings findings={findings} drafts={drafts} archived={tab === 'archived'} q={q} unread={marks.unread} onArchive={archiveFindings} onApprove={approveFinding} onRead={markRead} />}
      {tab === 'held' && !gate.checking && gate.held.length > 0 && (
        <div className="set-card mr-rules" aria-label="Not shown yet">
          {gate.held.map((h) => (
            <div key={h.id} className="set-line mr-rule">
              <span className="mr-name"><strong>{h.title}</strong><span className="muted">{h.line}</span><span className="muted">{h.why}</span></span>
              {h.bucket === 'check' && <span className="mr-counts"><span className="mr-count" data-tip="It waits unticked in Review everything">Check these first</span></span>}
            </div>
          ))}
        </div>
      )}
      {!entries.length && !findingsShown && !(tab === 'held' && gate.held.length > 0) && <div className="nf-empty"><p>{tab === 'held' && !gate.checking ? 'Every suggestion Quorum checked is in Needs review.' : empty}</p></div>}
      {plan && <BulkPlan ids={plan.ids} everything={plan.everything} onClose={() => setPlan(null)} onApplied={() => { clear(); load(); onChanged(); window.dispatchEvent(new Event(CHANGED)); }} />}
    </div>
  );
}

// The drawer for one Memory health issue in an open note: everything the Needs review notification has (the issue, its
// facts, the problem, what fixing it does, the recommendation, where the links come from), with Decline and Approve
export function IssueDrawer({ issue, at, total, locked, busy, run, fixing, onOpen, onDecide, onClose, onNext }: {
  issue: Issue; at: number; total: number; locked: boolean; busy: boolean; run?: FixRun; fixing?: boolean; onOpen: (rel: string) => void; onDecide: (approve: boolean) => void; onClose: () => void; onNext?: () => void;
}) {
  // after Approve: the agent working (the banner with its steps, the title shimmering), then Fixed in green or Not
  // fixed in grey; the item has left Needs review
  const live = fixing && (!run || run.status === 'queued' || run.status === 'running');
  const ended = fixing && !live;
  const kind = !fixing ? `Needs review · ${at + 1} of ${total}` : live ? 'Fixing' : run?.status === 'success' ? 'Fixed' : 'Not fixed';
  const shown = issue.sources.slice(0, 8);
  const c = issue.candidate;
  return (
    <aside className={`mh-drawer${live ? ' running' : ''}${ended ? (run?.status === 'success' ? ' fixed' : ' not-fixed') : ''}`} role="dialog" aria-label="Memory health issue" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
      <header className="mh-drawer-head">
        <img src={markReview} alt="" width={24} height={24} />
        <span className="mh-drawer-kind">{kind}</span>
        <button className="icon-btn" aria-label="Close" data-tip="Close" onClick={onClose}><IconClose width={16} height={16} /></button>
      </header>
      <div className="mh-drawer-body">
        <h3 className="nf-title">{issue.title}</h3>
        {fixing && <RunBanner run={run ?? { id: '', key: issue.key, target: issue.target, title: issue.title, rel: issue.path, status: 'queued', queuedAt: 0, startedAt: null, endedAt: null, steps: [], outcome: null, error: null, dismissedAt: null }} />}
        <ReviewDetails recommendation={fixing ? undefined : issue.recommend} problem={issue.problem} solution={issue.solution} value={issue.value} meta={issueMeta(issue)} />
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
        {fixing
          ? live
            ? <span className="mh-drawer-wait"><i className="run-spin" /> Quorum is fixing it</span>
            : onNext ? <button className="act-pill primary" onClick={onNext}>Next item</button> : <button className="act-pill primary" onClick={onClose}>Done</button>
          : <>
              <button className="act-pill" disabled={busy || locked} data-tip="Set it aside without fixing it" onClick={() => onDecide(false)}>Archive</button>
              <button className="act-pill primary" disabled={busy || locked} data-tip={locked ? 'Waits until the run writing this note finishes' : undefined} onClick={() => onDecide(true)}>Approve</button>
            </>}
      </footer>
    </aside>
  );
}

// a fix run in Memory health: the same row as an issue, shimmering while it works, with its banner and the issue's
// details folded open below
function RunRow({ run, unread, picked, onPick }: { run: FixRun; unread: boolean; picked: boolean; onPick: () => void }) {
  const [open, setOpen] = useState(!!run.showBanner);
  const live = run.status === 'queued' || run.status === 'running';
  const n = run.items?.length ?? 0;
  const what = `${n} memory ${n === 1 ? 'fix' : 'fixes'}`;
  const line = run.kind === 'batch'
    ? run.status === 'queued' ? `Waiting to apply ${what}` : live ? `Applying ${what}` : run.status === 'success' ? (run.auto ? `Quorum applied ${what} on its own` : `Applied ${what}`) : `Could not apply ${what}`
    : run.status === 'queued' ? `Waiting to fix “${run.target}”` : live ? `Fixing “${run.target}”` : run.status === 'success' ? `Fixed “${run.target}”` : `Could not fix “${run.target}”`;
  return (
    <div className={`conn-row nf-row mh-row${live ? ' running' : ''}`}>
      <div className="conn-line nf-line">
        <label className="nf-check"><input type="checkbox" checked={picked} aria-label="Select" onChange={onPick} /></label>
        <span className="nf-who"><img src={markReview} alt="" width={32} height={32} /></span>
        <span className="nf-main">
          <span className="nf-head"><strong className="conn-title nf-title" data-tip={line}>{line}</strong>{unread && <i className="nf-dot" role="img" aria-label="Unread" data-tip="Unread" />}</span>
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

// a batch run's items as the banner lists them, each with its own state; a failed batch put every item back
const batchItems = (r: FixRun): FixRun[] => (r.items ?? []).map((it) => ({ ...r, id: it.id, key: it.key, target: it.line || it.title, status: r.status === 'error' ? 'error' : it.status, steps: it.status === 'running' ? r.steps : [] }));

// a bulk Approve's progress, full width under the bulk bar: the item being fixed shimmers here and in its row, the bar
// fills as items finish, and the fold lists every item with its state. Done, it says how many were fixed
function BatchBanner({ runs, error, onDismiss }: { runs: FixRun[]; error?: string | null; onDismiss: () => void }) {
  const [open, setOpen] = useState(false);
  const items = [...runs].sort((a, b) => a.queuedAt - b.queuedAt).map((r) => ({ k: r.id, title: r.target, run: r }));
  const ok = items.filter((x) => x.run.status === 'success').length;
  const bad = items.filter((x) => x.run.status === 'error').length;
  const finished = ok + bad;
  const now = items.find((x) => x.run.status === 'running');
  const live = finished < items.length;
  const text = live
    ? `Fixing ${finished + 1} of ${items.length}${now ? `: “${now.title}”${now.run.steps.length ? `, ${now.run.steps[now.run.steps.length - 1].label.toLowerCase()}` : ''}` : ''}`
    : `Fixed ${ok} of ${items.length}${bad ? `. ${bad} could not be fixed` : ''}`;
  return (
    <WorkBanner
      state={live ? 'live' : bad && !ok ? 'error' : 'success'} text={text} startedAt={Math.min(...items.map((x) => x.run.queuedAt))} endedAt={Math.max(...items.map((x) => x.run.endedAt ?? 0))}
      progress={finished / items.length}
      note={live ? 'This can take a few minutes. You can leave this page; Quorum keeps fixing in the background and each item updates as it finishes.' : error}
      actions={<>
        <button className={`icon-btn conn-fold${open ? ' open' : ''}`} aria-expanded={open} aria-label={open ? 'Hide items' : 'Show items'} onClick={() => setOpen((o) => !o)}><IconChevron width={14} height={14} /></button>
        {!live && <button className="act-pill run-dismiss" onClick={onDismiss}>Dismiss</button>}
      </>}
    >
      <div className={`fold-anim${open ? ' open' : ''}`}>
        <div className="fold-inner">
          <ol className="run-steps mh-batch-list">
            {items.map((x) => {
              const st = x.run.status;
              return <li key={x.k} className={st === 'running' ? 'now' : st === 'success' || st === 'error' ? 'done' : ''}><span className={st === 'running' ? 'shimmer' : ''} data-tip={x.title}>{x.title}</span><span className="run-time">{st === 'success' ? 'Fixed' : st === 'error' ? 'Could not fix' : st === 'running' ? 'Fixing' : 'Waiting'}</span></li>;
            })}
          </ol>
        </div>
      </div>
    </WorkBanner>
  );
}
