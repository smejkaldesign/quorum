import { useEffect, useState } from 'react';
import type { MemoryReview, MemoryVersion, Settings } from './quorum';
import { Row, Toggle } from './controls';
import { Section } from './NoteTools';
import { IconCheck, IconClock, IconListCheck } from './icons';

// Review of the changes Quorum's agents make to vault notes (memoryVersions.js): the banner over an open note, the
// versions in its side panel, the bar over a version opened read-only, and the two settings in Settings > Memory

// who changed a note, the way the banner and the versions list name them
const WHO: Record<string, string> = { keeper: 'Upkeep', agent: 'Agent', cli: 'Quorum command', you: 'You', import: 'Import', maintenance: 'Maintenance' };
export const whoLabel = (who: string) => WHO[who] ?? who;
export const when = (at: number) => new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

export type ReviewMode = 'before' | 'after';

// the count and time of the updates, the Before and After toggle, and Accept while they wait for approval
export function UpdateBanner({ review, mode, onMode, onAccept }: { review: MemoryReview; mode: ReviewMode; onMode: (m: ReviewMode) => void; onAccept: () => void }) {
  const waiting = review.dot === 'green';
  return (
    <div className={`mu-banner ${review.dot}`} role="status">
      <div className="seg mu-seg" role="group" aria-label="Show the note before or after the updates">
        <button className={mode === 'before' ? 'on' : ''} aria-pressed={mode === 'before'} onClick={() => onMode('before')}>Before</button>
        <button className={mode === 'after' ? 'on' : ''} aria-pressed={mode === 'after'} onClick={() => onMode('after')}>After</button>
      </div>
      <span className="mu-count">{review.count} {review.count === 1 ? 'update' : 'updates'} on {when(review.at)}</span>
      {waiting
        ? <button className="pill small-pill with-icon mu-accept" onClick={onAccept}><IconCheck width={15} height={15} />Accept updates</button>
        : <span className="mu-approved">Approved</span>}
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
export function VersionBar({ version, busy, onRestore, onClose }: { version: MemoryVersion; busy: boolean; onRestore: () => void; onClose: () => void }) {
  return (
    <div className="mu-banner version" role="status">
      <span className="mu-count">Version from {when(version.at)}, before {whoLabel(version.who)}. Read only.</span>
      <span className="mu-actions">
        <button className="pill small-pill" onClick={onClose}>Back to current</button>
        <button className="pill small-pill" disabled={busy} onClick={onRestore}>{busy ? 'Restoring…' : 'Restore'}</button>
      </span>
    </div>
  );
}

// Settings > Memory: whether agent changes are approved when made, and how long a blue dot stays in the tree
export function MemoryUpdatesCard({ settings, onSettings }: { settings: Settings; onSettings: (s: Settings) => void }) {
  const saved = settings.memoryDotDays ?? 30;
  const save = async (patch: Partial<Settings>) => onSettings(await window.quorum.setSettings(patch));
  // a whole number from 1 to 365 is saved; anything else puts the saved number back
  const commit = (el: HTMLInputElement) => {
    const n = Math.round(Number(el.value));
    if (Number.isFinite(n) && n >= 1 && n <= 365) { el.value = String(n); if (n !== saved) save({ memoryDotDays: n }); } else el.value = String(saved);
  };
  return (
    <>
      <h3>Memory updates</h3>
      <div className="set-card">
        <Row icon={<IconListCheck width={18} height={18} />} title="Auto-approve memory updates"
          desc="Changes Quorum's agents make to your notes count as approved when they are made. Turn this off to accept each change in the Memory tab.">
          <Toggle on={settings.memoryAutoApprove !== false} onChange={(v) => save({ memoryAutoApprove: v })} />
        </Row>
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
