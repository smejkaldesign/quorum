import { useCallback, useEffect, useRef, useState } from 'react';
import type { Kb, KbFile, KbHostedConflict, KbHostedNote as Note, KbNote } from '../../src/quorum';
import { Markdown } from '../../src/Markdown';
import { NoteEditor, type NoteEditorHandle } from '../../src/editor/NoteEditor';
import { IconBack, IconNotes } from '../../src/icons';
import { IconPen } from '../../src/PrivateNotes';
import { withFile, withoutFile } from './kbFiles';
import { findFolder, flattenFolders, folderPath } from './kbTree';
import { kbCall, KbConfirm } from './kbUi';

// A note of a knowledge base hosted by Quorum, in the note editor (ee/kbHosted.js, migration 0034). Editors and admins
// write, rename, move and delete it and attach images or PDFs; readers read it in the preview, where pictures show
// inline. Save sends the hash the note was opened at. When someone saved the note in between, nothing is written and
// the newer version is shown, with the choice to use the merge of both edits (when they do not touch the same lines),
// keep this text, or take the newer version.
//
// The note opened is read once, when the view mounts. A save updates the note in place: the text typed while the save
// was on its way stays in the editor, and a new note keeps its editor through its first save (KbBrowser keys the view
// by the open, not by the note's id).

type Base = { hash: string | null; title: string; content: string };
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const sizeOf = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const asKbNote = (n: Note): KbNote => ({ id: n.id, path: n.path, title: n.title, folderId: n.folderId, userId: '', updatedAt: n.updatedAt });

export function KbHostedNote({ kb, note, folderId, onBack, onChanged, onSaved, onMoved, onDeleted }: {
  kb: Kb; note: KbNote | null; folderId: string | null; onBack: () => void; onChanged: () => void; onSaved: (n: KbNote) => void; onMoved: (folderId: string | null) => void; onDeleted: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const editor = useRef<NoteEditorHandle>(null);
  const [opened] = useState(note);
  const [loaded, setLoaded] = useState<Note | null>(null);
  const [ready, setReady] = useState(!opened);
  const [base, setBase] = useState<Base>({ hash: null, title: '', content: '' });
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [folder, setFolder] = useState<string | null>(folderId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState<KbHostedConflict | null>(null);
  const [files, setFiles] = useState<KbFile[]>([]);
  const [deleting, setDeleting] = useState(false);
  const writable = !!kb.writable;
  const [preview, setPreview] = useState(!writable);
  // the latest values for the save, which runs from a key press and from the attach and remove buttons
  const latest = useRef({ title, content, base, loaded, folder, preview });
  useEffect(() => { latest.current = { title, content, base, loaded, folder, preview }; });

  const take = (n: Note) => {
    setLoaded(n); setFolder(n.folderId);
    setBase({ hash: n.hash, title: n.title, content: n.content });
    setTitle(n.title); setContent(n.content);
  };
  useEffect(() => {
    if (!opened) return;
    let live = true;
    kbCall(() => window.quorum.kbHostedNote(opened.id), 'The note could not be opened.').then((r) => {
      if (!live) return;
      if (r.error || !r.note) setError(r.error ?? 'The note could not be opened.'); else take(r.note);
      setReady(true);
    });
    kbCall(() => window.quorum.kbFiles(opened.id), 'The attachments could not be read.').then((r) => { if (live && r.files) setFiles(r.files); });
    return () => { live = false; };
  }, [opened]);

  const current = () => (latest.current.preview ? latest.current.content : editor.current?.flush() ?? latest.current.content);
  const dirty = title.trim() !== base.title || content !== base.content;

  // over: the version to save on top of (Keep mine uses the newer one's hash); text: what to save instead of the
  // editor's text (a removed file's link taken out); asNew saves a note deleted meanwhile as a new note
  const save = useCallback(async (opts: { over?: { hash: string | null; content: string }; text?: string; asNew?: boolean } = {}) => {
    if (busy || !writable) return;
    const sent = opts.text ?? current();
    const now = latest.current;
    const t = now.title.trim();
    if (!t) { setError('A note needs a title.'); return; }
    setBusy(true); setError(''); setNotice('');
    const from = opts.over ?? { hash: now.base.hash, content: now.base.content };
    const r = await kbCall(() => window.quorum.kbHostedNoteSave({ kbId: kb.id, noteId: opts.asNew ? undefined : now.loaded?.id, folderId: now.folder, title: t, content: sent, baseHash: from.hash, baseContent: from.content }), 'The note could not be saved.');
    setBusy(false);
    if (r.error) { setError(r.error); return; }
    if (r.conflict) { setConflict(r.conflict); return; }
    const n = r.note;
    if (!n) return;
    setConflict(null);
    setLoaded(n); setFolder(n.folderId);
    setBase({ hash: n.hash, title: n.title, content: n.content });
    // what was typed while the save was on its way stays; an unchanged editor takes the stored text (line ends)
    const typed = latest.current.preview ? latest.current.content : editor.current?.flush() ?? latest.current.content;
    if (typed === sent) setContent(n.content); else setContent(typed);
    if (latest.current.title.trim() === t) setTitle(n.title);
    onSaved(asKbNote(n)); onChanged();
    setNotice('Saved.');
  }, [busy, writable, kb.id, onSaved, onChanged]);

  // Cmd+S or Ctrl+S saves only while this view has the focus and shows, the note has changes, and no conflict waits
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's')) return;
      const el = root.current;
      if (!el || !el.contains(document.activeElement) || el.offsetParent === null) return;
      e.preventDefault();
      if (!writable || conflict || busy || !dirty) return;
      save();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [save, writable, conflict, busy, dirty]);

  const useMerge = () => {
    if (!conflict?.theirs || conflict.merged === null) return;
    const t = conflict.theirs;
    setBase({ hash: t.hash, title: t.title, content: t.content });
    setContent(conflict.merged);
    setConflict(null);
    setNotice('Both edits are in the text now. Review it, then save.');
  };
  const useTheirs = () => {
    if (!conflict?.theirs) return;
    take(conflict.theirs);
    setConflict(null);
    setNotice('Showing the newer version. Your edit was set aside.');
  };
  const keepMine = () => { if (conflict?.theirs) save({ over: { hash: conflict.theirs.hash, content: conflict.theirs.content } }); };

  const attach = async () => {
    if (!loaded) { setError('Save the note before attaching files.'); return; }
    setError(''); setNotice('');
    const r = await kbCall(() => window.quorum.kbFileAttach(loaded.id), 'The file could not be attached.');
    if (r.error) { setError(r.error); return; }
    if (!r.file) return;
    const f = r.file;
    setFiles((list) => [...list, f]);
    setContent(withFile(current(), f));
    setNotice(`${f.name} is attached. Save the note to keep it in the text.`);
  };
  const openFile = async (f: KbFile) => {
    setError('');
    const r = await kbCall(() => window.quorum.kbFileOpen(f.id), 'The file could not be opened.');
    if (r.error) setError(r.error);
  };
  // the file goes from the note and from its text; the text is saved at once so no link points at a removed file
  const removeFile = async (f: KbFile) => {
    setError('');
    const r = await kbCall(() => window.quorum.kbFileRemove(f.id), 'The file could not be removed.');
    if (r.error) { setError(r.error); return; }
    setFiles((list) => list.filter((x) => x.id !== f.id));
    const before = current();
    const text = withoutFile(before, f.id);
    if (text === before) return;
    setContent(text);
    if (!conflict) await save({ text });
  };
  const move = async (to: string | null) => {
    if (!loaded) { setFolder(to); return; }
    setError('');
    const r = await kbCall(() => window.quorum.kbHostedNoteMove(loaded.id, to), 'The note could not be moved.');
    if (r.error || !r.note) { setError(r.error ?? 'The note could not be moved.'); return; }
    setLoaded(r.note); setFolder(r.note.folderId);
    onMoved(r.note.folderId); onChanged();
  };
  const remove = async () => {
    setDeleting(false);
    if (!loaded) { onBack(); return; }
    setError('');
    const r = await kbCall(() => window.quorum.kbHostedNoteDelete(loaded.id, base.hash), 'The note could not be deleted.');
    if (r.error) { setError(r.error); return; }
    if (r.conflict) { setConflict(r.conflict); setNotice('The note changed since you opened it, so it was not deleted. Look at the newer version first.'); return; }
    onDeleted();
  };

  const place = [kb.name, ...(folder ? folderPath(kb.folders, folder) : [])].join(' / ');
  const targets = [{ id: null as string | null, label: `${kb.name} (top level)` }, ...flattenFolders(kb.folders).map((f) => ({ id: f.id as string | null, label: [kb.name, ...folderPath(kb.folders, f.id)].join(' / ') }))];
  return (
    <div ref={root} className="kbh-view">
      <div className="tk-subhead">
        <button className="tk-back" onClick={onBack}><IconBack width={16} height={16} />{folder ? findFolder(kb.folders, folder)?.name ?? kb.name : kb.name}</button>
        <span className="tk-crumb">{loaded ? loaded.path : `New note in ${place}`}</span>
        {writable && (
          <span className="kbh-actions">
            <span className="seg" role="group" aria-label="Mode">
              <button className={!preview ? 'on' : ''} aria-pressed={!preview} aria-label="Write" data-tip="Write" onClick={() => setPreview(false)}><IconPen width={16} height={16} /></button>
              <button className={preview ? 'on' : ''} aria-pressed={preview} aria-label="Preview" data-tip="Preview" onClick={() => { setContent(current()); setPreview(true); }}><IconNotes width={16} height={16} /></button>
            </span>
            <select className="kb-role" aria-label="Folder" value={folder ?? ''} disabled={busy} onChange={(e) => move(e.target.value || null)}>
              {targets.map((t) => <option key={t.id ?? 'top'} value={t.id ?? ''}>{t.label}</option>)}
            </select>
            <button className="pill small" disabled={busy} onClick={attach}>Attach file</button>
            {loaded && <button className="pill small danger-pill" disabled={busy} onClick={() => setDeleting(true)}>Delete</button>}
            <button className="pill small primary" disabled={busy || !!conflict || (!dirty && !!loaded)} onClick={() => save()}>{busy ? 'Saving…' : 'Save'}</button>
          </span>
        )}
      </div>
      <div className="tk-body"><article className="tk-doc kbh-doc">
        {!ready ? <p className="muted">Loading…</p> : (
          <>
            {writable
              ? <input className="kbh-title" value={title} placeholder="Title" aria-label="Title" autoFocus={!opened} onChange={(e) => setTitle(e.target.value)} />
              : <h1>{title}</h1>}
            {!writable && kb.role !== 'reader' && <p className="muted">The workspace's plan ended, so this knowledge base is read-only until the plan is renewed.</p>}
            {loaded?.editedBy && <p className="muted">Last saved by {loaded.editedBy}{loaded.updatedAt ? `, ${when(loaded.updatedAt)}` : ''}.</p>}
            {error && <p className="set-error" role="alert">{error}</p>}
            {notice && !error && <p className="muted" role="status">{notice}</p>}
            {conflict && <ConflictPanel conflict={conflict} busy={busy} onMerge={useMerge} onKeep={keepMine} onTheirs={useTheirs} onSaveNew={() => save({ asNew: true })} onDiscard={onDeleted} />}
            {preview
              ? (content.trim() ? <Markdown text={content} headings /> : <p className="muted">Nothing written yet.</p>)
              : <NoteEditor ref={editor} value={content} onChange={setContent} readOnly={!writable} autoFocus={!!opened && writable}
                  placeholder="Start writing. Type / for blocks, [[ to link a note." />}
            {files.length > 0 && (
              <div className="kbh-files">
                <p className="kb-label">Attached files</p>
                {files.map((f) => (
                  <div key={f.id} className="kbh-file">
                    <button className="md-link" onClick={() => openFile(f)}>{f.name}</button>
                    <em className="muted">{sizeOf(f.size)}</em>
                    {writable && <button className="pill small ghost" disabled={busy} onClick={() => removeFile(f)}>Remove</button>}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </article></div>
      {deleting && <KbConfirm title={`Delete ${title || 'this note'}?`} body="It is deleted for everyone, with its attached files, and each Mac removes its copy. This cannot be undone." action="Delete note" onDone={(ok) => (ok ? remove() : setDeleting(false))} />}
    </div>
  );
}

function ConflictPanel({ conflict, busy, onMerge, onKeep, onTheirs, onSaveNew, onDiscard }: { conflict: KbHostedConflict; busy: boolean; onMerge: () => void; onKeep: () => void; onTheirs: () => void; onSaveNew: () => void; onDiscard: () => void }) {
  const t = conflict.theirs;
  if (!t) {
    return (
      <div className="kbh-conflict" role="alert">
        <strong>Someone deleted this note while you were editing it.</strong>
        <div className="kb-form-row">
          <button className="pill primary" disabled={busy} onClick={onSaveNew}>Save mine as a new note</button>
          <button className="pill ghost" disabled={busy} onClick={onDiscard}>Discard my text</button>
        </div>
      </div>
    );
  }
  return (
    <div className="kbh-conflict" role="alert">
      <strong>{t.editedBy ?? 'Someone'} saved this note{t.updatedAt ? ` at ${when(t.updatedAt)}` : ''} while you were editing it.</strong>
      <p className="muted">{conflict.merged !== null ? 'The two edits change different lines, so they can be merged.' : 'The two edits change the same lines, so Quorum cannot merge them.'} Nothing was saved yet. Their version:</p>
      <pre className="kbh-theirs">{t.content || '(empty)'}</pre>
      <div className="kb-form-row">
        {conflict.merged !== null && <button className="pill primary" disabled={busy} onClick={onMerge}>Use the merge</button>}
        <button className={`pill ${conflict.merged === null ? 'primary' : ''}`} disabled={busy} onClick={onKeep}>Keep mine</button>
        <button className="pill ghost" disabled={busy} onClick={onTheirs}>Use theirs</button>
      </div>
    </div>
  );
}
