import { useMemo, useRef } from 'react';
import type { CalendarEvent } from './quorum';

// Where Back goes. When one page opens another, App records the place the person was on; Back on the opened page
// returns there, and Home is the answer only when nothing was recorded. A header tab or the bell clears the history.

// a page Home shows in place of its list: a note's page or a meeting's page
export type HomePage = { kind: 'note'; file: string } | { kind: 'event'; event: CalendarEvent };
export type Place =
  | { kind: 'home'; page: HomePage | null; convo?: boolean }
  | { kind: 'memory'; rel: string | null }
  | { kind: 'knowledge' }
  | { kind: 'call'; tab: string }
  | { kind: 'notifications' }
  | { kind: 'settings'; page: string }
  // a note open in the note view under the header
  | { kind: 'note'; file: string | null }
  // the recording page under the header, or a new note being typed there
  | { kind: 'live' };

export const NAV_LIMIT = 20;

const homeKey = (p: HomePage | null) => (!p ? '' : p.kind === 'note' ? `note:${p.file}` : `event:${p.event.id}`);
export function placeKey(p: Place): string {
  switch (p.kind) {
    case 'home': return `home|${homeKey(p.page)}|${p.convo ? 'convo' : ''}`;
    case 'memory': return `memory|${p.rel ?? ''}`;
    case 'call': return `call|${p.tab}`;
    case 'settings': return `settings|${p.page}`;
    case 'note': return `note|${p.file ?? ''}`;
    default: return p.kind;
  }
}
export const samePlace = (a: Place, b: Place) => placeKey(a) === placeKey(b);

// the place you are leaving goes on top; the same place twice in a row is kept once, and past the limit the oldest are removed
export function pushPlace(stack: readonly Place[], place: Place, limit = NAV_LIMIT): Place[] {
  const top = stack[stack.length - 1];
  const next = top && samePlace(top, place) ? [...stack] : [...stack, place];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

// Back: the newest place that differs from where you are now. Entries equal to the current place are dropped on the
// way, so a page that was recorded and then reopened does not send Back to itself
export function popPlace(stack: readonly Place[], here: Place | null): { place: Place | null; stack: Place[] } {
  const rest = [...stack];
  while (rest.length) {
    const place = rest.pop()!;
    if (!here || !samePlace(place, here)) return { place, stack: rest };
  }
  return { place: null, stack: rest };
}

// Home's list keeps its note and meeting pages in its own state. It reports the one on screen so App can record it,
// and App asks for one back through a waiting request and a window event, the way Up next opens a meeting page
export const HOME_PAGE_EVENT = 'quorum:home-page';
let shownHome: HomePage | null = null;
let pendingHome: { page: HomePage | null } | null = null;
export function reportHomePage(p: HomePage | null) { shownHome = p; }
export function shownHomePage() { return shownHome; }
export function requestHomePage(p: HomePage | null) { pendingHome = { page: p }; window.dispatchEvent(new Event(HOME_PAGE_EVENT)); }
export function takeHomePage() { const p = pendingHome; pendingHome = null; return p; }

// the Memory tab reports the note it shows, so leaving it records that note
let shownMemory: string | null = null;
export function reportMemoryNote(rel: string | null) { shownMemory = rel; }
export function shownMemoryNote() { return shownMemory; }

// App's history. mark records where you are before a page opens another one; back returns to the newest recorded place
// and says false when there was none, so the page can fall back to Home; clear empties it. here and restore
// are read at call time, so the handlers that window events hold on to always see the current view
export function useNavHistory(here: () => Place, restore: (p: Place) => void) {
  const stack = useRef<Place[]>([]);
  const hereRef = useRef(here);
  const restoreRef = useRef(restore);
  hereRef.current = here;
  restoreRef.current = restore;
  return useMemo(() => ({
    mark: () => { stack.current = pushPlace(stack.current, hereRef.current()); },
    back: () => {
      const r = popPlace(stack.current, hereRef.current());
      stack.current = r.stack;
      if (!r.place) return false;
      restoreRef.current(r.place);
      return true;
    },
    clear: () => { stack.current = []; },
  }), []);
}
