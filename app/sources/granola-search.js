// A live search of the person's Granola account through the sign-in Quorum holds, for the quorum MCP server's
// granola_search tool. The token stays in this process; results naming an opted-out customer are dropped or withheld
// here, before they reach the socket.
import { parseMeetingList } from './granola.js';

export const MODES = ['notes', 'transcripts'];
const DATE = /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const unescape = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');

export function searchArgs({ query, participant, from, to, in: mode = 'notes', limit = 10, cursor } = {}) {
  const q = String(query ?? '').trim().slice(0, 300);
  const who = String(participant ?? '').trim().slice(0, 200);
  if (!MODES.includes(mode)) throw new Error('in must be notes or transcripts.');
  if (mode === 'transcripts' && !q) throw new Error('A transcript search needs a query.');
  if (!q && !who) throw new Error('Give a query, a participant, or both.');
  for (const [k, v] of [['from', from], ['to', to]]) if (v != null && !DATE.test(String(v))) throw new Error(`${k} must be an ISO date, for example 2026-11-01.`);
  const n = Math.min(20, Math.max(1, Math.floor(Number(limit) || 10)));
  const args = { limit: n };
  if (q) args.keywords = [q];
  if (who) args.participant = who;
  if (from) args.from_date = String(from);
  if (to) args.to_date = String(to);
  if (cursor) args.cursor = String(cursor).slice(0, 2048);
  if (mode === 'notes') args.max_participants = 20;
  return { mode, args };
}

// search_transcripts answers JSON, sometimes after a line of plain text
const jsonOf = (text) => { const s = String(text ?? ''); const i = s.indexOf('{'); try { return i < 0 ? null : JSON.parse(s.slice(i)); } catch { return null; } };

export async function granolaSearch({ mcp, input, isExcluded, redact, filed = new Set() }) {
  const { mode, args } = searchArgs(input);
  if (isExcluded(`${args.keywords?.[0] ?? ''} ${args.participant ?? ''}`)) throw new Error('This search names an opted-out customer, so Quorum withholds its results.');
  if (mode === 'notes') {
    const { text } = await mcp.call('search_meetings', args);
    const raw = new Map([...String(text).matchAll(/<meeting\b[^>]*\bid="([^"]+)"[^>]*>[\s\S]*?<\/meeting>/g)].map((m) => [m[1], unescape(m[0])]));
    const page = parseMeetingList(text);
    const meetings = page.meetings
      .filter((m) => !isExcluded(`${m.title} ${m.participants.map((p) => p.name).join(' ')} ${raw.get(m.id) ?? ''}`))
      .map((m) => ({ id: m.id, title: m.title, date: m.meetingAt, url: m.url, people: m.participants.map((p) => p.name), inQuorum: filed.has(m.id) }));
    return { source: 'granola', in: 'notes', meetings, nextCursor: page.hasMore ? page.cursor : null };
  }
  const j = jsonOf((await mcp.call('search_transcripts', args)).text);
  if (!j) throw new Error('Granola returned a search result Quorum could not read.');
  const meetings = (Array.isArray(j.meetings) ? j.meetings : [])
    .filter((m) => m?.meeting_id && !isExcluded(String(m.title ?? '')))
    .map((m) => ({
      id: m.meeting_id, title: String(m.title ?? ''), date: m.date ?? null, inQuorum: filed.has(m.meeting_id),
      passages: (Array.isArray(m.passages) ? m.passages : []).map((p) => ({ time: p?.time ?? null, text: redact(String(p?.text ?? '')) })),
    }));
  return { source: 'granola', in: 'transcripts', meetings, nextCursor: j.next_cursor ?? null };
}
