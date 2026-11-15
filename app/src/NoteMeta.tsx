import { useEffect, useRef, useState } from 'react';
import type { CalendarEvent, EventRef } from './quorum';
import { AppLogo, CALENDAR_APP, PLATFORM_APP, sourceApp } from './AppChip';
import { dayLabel } from './upNextList';
import { IconCalendar, IconPeople } from './icons';

export type NoteMetaInfo = {
  title?: string; date?: string | null; people?: string[]; source?: string | null; sourceUrl?: string | null;
  platform?: 'zoom' | 'meet' | 'teams' | null; meetingUrl?: string | null; calendar?: 'apple-calendar' | 'google-calendar' | null; event?: EventRef | null;
};

// an app a note is tied to, as an icon button: the connector it came from, its calendar
// event or its meeting app; the name is in the tooltip, and a click opens the item in that app when there is a link
export function AppIcon({ id, name, logo, onOpen }: { id: string; name: string; logo?: React.ReactNode; onOpen?: (() => void) | null }) {
  const art = logo ?? <AppLogo id={id} name={name} />;
  if (!onOpen) return <span className="meta-pill meta-icon" data-tip={name} aria-label={name}>{art}</span>;
  return <button className="meta-pill meta-icon" data-tip={`Open in ${name}`} aria-label={`Open in ${name}`} onClick={onOpen}>{art}</button>;
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
      <button className="meta-pill" aria-haspopup="dialog" aria-expanded={open} aria-label={`${people.length} ${people.length === 1 ? 'person' : 'people'}`} data-tip={`${people.length} ${people.length === 1 ? 'person' : 'people'}`} onClick={() => setOpen((o) => !o)}>
        <IconPeople width={16} height={16} />{people.length}
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
      {ok && <span className="meta-pill"><IconCalendar width={16} height={16} />{dayLabel(date)} · {date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>}
      {/* a source logo shows only for a note tied to a connector; Quorum's own notes show none */}
      {meta.source && meta.source !== 'quorum' && meta.source !== 'quorum-dev' && <AppIcon {...sourceApp(meta.source)} onOpen={meta.sourceUrl ? () => window.quorum.openExternal(meta.sourceUrl!) : null} />}
      {meta.calendar && ev && <AppIcon {...CALENDAR_APP[meta.calendar]}
        onOpen={ev.item || ev.link ? () => window.quorum.calendarOpen({ ...ev, id: ev.id ?? '', title: meta.title ?? '', end: ev.start } as CalendarEvent) : null} />}
      {meta.platform && <AppIcon id={PLATFORM_APP[meta.platform].id} name={PLATFORM_APP[meta.platform].name} onOpen={meta.meetingUrl ? () => window.quorum.openExternal(meta.meetingUrl!) : null} />}
      <PeoplePill people={meta.people ?? []} />
      {children}
    </div>
  );
}
