import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { HandNoteRef, RecordState } from './quorum';
import { Markdown } from './Markdown';
import { IconBack, IconCalendar, IconFolder, IconNotes, IconRecord, IconScreen, IconStop } from './icons';
import { IconPen } from './PrivateNotes';
import { RecordMenu } from './Record';
import { appendScreen, appendTurn, recordChoices, type RecordChoice, type Written } from './noteRecord';

const SAVE_AFTER = 800;
type Status = 'idle' | 'saving' | 'saved' | 'conflict';

// New note: the note view a recording ends on, opened on a fresh Untitled note (file null) or on an existing note to
// continue it. The title and the markdown body are edited by hand and saved on a short pause into the vault folder
// recorded notes go to. Record appends what it hears, and with Screen what the front window shows, at the end of the
// note. canRecord follows the manual-listen flag; screenOffered is the screen-context flag plus its setting
export function NoteView({ file: openFile, record: startWith, canRecord, screenOffered, onClose }: {
  file: string | null; record: RecordChoice | null; canRecord: boolean; screenOffered: boolean; onClose: () => void;
}) {
  const [id] = useState(() => new Date().toISOString().replace(/[:.]/g, '-'));
  const fresh = !openFile;
  const [loaded, setLoaded] = useState(fresh);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [date, setDate] = useState(() => new Date());
  const [readOnly, setReadOnly] = useState(false);
  const [ref, setRef] = useState<HandNoteRef | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [rec, setRec] = useState<RecordState>({ audio: false, screen: false });
  const [menu, setMenu] = useState(false);
  const [choice, setChoice] = useState<RecordChoice>(() => recordChoices(screenOffered));
  const [preview, setPreview] = useState(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  // the text the save timer, Record and the close read outside a render
  const live = useRef({ title: '', body: '', ref: null as HandNoteRef | null, dirty: false, saving: false, blocked: false, rec: { audio: false, screen: false } as RecordState });
  const last = useRef<Written>(null);
  const timer = useRef<number | null>(null);
  const recording = rec.audio || rec.screen;
  live.current.rec = rec;

  async function save() {
    const s = live.current;
    if (!s.dirty || s.saving || s.blocked) return;
    if (!s.ref && !s.title.trim() && !s.body.trim()) return;
    s.saving = true;
    s.dirty = false;
    setStatus('saving');
    try {
      const r = await window.quorum.handNoteSave({ id, file: s.ref?.file ?? null, title: s.title, body: s.body, hash: s.ref?.hash ?? null, fresh });
      if ('conflict' in r) { s.blocked = true; setStatus('conflict'); return; }
      if ('error' in r) { s.dirty = true; setStatus('idle'); setError(r.error); return; }
      s.ref = r;
      setRef(r);
      setError(null);
      setStatus('saved');
    } catch (err) {
      s.dirty = true;
      setStatus('idle');
      setError(`Couldn't save: ${String(err).replace(/^.*Error:\s*/, '')}`);
    } finally { s.saving = false; }
    if (s.dirty) schedule();
  }
  function schedule() {
    live.current.dirty = true;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { timer.current = null; save(); }, SAVE_AFTER);
  }
  const editTitle = (t: string) => { live.current.title = t; setTitle(t); schedule(); };
  const editBody = (b: string) => { live.current.body = b; setBody(b); schedule(); };

  // what Record adds goes at the end; a caret in the editor stays where it was
  function append(next: (b: string) => { body: string; last: Written }) {
    if (live.current.blocked) return;
    const r = next(live.current.body);
    if (r.body === live.current.body) return;
    last.current = r.last;
    const ta = editor.current;
    const caret = ta && document.activeElement === ta ? [ta.selectionStart, ta.selectionEnd] as const : null;
    editBody(r.body);
    requestAnimationFrame(() => {
      if (caret && editor.current) editor.current.setSelectionRange(caret[0], caret[1]);
      else scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
    });
  }

  useEffect(() => {
    if (!openFile) return;
    let on = true;
    window.quorum.handNoteOpen(openFile).then((n) => {
      if (!on) return;
      if (!n) { setError('This note was moved or deleted.'); setReadOnly(true); setLoaded(true); return; }
      live.current = { ...live.current, title: n.title, body: n.body, ref: n };
      setTitle(n.title);
      setBody(n.body);
      setRef(n);
      setReadOnly(n.readOnly);
      live.current.blocked = n.readOnly;
      if (n.date && !Number.isNaN(Date.parse(n.date))) setDate(new Date(n.date));
      setLoaded(true);
    });
    return () => { on = false; };
  }, [openFile]);

  useEffect(() => {
    const offs = [
      window.quorum.onRecord(setRec),
      window.quorum.onHelperEvent((e) => {
        if (e.event !== 'transcript' || !e.isFinal || e.channel === 'dictation' || !live.current.rec.audio) return;
        const turn = { id: e.id ?? 0, channel: e.channel, text: e.text, replace: e.replace };
        append((b) => appendTurn(b, last.current, turn));
      }),
      window.quorum.onScreenContext((s) => { if (live.current.rec.screen) append((b) => ({ body: appendScreen(b, s), last: last.current })); }),
    ];
    window.quorum.recordStatus().then(setRec).catch(() => {});
    return () => offs.forEach((off) => off());
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // the header's Record opens a note that starts recording as soon as it is ready
  const started = useRef(false);
  useEffect(() => {
    if (!loaded || started.current || !startWith || !canRecord || readOnly) return;
    started.current = true;
    start(startWith);
  }, [loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!menu) return;
    const shut = () => setMenu(false);
    window.addEventListener('click', shut);
    return () => window.removeEventListener('click', shut);
  }, [menu]);
  useEffect(() => { if (loaded && fresh) editor.current?.focus(); }, [loaded, fresh]);
  useLayoutEffect(() => {
    const ta = editor.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
  }, [body, preview, loaded]);

  async function start(c: RecordChoice) {
    setMenu(false);
    setError(null);
    last.current = null;
    const r = await window.quorum.recordStart(c);
    if ('error' in r) { setError(r.error); return; }
    setRec(r);
  }
  const stop = async () => setRec(await window.quorum.recordStop());

  async function close() {
    if (live.current.rec.audio || live.current.rec.screen) await window.quorum.recordStop();
    if (timer.current) { window.clearTimeout(timer.current); timer.current = null; }
    await save();
    window.quorum.handNoteDone(live.current.ref?.file ?? null);
    onClose();
  }

  const copyText = () => navigator.clipboard.writeText(`# ${live.current.title || 'Untitled note'}\n\n${live.current.body}`);
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const day = date.toDateString() === new Date().toDateString() ? 'Today' : date.toLocaleDateString();

  return (
    <div className="panel end note-view">
      <header className="end-bar">
        <button className="pill ghost" onClick={close}><IconBack width={16} height={16} /> Back</button>
        <div className="end-actions">
          {status === 'saving' && <span className="muted note-status">Saving…</span>}
          {status === 'saved' && ref && <span className="saved">Saved to {ref.rel.replace(/^MyBrain\//, '')}</span>}
          {ref && <button className="pill" onClick={() => window.quorum.openNote(ref.file)}><IconFolder width={15} height={15} /> Show in {ref.app}</button>}
          {canRecord && !readOnly && (
            <div className="menu-wrap">
              {recording ? (
                <button className="pill record-btn on" onClick={stop} aria-label="Stop recording"><IconStop width={14} height={14} /> Stop recording</button>
              ) : (
                <button className="pill record-btn" disabled={!loaded} aria-haspopup={screenOffered ? 'dialog' : undefined} aria-expanded={screenOffered ? menu : undefined}
                  onClick={(e) => { e.stopPropagation(); if (screenOffered) setMenu((m) => !m); else start(recordChoices(false)); }}>
                  <IconRecord width={16} height={16} /> Record
                </button>
              )}
              {menu && !recording && <RecordMenu choice={choice} onChoice={setChoice} onStart={start} />}
            </div>
          )}
        </div>
      </header>

      <div className="end-scroll" ref={scroller}>
        <article className="doc">
          <input className="note-title" value={title} placeholder="Untitled" aria-label="Title" readOnly={readOnly} disabled={!loaded}
            onChange={(e) => editTitle(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); editor.current?.focus(); } }} />
          <div className="meta-row">
            <span className="meta-pill"><IconCalendar width={16} height={16} />{day} · {time}</span>
            {recording && (
              <span className="meta-pill recording-pill" role="status">
                <span className="live-dot" aria-hidden="true" />Recording{rec.audio ? ' · Transcription' : ''}{rec.screen ? ' · Screen' : ''}
                {rec.screen && <button className="icon-btn" aria-label="Read the screen now" data-tip="Read the screen now" onClick={() => window.quorum.recordScreenNow()}><IconScreen width={15} height={15} /></button>}
              </span>
            )}
            <div className="view-toggle" role="group" aria-label="Show">
              <button className={!preview ? 'on' : ''} aria-pressed={!preview} aria-label="Write" data-tip="Write" onClick={() => setPreview(false)}><IconPen width={16} height={16} /></button>
              <button className={preview ? 'on' : ''} aria-pressed={preview} aria-label="Preview" data-tip="Preview" onClick={() => setPreview(true)}><IconNotes width={16} height={16} /></button>
            </div>
          </div>
          {error && <p className="set-error" role="alert">{error}</p>}
          {status === 'conflict' && (
            <p className="set-error" role="alert">
              This note changed on disk since it was opened, so Quorum stopped saving to keep that version. Your text is still here.{' '}
              <button className="pill small-pill" onClick={copyText}>Copy your text</button>
            </p>
          )}
          {readOnly && ref && <p className="muted">This note has withheld lines, so it opens read-only here. Edit it in the vault.</p>}
          {preview ? (
            body.trim() ? <Markdown text={body} headings /> : <p className="muted">Nothing written yet.</p>
          ) : (
            <textarea ref={editor} className="note-editor" value={body} readOnly={readOnly} disabled={!loaded} spellCheck
              placeholder={canRecord ? 'Start writing, or press Record to transcribe into this note.' : 'Start writing.'}
              onChange={(e) => editBody(e.target.value)} />
          )}
        </article>
      </div>
    </div>
  );
}
