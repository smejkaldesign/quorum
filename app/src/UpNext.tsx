import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { CalendarEvent, PlatformInfo } from './quorum';
import { useSession } from './session';
import { canNewNote, dayLabel, upNextRows, type ConnectionLive } from './upNextList';
import { IconCalendar, IconChevron, IconMore, IconPlus } from './icons';

const PLATFORM = { zoom: 'Zoom', meet: 'Google Meet', teams: 'Microsoft Teams' } as const;
const time = (d: Date) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?(AM|PM)/i, '');
const half = (d: Date) => (d.getHours() < 12 ? 'AM' : 'PM');

// Up next, above the top tabs on every tab: the next three events from the connected calendar, Show more for the rest
// (open or closed for the rest of this launch), and + New once a meeting app or a meeting notes app is connected.
// + New sends quorum:new-note; the note editor listens for it.
export function UpNext() {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  // events without a call on a connected platform stay out of the list unless asked for; hidden counts them
  const [cal, setCal] = useState<{ connected: boolean; showAll: boolean; hidden: number }>({ connected: false, showAll: false, hidden: 0 });
  const [open, setOpen] = useSession('upNextOpen', false);
  const [eventMenu, setEventMenu] = useState<string | null>(null);
  const [canNew, setCanNew] = useState(false);
  const listId = useId();
  const retry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // the helper can still be starting on launch, so a miss retries in 10s instead of waiting for the 5 minute refresh
  const loadCal = useCallback(() => window.quorum.calendar().then((c) => {
    setEvents(c.connected ? c.events.filter((e) => new Date(e.end) > new Date()) : []);
    setCal({ connected: c.connected, showAll: c.showAll, hidden: c.hidden });
    clearTimeout(retry.current);
    if (c.status === 'unavailable') retry.current = setTimeout(loadCal, 10000);
  }).catch(() => {}), []);
  const loadConnectors = useCallback(async () => {
    // the local edition has no platform handlers; that call fails and the list stays empty
    const [sources, providers, platforms] = await Promise.all([
      window.quorum.sourcesList().catch(() => []),
      window.quorum.meetingProviders().catch(() => []),
      window.quorum.platformsList().catch(() => [] as PlatformInfo[]),
    ]);
    setCanNew(canNewNote({ sources, providers, platforms } as ConnectionLive));
  }, []);
  useEffect(() => {
    const load = () => { loadCal(); loadConnectors(); };
    load();
    const t = setInterval(load, 5 * 60000);
    const off = window.quorum.onSettings(load);
    const offSource = window.quorum.onSourceJob(() => loadConnectors());
    return () => { clearInterval(t); clearTimeout(retry.current); off(); offSource(); };
  }, [loadCal, loadConnectors]);
  useEffect(() => {
    if (!eventMenu) return;
    const close = () => setEventMenu(null);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [eventMenu]);

  const showCal = cal.connected && (events.length > 0 || cal.hidden > 0);
  if (!showCal && !canNew) return null;
  const { rows, more } = upNextRows(events, open);
  return (
    <section className="up-strip" aria-label="Up next">
      <div className="up-head">
        <h4>Up next</h4>
        <span className="up-head-end">
          {showCal && (cal.hidden > 0 || cal.showAll) && (
            <label className="up-toggle"><input type="checkbox" checked={cal.showAll} onChange={(ev) => window.quorum.calendarSet({ showAll: ev.target.checked }).then(loadCal)} />Show no meeting{!cal.showAll && cal.hidden > 0 ? ` (${cal.hidden})` : ''}</label>
          )}
          {canNew && <button className="pill small-pill up-new" onClick={() => window.dispatchEvent(new CustomEvent('quorum:new-note'))}><IconPlus width={14} height={14} />New</button>}
        </span>
      </div>
      {showCal && events.length === 0 && <p className="up-empty">No calls on a connected platform in the next few days.</p>}
      {!showCal && <p className="up-empty">{cal.connected ? 'No upcoming meetings.' : 'Connect a calendar in Settings to see your upcoming meetings here.'}</p>}
      {rows.length > 0 && (
        <div className="up-list" id={listId}>
          {rows.map((e) => {
            const at = new Date(e.start), end = new Date(e.end);
            const platform = e.platform ? PLATFORM[e.platform] : null;
            const menu = eventMenu === e.id;
            return (
              <div key={e.id} className="hist-item">
                <div className={`hist-row up-row ${menu ? 'menu-open' : ''}`} onClick={() => e.item && window.quorum.calendarOpen(e)}>
                  <span className="avatar-sq cal"><IconCalendar width={18} height={18} /></span>
                  <span className="hist-text"><strong>{e.title}</strong><span>{dayLabel(at)} · {time(at)} – {time(end)} {half(end)}{platform ? ` · ${platform}` : ''}</span></span>
                  {!e.platform && <span className="up-badge">No meeting</span>}
                  <span className="hist-time">{time(at)}<small>{half(at)}</small></span>
                  <span className="hist-hover menu-wrap" onMouseDown={(ev) => ev.stopPropagation()}>
                    <button className="icon-btn up-more" aria-label="More" aria-expanded={menu} onClick={(ev) => { ev.stopPropagation(); setEventMenu(menu ? null : e.id); }}><IconMore /></button>
                    {menu && (
                      <div className="menu up-menu" onClick={(ev) => ev.stopPropagation()}>
                        {e.item && <button onClick={() => { setEventMenu(null); window.quorum.calendarOpen(e); }}>View in Calendar</button>}
                        {e.join && <button onClick={() => { setEventMenu(null); window.quorum.openExternal(e.join!); }}>Open call link</button>}
                        <button onClick={() => { setEventMenu(null); window.quorum.calendarSet({ hide: e.id }).then(loadCal); }}>Remove from list</button>
                      </div>
                    )}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {more && (
        <div className="up-more-row">
          <button className="up-show-more" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((o) => !o)}>
            {open ? 'Show less' : 'Show more'}<IconChevron width={14} height={14} className={open ? 'up-chev open' : 'up-chev'} />
          </button>
        </div>
      )}
    </section>
  );
}
