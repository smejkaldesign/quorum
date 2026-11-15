import { useEffect, useState } from 'react';
import type { NoteDoc, Visibility } from './quorum';
import { IconChevron, IconFolder, IconGlobe, IconLock, IconMore, IconTrash } from './icons';

// A note's Private/Public pill and its More menu, shared by the Home list rows and the note page. Their own module so
// the Home list does not load the note editor
// Private or public, as a small pill with a menu; public is what makes a note's link open for someone else
export function VisibilityPill({ value, onChange, compact }: { value: Visibility; onChange: (v: Visibility) => void; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [open]);
  const pick = (v: Visibility) => (e: React.MouseEvent) => { e.stopPropagation(); setOpen(false); if (v !== value) onChange(v); };
  return (
    <div className="menu-wrap" onClick={(e) => e.stopPropagation()}>
      <button className={`act-pill vis-pill ${compact ? 'compact' : ''}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {value === 'public' ? <IconGlobe width={14} height={14} /> : <IconLock width={14} height={14} />}
        {value === 'public' ? 'Public' : 'Private'}<IconChevron />
      </button>
      {open && (
        <div className="menu vis-menu" role="menu">
          <button role="menuitemradio" aria-checked={value === 'private'} className={value === 'private' ? 'checked' : ''} onClick={pick('private')}>
            <span><IconLock width={14} height={14} /> Private</span><em>Only you can open it</em>
          </button>
          <button role="menuitemradio" aria-checked={value === 'public'} className={value === 'public' ? 'checked' : ''} disabled>
            <span><IconGlobe width={14} height={14} /> Public <em className="soon">Coming soon</em></span><em>Anyone with the link can view and save it</em>
          </button>
        </div>
      )}
    </div>
  );
}

export function NoteMenu({ note, onDeleted, compact }: { note: Pick<NoteDoc, 'file' | 'rel' | 'app' | 'link'>; onDeleted: () => void; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [open]);
  const run = (fn: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); setOpen(false); fn(); };
  return (
    <div className="menu-wrap" onClick={(e) => e.stopPropagation()}>
      <button className={`icon-btn ${compact ? 'row-more' : ''}`} aria-label="More options" aria-haspopup="menu" aria-expanded={open} data-tip="More options" onClick={() => setOpen((o) => !o)}>
        <IconMore />
      </button>
      {open && (
        <div className="menu note-menu" role="menu">
          <button role="menuitem" onClick={run(() => window.quorum.vaultReveal(note.rel))}><IconFolder width={15} height={15} /> Show in {note.app}</button>
          <div className="menu-sep" />
          <button role="menuitem" className="danger" onClick={run(async () => { if (await window.quorum.vaultTrash(note.rel)) onDeleted(); })}><IconTrash width={15} height={15} /> Delete note</button>
        </div>
      )}
    </div>
  );
}
