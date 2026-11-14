import { useEffect, useState } from 'react';
import type { KbDiffLine, KbSuggestion } from '../../src/quorum';
import { kbCall } from './kbUi';

// Above a synced KB note, for the KB's admins: what Quorum changed in its copy of the note (ee/kbUpstream.js). After the
// source changed under an edit, the note shows the source's version and Quorum's edit is kept here as a suggestion with
// its changes. A ready suggestion applies to Quorum's copy; a stale one was made to an older version and can only be
// dismissed. Readers never call this; for them the handler answers with nothing anyway. Nothing goes back to the source.

type State = { edited: boolean; suggestion: KbSuggestion | null };
type Shown = { title: string | null; body: string };

const READY = 'The source changed after Quorum edited this note, so the note now shows the source\'s version. Quorum\'s edit still fits the new version and can be applied to Quorum\'s copy.';
const STALE = 'The source changed after Quorum edited this note, so the note now shows the source\'s version. Quorum\'s edit was made to the older version and no longer fits, so it cannot be applied. Its changes are shown against that older version.';
const label = (op: KbDiffLine['op']) => (op === '+' ? 'Added' : op === '-' ? 'Removed' : 'Unchanged');

export function KbSuggestionBanner({ noteId, onApplied }: { noteId: string; onApplied: (doc: Shown) => void }) {
  const [state, setState] = useState<State | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<'apply' | 'dismiss' | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    kbCall(() => window.quorum.kbSuggestion?.(noteId), 'The suggestion could not be read.').then((r) => {
      if (live && !r.error) setState({ edited: !!r.edited, suggestion: r.suggestion ?? null });
    });
    return () => { live = false; };
  }, [noteId]);

  if (!state) return null;
  const s = state.suggestion;
  if (!s) return state.edited ? <p className="kbs-edited">Edited by Quorum since the last sync. The source tool keeps its own version.</p> : null;

  const apply = async () => {
    setBusy('apply'); setError('');
    const r = await kbCall(() => window.quorum.kbSuggestionApply(noteId), 'The suggestion could not be applied.');
    setBusy(null);
    if (r.error) { setError(r.error); return; }
    setState({ edited: true, suggestion: null });
    onApplied({ title: r.title ?? null, body: r.body ?? '' });
  };
  const dismiss = async () => {
    setBusy('dismiss'); setError('');
    const r = await kbCall(() => window.quorum.kbSuggestionDismiss(noteId), 'The suggestion could not be dismissed.');
    setBusy(null);
    if (r.error) { setError(r.error); return; }
    setState({ ...state, suggestion: null });
  };
  const changes = s.lines.filter((l) => l.op === '+' || l.op === '-').length;

  return (
    <section className={`kbs ${s.state}`} aria-labelledby={`kbs-${noteId}`}>
      <h2 id={`kbs-${noteId}`} className="kbs-title">Suggestion from Quorum{s.state === 'stale' ? <span className="kbs-tag">Made to an older version</span> : null}</h2>
      <p className="kbs-text">{s.state === 'ready' ? READY : STALE}</p>
      {s.blocked && <p className="kbs-text">{s.blocked}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="kbs-actions">
        <button className="pill small" aria-expanded={open} aria-controls={`kbs-diff-${noteId}`} onClick={() => setOpen(!open)}>
          {open ? 'Hide changes' : `Show changes (${changes} ${changes === 1 ? 'line' : 'lines'})`}
        </button>
        {s.state === 'ready' && <button className="pill small primary" disabled={!!busy || !!s.blocked} onClick={apply}>{busy === 'apply' ? 'Applying…' : 'Apply'}</button>}
        <button className="pill small ghost" disabled={!!busy} onClick={dismiss}>{busy === 'dismiss' ? 'Dismissing…' : 'Dismiss'}</button>
      </div>
      {open && (
        <div id={`kbs-diff-${noteId}`} className="kbs-diff" role="list" aria-label="Changes in the suggestion">
          {s.lines.map((l, i) => (l.op === '~'
            ? <div key={i} role="listitem" className="kbs-fold">{l.text} unchanged {l.text === '1' ? 'line' : 'lines'}</div>
            : (
              <div key={i} role="listitem" className={`kbs-line ${l.op === '+' ? 'add' : l.op === '-' ? 'del' : ''}`}>
                <span className="kbs-mark" aria-hidden="true">{l.op}</span><span className="sr-only">{label(l.op)}: </span>{l.text || ' '}
              </div>
            )))}
        </div>
      )}
    </section>
  );
}
