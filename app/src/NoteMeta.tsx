import { useEffect, useRef, useState } from 'react';
import type { CalendarEvent, EventRef } from './quorum';
import markProd from '../assets/quorum-mark.png';
import markDev from '../assets/quorum-mark-dev.png';
import { AppLogo, AppPill, CALENDAR_APP, PLATFORM_APP, sourceApp } from './AppChip';
import { dayLabel } from './upNextList';
import { IconCalendar, IconPeople } from './icons';

export type NoteMetaInfo = {
  title?: string; date?: string | null; people?: string[]; source?: string | null; sourceUrl?: string | null;
  platform?: 'zoom' | 'meet' | 'teams' | null; meetingUrl?: string | null; calendar?: 'apple-calendar' | 'google-calendar' | null; event?: EventRef | null;
};

// where a note came from: the notetaker's logo and name, opening the note in that app when it has a link. Quorum's own
// notes show the Quorum mark (green in the dev copy)
function SourcePill({ source, url }: { source: string; url?: string | null }) {
  const own = source === 'quorum' || source === 'quorum-dev';
  const app = own ? { id: source, name: source === 'quorum' ? 'Quorum' : 'Quorum Dev' } : sourceApp(source);
  const logo = own ? <img className="app-logo" src={source === 'quorum' ? markProd : markDev} alt="" /> : <AppLogo {...app} />;
  if (!url) return <span className="meta-pill meta-app" data-tip={`From ${app.name}`}>{logo}{app.name}</span>;
  return <button className="meta-pill meta-app" data-tip={`Open in ${app.name}`} onClick={() => window.quorum.openExternal(url)}>{logo}{app.name}</button>;
}

// the people in a note: the first name and +N; a click lists everyone in a scrolling popover
function PeoplePill({ people }: { people: string[] }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const shut = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', shut);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('mousedown', shut); window.removeEventListener('keydown', esc); };
  }, [open]);
  if (!people.length) return null;
  return (
    <span className="menu-wrap people-pill" ref={wrap}>
      <button className="meta-pill" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <IconPeople width={16} height={16} />{people[0]}{people.length > 1 && <span className="muted">+{people.length - 1}</span>}
      </button>
      {open && (
        <div className="menu left people-pop-list" role="dialog" aria-label="People">
          <p className="people-pop-head">{people.length} {people.length === 1 ? 'person' : 'people'}</p>
          <ul>{people.map((p) => <li key={p}>{p}</li>)}</ul>
        </div>
      )}
    </span>
  );
}

// A note's details row in the Memory file view and the Home note reader: where it came from, when, who was in it, and
// its calendar event and meeting app
export function NoteMeta({ meta, children }: { meta: NoteMetaInfo; children?: React.ReactNode }) {
  const date = meta.date ? new Date(meta.date) : null;
  const ok = date && !Number.isNaN(date.getTime());
  const ev = meta.event;
  return (
    <div className="meta-row">
      {meta.source && <SourcePill source={meta.source} url={meta.sourceUrl} />}
      {ok && <span className="meta-pill"><IconCalendar width={16} height={16} />{dayLabel(date)} · {date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>}
      <PeoplePill people={meta.people ?? []} />
      {meta.calendar && ev && <AppPill id={CALENDAR_APP[meta.calendar].id} name={CALENDAR_APP[meta.calendar].name}
        onOpen={ev.item || ev.link ? () => window.quorum.calendarOpen({ ...ev, id: ev.id ?? '', title: meta.title ?? '', end: ev.start } as CalendarEvent) : null} />}
      {meta.platform && <AppPill id={PLATFORM_APP[meta.platform].id} name={PLATFORM_APP[meta.platform].short} onOpen={meta.meetingUrl ? () => window.quorum.openExternal(meta.meetingUrl!) : null} />}
      {children}
    </div>
  );
}
