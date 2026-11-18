import { useEffect, useState, type ReactNode } from 'react';
import type { LiveRun, MemoryVersion, Settings } from './quorum';
import { Row, Segmented, Toggle } from './controls';
import { Section } from './NoteTools';
import { useCatchupControl } from './Catchup';
import { IconArrowDown, IconArrowUp, IconCheck, IconClock, IconClose, IconHighlight, IconListCheck, IconStop } from './icons';

// Review of the changes Quorum's agents make to vault notes (memoryVersions.js) and of the issues Memory health finds
// (memoryHealth.js): the banner over an open note, the banner while a run is writing it, the versions in its side
// panel, the bar over a version opened read-only, and the settings in Settings > Memory

// who changed a note, the way the banners and the versions list name them
const WHO: Record<string, string> = { keeper: 'Upkeep', agent: 'Agent', cli: 'Quorum command', you: 'You', import: 'Import', maintenance: 'Maintenance' };
export const whoLabel = (who: string) => WHO[who] ?? who;
export const when = (at: number) => new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

export type ReviewMode = 'before' | 'after';

// one banner for both reviews: green or blue for updates, red for issues. Each part shows only when its handler is
// given: the Before and After toggle, the highlight switch, the arrows through the items, Accept and Reject, and
// Done. locked turns off the controls that change the note while a run is writing it
export function ReviewBanner({ tone, label, mode, onMode, highlight, onHighlight, nav, onAccept, onReject, words = false, acceptTip, rejectTip, onClose, locked = false }: {
  tone: 'green' | 'blue' | 'red' | 'orange'; label: ReactNode;
  mode?: ReviewMode; onMode?: (m: ReviewMode) => void;
  highlight?: boolean; onHighlight?: () => void;
  nav?: { at: number; total: number; onPrev: () => void; onNext: () => void };
  onAccept?: () => void; onReject?: () => void; words?: boolean; acceptTip?: string; rejectTip?: string;
  onClose?: () => void; locked?: boolean;
}) {
  return (
    <div className={`mu-banner ${tone}`} role="status">
      {onMode && mode && (
        <Segmented kind="pressed" className="mu-seg" label="Show the note before or after the updates" value={mode} onChange={onMode}
          options={[{ id: 'before', label: 'Before' }, { id: 'after', label: 'After' }]} />
      )}
      {onHighlight && (
        <button className={`icon-btn mu-icon ${highlight ? 'active' : ''}`} aria-pressed={!!highlight} aria-label={highlight ? 'Hide highlights' : 'Show highlights'}
          data-tip={highlight ? 'Hide highlights' : 'Show highlights'} onClick={onHighlight}><IconHighlight width={16} height={16} /></button>
      )}
      <span className="mu-count">{label}</span>
      {nav && nav.total > 0 && (
        <span className="mu-nav">
          <button className="icon-btn mu-icon" aria-label="Previous" data-tip="Previous" onClick={nav.onPrev}><IconArrowUp width={15} height={15} /></button>
          <span className="mu-pos">{nav.at >= 0 ? nav.at + 1 : '-'} of {nav.total}</span>
          <button className="icon-btn mu-icon" aria-label="Next" data-tip="Next" onClick={nav.onNext}><IconArrowDown width={15} height={15} /></button>
        </span>
      )}
      {/* a Memory health issue answers in words: Archive, Approve */}
      {words && (
        <span className="mu-nav mu-words">
          {onReject && <button className="act-pill" disabled={locked} data-tip={rejectTip} onClick={onReject}>Archive</button>}
          {onAccept && <button className="act-pill primary" disabled={locked} data-tip={acceptTip} onClick={onAccept}>Approve</button>}
        </span>
      )}
      {!words && (onAccept || onReject) && (
        <span className="mu-nav">
          {/* decline first, the check on the right, the same order as Decline and Approve everywhere else */}
          {onReject && <button className="icon-btn mu-icon mu-no" disabled={locked} aria-label={rejectTip ?? 'Reject'} data-tip={rejectTip ?? 'Reject'} onClick={onReject}><IconClose width={15} height={15} /></button>}
          {onAccept && <button className="icon-btn mu-icon mu-yes" disabled={locked} aria-label={acceptTip ?? 'Accept'} data-tip={acceptTip ?? 'Accept'} onClick={onAccept}><IconCheck width={16} height={16} /></button>}
        </span>
      )}
      {onClose && <button className="pill small-pill" onClick={onClose}>Done</button>}
    </div>
  );
}

// over a note a run is writing right now: edits wait until it finishes, and a stoppable run can be stopped
export function LiveBanner({ run, onStop }: { run: LiveRun; onStop: () => void }) {
  return (
    <div className="mu-banner live" role="status">
      <span className="mu-live-dot" aria-hidden="true" />
      <span className="mu-count">{run.label} is currently updating this page. Edits are locked until it finishes.</span>
      {run.stoppable && <button className="pill small-pill with-icon" disabled={run.stopping} onClick={onStop}><IconStop width={13} height={13} />{run.stopping ? 'Stopping…' : 'Stop'}</button>}
    </div>
  );
}

// the versions of the open note, newest first; one opens read-only in place of the note
export function VersionList({ rel, stamp, viewing, onView }: { rel: string; stamp: number; viewing: string | null; onView: (v: MemoryVersion) => void }) {
  const [list, setList] = useState<MemoryVersion[]>([]);
  useEffect(() => {
    let live = true;
    window.quorum.memoryVersions(rel).then((v) => { if (live) setList(v); });
    return () => { live = false; };
  }, [rel, stamp]);
  return (
    <Section title="Versions" count={list.length}>
      {list.length ? list.map((v) => (
        <button key={v.id} className={`np-item mu-version ${viewing === v.id ? 'on' : ''}`} disabled={v.created} onClick={() => onView(v)}
          data-tip={v.created ? 'The note did not exist before this change' : undefined} data-tip-pos="left">
          <strong>{when(v.at)}</strong>
          <span>{v.created ? `${whoLabel(v.who)} made this note` : `Before ${whoLabel(v.who)}${v.reason ? `: ${v.reason}` : ''}`}</span>
        </button>
      )) : <p className="np-empty">No versions yet. Quorum keeps one each time its agents change this note.</p>}
    </Section>
  );
}

// over a version opened read-only: what it is, Restore, and the way back to the current text
export function VersionBar({ version, busy, locked, onRestore, onClose }: { version: MemoryVersion; busy: boolean; locked: boolean; onRestore: () => void; onClose: () => void }) {
  return (
    <div className="mu-banner version" role="status">
      <span className="mu-count">Version from {when(version.at)}, before {whoLabel(version.who)}. Read only.</span>
      <span className="mu-actions">
        <button className="pill small-pill" onClick={onClose}>Back to current</button>
        <button className="pill small-pill" disabled={busy || locked} onClick={onRestore}>{busy ? 'Restoring…' : 'Restore'}</button>
      </span>
    </div>
  );
}

// Settings > Memory: whether agent changes are approved when made, whether changed text starts highlighted, and how
// long a blue dot stays in the tree
export function MemoryUpdatesCard({ settings, onSettings }: { settings: Settings; onSettings: (s: Settings) => void }) {
  const saved = settings.memoryDotDays ?? 30;
  const save = async (patch: Partial<Settings>) => onSettings(await window.quorum.setSettings(patch));
  // a whole number from 1 to 365 is saved; anything else puts the saved number back
  const commit = (el: HTMLInputElement) => {
    const n = Math.round(Number(el.value));
    if (Number.isFinite(n) && n >= 1 && n <= 365) { el.value = String(n); if (n !== saved) save({ memoryDotDays: n }); } else el.value = String(saved);
  };
  const cap = settings.memoryDraftCap ?? 40;
  const commitCap = (el: HTMLInputElement) => {
    const n = Math.round(Number(el.value));
    if (Number.isFinite(n) && n >= 1 && n <= 500) { el.value = String(n); if (n !== cap) save({ memoryDraftCap: n }); } else el.value = String(cap);
  };
  // how many model calls Check everything now runs at once, 1 to 6
  const parallel = settings.memoryCatchupParallel ?? 4;
  const commitParallel = (el: HTMLInputElement) => {
    const n = Math.round(Number(el.value));
    if (Number.isFinite(n) && n >= 1 && n <= 6) { el.value = String(n); if (n !== parallel) save({ memoryCatchupParallel: n }); } else el.value = String(parallel);
  };
  const catchup = useCatchupControl(settings.memoryDrafts === true);
  return (
    <>
      <h3>Memory updates</h3>
      <div className="set-card">
        <Row icon={<IconListCheck width={18} height={18} />} title="Auto-approve memory updates"
          desc="Changes Quorum's agents make to your notes count as approved when they are made. Turn this off to accept each change in the Memory tab.">
          <Toggle on={settings.memoryAutoApprove !== false} onChange={(v) => save({ memoryAutoApprove: v })} />
        </Row>
        <Row icon={<IconHighlight width={18} height={18} />} title="Highlight changed text"
          desc="An open note shows the text its updates changed in green, or blue once approved. The highlight button on the note turns it off for that view.">
          <Toggle on={settings.memoryHighlight !== false} onChange={(v) => save({ memoryHighlight: v })} />
        </Row>
        <Row icon={<IconListCheck width={18} height={18} />} title="Check memory in the background"
          desc="Memory health looks for out-of-date, duplicate, oversized and unlinked notes, frontmatter that does not fit its folder, misplaced confidential marks and written secrets. It checks every 3.5 hours and once a day while you are away. Turn this off to pause those checks; notes you save are still checked.">
          <Toggle on={settings.memorySweeps !== false} onChange={(v) => save({ memorySweeps: v })} />
        </Row>
        <Row icon={<IconListCheck width={18} height={18} />} title="Apply memory fixes on its own"
          desc="After each check, Quorum applies every Memory health fix that needs no review of its own as one batch, and lists it in Notifications with Undo. Fixes that conflict or need a review stay in Needs review. Off by default.">
          <Toggle on={settings.memoryAutoApply === true} onChange={(v) => save({ memoryAutoApply: v })} />
        </Row>
        <Row icon={<IconListCheck width={18} height={18} />} title="Let AI tools approve and undo memory changes"
          desc="Claude Code, Codex and other AI tools connected through the quorum MCP can approve and dismiss items in Needs review, undo fixes and create knowledge bases, through the same steps as the buttons here. Each fix shows which tool approved it and keeps its Undo. Reading Needs review, marking items read and Check everything now work without this. Off by default.">
          <Toggle on={settings.memoryAgentActions === true} onChange={(v) => save({ memoryAgentActions: v })} />
        </Row>
        <Row icon={<IconListCheck width={18} height={18} />} title="Let the agent draft fixes"
          desc="For fixes the rules cannot decide (a missing note to write, a weak relink or alias, two notes that repeat each other), the agent reads those notes and drafts the fix with quoted lines and a confidence. It runs on your own Claude Code sign-in, reads only the notes Quorum gives it, and changes nothing until you approve. It waits while you record or type. Off by default.">
          <Toggle on={settings.memoryDrafts === true} onChange={(v) => save({ memoryDrafts: v })} />
        </Row>
        <Row icon={<IconListCheck width={18} height={18} />} title="Check everything now" desc={catchup.desc}>
          {catchup.control}
        </Row>
        {settings.memoryDrafts === true && (
          <>
            <Row icon={<IconClock width={18} height={18} />} title="Drafts per day"
              desc="The agent stops drafting for the day after this many drafts.">
              <label className="mu-days">
                <input key={cap} type="number" min={1} max={500} defaultValue={cap} aria-label="Drafts per day"
                  onBlur={(e) => commitCap(e.currentTarget)} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
                <span>drafts</span>
              </label>
            </Row>
            <Row icon={<IconClock width={18} height={18} />} title="Calls at once in Check everything now"
              desc="How many model calls the check runs side by side. More finishes sooner; each call counts against your Claude Code plan's limits. Drafts per day does not apply to the check.">
              <label className="mu-days">
                <input key={parallel} type="number" min={1} max={6} defaultValue={parallel} aria-label="Calls at once in Check everything now"
                  onBlur={(e) => commitParallel(e.currentTarget)} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
                <span>calls</span>
              </label>
            </Row>
            <Row icon={<IconListCheck width={18} height={18} />} title="Let the agent read confidential notes"
              desc="Off: a note marked confidential, or in a folder marked confidential, is never sent to the agent, and a fix that needs one gets no draft. Folders the read guard blocks are never sent.">
              <Toggle on={settings.memoryDraftConfidential === true} onChange={(v) => save({ memoryDraftConfidential: v })} />
            </Row>
          </>
        )}
        <Row icon={<IconClock width={18} height={18} />} title="Hide update dots after"
          desc="A blue dot in the Memory tree goes away when you open the note or after this many days. A green dot stays until you accept its updates.">
          <label className="mu-days">
            <input key={saved} type="number" min={1} max={365} defaultValue={saved} aria-label="Days before update dots hide"
              onBlur={(e) => commit(e.currentTarget)} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
            <span>days</span>
          </label>
        </Row>
      </div>
    </>
  );
}
