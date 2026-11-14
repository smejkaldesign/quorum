// A live search of the person's Granola account through the sign-in Quorum holds, for the quorum MCP server's
// granola_search tool. The token stays in this process, and this is the one place results are checked for opted-out
// customers: a meeting naming one, in its title, attendees or a matching passage, is dropped whole.
import { parseMeetingDetails, parseMeetingList } from './granola.js';

export const MODES = ['notes', 'transcripts'];
const DATE = /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/;

// a next page needs only the cursor and the same `in`; Granola keeps the first page's filters
export function searchArgs({ query, participant, from, to, in: mode = 'notes', limit, cursor } = {}) {
  const q = String(query ?? '').trim().slice(0, 300);
  const who = String(participant ?? '').trim().slice(0, 200);
  const next = cursor ? String(cursor).slice(0, 2048) : null;
  if (!MODES.includes(mode)) throw new Error('in must be notes or transcripts.');
  if (!next && mode === 'transcripts' && !q) throw new Error('A transcript search needs a query.');
  if (!next && !q && !who) throw new Error('Give a query, a participant, or both.');
  for (const [k, v] of [['from', from], ['to', to]]) if (v != null && !DATE.test(String(v))) throw new Error(`${k} must be an ISO date, for example 2026-11-01.`);
  const args = {};
  if (limit != null) {
    const n = Math.floor(Number(limit));
    if (!Number.isFinite(n)) throw new Error('limit must be a number from 1 to 20.');
    args.limit = Math.min(20, Math.max(1, n));
  } else if (!next) args.limit = 10;
  if (q) args.keywords = [q];
  if (who) args.participant = who;
  if (from) args.from_date = String(from);
  if (to) args.to_date = String(to);
  if (next) args.cursor = next;
  return { mode, args };
}

// search_transcripts answers JSON, sometimes after a line of plain text
const jsonOf = (text) => { const s = String(text ?? ''); const i = s.indexOf('{'); try { return i < 0 ? null : JSON.parse(s.slice(i)); } catch { return null; } };
// a meeting whose attendee list Granola cut short cannot be checked, so it is withheld
const named = (m, isExcluded) => m.omitted > 0 || isExcluded(`${m.title} ${m.participantsText}`);

export async function granolaSearch({ mcp, input, isExcluded, filed = new Set() }) {
  const { mode, args } = searchArgs(input);
  if (isExcluded(`${args.keywords?.[0] ?? ''} ${args.participant ?? ''}`)) throw new Error('This search names an opted-out customer, so Quorum withholds its results.');
  if (mode === 'notes') {
    const page = parseMeetingList((await mcp.call('search_meetings', args)).text);
    const meetings = page.meetings.filter((m) => !named(m, isExcluded))
      .map((m) => ({ id: m.id, title: m.title, date: m.meetingAt, url: m.url, people: m.participants.map((p) => p.name), inQuorum: filed.has(m.id) }));
    return { source: 'granola', in: 'notes', meetings, nextCursor: page.cursor };
  }
  const j = jsonOf((await mcp.call('search_transcripts', args)).text);
  if (!j) throw new Error('Granola returned a search result Quorum could not read.');
  const found = (Array.isArray(j.meetings) ? j.meetings : []).filter((m) => m?.meeting_id)
    .map((m) => ({ id: String(m.meeting_id), title: String(m.title ?? ''), date: m.date ?? null, passages: (Array.isArray(m.passages) ? m.passages : []).map((p) => ({ time: p?.time ?? null, text: String(p?.text ?? '') })) }))
    .filter((m) => !isExcluded(m.title) && !m.passages.some((p) => isExcluded(p.text)));
  // transcript hits carry no attendees; the meetings' own records do, ten per call
  const people = new Map();
  for (let i = 0; i < found.length; i += 10) {
    for (const d of parseMeetingDetails((await mcp.call('get_meetings', { meeting_ids: found.slice(i, i + 10).map((m) => m.id), attachments: 'none' })).text)) people.set(d.id, d);
  }
  const meetings = found.filter((m) => people.has(m.id) && !named(people.get(m.id), isExcluded))
    .map((m) => ({ ...m, people: people.get(m.id).participants.map((p) => p.name), inQuorum: filed.has(m.id) }));
  return { source: 'granola', in: 'transcripts', meetings, nextCursor: j.next_cursor ?? null };
}
