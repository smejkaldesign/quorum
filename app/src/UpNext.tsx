import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { CalendarEvent, PlatformInfo, SourceJob } from './quorum';
import { CONNECTORS_CHANGED, canNewNote, connectorsFor } from '../connectors/library';
import { useFlag } from './flags';
import { useExclusiveMenu } from './menuBus';
import { useSession } from './session';
import { dayLabel, upNextRows } from './upNextList';
import { IconCalendar, IconChevron, IconMore, IconPlus } from './icons';

const PLATFORM = { zoom: 'Zoom', meet: 'Google Meet', teams: 'Microsoft Teams' } as const;
const time = (d: Date) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?(AM|PM)/i, '');
const half = (d: Date) => (d.getHours() < 12 ? 'AM' : 'PM');

// The calendar as Up next loaded it. UpNext is the only reader of window.quorum.calendar(); Home reads this to decide
// whether to offer connecting a calendar.
type CalView = { events: CalendarEvent[]; connected: boolean; showAll: boolean; hidden: number; status: string };
let calView: CalView = { events: [], connected: false, showAll: false, hidden: 0, status: '' };
const calSubs = new Set<() => void>();
const setCalView = (v: CalView) => { calView = v; calSubs.forEach((f) => f()); };
const subscribeCal = (f: () => void) => { calSubs.add(f); return () => { calSubs.delete(f); }; };
export const useCalendarView = () => useSyncExternalStore(subscribeCal, () => calView, () => calView);

// Up next, under the header on every tab: the next three events from the connected calendar, Show more for the rest
// (open or closed for the rest of this launch), and + New once a meeting app or a meeting notes app is connected.
// + New sends quorum:new-note, which the note editor handles. hidden keeps the loading going while the strip is out
// of sight (a live call view, or History filters).
export function UpNext({ hidden = false }: { hidden?: boolean }) {
  const cal = useCalendarView();
  const [open, setOpen] = useSession('upNextOpen', false);
  const [eventMenu, setEventMenu] = useState<string | null>(null);
  const [canNew, setCanNew] = useState(false);
  const meetingCapture = useFlag('meeting-capture');
  const listId = useId();
  const retry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // the helper can still be starting on launch, so a miss retries in 10s instead of waiting for the 5 minute refresh
  const loadCal = useCallback(function load() {
    return window.quorum.calendar().then((c) => {
      setCalView({ events: c.connected ? c.events.filter((e) => new Date(e.end) > new Date()) : [], connected: c.connected, showAll: c.showAll, hidden: c.hidden, status: c.status });
      clearTimeout(retry.current);
      if (c.status === 'unavailable') retry.current = setTimeout(load, 10000);
    }).catch(() => {});
  }, []);
  const loadConnectors = useCallback(async () => {
    // the local edition has no platform handlers; that call fails and the list stays empty
    const [sources, providers, platforms, settings] = await Promise.all([
      window.quorum.sourcesList().catch(() => []),
      window.quorum.meetingProviders().catch(() => []),
      window.quorum.platformsList().catch(() => [] as PlatformInfo[]),
      window.quorum.getSettings().catch(() => null),
    ]);
    setCanNew(canNewNote({ sources, providers, platforms, added: settings?.meetingProviders }, connectorsFor({ meetingCapture })));
  }, [meetingCapture]);
  useEffect(() => {
    loadCal();
    const t = setInterval(loadCal, 5 * 60000);
    const off = window.quorum.onSettings(() => loadCal());
    return () => { clearInterval(t); clearTimeout(retry.current); off(); };
  }, [loadCal]);
  // connector state changes only when something connects or disconnects, or a source job finishes
  useEffect(() => {
    loadConnectors();
    const changed = () => { loadConnectors(); };
    window.addEventListener(CONNECTORS_CHANGED, changed);
    const done = (j: SourceJob) => { if (j.status !== 'running') loadConnectors(); };
    const offSource = window.quorum.onSourceJob(done);
    const offPlatform = window.quorum.onPlatformJob(done);
    return () => { window.removeEventListener(CONNECTORS_CHANGED, changed); offSource(); offPlatform(); };
  }, [loadConnectors]);

  const showCal = cal.connected && (cal.events.length > 0 || cal.hidden > 0);
  if (hidden || (!showCal && !canNew)) return null;
  const { rows, more } = upNextRows(cal.events, open);
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
      {showCal && cal.events.length === 0 && <p className="up-empty">No calls on a connected platform in the next few days.</p>}
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
                  <span className="hist-hover" onMouseDown={(ev) => ev.stopPropagation()}>
                    <EventMenu event={e} open={menu} onOpen={(o) => setEventMenu(o ? e.id : null)} onChanged={loadCal} />
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

// a row's More menu, drawn on the body at the button's position so the list's scroll area cannot clip it
function EventMenu({ event: e, open, onOpen, onChanged }: { event: CalendarEvent; open: boolean; onOpen: (open: boolean) => void; onChanged: () => void }) {
  const button = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  const close = useCallback(() => onOpen(false), [onOpen]);
  useExclusiveMenu(`up-${e.id}`, open, close);
  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const r = button.current.getBoundingClientRect();
    setAt({ top: r.bottom + 4, right: window.innerWidth - r.right });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    window.addEventListener('mousedown', close);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('resize', close); window.removeEventListener('scroll', close, true); };
  }, [open, close]);
  const run = (fn: () => unknown) => () => { onOpen(false); fn(); };
  return (
    <>
      <button ref={button} className="icon-btn up-more" aria-label="More" aria-expanded={open} onClick={(ev) => { ev.stopPropagation(); onOpen(!open); }}><IconMore /></button>
      {open && at && createPortal(
        <div className="menu up-menu" style={{ position: 'fixed', top: at.top, right: at.right }} onMouseDown={(ev) => ev.stopPropagation()} onClick={(ev) => ev.stopPropagation()}>
          {e.item && <button onClick={run(() => window.quorum.calendarOpen(e))}>View in Calendar</button>}
          {e.join && <button onClick={run(() => window.quorum.openExternal(e.join!))}>Open call link</button>}
          <button onClick={run(() => window.quorum.calendarSet({ hide: e.id }).then(onChanged))}>Remove from list</button>
        </div>,
        document.body,
      )}
    </>
  );
}
