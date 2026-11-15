import { BackButton } from './BackButton';
import { NoteMeta } from './NoteMeta';
import { TypedTitle, useStuck } from './StickyBar';
import markProd from '../assets/quorum-mark.png';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CONNECTOR_BY_ID } from '../connectors/library';
import { ViewsPill } from './ViewsPill';
import { KeepPrivate } from './KeepPrivate';
import { SourceAsk, useMeetingSources } from './MeetingSources';
import type { CalendarEvent, MeetingShare, NoteDoc, Visibility } from './quorum';
import { Markdown } from './Markdown';
import { Composer } from './Composer';
import { IconArrowDown, IconSound, IconChevron, IconFolder, IconGlobe, IconLock, IconLogs, IconMore, IconNotes, IconTrash } from './icons';
import { Avatar } from './Speaker';
import { NoteEditor, type NoteEditorHandle } from './editor/NoteEditor';
import { ChatExit, ChatList, useChats, useComposerFocus } from './ChatStack';
import { useMemo } from 'react';
import { joinParts } from '../noteParts.js';
import { soundLine } from './EndView';

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
      {onBack && <BackButton onClick={onBack} />}
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

// a saved note's transcript: each speaker's name above their run of turns, like the recording's review
function SavedTranscript({ turns }: { turns: { id: number; channel: 'me' | 'them'; who: string; text: string; sound?: boolean; unclear?: boolean }[] }) {
  const groups: { key: string; who: string; channel: string; turns: typeof turns }[] = [];
  for (const t of turns) {
    const key = `${t.channel}|${t.who}`;
    if (groups[groups.length - 1]?.key === key) groups[groups.length - 1].turns.push(t); else groups.push({ key, who: t.who, channel: t.channel, turns: [t] });
  }
  return (
    <section className="transcript end-transcript">
      {groups.map((g) => g.turns[0].sound ? <p key={g.turns[0].id} className="turn-sound">{[...new Set(g.turns.map((t) => soundLine(t.text)))].join(' ')}</p> : (
        <div key={g.turns[0].id} className={`turn-group ${g.channel}`}>
          <div className="spk">{g.who === 'Unknown' || g.who === 'You' ? <span className="avatar-sm avatar-unknown" aria-label="Unknown speaker">?</span>
            : /^(Person|Speaker) \d+$|^Mixed discussion/.test(g.who) ? <><span className="avatar-sm avatar-unknown" aria-label="Unnamed speaker">?</span><span className="spk-anon">{g.who}</span></>
            : <><Avatar name={g.who} /><span>{g.who}</span></>}</div>
          {g.turns.map((t) => <p key={t.id}>{t.text}</p>)}
        </div>
      ))}
    </section>
  );
}

// what the reader shows for the Debrief question; main gets the debrief marker instead
const DEBRIEF_SHOWN = 'Debrief this meeting';
// post-meeting asks above the chat input, one click each
// each one also runs from the chat input as /command
const SKILLS = [
  { label: 'Debrief', cmd: 'debrief', ask: DEBRIEF_SHOWN },
  { label: 'Follow-up email', cmd: 'follow-up-email', ask: 'Draft a short follow-up email to the people in this meeting: the decisions and the next steps with owners.' },
  { label: 'Action items', cmd: 'action-items', ask: 'List the action items from this meeting, each with its owner and date when the note gives them.' },
];
// an answer's last line "Choices: A | B | C" becomes buttons; the rest is the text (an edit in progress is hidden)
export function splitChoices(raw: string) {
  const t = raw.replace(/<updated-note>[\s\S]*$/, '').trim();
  const m = t.match(/\n?Choices:\s*(.+)\s*$/);
  return m ? { text: t.slice(0, m.index).trim(), choices: m[1].split('|').map((c) => c.trim()).filter(Boolean).slice(0, 4) } : { text: t, choices: [] as string[] };
}

export function NoteReader({ note: initial, dayLabel, peopleLine, onBack, chat = null, firstAsk = null }: {
  firstAsk?: { q: string; files: string[] } | null; chat?: string | null; note: NoteDoc; dayLabel: (d: Date | null) => string; peopleLine: (p: string[], n: number) => string; onBack: () => void;
}) {
  const [note, setNote] = useState(initial);
  // three tabs, like a new note: the Summary (when there is one, and the page opens on it), your Note, the Transcript
  const parts = useMemo(() => note.parts ?? { note: note.hand ? note.body : '', summary: note.hand ? '' : note.body, split: false }, [note.parts, note.body, note.hand]);
  const [showing, setShowing] = useState<'summary' | 'note' | 'transcript'>(() => ((initial.parts ? initial.parts.summary : !initial.hand && initial.body.trim()) ? 'summary' : 'note'));
  const bar = useStuck();
  // the debrief starts on its own when it matters most, once per note: right after a summary is written, or when a
  // recording from the last day has no people named and no chat yet. Its first question waits under the summary
  function autoDebrief(force = false) {
    const key = `debrief-auto:${note.file}`;
    try { if (localStorage.getItem(key)) return; } catch { /* storage off: still runs once this view */ }
    const fresh = note.date ? Date.now() - new Date(note.date).getTime() < 86400000 : false;
    if (!force && !(fresh && note.source?.startsWith('quorum') && !note.people.length && !chat)) return;
    try { localStorage.setItem(key, '1'); } catch { /* ignore */ }
    ask([], DEBRIEF_SHOWN);
  }
  useEffect(() => { if (note.body.trim()) autoDebrief(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // the note's chat comes with it; opened at a chat (or from Home with a question), the page goes down to it
  useEffect(() => {
    if (firstAsk) { ask(firstAsk.files, firstAsk.q); return; }
    window.quorum.noteChats(note.file).then((list) => {
      cs.setChats(list.map((c) => ({ id: c.id, turns: c.turns.map((t) => ({ q: t.q, a: t.a, proposal: null })) })));
      // opened at a chat: that one is open; otherwise every chat starts collapsed
      if (chat && list.some((c) => c.id === chat)) {
        cs.setOpenId(chat);
        requestAnimationFrame(() => scroller.current?.querySelector('.note-thread')?.scrollIntoView({ block: 'start' }));
      }
    }).catch(() => {});
  }, [chat, note.file]); // eslint-disable-line react-hooks/exhaustive-deps
  const [summing, setSumming] = useState(false);
  const [sumError, setSumError] = useState<string | null>(null);
  async function summarize() {
    setSumming(true); setSumError(null);
    const r = await window.quorum.noteSummarize(note.file).catch((err) => ({ error: String(err) }));
    setSumming(false);
    if ('error' in r) setSumError(r.error); else { await reload(); autoDebrief(true); }
  }
  // the note's chats: several can stack, each collapsed until opened; the open one is the thread below
  const cs = useChats<Turn>();
  const turns = cs.active?.turns ?? [];
  const setTurns = (fn: (t: Turn[]) => Turn[]) => { if (cs.openId) cs.update(cs.openId, fn); };
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
  const busy = cs.chats.some((c) => c.turns.some((t) => t.pending));
  // the skill pills go away once one has run in this chat; the /commands keep working
  // they show only at the bottom of the page and before the first message; above the bottom an arrow offers the rest
  const [atBottom, setAtBottom] = useState(false);
  useEffect(() => {
    const box = scroller.current?.closest<HTMLElement>('.body');
    if (!box) return;
    const check = () => setAtBottom(box.scrollHeight - box.scrollTop - box.clientHeight < 24);
    check();
    box.addEventListener('scroll', check, { passive: true });
    const ro = new ResizeObserver(check);
    ro.observe(scroller.current!);
    return () => { box.removeEventListener('scroll', check); ro.disconnect(); };
  }, []);
  // one screen down: what is at the bottom of the view now lands at its top
  const pageDown = () => {
    const box = scroller.current?.closest<HTMLElement>('.body');
    const dock = scroller.current?.querySelector<HTMLElement>('.note-dock')?.offsetHeight ?? 0;
    box?.scrollBy({ top: box.clientHeight - dock, behavior: 'smooth' });
  };
  const inChat = useComposerFocus();
  const slash = draft.startsWith('/') && !draft.includes(' ') ? SKILLS.filter((k) => `/${k.cmd}`.startsWith(draft.trim().toLowerCase())) : [];
  // a skill keeps the page at the bottom of the chat while its answer comes in
  const pinBottom = useRef(false);
  const runSkill = (k: (typeof SKILLS)[number]) => { setDraft(''); pinBottom.current = true; ask([], k.ask); };
  // Note and Summary are edited in place; a change brings up Undo and Save edits
  const noteEd = useRef<NoteEditorHandle>(null);
  const sumEd = useRef<NoteEditorHandle>(null);
  const [edits, setEdits] = useState<{ note?: string; summary?: string }>({});
  const [editKey, setEditKey] = useState(0);
  const [savingEdit, setSavingEdit] = useState(false);
  const titleLine = note.body.match(/^# [^\n]*\n+/)?.[0] ?? '';
  const changed = (k: 'note' | 'summary') => edits[k] !== undefined && edits[k]!.trim() !== parts[k].trim();
  const dirty = changed('note') || changed('summary');
  const undo = () => { typed.current = { note: false, summary: false }; setEdits({}); setEditKey((n) => n + 1); };
  async function saveEdits() {
    const n = noteEd.current?.flush() ?? edits.note ?? parts.note;
    const sm = sumEd.current?.flush() ?? edits.summary ?? parts.summary;
    setSavingEdit(true);
    try { await window.quorum.noteApply(note.file, `${titleLine}${joinParts(n, sm, parts)}\n`); await reload(); setEdits({}); setEditKey((k) => k + 1); } finally { setSavingEdit(false); }
  }
  // the editors write markdown when they mount, so only typing counts as an edit
  const typed = useRef<{ note: boolean; summary: boolean }>({ note: false, summary: false });
  const onEdit = (k: 'note' | 'summary') => (md: string) => { if (typed.current[k]) setEdits((e) => ({ ...e, [k]: md })); };

  useEffect(() => window.quorum.onAgentStep(({ text }) => setStep(text)), []);
  // the answer as it streams in, and who is asking, for the names above each turn
  const [live, setLive] = useState('');
  useEffect(() => window.quorum.onNoteDelta(({ text }) => setLive(text)), []);
  const [me, setMe] = useState<{ name: string; photo: string | null }>({ name: 'You', photo: null });
  useEffect(() => { window.quorum.user().then((u) => { if (u) setMe({ name: u.name || 'You', photo: u.photo ?? null }); }).catch(() => {}); }, []);
  // the reader reuses the list's scroll box, so a note opens at its top rather than wherever the list was
  useLayoutEffect(() => { scroller.current?.scrollTo({ top: 0 }); }, [note.file]);
  // while an answer comes in the page follows it down, until the question reaches the top; then it stays there
  useLayoutEffect(() => {
    const box = scroller.current?.closest<HTMLElement>('.body');
    const q = scroller.current?.querySelector<HTMLElement>('.nt-turn:last-child .nt-q');
    if (!box || !q || !turns.length) return;
    if (pinBottom.current) { box.scrollTo({ top: box.scrollHeight }); if (!turns.some((t) => t.pending)) pinBottom.current = false; return; }
    const top = box.scrollTop + q.getBoundingClientRect().top - box.getBoundingClientRect().top - 16;
    box.scrollTo({ top: Math.min(box.scrollHeight - box.clientHeight, top) });
  }, [turns, live, step]);

  const reload = async () => { const n = await window.quorum.readNote(note.file); if (n) setNote(n); };
  // named after its first answer, the file can move: the reader follows it
  useEffect(() => window.quorum.onNoteRenamed((d) => { if (d.from === note.file) window.quorum.readNote(d.to).then((n) => { if (n) setNote(n); }); }), [note.file]);

  async function ask(files: string[] = [], said?: string) {
    const q = (said ?? draft).trim();
    if (!q || busy) return;
    if (said === undefined) setDraft('');
    setStep('');
    setLive('');
    const to = cs.target();
    cs.update(to.id, (t) => [...t, { q, a: '', proposal: null, pending: true }]);
    let next: Omit<Turn, 'q'>;
    let saved: string | undefined;
    try {
      const r = await window.quorum.noteAsk(note.file, q === DEBRIEF_SHOWN ? '[debrief]' : q, to.history, files, to.send);
      next = { a: r.text, proposal: r.proposal };
      saved = r.chatId;
    } catch (err) { next = { a: `Couldn't answer: ${String(err).replace(/^.*Error:\s*/, '')}`, proposal: null }; }
    cs.update(to.id, (t) => t.map((x, i) => (i === t.length - 1 ? { ...x, ...next, pending: false } : x)));
    cs.settle(to.id, saved);
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
      <div ref={bar.sentinel} className="rb-sentinel" aria-hidden="true" />
      <div className={`reader-bar sticky-bar${bar.stuck ? ' stuck' : ''}`}>
        <span className="rb-left"><BackButton onClick={onBack} /><TypedTitle text={note.title || 'Untitled note'} on={bar.stuck} /></span>
        <div className="reader-actions">
          {dirty && <>
            <button className="text-btn" onClick={undo}>Undo</button>
            <button className="act-pill primary" disabled={savingEdit} onClick={saveEdits}>{savingEdit ? 'Saving…' : 'Save edits'}</button>
          </>}
          <KeepPrivate file={note.file} onState={setShare} onRef={() => reload()} reload={shareRead} />
          {!inMeetingsKb && <VisibilityPill value={note.visibility} onChange={async (v) => { await window.quorum.noteVisibility(note.file, v); reload(); }} />}
          <NoteMenu note={note} onDeleted={onBack} />
        </div>
      </div>
      <article className="doc">
        <h1 className={summing || savingEdit ? 'shimmer' : undefined}>{note.title}</h1>
        <NoteMeta meta={{ title: note.title, date: note.date ?? null, people: note.people, source: note.source ?? null, sourceUrl: note.sourceUrl, platform: note.platform, meetingUrl: note.meetingUrl, calendar: note.calendar, event: note.event }}>
          {note.rel && !note.rel.startsWith('.') && (
            <button className="meta-pill meta-icon" aria-label="Open in Memory" data-tip={`In your memory: ${note.rel.split('/').slice(0, -1).join('/') || 'top folder'}`}
              onClick={() => window.dispatchEvent(new CustomEvent('quorum:open-memory', { detail: note.file }))}><IconFolder width={17} height={17} /></button>
          )}
          <ViewsPill views={note.views} />
          <div className="view-toggle" role="group" aria-label="Show">
            {parts.summary && <button className={showing === 'summary' ? 'on' : ''} aria-pressed={showing === 'summary'} aria-label="Summary" data-tip="Summary" onClick={() => setShowing('summary')}><IconLogs width={16} height={16} /></button>}
            <button className={showing === 'note' ? 'on' : ''} aria-pressed={showing === 'note'} aria-label="Note" data-tip="Note" onClick={() => setShowing('note')}><IconNotes width={16} height={16} /></button>
            {<button className={showing === 'transcript' ? 'on' : ''} aria-pressed={showing === 'transcript'} aria-label="Transcript" data-tip="Transcript" onClick={() => setShowing('transcript')}><IconSound width={16} height={16} /></button>}
          </div>
        </NoteMeta>
        {share?.ask && <SourceAsk source={share.ask} data={sources} onDone={() => { loadSources(); setShareRead((n) => n + 1); }} />}
        {showing === 'transcript' && <>
          {/* a recording with no summary yet: a way to write one from the transcript */}
          {!parts.summary && (note.summarizable || !!note.transcript?.length) && (
            <div className="no-summary">
              {summing ? <p className="shimmer">Writing the summary from the transcript</p> : null}
              {sumError && <p className="set-error" role="alert">{sumError}</p>}
              <button className="act-pill primary" disabled={summing} onClick={summarize}>Summarize transcript</button>
            </div>
          )}
          {note.transcript?.length ? <SavedTranscript turns={note.transcript} /> : !note.summarizable && <p className="no-transcript">No transcript yet. Start recording now to create one.</p>}
        </>}
        {showing !== 'transcript' && note.withheld && <p className="muted withheld-note">This note has withheld lines, so edit it in your vault.</p>}
        {showing !== 'transcript' && (
          // Note and Summary edit in place; a note with withheld lines stays read-only
          <div className="reader-edit my-notes-editor" key={`${showing}-${editKey}`} onInput={() => { typed.current[showing as 'note' | 'summary'] = true; }}>
            <NoteEditor ref={showing === 'note' ? noteEd : sumEd} value={showing === 'note' ? edits.note ?? parts.note : edits.summary ?? parts.summary}
              onChange={onEdit(showing as 'note' | 'summary')} readOnly={note.withheld} placeholder={showing === 'note' ? 'Type your notes' : 'No summary yet'} />
          </div>
        )}
      </article>

      {!cs.active && <ChatList chats={cs.chats} onOpen={cs.setOpenId} me={me} />}
      {cs.active && <section className="note-thread" aria-label="Questions about this note">
          <ChatExit onExit={cs.exit} />
          {turns.map((t, i) => {
            const { text, choices } = splitChoices(t.pending ? live : t.a);
            return (
            <div key={i} className="nt-turn">
              <div className="nt-who"><Avatar name={me.name} photo={me.photo} size={22} /><strong>{me.name}</strong></div>
              <p className="nt-q">{t.q}</p>
              <div className="nt-who quorum"><img src={markProd} alt="" width={22} height={22} /><strong>Quorum</strong></div>
              {t.pending && !text ? <p className="nt-step shimmer">{step || 'Thinking…'}</p> : <div className="nt-a"><Markdown text={text} /></div>}
              {!t.pending && i === turns.length - 1 && choices.length > 0 && (
                <div className="nt-choices">{choices.map((c) => <button key={c} className="pill small-pill" disabled={busy} onClick={() => ask([], c)}>{c}</button>)}</div>
              )}
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
            );
          })}
      </section>}

      <div className="note-dock">
      {!atBottom && <button className="more-below" aria-label="Show more" data-tip="More below" onClick={pageDown}><IconArrowDown width={18} height={18} /></button>}
      {slash.length > 0 ? (
        <div className="slash-menu" role="listbox" aria-label="Commands">
          {slash.map((k) => <button key={k.cmd} role="option" aria-selected={false} disabled={busy} onClick={() => runSkill(k)}><strong>/{k.cmd}</strong><span>{k.label}</span></button>)}
        </div>
      ) : !cs.active && !cs.chats.length && atBottom && inChat && (
        <div className="skill-pills" role="group" aria-label="Quick asks">
          {SKILLS.map((k) => <button key={k.label} className="skill-pill" disabled={busy} onClick={() => runSkill(k)}>{k.label}</button>)}
        </div>
      )}
      <Composer className="note-composer" value={draft} onChange={setDraft} onSubmit={(_q, f) => (slash.length ? runSkill(slash[0]) : ask(f))} busy={busy} onNewChat={cs.chats.length ? cs.newChat : undefined} placeholder={cs.active || !cs.chats.length ? 'Ask about this note, or ask Quorum to change it' : 'Ask in your latest chat, or + for a new one'} />
      </div>
    </div>
  );
}

export { joinParts };
