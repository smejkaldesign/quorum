import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { HandNoteRef, RecordState } from './quorum';
import { Markdown } from './Markdown';
import { IconBack, IconCalendar, IconFolder, IconNotes, IconRecord, IconStop } from './icons';
import { IconPen } from './PrivateNotes';
import { RecordMenu } from './Record';
import { appendTurn, emptyWritten, recordChoices, type RecordChoice, type Written } from './noteRecord';
import { speakerLabels, timedTurn, type SpeakerRead, type TimedTurn } from './attribution';

const SAVE_AFTER = 800;
type Status = 'idle' | 'saving' | 'saved' | 'conflict';

// New note: the note view a recording ends on, opened on a fresh Untitled note (file null) or on an existing note to
// continue it. The title and the markdown body are edited by hand and saved on a short pause into the vault folder
// recorded notes go to. Record appends what it hears at the end of the note; with Screen on, the call app's names label
// each paragraph (the screen reads themselves stay beside the recording, never in the note). canRecord follows the manual-listen flag; screenOffered is the screen-context flag plus its setting.
// fresh marks a note this editor created, whose file name follows its title; onSaved reports the file after a save so
// a remount reopens it. A change in leave closes the view the way Back does (a call started)
export function NoteView({ file: initialFile, fresh, record: startWith, canRecord, screenOffered, leave, onSaved, onClose }: {
  file: string | null; fresh: boolean; record: RecordChoice | null; canRecord: boolean; screenOffered: boolean; leave: number;
  onSaved: (file: string) => void; onClose: () => void;
}) {
  const [id] = useState(() => new Date().toISOString().replace(/[:.]/g, '-'));
  // the file is read once per mount; later saves move it through live.current.ref
  const [openFile] = useState(initialFile);
  const [loaded, setLoaded] = useState(!openFile);
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
  // the text the save timer, Record and the close read outside a render. readOnly stops saving and appending; a
  // conflict stops saving only, so Record keeps writing into the text on screen, which the person can copy
  const live = useRef({
    title: '', body: '', ref: null as HandNoteRef | null, dirty: false, readOnly: false, conflict: false, closing: false,
    inflight: null as Promise<boolean> | null, rec: { audio: false, screen: false } as RecordState,
  });
  const written = useRef<Written>(emptyWritten());
  // this recording's timed turns and the call app's speaker reads, for the paragraph labels; self is your own name
  const heard = useRef<{ turns: TimedTurn[]; reads: SpeakerRead[]; self: string[] }>({ turns: [], reads: [], self: [] });
  const timer = useRef<number | null>(null);
  const recording = rec.audio || rec.screen;
  live.current.rec = rec;

  // one save at a time: a save asked for while another runs waits for it, then saves the latest text if it changed.
  // Resolves once nothing newer is left to save, or the last attempt failed
  async function writeOnce(): Promise<boolean> {
    const s = live.current;
    s.dirty = false;
    setStatus('saving');
    try {
      const r = await window.quorum.handNoteSave({ id, file: s.ref?.file ?? null, title: s.title, body: s.body, hash: s.ref?.hash ?? null, fresh });
      if ('conflict' in r) { s.conflict = true; setStatus('conflict'); return false; }
      if ('error' in r) { s.dirty = true; setStatus('idle'); setError(r.error); return false; }
      const moved = r.file !== s.ref?.file;
      s.ref = r;
      setRef(r);
      setError(null);
      setStatus('saved');
      if (moved) onSaved(r.file);
      return true;
    } catch (err) {
      s.dirty = true;
      setStatus('idle');
      setError(`Couldn't save: ${String(err).replace(/^.*Error:\s*/, '')}`);
      return false;
    }
  }
  async function save(): Promise<void> {
    const s = live.current;
    if (s.inflight) { const ok = await s.inflight; if (ok && s.dirty) return save(); return; }
    if (!s.dirty || s.readOnly || s.conflict) return;
    if (!s.ref && !s.title.trim() && !s.body.trim()) return;
    s.inflight = writeOnce();
    const ok = await s.inflight;
    s.inflight = null;
    if (ok && s.dirty) { if (s.closing) return save(); schedule(); }
  }
  function schedule() {
    live.current.dirty = true;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { timer.current = null; save(); }, SAVE_AFTER);
  }
  const editTitle = (t: string) => { live.current.title = t; setTitle(t); schedule(); };
  const editBody = (b: string) => { live.current.body = b; setBody(b); schedule(); };

  // what Record adds goes at the end; a caret in the editor stays where it was
  function append(next: (b: string) => { body: string; written: Written }) {
    if (live.current.readOnly) return;
    const r = next(live.current.body);
    written.current = r.written;
    if (r.body === live.current.body) return;
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
      if (!n) { setError('This note was moved or deleted.'); setReadOnly(true); live.current.readOnly = true; setLoaded(true); return; }
      live.current = { ...live.current, title: n.title, body: n.body, ref: n, readOnly: n.readOnly };
      setTitle(n.title);
      setBody(n.body);
      setRef(n);
      setReadOnly(n.readOnly);
      if (n.date && !Number.isNaN(Date.parse(n.date))) setDate(new Date(n.date));
      setLoaded(true);
    });
    return () => { on = false; };
  }, [openFile]);

  useEffect(() => {
    const offs = [
      window.quorum.onRecord((s) => { setRec({ audio: s.audio, screen: s.screen }); if (s.notice) setError(s.notice); }),
      window.quorum.onHelperEvent((e) => {
        if (e.event !== 'transcript' || !e.isFinal || e.channel === 'dictation' || !live.current.rec.audio) return;
        const h = heard.current;
        const timed = timedTurn({ ...e, channel: e.channel }, Date.now());
        const i = h.turns.findIndex((t) => t.id === timed.id);
        if (i < 0) h.turns.push(timed); else h.turns[i] = { ...timed, startMs: Math.min(h.turns[i].startMs, timed.startMs) };
        const label = speakerLabels(h.turns, h.reads, { self: h.self })[timed.id];
        const turn = { id: timed.id, channel: e.channel, text: e.text, replace: e.replace, label };
        append((b) => appendTurn(b, written.current, turn));
      }),
      window.quorum.onCallSpeakers((r) => { if (live.current.rec.screen) heard.current.reads.push({ at: r.at, names: r.names, active: r.active }); }),
    ];
    window.quorum.user().then((u) => { if (u?.name) heard.current.self = [u.name]; }).catch(() => {});
    window.quorum.recordStatus().then((s) => setRec({ audio: s.audio, screen: s.screen })).catch(() => {});
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
  useEffect(() => { if (loaded && !openFile) editor.current?.focus(); }, [loaded, openFile]);
  useLayoutEffect(() => {
    const ta = editor.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
  }, [body, preview, loaded]);

  async function start(c: RecordChoice) {
    setMenu(false);
    setError(null);
    written.current = emptyWritten();
    heard.current = { ...heard.current, turns: [], reads: [] };
    const r = await window.quorum.recordStart(c);
    if ('error' in r) { setError(r.error); return; }
    setRec({ audio: r.audio, screen: r.screen });
  }
  const stop = async () => { const s = await window.quorum.recordStop(); setRec({ audio: s.audio, screen: s.screen }); };

  const copyText = () => navigator.clipboard.writeText(`# ${live.current.title || 'Untitled note'}\n\n${live.current.body}`);

  // Back: the recording stops, the save in flight finishes and the latest text is saved, then the note syncs. A note
  // stopped by a conflict goes to the clipboard so nothing typed or heard is lost
  async function close() {
    const s = live.current;
    if (s.closing) return;
    s.closing = true;
    if (s.rec.audio || s.rec.screen) await window.quorum.recordStop();
    if (timer.current) { window.clearTimeout(timer.current); timer.current = null; }
    await save();
    if (s.conflict) await copyText().catch(() => {});
    await window.quorum.handNoteDone(s.ref?.file ?? null);
    onClose();
  }
  useEffect(() => { if (leave) close(); }, [leave]); // eslint-disable-line react-hooks/exhaustive-deps

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
              This note changed on disk since it was opened, so Quorum stopped saving to keep that version.{' '}
              {recording ? 'Recording still writes into the text below, which is not saved. ' : 'Your text below is not saved. '}
              Back copies it to the clipboard.{' '}
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
