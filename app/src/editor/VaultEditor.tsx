import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { JSONContent } from '@tiptap/core';
import type { VaultEdit } from '../quorum';
import { NoteEditor, type NoteEditorHandle } from './NoteEditor';
import { canSplice, splice } from './markdown';
import { Properties } from './Properties';
import { toast } from '../Toasts';

const SAVE_AFTER = 800;
const READ_ONLY = {
  withheld: 'This note has withheld lines, so it opens read-only here. Edit it in the vault.',
  'line-endings': 'This note mixes line endings, so it opens read-only here to keep them as they are. Edit it in the vault.',
};

// The body of a note open in Knowledge, edited in place. It opens as rich text only when the body writes back byte for
// byte (canSplice), and as plain text otherwise, so opening a note never reformats it. Edits save on a short pause,
// splicing only the changed blocks, and each save names the hash of the file it was made from. When the file changes on
// disk under it (another app, a sync, an agent), the note reloads; an edit that wasn't saved yet goes to the clipboard
// first and the message says so. The note's frontmatter shows as Properties rows above the text, saved the same way.
// Until the note loads, and for a note main won't let this view edit, children show:
// the read view.
export function VaultEditor({ rel, onWiki, onSaved, children }: { rel: string; onWiki: (target: string) => void; onSaved: (body: string) => void; children: ReactNode }) {
  const [note, setNote] = useState<{ readOnly: VaultEdit['readOnly']; rich: boolean; n: number } | null>(null);
  const [body, setBody] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fm, setFm] = useState('');
  const [propsError, setPropsError] = useState<string | null>(null);
  // base is the body as opened, which a rich save splices into; saved and savedFm are what the file on disk has (its
  // hash); body and fm are the latest edits
  const live = useRef({ hash: '', base: '', saved: '', body: '', savedFm: '', fm: '', inflight: null as Promise<void> | null, timer: 0, gone: false });
  const rich = useRef<NoteEditorHandle>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const onSavedRef = useRef(onSaved);
  useEffect(() => { onSavedRef.current = onSaved; }, [onSaved]);

  function take(n: VaultEdit) {
    const s = live.current;
    window.clearTimeout(s.timer);
    Object.assign(s, { hash: n.hash, base: n.body, saved: n.body, body: n.body, savedFm: n.frontmatter, fm: n.frontmatter });
    setBody(n.body);
    setFm(n.frontmatter);
    setPropsError(null);
    setNote((o) => ({ readOnly: n.readOnly, rich: !n.readOnly && canSplice(n.body), n: (o?.n ?? 0) + 1 }));
  }
  // the file changed on disk: what wasn't saved goes to the clipboard, then the note opens again as it is now
  async function reload() {
    const s = live.current;
    const unsaved = s.body !== s.saved || s.fm !== s.savedFm;
    if (unsaved) await navigator.clipboard.writeText(`${s.fm !== s.savedFm ? s.fm : ''}${s.body}`).catch(() => {});
    if (s.gone) { if (unsaved) toast('A note changed on disk before your last edit saved. Your edit is on the clipboard.', 'info'); return; }
    const n = await window.quorum.vaultNoteEdit(rel, true);
    if (!n) { setError('This note was moved or deleted.'); return; }
    take(n);
    setNotice(unsaved ? 'This note changed on disk, so it reloaded. Your unsaved edit is on the clipboard.' : null);
  }

  // one save at a time; a save asked for while one runs waits for it, then saves the latest text if it still differs
  async function save(): Promise<void> {
    const s = live.current;
    while (s.inflight) await s.inflight;
    if (!s.hash || (s.body === s.saved && s.fm === s.savedFm)) return;
    const text = s.body, props = s.fm;
    const run = (async () => {
      try {
        const r = await window.quorum.vaultNoteSave({ rel, hash: s.hash, ...(text !== s.saved ? { body: text } : {}), ...(props !== s.savedFm ? { frontmatter: props } : {}) });
        if ('hash' in r) {
          Object.assign(s, { hash: r.hash, saved: text, savedFm: r.frontmatter });
          // properties that were turned down stay in the panel with the reason, and are not sent again until edited
          if (s.fm === props) s.fm = r.frontmatter;
          if (!s.gone) { setError(null); setPropsError(r.propsError ?? null); if (!r.propsError && s.fm === r.frontmatter) setFm(r.frontmatter); }
          onSavedRef.current(text);
        }
        else if ('conflict' in r) await reload();
        else if (!s.gone) setError(r.error);
      } catch (e) { if (!s.gone) setError(`Couldn't save: ${String(e).replace(/^.*Error:\s*/, '')}`); }
    })();
    s.inflight = run;
    await run;
    if (s.inflight === run) s.inflight = null;
  }
  const schedule = () => { const s = live.current; window.clearTimeout(s.timer); s.timer = window.setTimeout(save, SAVE_AFTER); };
  const edit = (md: string) => {
    live.current.body = md;
    setBody(md);
    setNotice(null);
    schedule();
  };
  // the Properties panel saves on ⌘↵ or blur, so its change goes out at once
  const editProps = (next: string) => {
    live.current.fm = next;
    setFm(next);
    window.clearTimeout(live.current.timer);
    void save();
  };

  useEffect(() => {
    let on = true;
    window.quorum.vaultNoteEdit(rel, true).then((n) => { if (on && n) take(n); }).catch(() => {});
    return () => { on = false; };
  }, [rel]);

  // a change on disk to this note that isn't this view's own save reloads it
  useEffect(() => window.quorum.onVaultChanged(async (rels) => {
    const s = live.current;
    if (!rels.includes(rel) || !s.hash) return;
    while (s.inflight) await s.inflight;
    const n = await window.quorum.vaultNoteEdit(rel).catch(() => null);
    if (n && n.hash !== s.hash && !s.gone) await reload();
  }), [rel]); // eslint-disable-line react-hooks/exhaustive-deps

  // leaving the note (another note, the graph, a review view) saves what's left; this runs before the editor's handle
  // goes away, so the rich editor can hand over its latest markdown
  useLayoutEffect(() => () => {
    const s = live.current;
    const md = rich.current?.flush();
    if (md !== undefined) s.body = md;
    window.clearTimeout(s.timer);
    s.gone = true;
    void save();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const ta = area.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
  }, [body, note]);

  if (!note) return <>{children}</>;
  if (note.readOnly) return <><p className="muted">{READ_ONLY[note.readOnly]}</p>{children}</>;
  const spliced = (doc: JSONContent) => splice(live.current.base, doc);
  return (
    <div className="kb-edit">
      {notice && <p className="set-error" role="alert">{notice}</p>}
      {error && <p className="set-error" role="alert">{error}</p>}
      <Properties key={note.n} value={fm} readOnly={false} error={propsError} onChange={editProps} withTitle />
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
