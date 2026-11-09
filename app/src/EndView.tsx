import { useEffect, useRef, useState } from 'react';
import type { MeetingMeta, Notes, NotesDraft } from './quorum';
import { SpeakerName, similarCount, type SpeakerTurn } from './Speaker';
import mark from '../assets/quorum-mark.png';
import { Markdown } from './Markdown';
import { IconArrowUp, IconCalendar, IconClock, IconFolder, IconLogs, IconNotes, IconPeople } from './icons';

type Followup = { q: string; a: string | null };

// Granola-sized end-of-call note: title, meta pills, sectioned notes, follow-up composer. While the notes stream in,
// whatever already parses is shown; a bullet with refs points back at the transcript turns it came from
export type Turn = SpeakerTurn & { who: string };

export function EndView({ notes, draft, meta, summarizing, transcript, participants, onSpeaker, onClose }: { notes: Notes | null; draft: NotesDraft | null; meta: MeetingMeta | null; summarizing: boolean; transcript: Turn[]; participants: string[]; onSpeaker: (id: number, name: string | null, similar: boolean) => Promise<void>; onClose: () => void }) {
  const [showing, setShowing] = useState<'summary' | 'transcript'>('summary');
  const [dropped, setDropped] = useState<Record<number, boolean>>({});
  const [followups, setFollowups] = useState<Followup[]>([]);
  const [draftQ, setDraftQ] = useState('');
  const [saved, setSaved] = useState<{ file: string; rel: string; app: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [hot, setHot] = useState<number[]>([]);
  const end = useRef<HTMLDivElement>(null);
  const streaming = summarizing && !notes;
  const shown = notes ?? draft?.partial ?? null;

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
    setSaving(true);
    try {
      const r = await window.quorum.saveNotes({
        notes: { ...notes, actions: notes.actions.filter((_, i) => !dropped[i]) },
        followups: followups.filter((f): f is { q: string; a: string } => !!f.a),
      });
      setSaved(r);
    } finally { setSaving(false); }
  }

  const turnById = new Map(transcript.map((t) => [t.id, t]));
  const tipFor = (refs: number[]) => { const t = refs.map((id) => turnById.get(id)).find(Boolean); return t ? `${t.who}: ${t.text.length > 180 ? `${t.text.slice(0, 180)}…` : t.text}` : undefined; };
  const refProps = (refs: number[]) => (refs?.length ? { className: 'ref', 'data-tip': tipFor(refs), 'data-tip-pos': 'top', onMouseEnter: () => setHot(refs), onMouseLeave: () => setHot([]), onClick: () => { if (refs.some((id) => turnById.has(id))) { setHot(refs); setShowing('transcript'); } } } : {});

  const started = meta?.startedAt ? new Date(meta.startedAt) : null;
  const when = started ? (started.toDateString() === new Date().toDateString() ? 'Today' : started.toLocaleDateString()) : 'Today';

  return (
    <div className="panel end">
      <header className="end-bar">
        <button className="pill ghost" onClick={async () => { await window.quorum.discard(); onClose(); }}>{saved ? 'Close' : 'Discard'}</button>
        <div className="end-actions">
          {saved ? (
            <>
              <span className="saved">Saved to {saved.rel.replace(/^MyBrain\//, '')}</span>
              <button className="pill" onClick={() => window.quorum.openNote(saved.file)}><IconFolder width={15} height={15} /> Show in {saved.app}</button>
            </>
          ) : (
            <button className="pill primary" disabled={!notes || saving} onClick={save}>{saving ? 'Saving…' : 'Save to vault'}</button>
          )}
        </div>
      </header>

      {!shown && !draft?.text ? (
        <div className="end-loading">
          <span className="spinner big" />
          <p>Summarizing call…</p>
        </div>
      ) : (
        <div className="end-scroll">
          <article className="doc">
            <h1>{shown?.title || meta?.title || 'Untitled meeting'}</h1>
            <div className="meta-row">
              <span className="meta-pill"><IconCalendar width={16} height={16} />{when}{started ? ` · ${started.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}</span>
              {meta && meta.minutes > 0 && <span className="meta-pill"><IconClock width={16} height={16} />{meta.minutes} min</span>}
              {meta && meta.participants > 0 && <span className="meta-pill"><IconPeople width={16} height={16} />{meta.participants}</span>}
              {meta && <span className="meta-pill">{modelName(meta.model)}</span>}
              <div className="view-toggle" role="group" aria-label="Show">
                <button className={showing === 'summary' ? 'on' : ''} aria-pressed={showing === 'summary'} aria-label="Summary" data-tip="Summary" onClick={() => setShowing('summary')}><IconNotes width={16} height={16} /></button>
                <button className={showing === 'transcript' ? 'on' : ''} aria-pressed={showing === 'transcript'} aria-label="Transcript" data-tip="Transcript" onClick={() => setShowing('transcript')}><IconLogs width={16} height={16} /></button>
              </div>
            </div>

            {showing === 'transcript' ? (
              <section className="transcript end-transcript">
                {transcript.length ? transcript.map((t) => (
                  <p key={t.id} id={`turn-${t.id}`} className={`${t.channel}${hot.includes(t.id) ? ' hot' : ''}`}>
                    {t.channel === 'them' ? <SpeakerName turn={t} fallback={t.who} participants={participants} similar={similarCount(transcript, t)} onPick={(name, similar) => onSpeaker(t.id, name, similar)} /> : <span>{t.who}</span>}
                    <div>{t.text}</div>
                  </p>
                )) : <p className="muted">Nothing was transcribed.</p>}
              </section>
            ) : !shown ? <p className="raw">{draft?.text}</p> : <>
            {shown.empty && <p className="muted">Nothing was transcribed in this call.</p>}
            {shown.summary && <p className="summary">{shown.summary}</p>}
            {shown.sections.map((sec, i) => (
              <section key={i} className="doc-section">
                <h2><span className="hash">#</span>{sec.heading}</h2>
                <ul>
                  {sec.bullets.map((b, j) => (
                    <li key={j} {...refProps(b.refs)}>{b.text}{b.sub?.length > 0 && <ul>{b.sub.map((s, k) => <li key={k}>{s}</li>)}</ul>}</li>
                  ))}
                </ul>
              </section>
            ))}
            {shown.decisions.length > 0 && (
              <section className="doc-section">
                <h2><span className="hash">#</span>Decisions</h2>
                <ul>{shown.decisions.map((d, i) => <li key={i} {...refProps(d.refs)}>{d.text}{d.status !== 'confirmed' && <em className="status"> · not agreed</em>}</li>)}</ul>
              </section>
            )}
            {shown.actions.length > 0 && (
              <section className="doc-section">
                <h2><span className="hash">#</span>Action items</h2>
                {shown.actions.map((a, i) => (
                  <label key={i} className="item" {...refProps(a.refs)}>
                    <input type="checkbox" checked={!dropped[i]} disabled={!notes} onChange={(e) => setDropped((d) => ({ ...d, [i]: !e.target.checked }))} />
                    <span>{a.task}<em> · {a.owner ?? 'no owner'}{a.due ? ` · due ${a.due}` : ''}{!a.owner || !a.due ? ' · not agreed' : ''}</em></span>
                  </label>
                ))}
                {notes && <p className="hint left">Unchecked items are left out of the saved note.</p>}
              </section>
            )}
            {shown.questions.length > 0 && (
              <section className="doc-section">
                <h2><span className="hash">#</span>Open questions</h2>
                <ul>{shown.questions.map((q, i) => <li key={i} {...refProps(q.refs)}>{q.text}</li>)}</ul>
              </section>
            )}
            {streaming && <p className="muted writing"><span className="spinner tiny" /> Writing notes…</p>}
            </>}

            {followups.length > 0 && (
              <section className="doc-section">
                <h2><span className="hash">#</span>Follow-ups</h2>
                {followups.map((f, i) => (
                  <div key={i} className="followup">
                    <div className="user-msg">{f.q}</div>
                    <div className="quorum-row">
                      <img className="avatar" src={mark} alt="Quorum" />
                      <div className="card">{f.a === null ? <p className="muted thinking">Thinking…</p> : <Markdown text={f.a} />}</div>
                    </div>
                  </div>
                ))}
              </section>
            )}
            <div ref={end} />
          </article>
        </div>
      )}

      <div className="end-composer-wrap">
        <form className="end-composer" onSubmit={(e) => { e.preventDefault(); ask(); }}>
          <input value={draftQ} placeholder="Any follow-ups?" disabled={!notes || summarizing} onChange={(e) => setDraftQ(e.target.value)} />
          <button type="submit" className="send" aria-label="Ask" disabled={!draftQ.trim()}><IconArrowUp /></button>
        </form>
        <p className="disclaimer">Quorum uses AI and can make mistakes.</p>
      </div>
    </div>
  );
}

// the note's model field, readable: claude-sonnet -> Claude Sonnet, claude-sonnet-5-5 -> Claude Sonnet 5.5, ollama/llama3.1 -> llama3.1
function modelName(m: string) {
  if (m.startsWith('ollama/')) return m.slice(7);
  if (!m.startsWith('claude-')) return m;
  return `Claude ${m.slice(7).replace(/^\w/, (c) => c.toUpperCase()).replace(/-(\d+)-(\d+)$/, ' $1.$2')}`;
}
