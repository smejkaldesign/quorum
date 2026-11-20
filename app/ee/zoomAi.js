// Zoom AI notes, read with the user's own Zoom token: the AI Companion meeting summary (written for the meeting's
// host) and the user's own My Notes (manual notes, the AI-generated recap and the transcript, for any meeting they
// joined). Pure helpers: the requests, the shapes Zoom answers with, and the note Quorum files from them.
//
//   GET /users/me/meeting_summaries?from&to                 meeting:read:list_summaries   summaries the user hosted
//   GET /meetings/{uuid}/meeting_summary                    meeting:read:summary          one summary (host only)
//   GET /my_notes/notes?meeting_id=<number>                 my_notes:read:note            the user's notes for a meeting
//   GET /my_notes/notes/{noteId}/content?include=transcript my_notes:read:content         one note, with its transcript
//   GET /meetings/{uuid}/transcript                         cloud_recording:read:meeting_transcript   AI Companion transcript
import { oneLine } from '../frontmatter.js';
import { slug } from '../sources/granola.js';

// the granular scope each capability needs, in the words the Connectors page shows when the Zoom app lacks it
export const CAPABILITIES = {
  summaries: { scope: 'meeting:read:list_summaries', label: 'list your AI Companion summaries' },
  summary: { scope: 'meeting:read:summary', label: 'read AI Companion summaries' },
  myNotes: { scope: 'my_notes:read:note', label: 'list your My Notes' },
  myNotesContent: { scope: 'my_notes:read:content', label: 'read your My Notes' },
  transcript: { scope: 'cloud_recording:read:meeting_transcript', label: 'read AI Companion transcripts' },
};

// a meeting uuid that starts with / or holds // has to be encoded twice in a path
export const encodeUuid = (uuid) => { const s = String(uuid); return s.startsWith('/') || s.includes('//') ? encodeURIComponent(encodeURIComponent(s)) : encodeURIComponent(s); };
// the meeting number in a Zoom join link (https://acme.zoom.us/j/81234567890?pwd=...)
export const meetingNumberFromUrl = (url) => /zoom\.(?:us|com)\/(?:j|w|s|my\/[^/?#]+\/j)\/(\d{9,12})\b/i.exec(String(url ?? ''))?.[1] ?? null;

// Zoom says a token lacks a scope with code 4711 ("Invalid access token, does not contain scopes:[...]"); a refusal
// like that means the Quorum Zoom app does not ask for the scope yet, so the capability is skipped, never retried
export const missingScope = (status, body) => status >= 400 && (Number(body?.code) === 4711 || /does not contain scopes?/i.test(String(body?.message ?? '')));

// the summary as markdown, or null when Zoom answered without one (a summary the caller cannot see comes back with
// has_permission false or without content)
export function summaryText(s) {
  if (!s || s.has_permission === false) return null;
  if (typeof s.summary_content === 'string' && s.summary_content.trim()) return s.summary_content.trim();
  const e = s.edited_summary ?? {};
  const overview = e.summary_overview || s.summary_overview || '';
  const details = e.summary_details
    ? [String(e.summary_details)]
    : (Array.isArray(s.summary_details) ? s.summary_details : []).map((d) => [d.label ? `### ${d.label}` : '', d.summary ?? ''].filter(Boolean).join('\n\n'));
  const steps = (e.next_steps ?? s.next_steps ?? []).map((x) => `- ${String(x).trim()}`);
  const parts = [overview.trim(), ...details.map((d) => d.trim()), steps.length ? `### Next steps\n\n${steps.join('\n')}` : ''].filter(Boolean);
  return parts.length ? parts.join('\n\n') : null;
}

// "00:01:05.200" -> 65 seconds
const offset = (t) => { const m = /^(\d+):(\d{2}):(\d{2})/.exec(String(t ?? '')); return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0; };
const stamp = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
// a My Notes transcript as timestamped speaker turns, consecutive segments from one speaker joined
export function noteTranscriptText(t) {
  // speakers carry display_name (Zoom's example: { speaker_id, display_name, zoom_user_id })
  const names = Object.fromEntries((t?.speakers ?? []).map((s) => [s.speaker_id, s.display_name ?? null]));
  const turns = [];
  for (const item of t?.items ?? []) {
    const text = String(item.text ?? '').trim();
    if (!text) continue;
    const who = names[item.speaker_id] ?? null;
    const last = turns[turns.length - 1];
    if (last && who && last.who === who) { last.text += ` ${text}`; continue; }
    turns.push({ start: offset(item.start_time), who, text });
  }
  return turns.map((x) => `[${stamp(x.start)}] ${x.who ? `${x.who}: ` : ''}${x.text}`).join('\n\n');
}

export const fileNameFor = (m) => `${String(m.start ?? '').slice(0, 10) || 'undated'}-${slug(m.title || 'zoom-meeting')}.md`;

// The note for one Zoom meeting, in the shape every imported meeting has (source, source_id, participants), with the
// AI Companion summary, the user's My Notes and a plain line for each part Zoom did not give this account.
// m: { uuid, number, title, start, duration, url, host }, notes: [{ id, url, manual, generated }], missing: [sentence]
export function zoomNote(m, { summary = null, notes = [], missing = [], transcriptRel = null } = {}) {
  const title = m.title || 'Zoom meeting';
  const id = m.uuid ?? (notes[0] ? `note:${notes[0].id}` : `meeting:${m.number}:${String(m.start ?? '').slice(0, 10)}`);
  const lines = [
    '---',
    `source_id: ${oneLine(id)}`,
    `title: ${JSON.stringify(title)}`,
    `date: ${oneLine(m.start ?? new Date().toISOString())}`,
    'participants:',
    ...(m.host ? [`  - ${oneLine(m.host)} (recorder)`] : []),
    `participant_count: ${m.host ? 1 : 0}`,
    'source: zoom',
    'visibility: private',
    ...(m.number ? [`zoom_meeting_id: ${oneLine(m.number)}`] : []),
    ...notes.map((n) => `zoom_note_id: ${oneLine(n.id)}`),
    ...(m.url ? [`zoom_url: ${oneLine(m.url)}`] : notes[0]?.url ? [`zoom_url: ${oneLine(notes[0].url)}`] : []),
    ...(m.duration ? [`duration_minutes: ${oneLine(m.duration)}`] : []),
    ...(transcriptRel ? [`transcript: ${oneLine(transcriptRel)}`] : []),
    // Quorum's own mark that the AI Companion summary is in the note; a recap's own headings cannot be told apart from it
    ...(summary ? ['zoom_summary: included'] : []),
    '---',
    '',
    `# ${title}`,
    '',
  ];
  if (summary) lines.push('## Summary', '', summary.trim(), '');
  for (const n of notes) {
    if (n.manual?.trim()) lines.push('## My notes', '', n.manual.trim(), '');
    // the recap keeps its own heading, so a host's summary that comes later gets the Summary section (addSummarySection)
    if (n.generated?.trim()) lines.push('## My Notes recap', '', n.generated.trim(), '');
  }
  if (missing.length) lines.push('## Not imported', '', ...missing.map((x) => `- ${x}`), '');
  return lines.join('\n');
}
