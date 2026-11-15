// Which meeting app a note's call ran on, for notes whose notetaker does not say (Granola sends no call link). A note
// matches the calendar event that starts within 15 minutes of it with a similar title, or within 3 minutes with any
// title; the event's call link gives the app and the link. Results are kept in Quorum's data folder, keyed by the
// note's id, so the vault's notes stay as their notetaker wrote them.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const NEAR = 15 * 60000, CLOSE = 3 * 60000;
const words = (t) => new Set(String(t ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1));

export function similarTitle(a, b) {
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return false;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared += 1;
  return shared / Math.min(x.size, y.size) >= 0.6;
}

// notes: [{ key, title, date }]; events: calendar events; callLink(event) -> { platform, join }.
// Returns { key: { platform, url, calendar } | null } for every note with a date: null when no event with a call
// matches. calendar is the connector the event came from (event.source), the Calendar app when unset.
export function matchPlatforms(notes, events, callLink) {
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
    const link = best ? callLink(best.e) : null;
    out[n.key] = link?.platform ? { platform: link.platform, url: link.join, calendar: best.e.source ?? 'apple-calendar' } : null;
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
