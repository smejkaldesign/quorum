import { useEffect, useRef, useState } from 'react';
import type { KbImportProgress, KbImportSource, Result } from '../../src/quorum';
import { IconFolder } from '../../src/icons';
import { checkGithubUrl, importSummary, progressLabel, progressShare, type KbImportResult } from './kbTree';

// Shared pieces of the knowledge base screens: a call that never rejects, the import (which another change adds to
// the main process, so the screens check for it before offering it), and the delete confirmation.

// one IPC call: its { error } sentence as is, and a fallback sentence when the call throws or the bridge lacks it
export async function kbCall<T extends Result>(fn: () => Promise<T> | undefined, fallback: string): Promise<T> {
  try {
    const r = await fn();
    return r ?? ({ error: fallback } as T);
  } catch {
    return { error: fallback } as T;
  }
}

// Settings and the Knowledge tab are separate views; a change made in one tells the other to read the KBs again
export const KB_CHANGED = 'quorum:kb-changed';
export const announceKbChange = () => { try { window.dispatchEvent(new Event(KB_CHANGED)); } catch { /* no window in tests */ } };

// a callback kept current in a ref, so a listener added once always calls the latest one
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => { ref.current = value; });
  return ref;
}

export const hasImport = (): boolean => {
  const q = window.quorum as Partial<Window['quorum']> | undefined;
  return typeof q?.kbImport === 'function' && typeof q?.kbImportPickZip === 'function';
};

export type SourceKind = 'empty' | 'github' | 'zip';
export type SourceDraft = { kind: SourceKind; url: string; branch: string; zip: string };
export const EMPTY_SOURCE: SourceDraft = { kind: 'empty', url: '', branch: '', zip: '' };

// the draft as the import's source, or the sentence that says what is missing
export function sourceOf(d: SourceDraft): { source: KbImportSource | null } | { error: string } {
  if (d.kind === 'empty') return { source: null };
  if (d.kind === 'zip') return d.zip ? { source: { kind: 'zip', path: d.zip } } : { error: 'Choose a zip file.' };
  const u = checkGithubUrl(d.url);
  if ('error' in u) return u;
  return { source: { kind: 'github', url: u.url, ...(d.branch.trim() ? { branch: d.branch.trim() } : {}) } };
}

// where the notes come from: an empty KB, a GitHub repository or a zip; `withEmpty` false for importing into a KB
export function SourceFields({ draft, onChange, withEmpty, disabled }: { draft: SourceDraft; onChange: (d: SourceDraft) => void; withEmpty: boolean; disabled?: boolean }) {
  const [error, setError] = useState('');
  const can = hasImport();
  const kinds: { id: SourceKind; label: string }[] = [...(withEmpty ? [{ id: 'empty' as const, label: 'Empty' }] : []), { id: 'github', label: 'From GitHub' }, { id: 'zip', label: 'From a zip' }];
  const pick = async () => {
    setError('');
    const r = await kbCall<Result & { path?: string; canceled?: true }>(() => window.quorum.kbImportPickZip(), 'The file picker did not open.');
    if (r.error) setError(r.error); else if (r.path) onChange({ ...draft, zip: r.path });
  };
  return (
    <>
      <div className="guard-kinds" role="radiogroup" aria-label="Start with">
        {kinds.map((k) => {
          const off = disabled || (k.id !== 'empty' && !can);
          return <button key={k.id} type="button" role="radio" aria-checked={draft.kind === k.id} disabled={off} className={`pill ${draft.kind === k.id ? 'primary' : ''}`} onClick={() => onChange({ ...draft, kind: k.id })}>{k.label}</button>;
        })}
      </div>
      {!can && <p className="kb-hint muted">Importing from GitHub or a zip is not in this build yet.</p>}
      {draft.kind === 'github' && (
        <div className="kb-form-row">
          <span className="set-field wide"><input value={draft.url} disabled={disabled} onChange={(e) => onChange({ ...draft, url: e.target.value })} placeholder="https://github.com/your-team/handbook" spellCheck={false} aria-label="Repository address" /></span>
          <span className="set-field kb-branch"><input value={draft.branch} disabled={disabled} onChange={(e) => onChange({ ...draft, branch: e.target.value })} placeholder="Branch (optional)" spellCheck={false} aria-label="Branch" /></span>
        </div>
      )}
      {draft.kind === 'zip' && (
        <div className="kb-form-row">
          <button type="button" className="pill with-icon" disabled={disabled} onClick={pick}><IconFolder width={15} height={15} />{draft.zip ? 'Choose another zip' : 'Choose a zip'}</button>
          {draft.zip && <span className="kb-path muted" title={draft.zip}>{draft.zip.replace(/^.*\//, '')}</span>}
        </div>
      )}
      {error && <p className="set-error" role="alert">{error}</p>}
    </>
  );
}

// one import at a time: progress from onKbImportProgress for this KB, then the result or the error sentence
export function useImport() {
  const [progress, setProgress] = useState<KbImportProgress | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<KbImportResult | null>(null);
  const [error, setError] = useState('');
  // resolves to null when the import finished, or to the sentence that says why it did not. Without a source the
  // import reads the KB's stored GitHub source again (Refresh from GitHub)
  const run = async (kbId: string, source?: KbImportSource): Promise<string | null> => {
    setRunning(true); setProgress(null); setResult(null); setError('');
    let off: (() => void) | undefined;
    try { off = window.quorum.onKbImportProgress?.((p) => { if (p?.kbId === kbId) setProgress(p); }); } catch { off = undefined; }
    const r = await kbCall(() => window.quorum.kbImport(source ? { kbId, source } : { kbId }), 'The import did not finish.');
    try { off?.(); } catch { /* the listener is gone either way */ }
    setRunning(false);
    if (r.error || !r.kb) { const why = r.error ?? 'The import did not finish.'; setError(why); return why; }
    setResult({ kb: r.kb, imported: r.imported ?? 0, skipped: r.skipped ?? [], removed: (r as { removed?: number }).removed ?? 0 });
    announceKbChange();
    return null;
  };
  const reset = () => { setProgress(null); setResult(null); setError(''); };
  return { progress, running, result, error, run, reset };
}

export function ImportStatus({ running, progress, result, error }: { running: boolean; progress: KbImportProgress | null; result: KbImportResult | null; error: string }) {
  if (running) {
    const share = progressShare(progress);
    return (
      <div className="kb-import" role="status" aria-live="polite">
        <span>{progressLabel(progress)}</span>
        <progress max={1} {...(share === null ? {} : { value: share })} aria-label="Import progress" />
      </div>
    );
  }
  if (error) return <p className="set-error" role="alert">{error}</p>;
  if (!result) return null;
  const s = importSummary(result);
  return (
    <div className="kb-import" role="status">
      <strong>{s.headline}</strong>
      {s.skipped.length > 0 && (
        <ul className="kb-skipped">
          {s.skipped.map((k) => <li key={k.path}><span>{k.path}</span><em>{k.reason}</em></li>)}
          {s.more > 0 && <li className="muted">and {s.more} more</li>}
        </ul>
      )}
    </div>
  );
}

// the delete question, with Escape and the scrim as Cancel and focus on Cancel
export function KbConfirm({ title, body, action, onDone }: { title: string; body: string; action: string; onDone: (ok: boolean) => void }) {
  const done = useLatest(onDone);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); done.current(false); } };
    window.addEventListener('keydown', esc, true);
    return () => window.removeEventListener('keydown', esc, true);
  }, [done]);
  return (
    <div className="palette-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onDone(false); }}>
      <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="kb-confirm-title" aria-describedby="kb-confirm-body">
        <h2 id="kb-confirm-title">{title}</h2>
        <p id="kb-confirm-body">{body}</p>
        <div className="modal-actions">
          <span />
          <span className="modal-actions-end">
            <button className="pill" autoFocus onClick={() => onDone(false)}>Cancel</button>
            <button className="pill danger-pill" onClick={() => onDone(true)}>{action}</button>
          </span>
        </div>
      </div>
    </div>
  );
}
