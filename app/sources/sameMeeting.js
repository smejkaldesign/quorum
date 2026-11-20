// One calendar event, one note. Two sources that both recorded a meeting (Granola and Zoom My Notes, say) give it
// different ids, so the source_id dedupe cannot see that they are the same meeting. A note from another source counts
// as the same meeting when it starts within WINDOW of this one and the titles agree once normalized, or when one
// title is Zoom's default ("Alex's Zoom Meeting") and says nothing either way. A meeting with no title yet matches
// nothing: a time alone cannot tell back-to-back meetings apart. First save wins, as with source ids, and every
// source checks (Zoom, Granola, import_meeting).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const WINDOW_MS = 10 * 60 * 1000;
const field = (head, key) => { const m = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(head); if (!m) return null; const v = m[1].trim(); try { return String(JSON.parse(v)); } catch { return v.replace(/^"|"$/g, ''); } };
export const titleKey = (t) => String(t ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const generic = (t) => /zoom meeting$/.test(t) || /personal meeting room/.test(t);

// every meeting note under the meetings folder: { file, source, date (ms), title }; transcripts are skipped
export function meetingIndex(root) {
  const out = [];
  if (!root || !existsSync(root)) return out;
  const walk = (dir, depth) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 3 && !e.name.startsWith('.') && e.name !== 'transcripts') walk(p, depth + 1); continue; }
      if (!e.name.endsWith('.md')) continue;
      let head;
      try { head = readFileSync(p, 'utf8').slice(0, 2000); } catch { continue; }
      if (!head.startsWith('---') || /^type:\s*transcript\s*$/m.test(head)) continue;
      const when = Date.parse(field(head, 'date') ?? '');
      if (Number.isNaN(when)) continue;
      out.push({ file: p, source: field(head, 'source') ?? 'quorum', date: when, title: titleKey(field(head, 'title')) });
    }
  };
  walk(root, 0);
  return out;
}

// the note another source already filed for this meeting, or null
export function sameMeeting(index, { date, title, source }) {
  const when = Date.parse(date ?? '');
  if (Number.isNaN(when)) return null;
  const t = titleKey(title);
  if (!t) return null;
  return index.find((n) => n.source !== source && n.title && Math.abs(n.date - when) <= WINDOW_MS && (n.title === t || generic(n.title) || generic(t) || (t.length > 5 && n.title.length > 5 && (n.title.includes(t) || t.includes(n.title))))) ?? null;
}
