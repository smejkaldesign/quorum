import { type ReactNode, useEffect, useState, useSyncExternalStore } from 'react';
import { CONNECTORS } from '../connectors/library';
import { isCalendarAddress, whoText } from '../meetingWho.js';

// The meeting apps a calendar event or a note can name, by the connector that carries the logo
export type Platform = 'zoom' | 'meet' | 'teams';
export const PLATFORM_APP: Record<Platform, { id: string; name: string; short: string }> = {
  zoom: { id: 'zoom', name: 'Zoom', short: 'Zoom' },
  meet: { id: 'google-meet', name: 'Google Meet', short: 'Meet' },
  teams: { id: 'teams', name: 'Microsoft Teams', short: 'Teams' },
};

// the calendars an event or a matched note can come from
export const CALENDAR_APP = { 'apple-calendar': { id: 'apple-calendar', name: 'Calendar' }, 'google-calendar': { id: 'google-calendar', name: 'Google Calendar' } } as const;

// connector logos, loaded once per launch and shared by every row
let icons: Record<string, string | null> = {};
let loading = false;
const subs = new Set<() => void>();
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
export function useAppIcons() {
  useEffect(() => {
    if (loading) return;
    loading = true;
    window.quorum.libraryIcons().then((i) => { icons = i ?? {}; subs.forEach((f) => f()); }).catch(() => { loading = false; });
  }, []);
  return useSyncExternalStore(subscribe, () => icons, () => icons);
}

// a notes source (granola, fireflies, ...) as the connector that brings it in
export function sourceApp(source: string) {
  const c = CONNECTORS.find((x) => x.source === source || x.id === source);
  return c ? { id: c.id, name: c.name } : { id: source, name: source[0].toUpperCase() + source.slice(1) };
}

// An app's logo, the letter of its name when there is no logo
export function AppLogo({ id, name }: { id: string; name: string }) {
  const icons = useAppIcons();
  const [broken, setBroken] = useState(false);
  return icons[id] && !broken ? <img className="app-logo" src={icons[id]!} alt="" onError={() => setBroken(true)} /> : <span className="app-logo app-chip-letter">{name[0]}</span>;
}

// An app's logo and name in a row's details, subdued until hovered. With a link, a click opens the item in that app
// without opening the row.
export function AppChip({ id, name, url }: { id: string; name: string; url?: string | null }) {
  if (!url) return <span className="app-chip"><AppLogo id={id} name={name} />{name}</span>;
  return (
    <a className="app-chip link" href={url} data-tip={`Open in ${name}`}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); window.quorum.openExternal(url); }}
      onKeyDown={(e) => e.stopPropagation()}>
      <AppLogo id={id} name={name} />{name}
    </a>
  );
}

// Details text that opens the item in its app (a link, or onOpen for the calendar): subdued, white on hover, without
// opening the row
export function AppLink({ url, onOpen, name, logo, children }: { url?: string | null; onOpen?: () => void; name: string; logo?: string; children: ReactNode }) {
  return (
    <a className="app-link hist-sub-text" href={url ?? '#'} data-tip={`Open in ${name}`}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); if (onOpen) onOpen(); else if (url) window.quorum.openExternal(url); }}
      onKeyDown={(e) => e.stopPropagation()}>
      {logo && <AppLogo id={logo} name={name} />}<span className="app-link-text">{children}</span>
    </a>
  );
}

// who was in a meeting, in the row's few words: the person the calendar event names (meetingWho.js) and how many others
// were invited, else the people the notetaker heard, else Self. A group or resource calendar's address is never shown
export function peopleText(event: { organizer?: string; others?: number; count?: number } | null | undefined, people: string[] = []) {
  const count = event?.count ?? 0;
  if (event?.organizer && !isCalendarAddress(event.organizer)) return whoText(event.organizer, event.others ?? Math.max(0, count - 1));
  if (people.length) return whoText(people[0], people.length - 1);
  return count > 1 ? `${count} people` : 'Self';
}

// A meeting's details on Home and in Up next: who (opening the calendar event when there is one), the meeting app (its
// call link), and the notetaker (its note)
export function RowDetails({ who, onCalendar, calendarName, platform, meetingUrl, source, sourceUrl, after }: {
  who: string; onCalendar?: (() => void) | null; calendarName?: string; platform?: Platform | null; meetingUrl?: string | null;
  source?: string | null; sourceUrl?: string | null; after?: ReactNode;
}) {
  return (
    <span className="hist-sub">
      {onCalendar ? <AppLink onOpen={onCalendar} name={calendarName ?? 'Calendar'}>{who}</AppLink> : <span className="hist-sub-text">{who}</span>}
      {platform && <AppChip id={PLATFORM_APP[platform].id} name={PLATFORM_APP[platform].short} url={meetingUrl} />}
      {source && source !== 'quorum' && <AppChip {...sourceApp(source)} url={sourceUrl} />}
      {after}
    </span>
  );
}

// the same apps as pills in a page's details row
export function AppPill({ id, name, onOpen }: { id: string; name: string; onOpen?: (() => void) | null }) {
  if (!onOpen) return <span className="meta-pill meta-app"><AppLogo id={id} name={name} />{name}</span>;
  return <button className="meta-pill meta-app" data-tip={`Open in ${name}`} onClick={onOpen}><AppLogo id={id} name={name} />{name}</button>;
}
