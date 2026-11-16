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

// a date written as a day alone (date: 2026-11-16) is that day here, with no time
const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const parseDate = (v: string) => (DAY_ONLY.test(v) ? new Date(`${v}T00:00:00`) : new Date(v));
const dayOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// the date pill as a button: it opens a date picker, and Set date writes date: YYYY-MM-DD into the note's frontmatter
function DatePill({ date, label, missing, onSet }: { date: Date | null; label: React.ReactNode; missing: boolean; onSet: (day: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [day, setDay] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrap = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const shut = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', shut);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('mousedown', shut); window.removeEventListener('keydown', esc); };
  }, [open]);
  const toggle = () => { if (!open) { setDay(date ? dayOf(date) : dayOf(new Date())); setError(null); } setOpen((o) => !o); };
  const save = async () => {
    setBusy(true);
    setError(null);
    try { await onSet(day); setOpen(false); } catch (e) { setError(String((e as Error)?.message ?? e).replace(/^.*Error:\s*/, '')); } finally { setBusy(false); }
  };
  const tip = missing ? 'This note has no date in its details. Set one' : 'Change the date';
  return (
    <span className="menu-wrap date-pill" ref={wrap}>
      <button className={`meta-pill${missing ? ' meta-missing' : ''}`} aria-haspopup="dialog" aria-expanded={open} data-tip={tip} onClick={toggle}>
        <IconCalendar width={16} height={16} />{label}
      </button>
      {open && (
        <div className="people-pop date-pop note-date-pop" role="dialog" aria-label="Note date">
          <div className="dp-custom">
            <label>Date<input className="fp-input" type="date" value={day} autoFocus onChange={(e) => setDay(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && DAY_ONLY.test(day)) save(); }} /></label>
            <button className="pill primary small-pill" disabled={busy || !DAY_ONLY.test(day)} onClick={save}>Set date</button>
          </div>
          {error && <p className="set-error note-date-error" role="alert">{error}</p>}
        </div>
      )}
    </span>
  );
}

// A note's details row in the Memory file view and the Home note reader: where it came from, when, who was in it, and
// its calendar event and meeting app. onSetDate makes the date pill a button that sets the note's date
export function NoteMeta({ meta, onSetDate, children }: { meta: NoteMetaInfo; onSetDate?: (day: string) => Promise<void>; children?: React.ReactNode }) {
  const date = meta.date ? parseDate(meta.date) : null;
  const ok = !!date && !Number.isNaN(date.getTime());
  const ev = meta.event;
  const label = ok ? (DAY_ONLY.test(meta.date ?? '') ? dayLabel(date) : `${dayLabel(date)} · ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`) : 'Date missing';
  return (
    <div className="meta-row">
      {/* the date pill is always there; a note without a readable date says so, subdued */}
      {onSetDate ? <DatePill date={ok ? date : null} label={label} missing={!ok} onSet={onSetDate} />
        : ok ? <span className="meta-pill"><IconCalendar width={16} height={16} />{label}</span>
        : <span className="meta-pill meta-missing" data-tip="This note has no date in its details"><IconCalendar width={16} height={16} />Date missing</span>}
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
