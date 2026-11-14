import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CONNECTOR_BY_ID } from '../connectors/library';
import { ViewsPill } from './ViewsPill';
import { KeepPrivate } from './KeepPrivate';
import { SourceAsk, useMeetingSources } from './MeetingSources';
import type { MeetingShare, NoteDoc, Visibility } from './quorum';
import { Markdown } from './Markdown';
import { Composer } from './Composer';
import { IconBack, IconChevron, IconCopy, IconFolder, IconGlobe, IconLock, IconMore, IconTrash } from './icons';

type Turn = { q: string; a: string; proposal: string | null; state?: 'applied' | 'discarded'; pending?: boolean };

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
      <button className={`vis-pill ${compact ? 'compact' : ''}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
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
          <button role="menuitem" disabled><IconCopy width={15} height={15} /> Copy link <em className="soon">Coming soon</em></button>
          <button role="menuitem" onClick={run(() => window.quorum.vaultReveal(note.rel))}><IconFolder width={15} height={15} /> Show in {note.app}</button>
          <div className="menu-sep" />
          <button role="menuitem" className="danger" onClick={run(async () => { if (await window.quorum.vaultTrash(note.rel)) onDeleted(); })}><IconTrash width={15} height={15} /> Delete note</button>
        </div>
      )}
    </div>
  );
}

// what someone sees when they open a link to a note that isn't shared with them
export function PrivateBlocked({ onBack }: { onBack?: () => void }) {
  return (
    <div className="blocked">
      <svg className="blocked-art" viewBox="0 0 160 120" aria-hidden="true">
        <rect x="22" y="18" width="84" height="96" rx="10" fill="#2a2a2d" stroke="#3a3a3e" />
        <rect x="36" y="38" width="48" height="6" rx="3" fill="#3d3d42" />
        <rect x="36" y="52" width="56" height="5" rx="2.5" fill="#333338" />
        <rect x="36" y="63" width="40" height="5" rx="2.5" fill="#333338" />
        <rect x="36" y="74" width="50" height="5" rx="2.5" fill="#333338" />
        <circle cx="112" cy="78" r="30" style={{ fill: 'var(--brand-deep)' }} />
        <rect x="98" y="76" width="28" height="22" rx="5" style={{ fill: 'var(--brand)' }} />
        <path d="M104 76v-6a8 8 0 0 1 16 0v6" fill="none" style={{ stroke: 'var(--brand-soft)' }} strokeWidth="4" strokeLinecap="round" />
        <circle cx="112" cy="86" r="3" style={{ fill: 'var(--brand-deep)' }} />
      </svg>
      <h2>This note is private</h2>
      <p>Only its owner can open it. Ask them to share it with you or make it public.</p>
      {onBack && <button className="pill primary small-pill" onClick={onBack}><IconBack width={16} height={16} /> Back</button>}
    </div>
  );
}

// the app that imported this note, with its logo: the connector library knows the name, the main process the icon
function SourcePill({ source }: { source: string }) {
  const [icon, setIcon] = useState<string | null>(null);
  useEffect(() => { window.quorum.libraryIcons().then((m) => setIcon(m[source] ?? null)); }, [source]);
  const name = CONNECTOR_BY_ID[source]?.name ?? source.replace(/^./, (c) => c.toUpperCase());
  return <span className="meta-pill meta-source" title={`Imported from ${name}`}>{icon && <img src={icon} alt="" />}{name}</span>;
}

export function NoteReader({ note: initial, dayLabel, peopleLine, onBack }: {
  note: NoteDoc; dayLabel: (d: Date | null) => string; peopleLine: (p: string[], n: number) => string; onBack: () => void;
}) {
  const [note, setNote] = useState(initial);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [step, setStep] = useState('');
  const [preview, setPreview] = useState(false);
  // a note in the team's meetings knowledge base shows Keep private in place of the visibility pill
  const [share, setShare] = useState<MeetingShare | null>(null);
  const [shareRead, setShareRead] = useState(0);
  const inMeetingsKb = !!share && (share.available || !!share.reason);
  const [sources, loadSources] = useMeetingSources();
  const scroller = useRef<HTMLDivElement>(null);
  const date = note.date ? new Date(note.date) : null;
  const busy = turns.some((t) => t.pending);

  useEffect(() => window.quorum.onAgentStep(({ text }) => setStep(text)), []);
  // the reader reuses the list's scroll box, so a note opens at its top rather than wherever the list was
  useLayoutEffect(() => { scroller.current?.scrollTo({ top: 0 }); }, [note.file]);
  useEffect(() => { if (turns.length) scroller.current?.querySelector('.note-dock')?.scrollIntoView({ block: 'end', behavior: 'smooth' }); }, [turns]);

  const reload = async () => { const n = await window.quorum.readNote(note.file); if (n) setNote(n); };

  async function ask(files: string[] = []) {
    const q = draft.trim();
    if (!q || busy) return;
    setDraft('');
    setStep('');
    setTurns((t) => [...t, { q, a: '', proposal: null, pending: true }]);
    let next: Omit<Turn, 'q'>;
    try {
      const r = await window.quorum.noteAsk(note.file, q, turns.filter((t) => !t.pending).map(({ q: tq, a }) => ({ q: tq, a })), files);
      next = { a: r.text, proposal: r.proposal };
    } catch (err) { next = { a: `Couldn't answer: ${String(err).replace(/^.*Error:\s*/, '')}`, proposal: null }; }
    setTurns((t) => t.map((x, i) => (i === t.length - 1 ? { ...x, ...next, pending: false } : x)));
  }

  async function apply(i: number) {
    try {
      await window.quorum.noteApply(note.file, turns[i].proposal!);
      setTurns((t) => t.map((x, j) => (j === i ? { ...x, state: 'applied' } : x)));
      reload();
    } catch (err) { setTurns((t) => t.map((x, j) => (j === i ? { ...x, a: `${x.a}\n\nCouldn't apply: ${String(err).replace(/^.*Error:\s*/, '')}` } : x))); }
  }

  if (preview) return <div className="history reader"><PrivateBlocked onBack={() => setPreview(false)} /></div>;

  return (
    <div className="history reader" ref={scroller}>
      <div className="reader-bar">
        <button className="pill primary small-pill" onClick={onBack}><IconBack width={16} height={16} /> Back</button>
        <div className="reader-actions">
          {/* continue this note in the note view: write in it, or Record more into it */}
          <button className="pill small-pill" disabled={note.withheld} data-tip={note.withheld ? 'This note has withheld lines; edit it in the vault' : undefined}
            onClick={() => window.dispatchEvent(new CustomEvent('quorum:new-note', { detail: { file: note.file } }))}>Edit note</button>
          <KeepPrivate file={note.file} onState={setShare} onRef={() => reload()} reload={shareRead} />
          {!inMeetingsKb && <VisibilityPill value={note.visibility} onChange={async (v) => { await window.quorum.noteVisibility(note.file, v); reload(); }} />}
          <NoteMenu note={note} onDeleted={onBack} />
        </div>
      </div>
      <article className="doc">
        <h1>{note.title}</h1>
        <div className="meta-row">
          {date && <span className="meta-pill">{dayLabel(date)} · {date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>}
          {note.people.length > 0 && <span className="meta-pill">{peopleLine(note.people, note.people.length)}</span>}
          {note.source && <SourcePill source={note.source} />}
          <ViewsPill views={note.views} />
        </div>
        {share?.ask && <SourceAsk source={share.ask} data={sources} onDone={() => { loadSources(); setShareRead((n) => n + 1); }} />}
        {note.body.trim() ? <Markdown text={note.body} headings /> : <p className="muted">No summary yet. Ask Quorum below to write one from the transcript.</p>}
      </article>

      {turns.length > 0 && (
        <section className="note-thread" aria-label="Questions about this note">
          {turns.map((t, i) => (
            <div key={i} className="nt-turn">
              <p className="nt-q">{t.q}</p>
              {t.pending ? <p className="nt-step shimmer">{step || 'Thinking…'}</p> : <div className="nt-a"><Markdown text={t.a} /></div>}
              {t.proposal && (
                <div className={`nt-proposal ${t.state ?? ''}`}>
                  <div className="nt-proposal-head">
                    <strong>{t.state === 'applied' ? 'Applied to the note' : t.state === 'discarded' ? 'Discarded' : 'Proposed edit'}</strong>
                    {!t.state && (
                      <span>
                        <button className="pill small-pill" onClick={() => setTurns((x) => x.map((y, j) => (j === i ? { ...y, state: 'discarded' } : y)))}>Discard</button>
                        <button className="pill primary small-pill" disabled={note.withheld} data-tip={note.withheld ? 'This note has withheld lines; edit it in the vault' : undefined} onClick={() => apply(i)}>Apply</button>
                      </span>
                    )}
                  </div>
                  {!t.state && <div className="nt-proposal-body"><Markdown text={t.proposal} headings /></div>}
                </div>
              )}
            </div>
          ))}
        </section>
      )}

      <div className="note-dock">
      <Composer className="note-composer" value={draft} onChange={setDraft} onSubmit={(_q, f) => ask(f)} busy={busy} placeholder="Ask about this note, or ask Quorum to change it" />
      </div>
    </div>
  );
}
