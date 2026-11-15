import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CalendarEvent, MeetingBrief } from './quorum';
import { AppPill, CALENDAR_APP, PLATFORM_APP, peopleText } from './AppChip';
import { Markdown } from './Markdown';
import { dayLabel } from './upNextList';
import { IconArrowRight, IconBack } from './icons';
import { TypedTitle, useStuck } from './StickyBar';
import { Composer } from './Composer';
import { Avatar } from './Speaker';
import { splitChoices } from './MeetingNote';
import markProd from '../assets/quorum-mark.png';

// one click each, above the chat input before the first question
const PREP_ASKS = ['What is still open from last time?', 'What should I ask in this meeting?'];

// questions about the meeting before it happens, answered from its prep notes, past notes and the rest of the Agent OS
function MeetingChat({ event }: { event: CalendarEvent }) {
  const [turns, setTurns] = useState<{ q: string; a: string; pending?: boolean }[]>([]);
  const [draft, setDraft] = useState('');
  const [live, setLive] = useState('');
  const [step, setStep] = useState('');
  const [me, setMe] = useState<{ name: string; photo: string | null }>({ name: 'You', photo: null });
  useEffect(() => { window.quorum.user().then((u) => { if (u) setMe({ name: u.name || 'You', photo: u.photo ?? null }); }).catch(() => {}); }, []);
  useEffect(() => window.quorum.onNoteDelta(({ text }) => setLive(text)), []);
  useEffect(() => window.quorum.onAgentStep(({ text }) => setStep(text)), []);
  // its saved chat comes back with the page; opened from the row's chats link, the page scrolls down to it
  useEffect(() => {
    window.quorum.eventChat(event.id).then((c) => {
      if (!c?.turns.length) return;
      setTurns(c.turns);
      if (event.openChat) requestAnimationFrame(() => document.querySelector('.meeting-page .note-thread')?.scrollIntoView({ block: 'start' }));
    }).catch(() => {});
  }, [event.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const busy = turns.some((t) => t.pending);
  async function ask(said?: string) {
    const q = (said ?? draft).trim();
    if (!q || busy) return;
    setDraft(''); setLive(''); setStep('');
    const history = turns.map(({ q: tq, a }) => ({ q: tq, a }));
    setTurns((t) => [...t, { q, a: '', pending: true }]);
    let a: string;
    try { a = (await window.quorum.meetingAsk(event, q, history)).text; } catch (err) { a = `Couldn't answer: ${String(err).replace(/^.*Error:\s*/, '')}`; }
    setTurns((t) => t.map((x, i) => (i === t.length - 1 ? { q: x.q, a } : x)));
  }
  return (
    <>
      {turns.length > 0 && (
        <section className="note-thread" aria-label="Questions about this meeting">
          {turns.map((t, i) => {
            const { text, choices } = splitChoices(t.pending ? live : t.a);
            return (
              <div key={i} className="nt-turn">
                <div className="nt-who"><Avatar name={me.name} photo={me.photo} size={22} /><strong>{me.name}</strong></div>
                <p className="nt-q">{t.q}</p>
                <div className="nt-who quorum"><img src={markProd} alt="" width={22} height={22} /><strong>Quorum</strong></div>
                {t.pending && !text ? <p className="nt-step shimmer">{step || 'Thinking…'}</p> : <div className="nt-a"><Markdown text={text} /></div>}
                {!t.pending && i === turns.length - 1 && choices.length > 0 && (
                  <div className="nt-choices">{choices.map((c) => <button key={c} className="pill small-pill" disabled={busy} onClick={() => ask(c)}>{c}</button>)}</div>
                )}
              </div>
            );
          })}
        </section>
      )}
      <div className="note-dock">
        {turns.length === 0 && (
          <div className="skill-pills" role="group" aria-label="Quick asks">
            {PREP_ASKS.map((q) => <button key={q} className="skill-pill" disabled={busy} onClick={() => ask(q)}>{q}</button>)}
          </div>
        )}
        <Composer className="note-composer" value={draft} onChange={setDraft} onSubmit={() => ask()} busy={busy} placeholder="Ask about this meeting" />
      </div>
    </>
  );
}

const ABOUT = [['what', 'What it is'], ['who', 'Who attends'], ['how', 'How it runs']] as const;

// a section's loading placeholder: grey lines that shimmer
function Skeleton({ lines }: { lines: number }) {
  return <div className="mp-skel" aria-label="Loading">{Array.from({ length: lines }, (_, i) => <span key={i} style={{ width: `${i === lines - 1 ? 60 : 100}%` }} />)}</div>;
}

// Text that types in: reveal(text) returns as much of each text as the shared clock has reached, so every section
// starts and finishes together whatever its length. Reduced motion shows it all at once.
function useReveal(total: number, key: unknown) {
  const [p, setP] = useState(1);
  useEffect(() => {
    if (!total || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { setP(1); return; }
    setP(0);
    const start = performance.now(), ms = 550;
    let raf = 0;
    const tick = (t: number) => { const x = Math.min(1, (t - start) / ms); setP(x); if (x < 1) raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [total, key]);
  return (text: string) => (p >= 1 ? text : text.slice(0, Math.ceil(text.length * p)));
}

const clock = (d: Date) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// The page an upcoming meeting opens to from Home or Up next: when it is, who is invited, its calendar and meeting
// app, and for a recurring meeting, prep notes and a short description written from its past notes (main.js
// meeting-brief). Fewer than three past meetings shows what will appear once there are.
export function MeetingPage({ event: e, onBack, onOpenNote }: { event: CalendarEvent; onBack: () => void; onOpenNote: (file: string) => void }) {
  const [data, setData] = useState<MeetingBrief | null>(null);
  const [writing, setWriting] = useState(false);
  const bar = useStuck();
  const top = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { top.current?.scrollIntoView({ block: 'start' }); }, [e.id]);
  useEffect(() => {
    let live = true;
    setData(null);
    window.quorum.meetingBrief({ title: e.title }).then((r) => {
      if (!live) return;
      setData(r);
      if (r.status !== 'stale') return;
      setWriting(true);
      window.quorum.meetingBrief({ title: e.title, generate: true }).then((g) => { if (live) setData(g); }).finally(() => { if (live) setWriting(false); });
    }).catch(() => { if (live) setData({ past: [], brief: null, status: 'failed' }); });
    return () => { live = false; };
  }, [e.id, e.title]);

  const at = new Date(e.start), end = new Date(e.end);
  const platform = e.platform ? PLATFORM_APP[e.platform] : null;
  const brief = data?.brief;
  const loading = !data || writing;
  // once the brief arrives, every section types itself in together over about half a second
  const reveal = useReveal(brief ? [brief.prep, brief.what, brief.who, brief.how].join('').length : 0, brief);
  const emptyText = data?.status === 'few' ? 'Not recurring yet. After 3 or more meetings, Quorum starts showing a summary and prep notes for this meeting, specific to you.'
    : data?.status === 'no-model' ? "Choose a model in Settings and Quorum writes prep notes from this meeting's past notes."
    : 'Quorum could not write prep notes this time. They are tried again the next time you open this meeting.';
  return (
    <div className="history reader meeting-page" ref={top}>
      <div ref={bar.sentinel} className="rb-sentinel" aria-hidden="true" />
      <div className={`reader-bar sticky-bar${bar.stuck ? ' stuck' : ''}`}>
        <span className="rb-left"><button className="pill primary small-pill" onClick={onBack}><IconBack width={16} height={16} /> Back</button><TypedTitle text={e.title} on={bar.stuck} /></span>
        <div className="reader-actions">
          {platform && e.join && <button className="up-join" onClick={() => window.quorum.openExternal(e.join!)}>Join {platform.short}<IconArrowRight width={14} height={14} /></button>}
        </div>
      </div>
      <article className="doc">
        <h1>{e.title}</h1>
        <div className="meta-row">
          <span className="meta-pill">{dayLabel(at)} · {clock(at)} – {clock(end)}</span>
          <span className="meta-pill">{peopleText(e)}</span>
          {e.calendar && <AppPill id={CALENDAR_APP[e.calendar].id} name={CALENDAR_APP[e.calendar].name} onOpen={e.item || e.link ? () => window.quorum.calendarOpen(e) : null} />}
          {platform && <AppPill id={platform.id} name={platform.short} onOpen={e.join ? () => window.quorum.openExternal(e.join!) : null} />}
        </div>

        <section className="mp-section mp-prep">
          <h2>Meeting prep notes</h2>
          {loading ? <Skeleton lines={4} />
            : brief?.prep ? <Markdown text={reveal(brief.prep)} />
            : <p className="mp-empty">{emptyText}</p>}
        </section>

        <section className="mp-section">
          <h2>About this meeting</h2>
          {ABOUT.map(([key, label]) => (
            <div key={key} className="mp-about">
              <h3>{label}</h3>
              {loading ? <Skeleton lines={2} />
                : brief?.[key] ? <p>{reveal(brief[key])}</p>
                : <p className="mp-empty">{data?.status === 'few' ? 'Shows after 3 meetings.' : 'Not written yet.'}</p>}
            </div>
          ))}
        </section>

        {!!data?.past.length && (
          <section className="mp-section">
            <h2>Past meetings</h2>
            <div className="mp-past">
              {data.past.map((p) => (
                <button key={p.file} className="mp-past-row" onClick={() => onOpenNote(p.file)}>
                  <span>{p.title}</span><span className="muted">{p.date ? dayLabel(new Date(p.date)) : 'Undated'}</span>
                </button>
              ))}
            </div>
          </section>
        )}
      </article>
      <MeetingChat key={e.id} event={e} />
    </div>
  );
}
