import { CONNECTORS } from '../connectors/library';

// The Up next strip above the top tabs: the next few calendar events on every tab, the rest behind Show more, and a
// + New button once a meeting app or a meeting notes app is connected. Pure, so the tests can drive it.
export const UP_NEXT_SHOWN = 3;

// the rows the strip draws: the first three while closed, all of them while open; more says whether Show more appears
export function upNextRows<T>(events: T[], open: boolean, shown = UP_NEXT_SHOWN) {
  return { rows: open ? events : events.slice(0, shown), more: events.length > shown };
}

// Today, Yesterday and Tomorrow by name, any other day as "Fri, Nov 13" (with the year when it is not this one)
export function dayLabel(d: Date | null, today = new Date()) {
  if (!d) return 'Undated';
  const y = new Date(today); y.setDate(today.getDate() - 1);
  const t = new Date(today); t.setDate(today.getDate() + 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  if (d.toDateString() === t.toDateString()) return 'Tomorrow';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) });
}

// the library categories that let you start a note: meeting apps (Zoom, Meet, Teams) and meeting notes apps
// (Granola, Wispr Notetaker and the rest)
export const NEW_NOTE_CATEGORIES = ['meetings', 'meeting-notes'];

type Connector = { category: string; kind: string; source?: string; app?: string };
export type ConnectionLive = {
  sources: { id: string; connected: boolean }[];
  providers: { id: string; enabled: boolean; installed: boolean; access: boolean | null }[];
  platforms: { id: string; connected: boolean }[];
};

// connected the way Settings > Connectors reads it: a notes source signed in, or a meeting app listening on this Mac
// or with its cloud account connected
export function isConnectedForNotes(x: Connector, live: ConnectionLive) {
  if (x.kind === 'mcp-source') return !!x.source && live.sources.some((s) => s.id === x.source && s.connected);
  if (x.kind === 'meeting-app') {
    if (!x.app) return false;
    const p = live.providers.find((q) => q.id === x.app);
    return (!!p && p.enabled && p.installed && p.access !== false) || live.platforms.some((q) => q.id === x.app && q.connected);
  }
  return false;
}

export function canNewNote(live: ConnectionLive, connectors: readonly Connector[] = CONNECTORS) {
  return connectors.some((x) => NEW_NOTE_CATEGORIES.includes(x.category) && isConnectedForNotes(x, live));
}
