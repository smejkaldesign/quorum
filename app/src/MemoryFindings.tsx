import { useState } from 'react';
import markReview from '../assets/quorum-mark.png';
import { IconCheck, IconChevron } from './icons';
import { DismissButton, ReviewDetails, RowMenu, StatusBadge, ViewButton, ago } from './NotificationsView';
import type { MemoryDraft, MemoryFinding } from './quorum';
import { DraftEvidence } from './MemoryDraft';

// The review rules' findings in Memory health (rules/index.js): stale notes, duplicates, frontmatter, confidential
// marks, secrets, oversized and orphan notes. One group per rule, in the same row pattern as the link issues. Approve
// runs the finding's fix or the change its rule allows, or keeps the note as it is (reviewApprove.js); View opens the
// note; Dismiss sets the finding aside until its evidence changes. A click on the row folds its details open. A grouped
// finding (fix.pick: one type for a folder's notes) lists its notes with a tick each; Approve runs on the ticked ones.
const openNote = (abs: string) => window.dispatchEvent(new CustomEvent('quorum:open-memory', { detail: abs }));
export const findingId = (key: string) => `r:find:${key}`;
// what Approve does on a finding, in one line: its own fix, the change its rule allows, or keep as is
const approveText = (f: MemoryFinding) => f.approve?.says ?? (f.fix ? f.proposal : 'Keep the note as it is and mark the item done.');

export function MemoryFindings({ findings, drafts = {}, archived, q, unread, onArchive, onApprove, onRead }: {
  findings: MemoryFinding[]; drafts?: Record<string, MemoryDraft>; archived: boolean; q: string; unread: Set<string>;
  onArchive: (keys: string[], on: boolean) => Promise<void>; onApprove: (f: MemoryFinding, only?: string[]) => Promise<void>; onRead: (ids: string[]) => void;
}) {
  const [unfolded, setUnfolded] = useState<Set<string>>(new Set());
  // the notes a person unticked in a grouped finding, by finding key
  const [unticked, setUnticked] = useState<Record<string, string[]>>({});
  const ticked = (f: MemoryFinding) => f.notes.filter((r) => !(unticked[f.key] ?? []).includes(r));
  const tick = (f: MemoryFinding, rel: string) => setUnticked((u) => { const cur = u[f.key] ?? []; return { ...u, [f.key]: cur.includes(rel) ? cur.filter((r) => r !== rel) : [...cur, rel] }; });
  const [busy, setBusy] = useState(false);
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = findings.filter((f) => f.archived === archived && words.every((w) => `${f.title} ${f.rule} ${f.notes.join(' ')}`.toLowerCase().includes(w)));
  if (!shown.length) return null;
  const groups = new Map<string, MemoryFinding[]>();
  for (const f of shown) groups.set(f.rule, [...(groups.get(f.rule) ?? []), f]);
  const act = async (keys: string[], on: boolean) => { setBusy(true); try { await onArchive(keys, on); } finally { setBusy(false); } };
  // a fix the agent drafted runs before the rule's own change
  const says = (f: MemoryFinding) => (drafts[findingId(f.key)] ? `Run the fix the agent drafted: ${drafts[findingId(f.key)].line ?? ''}` : approveText(f));
  const approve = async (f: MemoryFinding) => { setBusy(true); try { await onApprove(f, f.fix?.pick ? ticked(f) : undefined); } finally { setBusy(false); } };
  const fold = (k: string) => setUnfolded((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const open = (f: MemoryFinding) => { if (unread.has(findingId(f.key))) onRead([findingId(f.key)]); if (f.notes.length) openNote(f.abs); };
  return (
    <div className="mh-findings">
      {[...groups].map(([label, list]) => (
        <section key={label} className="mh-group" aria-label={label}>
          <div className="mh-group-head">
            <h3>{label}</h3>
            <span className="muted">{list.length}</span>
            <span className="nf-fill" />
            {list.length > 1 && <RowMenu label={archived ? `Move all ${list.length} back to review` : `Archive all ${list.length}`} onPick={() => act(list.map((f) => f.key), !archived)} />}
          </div>
          {list.map((f) => (
            <div key={f.key} className="conn-row nf-row mh-row">
              <div className="conn-line nf-line" role="button" tabIndex={0} aria-label={f.title} aria-expanded={unfolded.has(f.key)}
                onClick={() => fold(f.key)}
                onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); fold(f.key); } }}>
                <span className="nf-who"><img src={markReview} alt="Quorum, needs review" width={32} height={32} /></span>
                <span className="nf-main">
                  <span className="nf-head"><strong className="conn-title nf-title" data-tip={f.title}>{f.title}</strong>{!archived && unread.has(findingId(f.key)) && <i className="nf-dot" role="img" aria-label="Unread" data-tip="Unread" />}</span>
                  <span className="nf-sub"><span className="nf-when" title={new Date(f.at).toLocaleString()}>{ago(f.at)}</span></span>
                </span>
                <span className="nf-side mh-side">
                  <span onClick={stop} onKeyDown={stop}><ViewButton onView={() => open(f)} /></span>
                  <span className="mh-swap" onClick={stop} onKeyDown={stop}>
                    <span className="mh-when"><StatusBadge status={archived ? 'dismissed' : 'review'} /></span>
                    <span className="mh-hover">
                      {archived
                        ? <RowMenu label="Move back to review" onPick={() => act([f.key], false)} />
                        : <>
                            <DismissButton disabled={busy} onDismiss={() => act([f.key], true)} />
                            <button className="icon-btn mh-icon mh-yes" disabled={busy || (!!f.fix?.pick && !ticked(f).length)} aria-label="Approve" data-tip={f.fix?.pick ? `Approve: ${says(f)} (${ticked(f).length} of ${f.notes.length} ticked)` : `Approve: ${says(f)}`} onClick={() => approve(f)}><IconCheck width={16} height={16} /></button>
                          </>}
                    </span>
                  </span>
                  <span className="nf-tools" onClick={stop} onKeyDown={stop}>
                    <button className={`icon-btn conn-fold${unfolded.has(f.key) ? ' open' : ''}`} aria-expanded={unfolded.has(f.key)} aria-label={unfolded.has(f.key) ? 'Hide details' : 'Show details'} onClick={() => fold(f.key)}><IconChevron width={14} height={14} /></button>
                  </span>
                </span>
              </div>
              <div className={`fold-anim${unfolded.has(f.key) ? ' open' : ''}`} aria-hidden={!unfolded.has(f.key)}>
                <div className="fold-inner">
                  <div className="conn-sub conn-fold-body nf-details mh-fold">
                    <ReviewDetails recommendation={says(f)} problem={f.problem} solution={f.proposal}
                      meta={[...f.evidence.map((e, i) => [i ? `Evidence ${i + 1}` : 'Evidence', e] as [string, string]), ...f.meta]} />
                    {f.fix?.pick && !archived && (
                      <fieldset className="mh-picks">
                        <legend>Approve sets it on the ticked notes ({ticked(f).length} of {f.notes.length})</legend>
                        {f.notes.map((rel) => (
                          <label key={rel} className="mh-pick"><input type="checkbox" checked={!(unticked[f.key] ?? []).includes(rel)} onChange={() => tick(f, rel)} /><span>{rel}</span></label>
                        ))}
                      </fieldset>
                    )}
                    {drafts[findingId(f.key)] && <DraftEvidence draft={drafts[findingId(f.key)]} />}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
