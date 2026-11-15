import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CalendarEvent, MeetingBrief } from './quorum';
import { AppPill, CALENDAR_APP, PLATFORM_APP, peopleText } from './AppChip';
import { Markdown } from './Markdown';
import { dayLabel } from './upNextList';
import { IconBack } from './icons';

const clock = (d: Date) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// The page an upcoming meeting opens to from Home or Up next: when it is, who is invited, its calendar and meeting
// app, and for a recurring meeting, prep notes and a short description written from its past notes (main.js
// meeting-brief). Fewer than three past meetings shows what will appear once there are.
export function MeetingPage({ event: e, onBack, onOpenNote }: { event: CalendarEvent; onBack: () => void; onOpenNote: (file: string) => void }) {
  const [data, setData] = useState<MeetingBrief | null>(null);
  const [writing, setWriting] = useState(false);
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
  return (
    <div className="history reader meeting-page" ref={top}>
      <div className="reader-bar">
        <button className="pill primary small-pill" onClick={onBack}><IconBack width={16} height={16} /> Back</button>
        <div className="reader-actions">
          {platform && e.join && <button className="up-join" onClick={() => window.quorum.openExternal(e.join!)}>Join {platform.short}</button>}
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
          {!data ? <p className="nt-step shimmer">Reading past meetings…</p>
            : brief?.prep ? <Markdown text={brief.prep} />
            : writing ? <p className="nt-step shimmer">Writing prep notes from {data.past.length} past meetings…</p>
            : data.status === 'few' ? <p className="mp-empty">Not recurring yet. After 3 or more meetings, Quorum starts showing a summary and prep notes for this meeting, specific to you.</p>
            : data.status === 'no-model' ? <p className="mp-empty">Choose a model in Settings and Quorum writes prep notes from this meeting's past notes.</p>
            : <p className="mp-empty">Quorum could not write prep notes this time. They are tried again the next time you open this meeting.</p>}
        </section>

        {brief && (brief.what || brief.who || brief.how) && (
          <section className="mp-section">
            <h2>About this meeting</h2>
            {brief.what && <p><strong>What it is.</strong> {brief.what}</p>}
            {brief.who && <p><strong>Who attends.</strong> {brief.who}</p>}
            {brief.how && <p><strong>How it runs.</strong> {brief.how}</p>}
          </section>
        )}

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
    </div>
  );
}
