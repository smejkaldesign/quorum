import { BackButton } from './BackButton';
import { useEffect, useRef, useState } from 'react';
import type { MeetingMeta, Notes, NotesDraft, WhoAsk } from './quorum';
import { WhoSpoke, type WhoAnswers } from './WhoSpoke';
import { Avatar, SpeakerName, similarCounts, type SpeakerTurn } from './Speaker';
import mark from '../assets/quorum-mark.png';
import { Markdown } from './Markdown';
import { IconRecord, IconSound, IconStop, IconCalendar, IconClock, IconFolder, IconLogs, IconNotes, IconPeople } from './icons';
import { NoteEditor } from './editor/NoteEditor';
import { TypedTitle, useStuck } from './StickyBar';
import { splitChoices } from './MeetingNote';
import { Composer } from './Composer';

type Followup = { q: string; a: string | null };

// Granola-sized end-of-call note: title, meta pills, sectioned notes, follow-up composer. While the notes stream in,
// whatever already parses is shown; a bullet with refs points back at the transcript turns it came from
export type Turn = SpeakerTurn & { who: string; voice?: number | 'mix' | 'sound'; unclear?: boolean };

// privateNotes is what you typed on the call; edits here reach the main process the same way, and flush runs before Save
// live: the recording is running (or paused) and this is its page under the header; the transcript shows as it is
// heard and the summary waits for Stop, which writes it into this same page. embedded drops the window chrome
// ready: a new note before any recording; you can type in Your notes and Save, or press Record to transcribe into it
export function EndView({ notes, draft, meta, summarizing, transcript, participants, onSpeaker, privateNotes, onPrivateNotes, flushPrivateNotes, onClose, me, live = false, paused = false, embedded = false, partial = '', who = null, onAnswer, ready = false, onSaveDraft, onRecord, onContinue, recordBusy = false, asker }: { asker?: { name: string; photo: string | null }; onContinue?: () => void; onRecord?: () => void; recordBusy?: boolean; ready?: boolean; onSaveDraft?: (title: string) => Promise<void>; who?: WhoAsk | null; onAnswer?: (a: WhoAnswers | null) => void; live?: boolean; paused?: boolean; embedded?: boolean; partial?: string; me?: { name: string; photo: string | null }; notes: Notes | null; draft: NotesDraft | null; meta: MeetingMeta | null; summarizing: boolean; transcript: Turn[]; participants: string[]; onSpeaker: (id: number, name: string | null, similar: boolean) => Promise<void>; privateNotes: string; onPrivateNotes: (v: string) => void; flushPrivateNotes: () => void; onClose: () => void }) {
  // three tabs on one note: your Note, the Summary (once there is one) and the Transcript; the note's one chat sits below
  const [showing, setShowing] = useState<'note' | 'summary' | 'transcript'>(live ? 'transcript' : 'note');
  // a new note's title: empty reads New note in italics, and a click puts the cursor in it
  const [title, setTitle] = useState('');
  // Stop summarization turns the summary off for this note: Stop goes straight to Save note, the transcript stays
  const [autoSum, setAutoSum] = useState(true);
  const bar = useStuck();
  const hasSummary = !ready && !!(notes || draft || summarizing);
  // the summary works without names; a skill in the chat can ask who was who and what was missed, and a note saved
  // before that is flagged for review
  const gaps = transcript.some((t) => t.voice !== 'sound' && !t.speaker);
  const [gapsAsked, setGapsAsked] = useState(false);
  const fillGaps = () => {
    setGapsAsked(true);
    ask('Fill the gaps', 'Help me fill the gaps in this recording so the notes can say who said what. Ask me one short question at a time, three at most: who each unnamed speaker was (Person 1, Person 2, Unknown), then anything the transcript left unclear. End every question with a Choices line. After my last answer, list each speaker with their name and the corrections in two or three bullets.');
  };
  // Stop turns the page to the summary as it is written
  useEffect(() => { if (summarizing || who) setShowing('summary'); }, [summarizing, who]);
  const [dropped, setDropped] = useState<Record<number, boolean>>({});
  const [followups, setFollowups] = useState<Followup[]>([]);
  const [draftQ, setDraftQ] = useState('');
  const [saved, setSaved] = useState<{ file: string; rel: string; app: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [hot, setHot] = useState<number[]>([]);
  const end = useRef<HTMLDivElement>(null);
  const similar = similarCounts(transcript);
  const streaming = summarizing && !notes;
  const shown = notes ?? draft?.partial ?? null;
  // while the notes stream, the page is the real layout with placeholders where text has not arrived yet
  const view: Notes = shown ?? { title: '', summary: '', sections: [], decisions: [], actions: [], questions: [] };
  const lastSec = view.sections.length - 1;

  useEffect(() => { end.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }); }, [followups]);
  // a click on a bullet opens the transcript on its first turn
  useEffect(() => { if (showing === 'transcript' && hot.length) document.getElementById(`turn-${hot[0]}`)?.scrollIntoView({ block: 'center' }); }, [showing, hot]);

  // said: what the page shows as your message; sent: what goes to the model (a skill sends its own instructions)
  async function ask(said?: string, sent?: string) {
    const q = (said ?? draftQ).trim();
    if (!q || followups.some((f) => f.a === null)) return;
    if (said === undefined) setDraftQ('');
    setFollowups((f) => [...f, { q, a: null }]);
    let a: string;
    try { a = (await window.quorum.ask(sent ?? q)).text; } catch (err) { a = `Couldn't answer: ${String(err).replace(/^Error:\s*/, '')}`; }
    setFollowups((f) => f.map((x, i) => (i === f.length - 1 ? { ...x, a } : x)));
  }

  async function save() {
    // without a summary the note keeps your notes and the transcript; untitled, it is named after saving
    const base: Notes = notes ?? { title: '', summary: '', sections: [], decisions: [], actions: [], questions: [] };
    if (!notes && autoSum) return;
    flushPrivateNotes();
    setSaving(true);
    try {
      const r = await window.quorum.saveNotes({
        notes: { ...base, title: title.trim() || base.title || 'Untitled note', actions: base.actions.filter((_, i) => !dropped[i]) },
        ...(gaps && !gapsAsked ? { review: 'speakers' } : {}),
        followups: followups.filter((f): f is { q: string; a: string } => !!f.a),
      });
      setSaved(r);
    } finally { setSaving(false); }
  }

  // consecutive turns from the same speaker share one heading
  const groups: { key: string; turns: Turn[] }[] = [];
  // a line with no words in it (a lone period) is left out
  for (const t of transcript.filter((x) => x.voice === 'sound' || /[\p{L}\p{N}]/u.test(x.text))) {
    const key = `${t.channel}|${t.speaker ?? t.who}`;
    if (groups[groups.length - 1]?.key === key) groups[groups.length - 1].turns.push(t); else groups.push({ key, turns: [t] });
  }
  // a solo recording's microphone with no voice told apart: a ? and no name, since nothing proves who spoke
  // a voice Quorum told apart but nobody named keeps the ? with its label beside it: Person 1, Mixed discussion
  const speakerHead = (t: Turn) => (t.channel === 'me' && !me && !t.speaker
    ? <><span className="avatar-sm avatar-unknown" aria-label="Unknown speaker" data-tip="Unknown speaker">?</span>{t.voice != null && <span className="spk-anon">{t.who}</span>}</>
    : <><Avatar name={t.channel === 'me' ? me?.name || t.speaker || t.who : t.speaker ?? t.who} photo={t.channel === 'me' && me ? me.photo ?? null : null} />{t.channel === 'them' ? <SpeakerName turn={t} fallback={t.who} participants={participants} similar={similar(t)} onPick={(name, similar) => onSpeaker(t.id, name, similar)} /> : <span>{t.speaker ?? t.who}</span>}</>);
  const turnById = new Map(transcript.map((t) => [t.id, t]));
  const tipFor = (refs: number[]) => { const t = refs.map((id) => turnById.get(id)).find(Boolean); return t ? `${t.who}: ${t.text.length > 180 ? `${t.text.slice(0, 180)}…` : t.text}` : undefined; };
  const refProps = (refs: number[]) => (refs?.length ? { className: 'ref', 'data-tip': tipFor(refs), 'data-tip-pos': 'top', onMouseEnter: () => setHot(refs), onMouseLeave: () => setHot([]), onClick: () => { if (refs.some((id) => turnById.has(id))) { setHot(refs); setShowing('transcript'); } } } : {});

  const started = meta?.startedAt ? new Date(meta.startedAt) : null;
  const when = started ? (started.toDateString() === new Date().toDateString() ? 'Today' : started.toLocaleDateString()) : 'Today';

  return (
    <div className={embedded ? 'end embedded' : 'panel end'}>

      {(
        <div className="end-scroll">
          <div ref={bar.sentinel} className="rb-sentinel" aria-hidden="true" />
      <header className={`end-bar sticky-bar${bar.stuck ? ' stuck' : ''}`}>
        <span className="rb-left">{live || ready ? <BackButton onClick={onClose} />
          : <button className="act-pill" onClick={async () => { await window.quorum.discard(); onClose(); }}>{saved ? 'Close' : 'Discard'}</button>}
          <span className={[live && 'shimmer', !(title.trim() || shown?.title || meta?.title) && 'untitled'].filter(Boolean).join(' ') || undefined}><TypedTitle text={title.trim() || shown?.title || meta?.title || 'New note'} on={bar.stuck} /></span></span>
        <div className="end-actions">
          {ready ? <>
          {/* Record turns this page into the recording, the same as Record in the header */}
          {onRecord && <span data-tip={recordBusy ? 'A recording is already running' : undefined}><button className="act-pill" disabled={recordBusy} onClick={onRecord}><IconRecord width={15} height={15} /> Record</button></span>}
          <button className="act-pill primary" disabled={(!privateNotes.trim() && !title.trim()) || saving} onClick={async () => { setSaving(true); try { await onSaveDraft?.(title.trim()); } finally { setSaving(false); } }}>{saving ? 'Saving…' : 'Save'}</button>
          </> : live ? <button className="act-pill primary" onClick={() => window.quorum.end()}><IconStop width={14} height={14} /> Stop recording</button> : <>
          {saved ? (
            <>
              <span className="saved">Saved to {saved.rel.replace(/^MyBrain\//, '')}</span>
              <button className="pill" onClick={() => window.quorum.openNote(saved.file)}><IconFolder width={15} height={15} /> Show in {saved.app}</button>
            </>
          ) : (
            // Record keeps the same recording going after Stop; then Summarize transcript; while it writes, Summarizing; once it is on the page (or with the
            // summary turned off), Save note
            <>{onContinue && <button className="act-pill" disabled={recordBusy && !live} onClick={onContinue}><IconRecord width={15} height={15} /> Record</button>}
            {summarizing || streaming ? <button className="act-pill primary" disabled>Summarizing…</button> : <>
              {!notes && who && onAnswer && <button className="act-pill" onClick={() => onAnswer(null)}>Summarize transcript</button>}
              <button className="act-pill primary" disabled={saving || (!notes && autoSum && !who)} onClick={save}>{saving ? 'Saving…' : 'Save note'}</button>
            </>}</>
          )}
          </>}
        </div>
      </header>
          <article className={`doc${streaming ? ' streaming' : ''}`}>
            <h1>{ready || live || (!shown?.title && !streaming && !saved) || title ? (
              // the title is yours to type at any point; empty, it reads New note (shimmering while it records)
              <span className="title-wrap">
                {!title && live && <span className="shimmer title-ph" aria-hidden="true">New note</span>}
                <input className="title-input" value={title} placeholder={live ? '' : 'New note'} aria-label="Title" onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (document.querySelector('.my-notes-editor .ProseMirror') as HTMLElement | null)?.focus(); } }} />
              </span>
            ) : shown?.title || (streaming ? <span className="shimmer">{meta?.title || 'Writing the title'}</span> : meta?.title || 'Untitled note')}</h1>
            <div className="meta-row">
              <span className="meta-pill"><IconCalendar width={16} height={16} />{when}{started ? ` · ${started.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}</span>
              {meta && meta.minutes > 0 && <span className="meta-pill"><IconClock width={16} height={16} />{meta.minutes} min</span>}
              {meta && meta.participants > 0 && <span className="meta-pill"><IconPeople width={16} height={16} />{meta.participants}</span>}
              {meta && <span className="meta-pill">{modelName(meta.model)}</span>}
              <div className={`view-toggle${live || streaming ? ' working' : ''}`} role="group" aria-label="Show">
                {hasSummary && <button className={showing === 'summary' ? 'on' : ''} aria-pressed={showing === 'summary'} aria-label="Summary" data-tip="Summary" onClick={() => setShowing('summary')}><IconLogs width={16} height={16} /></button>}
                <button className={showing === 'note' ? 'on' : ''} aria-pressed={showing === 'note'} aria-label="Note" data-tip="Note" onClick={() => setShowing('note')}><IconNotes width={16} height={16} /></button>
                <button className={showing === 'transcript' ? 'on' : ''} aria-pressed={showing === 'transcript'} aria-label="Transcript" data-tip="Transcript" onClick={() => setShowing('transcript')}><IconSound width={16} height={16} /></button>
              </div>
            </div>

            {showing === 'note' && (
              <section className="doc-section my-notes-section">
                {/* while it records: the summary waits for Stop, and can be turned off for this note */}
                {live && autoSum && (
                  <div className="sum-wait" role="status">
                    <span className="sum-wait-text"><span className="spinner tiny" aria-hidden="true" />Summarizes when the recording stops</span>
                    <button className="act-pill" onClick={() => { setAutoSum(false); window.quorum.summaryOff(); }}>Cancel</button>
                  </div>
                )}
                {/* the note's own editor, formatting bar on top, typed inline with no box around it */}
                <div className="my-notes-editor" onBlur={flushPrivateNotes}>
                  <NoteEditor value={privateNotes} onChange={onPrivateNotes} readOnly={false} placeholder="Type your notes" autoFocus={ready} />
                </div>
              </section>
            )}

            {showing === 'transcript' ? (
              <section className="transcript end-transcript">
                {transcript.length ? groups.map((g) => (
                  // one speaker's run of turns: who it was on top, then each turn as its own paragraph
                  g.turns[0].voice === 'sound'
                    ? <p key={g.turns[0].id} className="turn-sound">{[...new Set(g.turns.map((t) => soundLine(t.text)))].join(' ')}</p>
                    : <div key={g.turns[0].id} className={`turn-group ${g.turns[0].channel}`}>
                    <div className="spk">{speakerHead(g.turns[0])}</div>
                    {g.turns.map((t) => <p key={t.id} id={`turn-${t.id}`} className={hot.includes(t.id) ? 'hot' : undefined}>{t.text}</p>)}
                  </div>
                )) : !partial && <p className="muted">{ready ? 'Press Record to transcribe into this note.' : live ? (paused ? 'Paused. Resume to keep transcribing.' : 'Listening…') : 'Nothing was transcribed.'}</p>}
                {live && partial && <p className="live-partial"><em className="partial">{partial}</em></p>}
              </section>
            ) : showing === 'summary' && <>
            {/* nobody named in the transcript: the summary stands, and a few questions in the chat below can fill the gaps */}
            {notes && !notes.empty && gaps && !gapsAsked && (
              <div className="gap-warn" role="note">
                <span>The speakers aren't named and parts of the transcript may be unclear, so the summary can't say who said what.</span>
                <button className="act-pill" onClick={fillGaps}>Fill the gaps</button>
              </div>
            )}
            {view.empty && !ready && <p className="muted">Nothing was transcribed.</p>}
            {view.summary ? <p className={`summary${streaming && !view.sections.length ? ' typing' : ''}`}>{view.summary}</p>
              : streaming && <div className="sk-block" aria-label="Writing the summary"><span className="sk sk-line w90" /><span className="sk sk-line w75" /><span className="sk sk-line w60" /></div>}
            {view.sections.map((sec, i) => (
              <section key={i} className="doc-section">
                <h2><span className="hash">#</span>{sec.heading}</h2>
                <ul>
                  {sec.bullets.map((b, j) => (
                    <li key={j} className={streaming && i === lastSec && j === sec.bullets.length - 1 ? 'typing' : undefined} {...refProps(b.refs)}>{b.text}{b.sub?.length > 0 && <ul>{b.sub.map((s, k) => <li key={k}>{s}</li>)}</ul>}</li>
                  ))}
                </ul>
              </section>
            ))}
            {streaming && (
              <section className="doc-section sk-section" aria-label="More on the way">
                <h2><span className="hash">#</span><span className="sk sk-head" /></h2>
                <ul><li><span className="sk sk-line w80" /></li><li><span className="sk sk-line w55" /></li></ul>
              </section>
            )}
            {view.decisions.length > 0 && (
              <section className="doc-section">
                <h2><span className="hash">#</span>Decisions</h2>
                <ul>{view.decisions.map((d, i) => <li key={i} {...refProps(d.refs)}>{d.text}{d.status !== 'confirmed' && <em className="status"> · not agreed</em>}</li>)}</ul>
              </section>
            )}
            {view.actions.length > 0 && (
              <section className="doc-section">
                <h2><span className="hash">#</span>Action items</h2>
                {view.actions.map((a, i) => (
                  <label key={i} className="item" {...refProps(a.refs)}>
                    <input type="checkbox" checked={!dropped[i]} disabled={!notes} onChange={(e) => setDropped((d) => ({ ...d, [i]: !e.target.checked }))} />
                    <span>{a.task}<em> · {a.owner ?? 'no owner'}{a.due ? ` · due ${a.due}` : ''}{!a.owner || !a.due ? ' · not agreed' : ''}</em></span>
                  </label>
                ))}
                {notes && <p className="hint left">Unchecked items are left out of the saved note.</p>}
              </section>
            )}
            {view.questions.length > 0 && (
              <section className="doc-section">
                <h2><span className="hash">#</span>Open questions</h2>
                <ul>{view.questions.map((q, i) => <li key={i} {...refProps(q.refs)}>{q.text}</li>)}</ul>
              </section>
            )}
            {streaming && <p className="muted writing"><span className="spinner tiny" /> Writing notes…</p>}
            </>}

            {/* the chat on this note, below a divider once it starts: the same layout as every other note */}
            {followups.length > 0 && (
              <section className="note-thread" aria-label="Questions about this note">
                {followups.map((f, i) => (
                  <div key={i} className="nt-turn">
                    <div className="nt-who"><Avatar name={asker?.name || me?.name || 'You'} photo={asker?.photo ?? me?.photo ?? null} size={22} /><strong>{asker?.name || me?.name || 'You'}</strong></div>
                    <p className="nt-q">{f.q}</p>
                    <div className="nt-who quorum"><img src={mark} alt="" width={22} height={22} /><strong>Quorum</strong></div>
                    {f.a === null ? <p className="nt-step shimmer">Thinking…</p> : <div className="nt-a"><Markdown text={splitChoices(f.a).text} /></div>}
                    {f.a !== null && i === followups.length - 1 && splitChoices(f.a).choices.length > 0 && (
                      <div className="nt-choices">{splitChoices(f.a).choices.map((c) => <button key={c} className="pill small-pill" onClick={() => ask(c)}>{c}</button>)}</div>
                    )}
                  </div>
                ))}
              </section>
            )}
            <div ref={end} />
          </article>
        </div>
      )}

      {!live && <div className="note-dock end-dock">
        <Composer className="note-composer" value={draftQ} onChange={setDraftQ} onSubmit={() => ask()} busy={followups.some((f) => f.a === null) || summarizing} placeholder="Ask about this note" />
      </div>}
    </div>
  );
}

// the note's model field, readable: claude-sonnet -> Claude Sonnet, claude-sonnet-5-5 -> Claude Sonnet 5.5, ollama/llama3.1 -> llama3.1
function modelName(m: string) {
  if (m.startsWith('ollama/')) return m.slice(7);
  if (!m.startsWith('claude-')) return m;
  return `Claude ${m.slice(7).replace(/^\w/, (c) => c.toUpperCase()).replace(/-(\d+)-(\d+)$/, ' $1.$2')}`;
}

// a sound line: music between notes, anything else in brackets
export const soundLine = (label: string) => (label === 'Music' ? `♪ ${label} ♪` : `[${label}]`);
