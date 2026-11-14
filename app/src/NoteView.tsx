import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { HandNoteRef, RecordState } from './quorum';
import { Markdown } from './Markdown';
import { IconBack, IconCalendar, IconFolder, IconNotes, IconRecord, IconStop } from './icons';
import { IconPen } from './PrivateNotes';
import { RecordMenu } from './Record';
import { appendTurn, emptyWritten, recordChoices, type RecordChoice, type Written } from './noteRecord';
import { MAX_READS, MAX_TURNS, labelFor, othersIn, timedTurn, type SpeakerRead, type TimedTurn } from './attribution';
import { NoteEditor, type NoteEditorHandle } from './editor/NoteEditor';
import { Properties } from './editor/Properties';
import { isLossless } from './editor/markdown';
import { KeepPrivate } from './KeepPrivate';

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
  // the note's id: the time it was opened plus a random part, so two notes never share one
  const [id] = useState(() => `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 10)}`);
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
  // rich text when the body survives the editor's round trip unchanged, plain text otherwise (decided once it loads)
  const [rich, setRich] = useState(true);
  const [frontmatter, setFrontmatter] = useState('');
  const editor = useRef<HTMLTextAreaElement>(null);
  const richEditor = useRef<NoteEditorHandle>(null);
  // a properties save the main process turned down: shown in the panel, while the title and body still save
  const [propsError, setPropsError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  // the text the save timer, Record and the close read outside a render. readOnly stops saving and appending; a
  // conflict stops saving only, so Record keeps writing into the text on screen, which the person can copy
  const live = useRef({
    title: '', body: '', ref: null as HandNoteRef | null, frontmatter: undefined as string | undefined, rich: true, dirty: false, readOnly: false, conflict: false, closing: false, starting: false,
    inflight: null as Promise<boolean> | null, rec: { audio: false, screen: false } as RecordState,
  });
  const written = useRef<Written>(emptyWritten());
  // this recording's timed turns and the call app's speaker reads, for the paragraph labels; self is your own name
  const heard = useRef<{ turns: TimedTurn[]; reads: SpeakerRead[]; others: Set<string>; self: string[] }>({ turns: [], reads: [], others: new Set(), self: [] });
  // Back could not save: the view stays open with the text, Copy and a way to close anyway
  const [unsaved, setUnsaved] = useState(false);
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
      const fm = s.frontmatter;
      const r = await window.quorum.handNoteSave({ id, file: s.ref?.file ?? null, title: s.title, body: s.body, hash: s.ref?.hash ?? null, fresh, ...(fm !== undefined && s.ref ? { frontmatter: fm } : {}) });
      if ('conflict' in r) { s.conflict = true; setStatus('conflict'); return false; }
      if ('error' in r) { s.dirty = true; setStatus('idle'); setError(r.error); return false; }
      const moved = r.file !== s.ref?.file;
      if (s.frontmatter === fm) s.frontmatter = undefined;
      setPropsError('propsError' in r && r.propsError ? r.propsError : null);
      s.ref = r;
      setRef(r);
      setFrontmatter(r.frontmatter);
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
  const editProps = (fm: string) => { live.current.frontmatter = fm; setFrontmatter(fm); schedule(); };

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
      setFrontmatter(n.frontmatter);
      setRich(isLossless(n.body));
      live.current.rich = isLossless(n.body);
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
        const now = timedTurn({ ...e, channel: e.channel }, Date.now());
        const i = h.turns.findIndex((t) => t.id === now.id);
        const timed = i < 0 ? now : { ...now, startMs: Math.min(h.turns[i].startMs, now.startMs) };
        if (i < 0) h.turns = [...h.turns.slice(-(MAX_TURNS - 1)), timed]; else h.turns[i] = timed;
        // only this turn is labeled, against the reads in its own window
        const label = labelFor(timed, h.turns.filter((t) => t.id !== timed.id && t.startMs <= timed.startMs), h.reads, h.others, { self: h.self });
        const turn = { id: timed.id, channel: e.channel, text: e.text, replace: e.replace, label };
        // rich text: the editor writes the turn by position and keeps the caret; plain text: the string model
        if (live.current.rich && richEditor.current) richEditor.current.recordTurn(turn);
        else append((b) => appendTurn(b, written.current, turn));
      }),
      window.quorum.onCallSpeakers((r) => {
        if (!live.current.rec.screen) return;
        const h = heard.current;
        const read = { at: r.at, names: r.names, active: r.active };
        h.reads = [...h.reads.slice(-(MAX_READS - 1)), read];
        for (const n of othersIn([read], h.self)) h.others.add(n);
      }),
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
  // a new note puts the cursor in the body: the rich editor focuses itself (autoFocus), the plain one here
  useEffect(() => { if (loaded && !openFile && !rich) editor.current?.focus(); }, [loaded, openFile, rich]);
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
    heard.current = { ...heard.current, turns: [], reads: [], others: new Set() };
    const s = live.current;
    s.starting = true;
    const r = await window.quorum.recordStart(c).finally(() => { s.starting = false; });
    if ('error' in r) { if (!s.closing) setError(r.error); return; }
    // Back was pressed while it started: main stands the start down, and this makes sure nothing keeps running
    if (s.closing) { await window.quorum.recordStop(); return; }
    setRec({ audio: r.audio, screen: r.screen });
  }
  const stop = async () => { const s = await window.quorum.recordStop(); setRec({ audio: s.audio, screen: s.screen }); };

  // Keep private writes into the file from the main process: the text on screen is saved first, so the choice is made
  // on the latest version, and the file state that comes back keeps later saves from reading as a conflict
  async function flushForChoice() {
    const md = richEditor.current?.flush();
    if (md !== undefined && md !== live.current.body) editBody(md);
    if (timer.current) { window.clearTimeout(timer.current); timer.current = null; }
    await save();
    return live.current.ref?.hash ?? null;
  }
  function tookChoice(r: HandNoteRef) {
    live.current.ref = r;
    setRef(r);
    setFrontmatter(r.frontmatter);
    if (live.current.frontmatter !== undefined) live.current.frontmatter = r.frontmatter;
  }

  const copyText = () => navigator.clipboard.writeText(`# ${live.current.title || 'Untitled note'}\n\n${live.current.body}`);

  // Back: the recording stops, the save in flight finishes and the latest text is saved, then the note syncs. A note
  // stopped by a conflict goes to the clipboard so nothing typed or heard is lost
  async function close(force = false) {
    const s = live.current;
    if (s.closing) return;
    s.closing = true;
    // a recording that is running, or still starting, stops before anything else
    if (s.rec.audio || s.rec.screen || s.starting) setRec(await window.quorum.recordStop());
    // the rich editor hands over its latest markdown before the last save
    const md = richEditor.current?.flush();
    if (md !== undefined && md !== s.body) editBody(md);
    if (timer.current) { window.clearTimeout(timer.current); timer.current = null; }
    await save();
    if (s.conflict) await copyText().catch(() => {});
    // a save that failed for another reason keeps the view open, so the text is never closed away unsaved
    if (!force && !s.conflict && !s.readOnly && s.dirty && (s.ref || s.title.trim() || s.body.trim())) {
      s.closing = false;
      setUnsaved(true);
      return;
    }
    await window.quorum.handNoteDone(s.ref?.file ?? null);
    onClose();
  }
  useEffect(() => { if (leave) close(); }, [leave]); // eslint-disable-line react-hooks/exhaustive-deps

  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const day = date.toDateString() === new Date().toDateString() ? 'Today' : date.toLocaleDateString();

  return (
    <div className="panel end note-view">
      <header className="end-bar">
        <button className="pill ghost" onClick={() => close()}><IconBack width={16} height={16} /> Back</button>
        <div className="end-actions">
          {status === 'saving' && <span className="muted note-status">Saving…</span>}
          {status === 'saved' && ref && <span className="saved">Saved to {ref.rel.replace(/^MyBrain\//, '')}</span>}
          {ref && <button className="pill" onClick={() => window.quorum.openNote(ref.file)}><IconFolder width={15} height={15} /> Show in {ref.app}</button>}
          {ref && <KeepPrivate file={ref.file} disabled={readOnly || status === 'conflict'} beforeChange={flushForChoice} onRef={tookChoice} />}
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
            onChange={(e) => editTitle(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (editor.current ?? document.querySelector<HTMLElement>('.note-view .ProseMirror'))?.focus(); } }} />
          <div className="meta-row">
            <span className="meta-pill"><IconCalendar width={16} height={16} />{day} · {time}</span>
            {recording && (
              <span className="meta-pill recording-pill" role="status">
                <span className="live-dot" aria-hidden="true" />Recording{rec.audio ? ' · Transcription' : ''}{rec.screen ? ' · Screen' : ''}
              </span>
            )}
            {!rich && (
            <div className="view-toggle" role="group" aria-label="Show">
              <button className={!preview ? 'on' : ''} aria-pressed={!preview} aria-label="Write" data-tip="Write" onClick={() => setPreview(false)}><IconPen width={16} height={16} /></button>
              <button className={preview ? 'on' : ''} aria-pressed={preview} aria-label="Preview" data-tip="Preview" onClick={() => setPreview(true)}><IconNotes width={16} height={16} /></button>
            </div>
            )}
          </div>
          {ref && <Properties value={frontmatter} readOnly={readOnly || status === 'conflict'} error={propsError} onChange={editProps} />}
          {error && <p className="set-error" role="alert">{error}</p>}
          {unsaved && (
            <p className="set-error" role="alert">
              Quorum couldn't save this note, so it stayed open. Copy your text, or try Back again.{' '}
              <button className="pill small-pill" onClick={copyText}>Copy your text</button>
              <button className="pill small-pill" onClick={() => close(true)}>Close without saving</button>
            </p>
          )}
          {status === 'conflict' && (
            <p className="set-error" role="alert">
              This note changed on disk since it was opened, so Quorum stopped saving to keep that version.{' '}
              {recording ? 'Recording still writes into the text below, which is not saved. ' : 'Your text below is not saved. '}
              Back copies it to the clipboard.{' '}
              <button className="pill small-pill" onClick={copyText}>Copy your text</button>
            </p>
          )}
          {readOnly && ref && <p className="muted">This note has withheld lines, so it opens read-only here. Edit it in the vault.</p>}
          {!rich && loaded && <p className="muted note-plain">Opened as plain text, so saving keeps this note's markdown exactly as it is.</p>}
          {rich && loaded ? (
            <NoteEditor ref={richEditor} value={body} onChange={editBody} readOnly={readOnly} autoFocus={!openFile}
              placeholder={canRecord ? 'Start writing, or press Record to transcribe into this note. Type / for blocks, [[ to link a note.' : 'Start writing. Type / for blocks, [[ to link a note.'} />
          ) : preview ? (
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
