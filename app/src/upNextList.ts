// The Up next strip under the header: the next few calendar events on every tab and the rest behind Show more. Pure,
// so the tests can drive it.
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
