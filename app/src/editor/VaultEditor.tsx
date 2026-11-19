import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { JSONContent } from '@tiptap/core';
import type { VaultEdit } from '../quorum';
import { NoteEditor, type NoteEditorHandle } from './NoteEditor';
import { canSplice, splice } from './markdown';
import { createEditSession } from './editSession';
import { toast } from '../Toasts';

const READ_ONLY = {
  withheld: 'This note has withheld lines, so it opens read-only here. Edit it in the vault.',
  'line-endings': 'This note mixes line endings, so it opens read-only here to keep them as they are. Edit it in the vault.',
  encoding: 'This note is not saved as UTF-8 text, so it opens read-only here to keep its bytes as they are. Edit it in the vault.',
};

// The body of a note open in Knowledge, edited in place. It opens as rich text only when the body writes back byte for
// byte (canSplice), and as plain text otherwise, so opening a note never reformats it. Saving, and reloading when the
// file changes on disk, follow editSession.ts. Until the note loads, and for a note main won't let this view edit,
// children show: the read view.
export function VaultEditor({ rel, onWiki, onSaved, children }: { rel: string; onWiki: (target: string) => void; onSaved: (body: string) => void; children: ReactNode }) {
  const [note, setNote] = useState<{ readOnly: VaultEdit['readOnly']; rich: boolean; n: number } | null>(null);
  const [body, setBody] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rich = useRef<NoteEditorHandle>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  // the parent keys this view by rel, so one session (and the onSaved it was made with) lives as long as the view
  const [session] = useState(() => createEditSession({
    load: (open) => window.quorum.vaultNoteEdit(rel, open),
    save: (p) => window.quorum.vaultNoteSave({ rel, ...p }),
    // main's clipboard, which works when the window isn't focused
    copy: (text) => window.quorum.copy(text),
    toast: (text) => toast(text, 'info'),
  }, {
    take: (n) => { setBody(n.body); setNote((o) => ({ readOnly: n.readOnly, rich: !n.readOnly && canSplice(n.body), n: (o?.n ?? 0) + 1 })); },
    notice: setNotice,
    error: setError,
    saved: (text) => onSaved(text),
  }));
  const edit = (md: string) => { setBody(md); session.edit(md); };

  useEffect(() => {
    let on = true;
    window.quorum.vaultNoteEdit(rel, true).then((n) => { if (on && n) session.take(n); }).catch(() => {});
    return () => { on = false; };
  }, [rel, session]);

  useEffect(() => window.quorum.onVaultChanged((rels) => { if (rels.includes(rel)) void session.changed(); }), [rel, session]);

  // leaving the note (another note, the graph, a review view) saves what's left; this runs before the editor's handle
  // goes away, so the rich editor can hand over its latest markdown
  useLayoutEffect(() => () => { void session.close(rich.current?.flush()); }, [session]);

  useLayoutEffect(() => {
    const ta = area.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
  }, [body, note]);

  if (!note) return <>{children}</>;
  if (note.readOnly) return <><p className="muted">{READ_ONLY[note.readOnly]}</p>{children}</>;
  const spliced = (doc: JSONContent) => splice(session.state.base, doc);
  return (
    <div className="kb-edit">
      {notice && <p className="set-error" role="alert">{notice}</p>}
      {error && <p className="set-error" role="alert">{error}</p>}
      {note.rich ? (
        <NoteEditor key={note.n} ref={rich} value={body} onChange={edit} readOnly={false} save={spliced} onWiki={onWiki}
          placeholder="Start writing. Type / for blocks, [[ to link a note." />
      ) : (
        <>
          <p className="muted note-plain">Opened as plain text, so saving keeps this note's markdown exactly as it is.</p>
          <textarea key={note.n} ref={area} className="note-editor" value={body} spellCheck aria-label="Note" placeholder="Start writing."
            onChange={(e) => edit(e.target.value)} />
        </>
      )}
    </div>
  );
}
