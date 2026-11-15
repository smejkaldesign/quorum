import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { CalendarEvent, PlatformInfo, SourceJob } from './quorum';
import { CONNECTORS_CHANGED, canNewNote, connectorsFor } from '../connectors/library';
import { useFlag } from './flags';
import { useExclusiveMenu } from './menuBus';
import { useSession } from './session';
import { dayLabel, upNextRows } from './upNextList';
import { AppLogo, PLATFORM_APP, useAppIcons } from './AppChip';
import { IconCalendar, IconChevron, IconMore, IconPlus } from './icons';

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

// What the strip loads for the copy in the Home list (whether + New shows), and whether that copy's first row has
// scrolled out of view, which slides the strip in on Home.
type Shared = { canNew: boolean; passed: boolean };
let shared: Shared = { canNew: false, passed: false };
const sharedSubs = new Set<() => void>();
const setShared = (v: Partial<Shared>) => {
  if (Object.entries(v).every(([k, x]) => shared[k as keyof Shared] === x)) return;
  shared = { ...shared, ...v }; sharedSubs.forEach((f) => f());
};
const subscribeShared = (f: () => void) => { sharedSubs.add(f); return () => { sharedSubs.delete(f); }; };
const useShared = () => useSyncExternalStore(subscribeShared, () => shared, () => shared);

// Up next, under the header on every tab: the next three events from the connected calendar, Show more for the rest
// (open or closed for the rest of this launch), and + New once a meeting app or a meeting notes app is connected.
// + New sends quorum:new-note, which the note editor handles. hidden keeps the loading going while the strip is out
// of sight (a live call view, or History filters).
// On Home the same list sits at the top of the Home list (inline, which only reads what the strip loads), and the
// strip is floating: out of sight until the inline copy's first row scrolls past the top, then it slides down.
export function UpNext({ hidden = false, inline = false, floating = false }: { hidden?: boolean; inline?: boolean; floating?: boolean }) {
  const cal = useCalendarView();
  const { canNew, passed } = useShared();
  const setCanNew = useCallback((v: boolean) => setShared({ canNew: v }), []);
  const [open, setOpen] = useSession('upNextOpen', false);
  const [eventMenu, setEventMenu] = useState<string | null>(null);
  const section = useRef<HTMLElement>(null);
  const meetingCapture = useFlag('meeting-capture');
  const listId = useId();
  const retry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // the helper can still be starting on launch, so a miss retries in 10s instead of waiting for the 5 minute refresh
  const loadCal = useCallback(function load(): Promise<void> {
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
  }, [meetingCapture, setCanNew]);
  useEffect(() => {
    if (inline) return;
    loadCal();
    const t = setInterval(loadCal, 5 * 60000);
    const off = window.quorum.onSettings(() => loadCal());
    return () => { clearInterval(t); clearTimeout(retry.current); off(); };
  }, [loadCal, inline]);
  // connector state changes only when something connects or disconnects, or a source job finishes
  useEffect(() => {
    if (inline) return;
    loadConnectors();
    const changed = () => { loadConnectors(); };
    window.addEventListener(CONNECTORS_CHANGED, changed);
    const done = (j: SourceJob) => { if (j.status !== 'running') loadConnectors(); };
    const offSource = window.quorum.onSourceJob(done);
    const offPlatform = window.quorum.onPlatformJob(done);
    return () => { window.removeEventListener(CONNECTORS_CHANGED, changed); offSource(); offPlatform(); };
  }, [loadConnectors, inline]);

  const showCal = cal.connected && (cal.events.length > 0 || cal.hidden > 0);
  const empty = hidden || (!showCal && !canNew);
  // inline: watch the first row (the heading when there are none) against the scrolling body above it
  useEffect(() => {
    const el = section.current;
    if (!inline || !el) return;
    const target = el.querySelector('.hist-item') ?? el;
    const root = el.closest('.body');
    const io = new IntersectionObserver(([e]) => {
      setShared({ passed: !e.isIntersecting && !!e.rootBounds && e.boundingClientRect.bottom <= e.rootBounds.top + 1 });
    }, { root });
    io.observe(target);
    return () => { io.disconnect(); setShared({ passed: false }); };
  }, [inline, empty, cal.events.length]);
  if (empty) return null;
  const { rows, more } = upNextRows(cal.events, open);
  const strip = (
    <section ref={section} className={inline ? 'hist-group up-inline' : 'up-strip'} aria-label="Up next" aria-hidden={floating && !passed ? true : undefined}>
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
            const platform = e.platform ? PLATFORM_APP[e.platform] : null;
            const menu = eventMenu === e.id;
            return (
              <div key={e.id} className="hist-item">
                <div className={`hist-row up-row ${menu ? 'menu-open' : ''}`} onClick={() => e.item && window.quorum.calendarOpen(e)}>
                  <span className="avatar-sq cal"><IconCalendar width={18} height={18} /></span>
                  <span className="hist-text"><strong>{e.title}</strong><span className="hist-sub">
                    <span className="hist-meet">
                    {platform && <AppLogo {...platform} />}
                    <span className="hist-sub-text up-when">{dayLabel(at)} · {time(at)} – {time(end)} {half(end)}</span>
                    </span>
                  </span></span>
                  {!e.platform && <span className="up-badge">No meeting</span>}
                  <span className="hist-time">{time(at)}<small>{half(at)}</small></span>
                  <span className="hist-hover" onMouseDown={(ev) => ev.stopPropagation()}>
                    {platform && e.join && <JoinButton id={platform.id} label={`Join ${platform.short}`} url={e.join} />}
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
  if (!floating) return strip;
  return <div className="up-float"><div className={`up-float-in ${passed ? 'shown' : ''}`} inert={!passed || undefined}>{strip}</div></div>;
}

// the white Join button an upcoming call shows on hover, with its app's logo
function JoinButton({ id, label, url }: { id: string; label: string; url: string }) {
  const icons = useAppIcons();
  return (
    <button className="up-join" onClick={(ev) => { ev.stopPropagation(); window.quorum.openExternal(url); }}>
      {icons[id] ? <img src={icons[id]!} alt="" /> : null}{label}
    </button>
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
