import { useState } from 'react';
import markReview from '../assets/quorum-mark.png';
import { IconArchive, IconChevron } from './icons';
import { ReviewDetails, RowMenu, StatusBadge, ago } from './NotificationsView';
import type { MemoryDraft, MemoryFinding } from './quorum';
import { DraftEvidence } from './MemoryDraft';

// The review rules' findings in Memory health (rules/index.js): stale notes, duplicates, frontmatter, confidential
// marks, secrets, oversized and orphan notes. One group per rule, in the same row pattern as the link issues. None has
// an automatic fix: a row opens its note, and Archive sets the finding aside until its evidence changes.
const openNote = (abs: string) => window.dispatchEvent(new CustomEvent('quorum:open-memory', { detail: abs }));
export const findingId = (key: string) => `r:find:${key}`;

export function MemoryFindings({ findings, drafts = {}, archived, q, unread, onArchive, onRead }: {
  findings: MemoryFinding[]; drafts?: Record<string, MemoryDraft>; archived: boolean; q: string; unread: Set<string>;
  onArchive: (keys: string[], on: boolean) => Promise<void>; onRead: (ids: string[]) => void;
}) {
  const [unfolded, setUnfolded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = findings.filter((f) => f.archived === archived && words.every((w) => `${f.title} ${f.rule} ${f.notes.join(' ')}`.toLowerCase().includes(w)));
  if (!shown.length) return null;
  const groups = new Map<string, MemoryFinding[]>();
  for (const f of shown) groups.set(f.rule, [...(groups.get(f.rule) ?? []), f]);
  const act = async (keys: string[], on: boolean) => { setBusy(true); try { await onArchive(keys, on); } finally { setBusy(false); } };
  const fold = (k: string) => setUnfolded((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const open = (f: MemoryFinding) => { if (unread.has(findingId(f.key))) onRead([findingId(f.key)]); openNote(f.abs); };
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
              <div className="conn-line nf-line" role="button" tabIndex={0} aria-label={f.title}
                onClick={() => open(f)}
                onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(f); } }}>
                <span className="nf-who"><img src={markReview} alt="Quorum, needs review" width={32} height={32} /></span>
                <span className="nf-main">
                  <span className="nf-head"><strong className="conn-title nf-title" data-tip={f.title}>{f.title}</strong>{!archived && unread.has(findingId(f.key)) && <i className="nf-dot" role="img" aria-label="Unread" data-tip="Unread" />}</span>
                  <span className="nf-sub"><span className="nf-when" title={new Date(f.at).toLocaleString()}>{ago(f.at)}</span></span>
                </span>
                <span className="nf-side mh-side">
                  <span className="mh-swap" onClick={stop} onKeyDown={stop}>
                    <span className="mh-when"><StatusBadge status={archived ? 'dismissed' : 'review'} /></span>
                    <span className="mh-hover">
                      {archived
                        ? <RowMenu label="Move back to review" onPick={() => act([f.key], false)} />
                        : <button className="icon-btn mh-icon" disabled={busy} aria-label="Archive" data-tip="Archive: set it aside. It comes back if its evidence changes" onClick={() => act([f.key], true)}><IconArchive width={16} height={16} /></button>}
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
                    <ReviewDetails recommendation={f.proposal} problem={f.problem}
                      meta={[...f.evidence.map((e, i) => [i ? `Evidence ${i + 1}` : 'Evidence', e] as [string, string]), ...f.meta, ['Fix', drafts[findingId(f.key)] ? `The agent drafted a fix: ${drafts[findingId(f.key)].line ?? ''}. Approve it in Notifications` : 'You make the change in the note, or approve its fix in Notifications']]} />
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
