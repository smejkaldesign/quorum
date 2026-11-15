import { useEffect, useState } from 'react';
import type { MissingLink } from './quorum';
import { categoryCounts, countsLine, footerFacts, issueOf, type Issue } from '../memoryHealth.js';
import { IconClose, IconReset } from './icons';

// Memory health: links that point at a note that does not exist, one card per missing note. Each card says what is
// wrong in one line, what Quorum suggests, and offers Accept recommendation, Reject (leave the links as they are) and
// Review (open the note with the issue marked). Nothing changes without a click.
export const LEFT_KEY = 'quorum.linksLeft';
export const leftAsIs = (): Set<string> => { try { return new Set(JSON.parse(localStorage.getItem(LEFT_KEY) ?? '[]')); } catch { return new Set(); } };
const setLeft = (key: string, on: boolean) => {
  const s = leftAsIs();
  if (on) s.add(key); else s.delete(key);
  try { localStorage.setItem(LEFT_KEY, JSON.stringify([...s])); } catch {}
  return s;
};

// Accept recommendation for one issue, shared with the review banner; answers with a line saying what changed. A new
// note goes into folder
export async function acceptIssue(issue: Issue, { folder }: { folder: string }): Promise<string> {
  const c = issue.candidate;
  if (issue.action === 'alias' && c) {
    await window.quorum.vaultAddAlias(c.rel, issue.target);
    return `Added “${issue.target}” as an alias of ${c.name ?? c.title}, so ${issue.links} ${issue.links === 1 ? 'link now works' : 'links now work'}`;
  }
  if (issue.action === 'relink' && c) {
    const r = await window.quorum.vaultFixLink(issue.target, c.rel);
    return `Fixed ${r.links} ${r.links === 1 ? 'link' : 'links'} in ${r.files} ${r.files === 1 ? 'note' : 'notes'}`;
  }
  if (issue.action === 'create') {
    const rel = await window.quorum.vaultNewNote(folder, issue.target.split('/').pop()!);
    return `Made the note ${rel}`;
  }
  setLeft(issue.key, true);
  return 'Left the link as it is';
}
// Reject: the links stay as they are, and the issue moves to Left as is
export function rejectIssue(issue: Issue) { setLeft(issue.key, true); return 'Left the link as it is'; }

export function LinkHealth({ focus, folder, isLive, onReview, onClose, onChanged }: {
  focus: string | null; folder: string; isLive: (rel: string) => boolean; onReview: (issue: Issue) => void; onClose: () => void; onChanged: () => void;
}) {
  const [items, setItems] = useState<MissingLink[] | null>(null);
  const [left, setLeftState] = useState<Set<string>>(leftAsIs);
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);
  const load = (fresh = false) => window.quorum.vaultLinkHealth(fresh).then(setItems);
  useEffect(() => { load(); }, []);
  useEffect(() => window.quorum.onVaultChanged(() => { load(); }), []);
  useEffect(() => { if (focus) document.getElementById(`lh-${focus.toLowerCase()}`)?.scrollIntoView({ block: 'center' }); }, [focus, items]);

  const refresh = async () => { setBusy(true); try { await load(true); } finally { setBusy(false); } };
  const after = (msg: string) => { setDone(msg); setLeftState(leftAsIs()); load(); onChanged(); };
  const accept = async (i: Issue) => { try { after(await acceptIssue(i, { folder })); } catch (e) { setDone(String(e).replace(/^.*Error:\s*/, '')); } };
  const reject = (i: Issue) => after(rejectIssue(i));
  const back = (i: Issue) => { setLeft(i.key, false); after('Moved back to review'); };

  const all = items ?? [];
  const open = all.filter((m) => !left.has(m.target.toLowerCase())).map(issueOf);
  const kept = all.filter((m) => left.has(m.target.toLowerCase())).map(issueOf);
  const counts = categoryCounts(all, left);
  // a fix writes the linking notes or the matched note, so it waits while a run is writing any of them
  const locked = (i: Issue) => [...(all.find((m) => m.target === i.target)?.sources ?? []), ...(i.candidate ? [i.candidate.rel] : [])].some(isLive);

  const card = (i: Issue, isLeft: boolean) => (
    <div key={i.key} id={`lh-${i.key}`} className={`mh-card ${focus?.toLowerCase() === i.key ? 'focus' : ''}`}>
      <p className="mh-path">{i.path}</p>
      <strong className="mh-title">{i.title}</strong>
      <p className="mh-fix">{isLeft ? 'Left as is. The links stay as they are.' : i.fix}</p>
      <div className="mh-foot">
        <span className="mh-facts">{footerFacts(i).map((f) => <span key={f}>{f}</span>)}</span>
        <span className="mh-actions">
          <button className="mh-plain" onClick={() => onReview(i)}>Review</button>
          {isLeft
            ? <button className="pill small-pill" onClick={() => back(i)}>Move back to review</button>
            : <>
                {i.action !== 'leave' && <button className="pill small-pill" onClick={() => reject(i)}>Reject</button>}
                <button className="pill small-pill mh-accept" disabled={locked(i)} data-tip={locked(i) ? 'Waits until the run writing these notes finishes' : undefined} onClick={() => accept(i)}>Accept recommendation</button>
              </>}
        </span>
      </div>
    </div>
  );

  return (
    <div className="link-health" role="region" aria-label="Memory health">
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
      <div className="lh-list">
        {open.map((i) => card(i, false))}
        {kept.length > 0 && <h5>Left as is ({kept.length})</h5>}
        {kept.map((i) => card(i, true))}
      </div>
    </div>
  );
}
