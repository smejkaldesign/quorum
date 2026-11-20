import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { CalendarEvent, ChatRow } from './quorum';
import markProd from '../assets/quorum-mark.png';
import { useExclusiveMenu } from './menuBus';
import { useSession } from './session';
import { ConfirmModal } from './ConfirmModal';
import { DayOff } from './DayOff';
import { dayLabel, upNextRows } from './upNextList';
import { AppLogo, CALENDAR_APP, PLATFORM_APP, RowDetails, peopleText, useAppIcons } from './AppChip';
import { IconArrowRight, IconCalendar, IconChevron, IconMore } from './icons';

const time = (d: Date) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?(AM|PM)/i, '');
const half = (d: Date) => (d.getHours() < 12 ? 'AM' : 'PM');

// The calendar as Up next loaded it. UpNext is the only reader of window.quorum.calendar(); Home reads this to decide
// whether to offer connecting a calendar.
type CalView = { events: CalendarEvent[]; connected: boolean; showAll: boolean; hidden: number; status: string; days: number | 'week' };
let calView: CalView = { events: [], connected: false, showAll: false, hidden: 0, status: '', days: 1 };
const calSubs = new Set<() => void>();
const setCalView = (v: CalView) => { calView = v; calSubs.forEach((f) => f()); };
const subscribeCal = (f: () => void) => { calSubs.add(f); return () => { calSubs.delete(f); }; };
export const useCalendarView = () => useSyncExternalStore(subscribeCal, () => calView, () => calView);

// Whether the Home list's top group has scrolled out of view, which slides the strip in on Home.
let passedTop = false;
const passSubs = new Set<() => void>();
const setPassed = (v: boolean) => { if (passedTop !== v) { passedTop = v; passSubs.forEach((f) => f()); } };
const usePassed = () => useSyncExternalStore((f) => { passSubs.add(f); return () => { passSubs.delete(f); }; }, () => passedTop, () => passedTop);


// Every Up next row opens its meeting page on Home (HistoryView). The event waits here when Home is not open yet; the
// window event moves the app to Home.
let pendingEvent: CalendarEvent | null = null;
export const OPEN_EVENT = 'quorum:open-event';
// an upcoming meeting's notes (its chats) in its row details; opens its page at them
function EventChatsLink({ n, onOpen }: { n: number; onOpen: () => void }) {
  return (
    <a className="app-chip link" href="#" data-tip="Open the notes on this meeting" onClick={(ev) => { ev.preventDefault(); ev.stopPropagation(); onOpen(); }} onKeyDown={(ev) => ev.stopPropagation()}>
      <img className="app-logo" src={markProd} alt="" />{n} {n === 1 ? 'note' : 'notes'}
    </a>
  );
}
export function openEvent(e: CalendarEvent) { pendingEvent = e; window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: e })); }
export function takeEvent() { const e = pendingEvent; pendingEvent = null; return e; }

// Up next, under the header on every tab: the next three events from the connected calendar and Show more for the
// rest (open or closed for the rest of this launch). hidden keeps the loading going while the strip is out of sight
// (a live call view, or History filters).
// On Home the strip is floating: out of sight until the Home list's top group (inline) scrolls past the top, then it
// slides down. The inline group only reads what the strip loads. It is Today when today has anything, today's calls
// first and then the rest of today's list (children); otherwise it is Up next, the next day with calls, its first
// call and Show more for the rest of that day.
// chats about upcoming meetings by event id, for the strip (the Home list passes its own)
function useEventChats(skip: boolean) {
  const [m, setM] = useState<Map<string, ChatRow[]>>(new Map());
  useEffect(() => {
    if (skip) return;
    const load = () => window.quorum.history().then((h) => {
      const next = new Map<string, ChatRow[]>();
      for (const c of h.chats) if (c.eventId && (!c.eventEnd || new Date(c.eventEnd).getTime() > Date.now())) next.set(c.eventId, [...(next.get(c.eventId) ?? []), c]);
      setM(next);
    }).catch(() => {});
    load();
    return window.quorum.onHistoryChanged(load);
  }, [skip]);
  return m;
}

export function UpNext({ hidden = false, inline = false, floating = false, chats: given }: { hidden?: boolean; inline?: boolean; floating?: boolean; chats?: Map<string, ChatRow[]> }) {
  const own = useEventChats(!!given);
  const chats = given ?? own;
  const cal = useCalendarView();
  const passed = usePassed();
  const [open, setOpen] = useSession('upNextOpen', false);
  const [dayOpen, setDayOpen] = useSession('upNextDayOpen', false);
  // the strip can fold down to its header; it stays in view while scrolling either way
  const [folded, setFolded] = useSession('upNextFolded', false);
  const [eventMenu, setEventMenu] = useState<string | null>(null);
  const section = useRef<HTMLElement>(null);
  const listId = useId();
  const retry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // the helper can still be starting on launch, so a miss retries in 10s instead of waiting for the 5 minute refresh
  const loadCal = useCallback(function load(): Promise<void> {
    return window.quorum.calendar().then((c) => {
      setCalView({ events: c.connected ? c.events.filter((e) => new Date(e.end) > new Date()) : [], connected: c.connected, showAll: c.showAll, hidden: c.hidden, status: c.status, days: c.days });
      clearTimeout(retry.current);
      if (c.status === 'unavailable') retry.current = setTimeout(load, 10000);
    }).catch(() => {});
  }, []);
  useEffect(() => {
    if (inline) return;
    loadCal();
    const t = setInterval(loadCal, 5 * 60000);
    const off = window.quorum.onSettings(() => loadCal());
    const offSync = window.quorum.onCalendarChanged(() => loadCal());
    return () => { clearInterval(t); clearTimeout(retry.current); off(); offSync(); };
  }, [loadCal, inline]);

  // Up next: every call in the chosen days, the first one until Show more
  const dayEvents = cal.events;
  const showCal = cal.connected && (cal.events.length > 0 || cal.hidden > 0);
  const empty = hidden || (inline ? !cal.connected : !showCal);
  // inline: watch the first row (the heading when there are none) against the scrolling body above it
  useEffect(() => {
    const el = section.current;
    if (!inline || !el) return;
    const target = el.querySelector('.hist-item') ?? el;
    const root = el.closest('.body');
    const io = new IntersectionObserver(([e]) => {
      setPassed(!e.isIntersecting && !!e.rootBounds && e.boundingClientRect.bottom <= e.rootBounds.top + 1);
    }, { root });
    io.observe(target);
    return () => { io.disconnect(); setPassed(false); };
  }, [inline, empty, cal.events.length]);
  if (empty) return null;

  // the strip: three calls until Show all; the Home list: the first call until Show all
  const stripRows = upNextRows(cal.events, open);
  const rows: CalendarEvent[] = inline ? (dayOpen ? dayEvents : dayEvents.slice(0, 1)) : stripRows.rows;
  const more = inline ? true : stripRows.more;
  const moreOpen = inline ? dayOpen : open;
  const toggle = inline ? () => setDayOpen((o) => !o) : () => setOpen((o) => !o);
  const label = 'Up next';
  // Show all, an outlined pill in the header that stays selected while open. The strip shows three calls until it is
  // opened and reads Show less while open; opened, its list stops at the window's height and scrolls.
  const moreButton = more && (
    <button className={`up-all ${moreOpen ? 'on' : ''}`} aria-pressed={moreOpen} aria-controls={listId} onClick={toggle}>{!inline && moreOpen ? 'Show less' : 'Show all'}</button>
  );
  const strip = (
    <section ref={section} className={inline ? 'up-inline' : 'up-strip'} aria-label={label}>
      <div className="up-head">
        {folded && !inline
          ? <button className="up-days-btn" aria-controls={listId} aria-expanded={false} onClick={() => setFolded(false)}><h4>Upcoming events</h4><IconChevron width={16} height={16} className="up-days-chev" /></button>
          : <DaysMenu days={cal.days} onPick={(d) => window.quorum.calendarSet({ days: d }).then(loadCal)} />}
        <span className="up-head-end">
          {!inline && <button className={`up-all ${folded ? 'on' : ''}`} aria-pressed={folded} aria-controls={listId} onClick={() => setFolded((f) => !f)}>{folded ? 'Show' : 'Hide'}</button>}
          {!(folded && !inline) && moreButton}
        </span>
      </div>
      {/* the strip's list folds up under its heading (Hide) and back down (Show); the Home list never folds */}
      <div className={`up-fold${folded && !inline ? ' folded' : ''}`} inert={(folded && !inline) || undefined}><div className="up-fold-in">
      {cal.events.length === 0 && (inline ? <DayOff title="No meetings" seed={1} /> : <p className="up-empty">No calls {cal.days === 'week' ? 'this week' : cal.days === 1 ? 'in the next day' : `in the next ${cal.days} days`}.</p>)}
      {rows.length > 0 && (
        <div className={`up-list ${!inline && moreOpen ? 'open' : ''}`} id={listId}>
          {rows.map((e) => {
            const at = new Date(e.start);
            const platform = e.platform ? PLATFORM_APP[e.platform] : null;
            const menu = eventMenu === e.id;
            const when = dayLabel(at);
            return (
              <div key={e.id} className="hist-item">
                <div className={`hist-row up-row ${menu ? 'menu-open' : ''}`} role="button" tabIndex={0} onClick={() => openEvent(e)} onKeyDown={(ev) => { if (ev.key === 'Enter') openEvent(e); }}>
                  {e.calendar ? <span className="avatar-sq app"><AppLogo {...CALENDAR_APP[e.calendar]} /></span> : <span className="avatar-sq cal"><IconCalendar width={18} height={18} /></span>}
                  <span className="hist-text"><strong>{e.title}</strong>
                    <RowDetails who={peopleText(e)} onCalendar={e.item || e.link ? () => window.quorum.calendarOpen(e) : null} calendarName={e.calendar ? CALENDAR_APP[e.calendar].name : undefined}
                      platform={e.platform} meetingUrl={e.join}
                      after={chats?.get(e.id)?.length ? <EventChatsLink n={chats.get(e.id)!.length} onOpen={() => openEvent({ ...e, openChat: true })} /> : null} />
                  </span>
                  {!e.platform && <span className="up-badge">No meeting</span>}
                  <span className="hist-time"><span className="up-day">{when}</span>{time(at)}<small>{half(at)}</small></span>
                  <span className="hist-hover" onMouseDown={(ev) => ev.stopPropagation()}>
                    {platform && e.join && <JoinButton id={platform.id} label="Join" name={platform.short} url={e.join} />}
                    <EventMenu event={e} open={menu} onOpen={(o) => setEventMenu(o ? e.id : null)} onChanged={loadCal} />
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
      </div></div>
    </section>
  );
  if (!floating) return strip;
  return <div className="up-float"><div className={`up-float-in ${passed ? 'shown' : ''}`} inert={!passed || undefined}>{strip}</div></div>;
}

// "Next 3 days" (or "Your week") and its chevron: a menu of how far ahead Up next reaches
function DaysMenu({ days, onPick }: { days: number | 'week'; onPick: (d: number | 'week') => void }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  useExclusiveMenu('up-days', open, close);
  useEffect(() => {
    if (!open) return;
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open, close]);
  const name = (d: number | 'week') => (d === 'week' ? 'Your week' : d === 1 ? 'Next 1 day' : `Next ${d} days`);
  return (
    <span className="menu-wrap up-days" onMouseDown={(ev) => ev.stopPropagation()}>
      <button className="up-days-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <h4>{name(days)}</h4><IconChevron width={16} height={16} className="up-days-chev" />
      </button>
      {open && (
        <div className="menu left up-days-menu" role="menu">
          {[1, 2, 3, 4, 5].map((d) => (
            <button key={d} role="menuitemradio" aria-checked={d === days} className={d === days ? 'checked' : ''} onClick={() => { setOpen(false); onPick(d); }}>{name(d)}</button>
          ))}
          <div className="menu-sep" />
          {/* the work week: this one Monday to Friday, the coming one on a weekend */}
          <button role="menuitemradio" aria-checked={days === 'week'} className={days === 'week' ? 'checked' : ''} onClick={() => { setOpen(false); onPick('week'); }}>Weekly</button>
        </div>
      )}
    </span>
  );
}

// the white Join button an upcoming call shows on hover, with its app's logo. The main process opens the link, after the
// My Notes check or the reminder to start notes by hand when Zoom AI notes are connected (joinAdvice.js)
export function JoinButton({ id, label, url, name }: { id: string; label: string; url: string; name?: string }) {
  const icons = useAppIcons();
  return (
    <button className="up-join" aria-label={name ? `Join on ${name}` : label} data-tip={name ? `Join on ${name}` : undefined} onClick={(ev) => { ev.stopPropagation(); window.quorum.joinMeeting(url, id).catch(() => window.quorum.openExternal(url)); }}>
      {icons[id] ? <img src={icons[id]!} alt="" /> : null}{label}<IconArrowRight width={14} height={14} />
    </button>
  );
}

// a row's More menu, drawn on the body at the button's position so the list's scroll area cannot clip it
function EventMenu({ event: e, open, onOpen, onChanged }: { event: CalendarEvent; open: boolean; onOpen: (open: boolean) => void; onChanged: () => void }) {
  const button = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  const [confirm, setConfirm] = useState(false);
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
          {e.join && <button onClick={run(() => window.quorum.copy(e.join!))}>Copy call link</button>}
          <button className="danger" onClick={run(() => setConfirm(true))}>Remove from list</button>
        </div>,
        document.body,
      )}
      {confirm && createPortal(
        <ConfirmModal title="Remove this meeting from Up next?" action="Remove"
          body={`${e.title} stops showing in Up next and on Home. It stays in your calendar. This action cannot be undone.`}
          onDone={(ok) => { setConfirm(false); if (ok) window.quorum.calendarSet({ hide: e.id }).then(onChanged); }} />,
        document.body,
      )}
    </>
  );
}
