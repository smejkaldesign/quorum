import { useCallback, useEffect, useState } from 'react';
import type { KbDiffLine, KbSuggestion } from '../../src/quorum';
import { kbCall } from './kbUi';

// Above a synced KB note, for the KB's admins: whether Quorum's copy of the note was edited since the last sync, and
// the edits kept as suggestions after the source changed (ee/kbUpstream.js). An edit can come from Quorum or from the
// person; the page does not tell the two apart. A ready suggestion applies to Quorum's copy; a stale one was made to an
// older version and can only be dismissed. When the note changed since the page read it, Apply is refused and the
// suggestions are read again. Readers never call this; for them the handler answers with nothing anyway. Nothing goes
// back to the source.

type State = { edited: boolean; noteHash: string | null; suggestions: KbSuggestion[] };
type Shown = { title: string | null; body: string };

const READY = 'The source changed after Quorum or you edited this copy, so the note now shows the source\'s version. The edit still fits the new version and can be applied to Quorum\'s copy.';
const STALE = 'The source changed after Quorum or you edited this copy, so the note now shows the source\'s version. The edit was made to the older version and no longer fits, so it cannot be applied. Its changes are shown against that older version.';
const label = (op: KbDiffLine['op']) => (op === '+' ? 'Added' : op === '-' ? 'Removed' : 'Unchanged');
const onDay = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : null);

export function KbSuggestionBanner({ noteId, onApplied }: { noteId: string; onApplied: (doc: Shown) => void }) {
  const [state, setState] = useState<State | null>(null);
  const [notice, setNotice] = useState('');

  const read = useCallback(() => kbCall(() => window.quorum.kbSuggestion?.(noteId), 'The suggestions could not be read.'), [noteId]);
  const take = (r: Awaited<ReturnType<typeof read>>) => { if (!r.error) setState({ edited: !!r.edited, noteHash: r.noteHash ?? null, suggestions: r.suggestions ?? [] }); };
  const load = () => { read().then(take); };
  useEffect(() => {
    let live = true;
    read().then((r) => { if (live && !r.error) setState({ edited: !!r.edited, noteHash: r.noteHash ?? null, suggestions: r.suggestions ?? [] }); });
    return () => { live = false; };
  }, [read]);

  if (!state) return null;
  if (!state.suggestions.length) {
    if (notice) return <p className="kbs-edited" role="status">{notice}</p>;
    return state.edited ? <p className="kbs-edited">Quorum or you edited this copy since the last sync. The source tool keeps its own version.</p> : null;
  }
  return (
    <>
      {notice && <p className="kbs-edited" role="status">{notice}</p>}
      {state.suggestions.map((s) => (
        <SuggestionCard key={s.id} noteId={noteId} s={s} noteHash={state.noteHash}
          onApplied={(doc) => { setNotice(''); onApplied(doc); load(); }}
          onDismissed={() => { setNotice(''); setState({ ...state, suggestions: state.suggestions.filter((x) => x.id !== s.id) }); }}
          onChanged={(why) => { setNotice(why); load(); }} />
      ))}
    </>
  );
}

function SuggestionCard({ noteId, s, noteHash, onApplied, onDismissed, onChanged }: {
  noteId: string; s: KbSuggestion; noteHash: string | null;
  onApplied: (doc: Shown) => void; onDismissed: () => void; onChanged: (why: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<'apply' | 'dismiss' | null>(null);
  const [error, setError] = useState('');
  const changes = s.lines.filter((l) => l.op === '+' || l.op === '-').length;
  const day = onDay(s.at);
  const id = `kbs-${noteId}-${s.id}`;

  const apply = async () => {
    setBusy('apply'); setError('');
    const r = await kbCall(() => window.quorum.kbSuggestionApply(noteId, s.id, noteHash), 'The suggestion could not be applied.');
    setBusy(null);
    if (r.changed) { onChanged(r.error ?? 'This note changed since you opened it.'); return; }
    if (r.error) { setError(r.error); return; }
    onApplied({ title: r.title ?? null, body: r.body ?? '' });
  };
  const dismiss = async () => {
    setBusy('dismiss'); setError('');
    const r = await kbCall(() => window.quorum.kbSuggestionDismiss(noteId, s.id), 'The suggestion could not be dismissed.');
    setBusy(null);
    if (r.error) { setError(r.error); return; }
    onDismissed();
  };

  return (
    <section className={`kbs ${s.state}`} aria-labelledby={id}>
      <h2 id={id} className="kbs-title">
        Suggestion from Quorum{day ? <span className="kbs-day">{day}</span> : null}
        {s.state === 'stale' ? <span className="kbs-tag">Made to an older version</span> : null}
      </h2>
      <p className="kbs-text">{s.state === 'ready' ? READY : STALE}</p>
      {s.blocked && <p className="kbs-text">{s.blocked}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="kbs-actions">
        <button className="pill small" aria-expanded={open} aria-controls={`${id}-diff`} onClick={() => setOpen(!open)}>
          {open ? 'Hide changes' : `Show changes (${changes} ${changes === 1 ? 'line' : 'lines'})`}
        </button>
        {s.state === 'ready' && <button className="pill small primary" disabled={!!busy || !!s.blocked} onClick={apply}>{busy === 'apply' ? 'Applying…' : 'Apply'}</button>}
        <button className="pill small ghost" disabled={!!busy} onClick={dismiss}>{busy === 'dismiss' ? 'Dismissing…' : 'Dismiss'}</button>
      </div>
      {open && (
        <div id={`${id}-diff`} className="kbs-diff" role="list" aria-label="Changes in the suggestion">
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
