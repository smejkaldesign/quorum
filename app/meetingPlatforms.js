// Which meeting app a note's call ran on, for notes whose notetaker does not say (Granola sends no call link). A note
// matches the calendar event that starts within 15 minutes of it with a similar title, or within 3 minutes with any
// title; the event's call link gives the app and the link. Results are kept in Quorum's data folder, keyed by the
// note's id, so the vault's notes stay as their notetaker wrote them.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { meetingWho } from './meetingWho.js';

const NEAR = 15 * 60000, CLOSE = 3 * 60000;
const words = (t) => new Set(String(t ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1));

export function similarTitle(a, b) {
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return false;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared += 1;
  return shared / Math.min(x.size, y.size) >= 0.6;
}

// The calendar event a match points at: enough to open it in its calendar and to name who was invited. organizer is
// the person the row names (meetingWho.js), others how many more were invited besides you
export const eventRef = (e, isMe) => {
  const who = meetingWho(e, isMe);
  return {
    id: e.id ?? null, item: e.item ?? null, link: e.link ?? null, start: e.start, recurring: !!e.recurring,
    organizer: who.name, others: who.others, count: (e.attendees ?? []).length,
  };
};

// notes: [{ key, title, date }]; events: calendar events; callLink(event) -> { platform, join }.
// Returns { key: { platform, url, calendar, event } | null } for every note with a date: null when no event matches,
// platform and url null when the event has no call. calendar is the connector the event came from (event.source),
// the Calendar app when unset.
export function matchPlatforms(notes, events, callLink, isMe) {
  const evs = events.map((e) => ({ e, at: new Date(e.start).getTime() })).filter((x) => Number.isFinite(x.at));
  const out = {};
  for (const n of notes) {
    const at = new Date(n.date ?? '').getTime();
    if (!Number.isFinite(at)) continue;
    let best = null;
    for (const x of evs) {
      const d = Math.abs(x.at - at);
      if (d > NEAR || !(d <= CLOSE || similarTitle(n.title, x.e.title))) continue;
      const score = d - (similarTitle(n.title, x.e.title) ? NEAR : 0);
      if (!best || score < best.score) best = { score, e: x.e };
    }
    if (!best) { out[n.key] = null; continue; }
    const link = callLink(best.e);
    out[n.key] = { platform: link?.platform ?? null, url: link?.join ?? null, calendar: best.e.source ?? 'apple-calendar', event: eventRef(best.e, isMe) };
  }
  return out;
}

export function createPlatformCache(file) {
  let data = {};
  try { if (existsSync(file)) data = JSON.parse(readFileSync(file, 'utf8')) ?? {}; } catch { data = {}; }
  return {
    get: (key) => data[key],
    has: (key) => Object.prototype.hasOwnProperty.call(data, key),
    // returns how many notes gained an app
    merge(found) {
      let added = 0;
      for (const [k, v] of Object.entries(found)) { if (v && !data[k]) added += 1; data[k] = v; }
      try { writeFileSync(file, JSON.stringify(data)); } catch {}
      return added;
    },
  };
}
