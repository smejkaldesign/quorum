import { useCallback, useEffect, useRef, useState } from 'react';
import type { Kb, KbFile, KbHostedConflict, KbHostedNote as Note, KbNote } from '../../src/quorum';
import { NoteEditor, type NoteEditorHandle } from '../../src/editor/NoteEditor';
import { IconBack } from '../../src/icons';
import { findFolder, flattenFolders, folderPath } from './kbTree';
import { kbCall, KbConfirm } from './kbUi';

// A note of a knowledge base hosted by Quorum, in the note editor (ee/kbHosted.js, migration 0034). Editors and admins
// write, rename, move and delete it and attach images or PDFs; readers read it. Save sends the hash the note was opened
// at. When someone saved the note in between, nothing is written and the newer version is shown, with the choice to use
// the merge of both edits (when they do not touch the same lines), keep this text, or take the newer version.

type Base = { hash: string | null; title: string; content: string };
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const sizeOf = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const asKbNote = (n: Note): KbNote => ({ id: n.id, path: n.path, title: n.title, folderId: n.folderId, userId: '', updatedAt: n.updatedAt });

export function KbHostedNote({ kb, note, folderId, onBack, onChanged, onSaved, onMoved, onDeleted }: {
  kb: Kb; note: KbNote | null; folderId: string | null; onBack: () => void; onChanged: () => void; onSaved: (n: KbNote) => void; onMoved: (folderId: string | null) => void; onDeleted: () => void;
}) {
  const editor = useRef<NoteEditorHandle>(null);
  const [loaded, setLoaded] = useState<Note | null>(null);
  const [ready, setReady] = useState(!note);
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

  const take = (n: Note) => {
    setLoaded(n); setFolder(n.folderId);
    setBase({ hash: n.hash, title: n.title, content: n.content });
    setTitle(n.title); setContent(n.content);
  };
  useEffect(() => {
    if (!note) return;
    let live = true;
    kbCall(() => window.quorum.kbHostedNote(note.id), 'The note could not be opened.').then((r) => {
      if (!live) return;
      if (r.error || !r.note) setError(r.error ?? 'The note could not be opened.'); else take(r.note);
      setReady(true);
    });
    kbCall(() => window.quorum.kbFiles(note.id), 'The attachments could not be read.').then((r) => { if (live && r.files) setFiles(r.files); });
    return () => { live = false; };
  }, [note]);

  const current = () => editor.current?.flush() ?? content;
  const dirty = title.trim() !== base.title || content !== base.content;

  // over: the hash to save on top of (Keep mine uses the newer version's); asNew saves a note deleted meanwhile again
  const save = useCallback(async (over?: { hash: string | null; content: string }, asNew = false) => {
    if (busy || !writable) return;
    const text = current();
    const t = title.trim();
    if (!t) { setError('A note needs a title.'); return; }
    setBusy(true); setError(''); setNotice('');
    const from = over ?? { hash: base.hash, content: base.content };
    const r = await kbCall(() => window.quorum.kbHostedNoteSave({ kbId: kb.id, noteId: asNew ? undefined : loaded?.id, folderId: folder, title: t, content: text, baseHash: from.hash, baseContent: from.content }), 'The note could not be saved.');
    setBusy(false);
    if (r.error) { setError(r.error); return; }
    if (r.conflict) { setConflict(r.conflict); return; }
    if (r.note) { setConflict(null); take(r.note); onSaved(asKbNote(r.note)); onChanged(); setNotice('Saved.'); }
  }, [busy, writable, title, base, kb.id, loaded, folder, onSaved, onChanged]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const key = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); save(); } };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [save]);

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
  const keepMine = () => { if (conflict?.theirs) save({ hash: conflict.theirs.hash, content: conflict.theirs.content }); };

  const attach = async () => {
    if (!loaded) { setError('Save the note before attaching files.'); return; }
    setError(''); setNotice('');
    const r = await kbCall(() => window.quorum.kbFileAttach(loaded.id), 'The file could not be attached.');
    if (r.error) { setError(r.error); return; }
    if (!r.file) return;
    const f = r.file;
    setFiles((list) => [...list, f]);
    const text = current();
    setContent(`${text.replace(/\s*$/, '')}${text.trim() ? '\n\n' : ''}[${f.name.replace(/[[\]]/g, '')}](${f.link})\n`);
    setNotice(`${f.name} is attached. Save the note to keep its link in the text.`);
  };
  const openFile = async (f: KbFile) => {
    setError('');
    const r = await kbCall(() => window.quorum.kbFileOpen(f.id), 'The file could not be opened.');
    if (r.error) setError(r.error);
  };
  const removeFile = async (f: KbFile) => {
    setError('');
    const r = await kbCall(() => window.quorum.kbFileRemove(f.id), 'The file could not be removed.');
    if (r.error) setError(r.error); else setFiles((list) => list.filter((x) => x.id !== f.id));
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
    <>
      <div className="tk-subhead">
        <button className="tk-back" onClick={onBack}><IconBack width={16} height={16} />{folder ? findFolder(kb.folders, folder)?.name ?? kb.name : kb.name}</button>
        <span className="tk-crumb">{loaded ? loaded.path : `New note in ${place}`}</span>
        {writable && (
          <span className="kbh-actions">
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
              ? <input className="kbh-title" value={title} placeholder="Title" aria-label="Title" autoFocus={!note} onChange={(e) => setTitle(e.target.value)} />
              : <h1>{title}</h1>}
            {!writable && kb.role !== 'reader' && <p className="muted">The workspace's plan ended, so this knowledge base is read-only until the plan is renewed.</p>}
            {loaded?.editedBy && <p className="muted">Last saved by {loaded.editedBy}{loaded.updatedAt ? `, ${when(loaded.updatedAt)}` : ''}.</p>}
            {error && <p className="set-error" role="alert">{error}</p>}
            {notice && !error && <p className="muted" role="status">{notice}</p>}
            {conflict && <ConflictPanel conflict={conflict} busy={busy} onMerge={useMerge} onKeep={keepMine} onTheirs={useTheirs} onSaveNew={() => save(undefined, true)} onDiscard={onDeleted} />}
            <NoteEditor ref={editor} value={content} onChange={setContent} readOnly={!writable} autoFocus={!!note && writable}
              placeholder={writable ? 'Start writing. Type / for blocks, [[ to link a note.' : 'Nothing written yet.'} />
            {files.length > 0 && (
              <div className="kbh-files">
                <p className="kb-label">Attached files</p>
                {files.map((f) => (
                  <div key={f.id} className="kbh-file">
                    <button className="md-link" onClick={() => openFile(f)}>{f.name}</button>
                    <em className="muted">{sizeOf(f.size)}</em>
                    {writable && <button className="pill small ghost" onClick={() => removeFile(f)}>Remove</button>}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </article></div>
      {deleting && <KbConfirm title={`Delete ${title || 'this note'}?`} body="It is deleted for everyone, with its attached files, and each Mac removes its copy. This cannot be undone." action="Delete note" onDone={(ok) => (ok ? remove() : setDeleting(false))} />}
    </>
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
