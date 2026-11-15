import { useEffect, useRef, useState } from 'react';
import type { MeetingMeta, Notes, NotesDraft, WhoAsk } from './quorum';
import { WhoSpoke, type WhoAnswers } from './WhoSpoke';
import { Avatar, SpeakerName, similarCounts, type SpeakerTurn } from './Speaker';
import mark from '../assets/quorum-mark.png';
import { Markdown } from './Markdown';
import { IconCalendar, IconClock, IconFolder, IconLogs, IconNotes, IconPeople } from './icons';
import { NoteEditor } from './editor/NoteEditor';
import { Composer } from './Composer';

type Followup = { q: string; a: string | null };

// Granola-sized end-of-call note: title, meta pills, sectioned notes, follow-up composer. While the notes stream in,
// whatever already parses is shown; a bullet with refs points back at the transcript turns it came from
export type Turn = SpeakerTurn & { who: string; voice?: number | 'mix' | 'sound'; unclear?: boolean };

// privateNotes is what you typed on the call; edits here reach the main process the same way, and flush runs before Save
// live: the recording is running (or paused) and this is its page under the header; the transcript shows as it is
// heard and the summary waits for Stop, which writes it into this same page. embedded drops the window chrome
// ready: a new note before any recording; you can type in Your notes and Save, or press Record to transcribe into it
export function EndView({ notes, draft, meta, summarizing, transcript, participants, onSpeaker, privateNotes, onPrivateNotes, flushPrivateNotes, onClose, me, live = false, paused = false, embedded = false, partial = '', who = null, onAnswer, ready = false, onSaveDraft }: { ready?: boolean; onSaveDraft?: () => Promise<void>; who?: WhoAsk | null; onAnswer?: (a: WhoAnswers | null) => void; live?: boolean; paused?: boolean; embedded?: boolean; partial?: string; me?: { name: string; photo: string | null }; notes: Notes | null; draft: NotesDraft | null; meta: MeetingMeta | null; summarizing: boolean; transcript: Turn[]; participants: string[]; onSpeaker: (id: number, name: string | null, similar: boolean) => Promise<void>; privateNotes: string; onPrivateNotes: (v: string) => void; flushPrivateNotes: () => void; onClose: () => void }) {
  const [showing, setShowing] = useState<'summary' | 'transcript'>(live ? 'transcript' : 'summary');
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

  async function ask() {
    const q = draftQ.trim();
    if (!q) return;
    setDraftQ('');
    setFollowups((f) => [...f, { q, a: null }]);
    let a: string;
    try { a = (await window.quorum.ask(q)).text; } catch (err) { a = `Couldn't answer: ${String(err).replace(/^Error:\s*/, '')}`; }
    setFollowups((f) => f.map((x, i) => (i === f.length - 1 ? { ...x, a } : x)));
  }

  async function save() {
    if (!notes) return;
    flushPrivateNotes();
    setSaving(true);
    try {
      const r = await window.quorum.saveNotes({
        notes: { ...notes, actions: notes.actions.filter((_, i) => !dropped[i]) },
        followups: followups.filter((f): f is { q: string; a: string } => !!f.a),
      });
      setSaved(r);
    } finally { setSaving(false); }
  }

  // consecutive turns from the same speaker share one heading
  const groups: { key: string; turns: Turn[] }[] = [];
  for (const t of transcript) {
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
      <header className="end-bar">
        {live || ready ? <button className="pill ghost" onClick={onClose}>Back</button>
          : <button className="pill ghost" onClick={async () => { await window.quorum.discard(); onClose(); }}>{saved ? 'Close' : 'Discard'}</button>}
        <div className="end-actions">
          {ready ? <button className="pill primary" disabled={!privateNotes.trim() || saving} onClick={async () => { setSaving(true); try { await onSaveDraft?.(); } finally { setSaving(false); } }}>{saving ? 'Saving…' : 'Save'}</button>
          : live ? <span className="muted note-status" role="status">{paused ? 'Paused' : 'Recording'}</span> : <>
          {saved ? (
            <>
              <span className="saved">Saved to {saved.rel.replace(/^MyBrain\//, '')}</span>
              <button className="pill" onClick={() => window.quorum.openNote(saved.file)}><IconFolder width={15} height={15} /> Show in {saved.app}</button>
            </>
          ) : (
            <button className="pill primary" disabled={!notes || saving} onClick={save}>{saving ? 'Saving…' : 'Keep'}</button>
          )}
          </>}
        </div>
      </header>

      {(
        <div className="end-scroll">
          <article className={`doc${streaming ? ' streaming' : ''}`}>
            <h1>{ready ? <span className="muted">New note</span> : live ? <span className="shimmer">New note</span> : shown?.title || (streaming ? <span className="shimmer">{meta?.title || 'Writing the title'}</span> : meta?.title || 'Untitled note')}</h1>
            <div className="meta-row">
              <span className="meta-pill"><IconCalendar width={16} height={16} />{when}{started ? ` · ${started.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}</span>
              {meta && meta.minutes > 0 && <span className="meta-pill"><IconClock width={16} height={16} />{meta.minutes} min</span>}
              {meta && meta.participants > 0 && <span className="meta-pill"><IconPeople width={16} height={16} />{meta.participants}</span>}
              {meta && <span className="meta-pill">{modelName(meta.model)}</span>}
              <div className={`view-toggle${live || streaming ? ' working' : ''}`} role="group" aria-label="Show">
                <button className={showing === 'summary' ? 'on' : ''} aria-pressed={showing === 'summary'} aria-label="Summary" data-tip="Summary" onClick={() => setShowing('summary')}><IconNotes width={16} height={16} /></button>
                <button className={showing === 'transcript' ? 'on' : ''} aria-pressed={showing === 'transcript'} aria-label="Transcript" data-tip="Transcript" onClick={() => setShowing('transcript')}><IconLogs width={16} height={16} /></button>
              </div>
            </div>

            {showing === 'summary' && (
              <section className="doc-section my-notes-section">
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
                    ? <p key={g.turns[0].id} className="turn-sound">{[...new Set(g.turns.map((t) => t.text))].join(', ')}</p>
                    : <div key={g.turns[0].id} className={`turn-group ${g.turns[0].channel}`}>
                    <div className="spk">{speakerHead(g.turns[0])}</div>
                    {g.turns.map((t) => <p key={t.id} id={`turn-${t.id}`} className={[hot.includes(t.id) && 'hot', t.unclear && 'unclear'].filter(Boolean).join(' ') || undefined} data-tip={t.unclear ? 'Hard to hear; Quorum may have some words wrong' : undefined}>{t.text}</p>)}
                  </div>
                )) : !partial && <p className="muted">{ready ? 'Press Record to transcribe into this note.' : live ? (paused ? 'Paused. Resume to keep transcribing.' : 'Listening…') : 'Nothing was transcribed.'}</p>}
                {live && partial && <p className="live-partial"><em className="partial">{partial}</em></p>}
              </section>
            ) : <>
            {who && onAnswer && <WhoSpoke ask={who} onDone={onAnswer} />}
            {live && (
              <div className="live-wait">
                <p className="shimmer">Waiting for the recording to stop to summarize</p>
                <div className="sk-block" aria-hidden="true"><span className="sk sk-line w90" /><span className="sk sk-line w75" /><span className="sk sk-line w60" /></div>
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
                    <div className="nt-who"><Avatar name={me?.name || 'You'} photo={me?.photo ?? null} size={22} /><strong>{me?.name || 'You'}</strong></div>
                    <p className="nt-q">{f.q}</p>
                    <div className="nt-who quorum"><img src={mark} alt="" width={22} height={22} /><strong>Quorum</strong></div>
                    {f.a === null ? <p className="nt-step shimmer">Thinking…</p> : <div className="nt-a"><Markdown text={f.a} /></div>}
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
