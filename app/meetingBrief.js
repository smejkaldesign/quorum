// The meeting page's summary of a recurring meeting: its past notes (same title, matched like meetingPlatforms.js),
// and once there are three or more, prep notes and a short description written from those notes by the person's own
// model. Briefs are kept in Quorum's data folder, keyed by the series and its newest note, so a page opens at once
// until another meeting in the series is written.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { similarTitle } from './meetingPlatforms.js';

export const SERIES_MIN = 3;
export const seriesKey = (title) => String(title ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// past notes of the series, newest first; a meeting the calendar marks as one series also counts when titles drift
export function seriesOf(meetings, { title, before = Date.now() }) {
  return meetings
    .filter((m) => m.kind !== 'note' && m.date && new Date(m.date).getTime() <= before && similarTitle(m.title, title))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

export const BRIEF_SYSTEM = `You prepare one person for a recurring meeting from the notes of its past occurrences. Write plain, literal
sentences. No figures of speech. Use only what the notes say; never invent names, numbers or decisions. Reply with JSON
only: {"prep": string, "what": string, "who": string, "how": string}.
- prep: markdown bullets, most useful first: open items and follow-ups from the latest meetings, decisions to revisit,
  questions to bring. At most 8 bullets.
- what: one or two sentences on what this meeting is for.
- who: who usually attends and their role in it, one or two sentences.
- how: how it usually runs (format, recurring agenda items), one or two sentences.`;

export function briefPrompt({ title, notes }) {
  const parts = notes.map((n) => `## ${n.title} (${String(n.date).slice(0, 10)})\n${String(n.text).slice(0, 6000)}`);
  return `Meeting: ${title}\n\nPast notes, newest first:\n\n${parts.join('\n\n')}`;
}

export function parseBrief(text) {
  const m = String(text ?? '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    const s = (v) => (typeof v === 'string' ? v.trim() : '');
    const out = { prep: s(j.prep), what: s(j.what), who: s(j.who), how: s(j.how) };
    return out.prep || out.what ? out : null;
  } catch { return null; }
}

export function createBriefCache(file) {
  let data = {};
  try { if (existsSync(file)) data = JSON.parse(readFileSync(file, 'utf8')) ?? {}; } catch { data = {}; }
  return {
    get: (key, stamp) => (data[key]?.stamp === stamp ? data[key].brief : null),
    set(key, stamp, brief) { data[key] = { stamp, brief, at: new Date().toISOString() }; try { writeFileSync(file, JSON.stringify(data)); } catch {} },
  };
}
