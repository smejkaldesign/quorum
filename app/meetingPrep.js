// Meeting prep (issue 63): the note an upcoming event on Home opens to, built from the person's own vault. Pure Node:
// main.js supplies the vault snapshot, the meeting index, the opt-out checks and the model call; the tests call these
// with plain data. What the vault says is gathered here without a model (who was in which meeting, which notes name
// an invitee, which unchecked tasks name them or the topic), and only those sources reach the model, numbered. The
// model writes the summaries and talking points, and each one must cite a source number; anything that cites none is
// dropped. An invitee with no sources reads "Nothing found." and is never sent to the model.
import { createHash } from 'node:crypto';
import { similarTitle } from './meetingPlatforms.js';

// Settings > Calendar > Meeting prep. ahead is 'today' (the rest of today) or a number of hours. minInvitees 0 turns
// the filter off; otherwise an event needs that many invitees besides you, or (orNew) someone you have never met with
export const PREP_DEFAULTS = Object.freeze({ enabled: false, ahead: 'today', minInvitees: 3, orNew: true });
export const AHEAD_HOURS = [2, 4, 8, 24];
export const MIN_INVITEES = [0, 2, 3, 4, 5];

export function prepSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: r.enabled === true,
    ahead: r.ahead === 'today' || AHEAD_HOURS.includes(r.ahead) ? r.ahead : PREP_DEFAULTS.ahead,
    minInvitees: MIN_INVITEES.includes(r.minInvitees) ? r.minInvitees : PREP_DEFAULTS.minInvitees,
    orNew: typeof r.orNew === 'boolean' ? r.orNew : PREP_DEFAULTS.orNew,
  };
}

// the end of the prepare-ahead window, in ms: midnight tonight (local time) for 'today', else now plus the hours
export function prepUntil(now, ahead) {
  if (ahead === 'today') { const d = new Date(now); d.setHours(23, 59, 59, 999); return d.getTime(); }
  return now + (AHEAD_HOURS.includes(ahead) ? ahead : 24) * 3600000;
}
// an event that has not ended and starts before the window closes
export function inPrepWindow(event, now, ahead) {
  const start = new Date(event?.start ?? '').getTime(), end = new Date(event?.end ?? event?.start ?? '').getTime();
  return Number.isFinite(start) && Number.isFinite(end) && end > now && start <= prepUntil(now, ahead);
}

// Join links keep the meeting and drop anything that lets someone in without asking: a password, passcode or token
// in the query, a user:password before the host, and the fragment. Only https links are kept
const SECRET_PARAM = /^(pwd|pw|pass|passcode|password|pin|tk|token|access_token|auth|key|secret|sig|signature)$/i;
export function stripJoinCredentials(url) {
  let u;
  try { u = new URL(String(url ?? '').trim()); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  for (const k of [...u.searchParams.keys()]) if (SECRET_PARAM.test(k)) u.searchParams.delete(k);
  u.username = ''; u.password = ''; u.hash = '';
  return u.toString();
}
// invite text with every link stripped as above and the value after "Passcode:", "Password:" or "PIN:" removed
export function stripCredentialsInText(text) {
  return String(text ?? '')
    .replace(/https?:\/\/[^\s<>"')\]]+/gi, (m) => stripJoinCredentials(m) ?? '[link removed]')
    .replace(/\b(passcode|password|pwd|pin)\b(\s*[:=]\s*)\S+/gi, '$1$2[removed]');
}

const lower = (s) => String(s ?? '').trim().toLowerCase();
const words = (s) => lower(s).replace(/[^a-z0-9@.\s'-]/g, ' ').split(/\s+/).filter(Boolean);
// jane.doe@example.com reads as "jane doe" for matching only; it is never shown as a name
const emailName = (email) => { const w = lower(email).split('@')[0].split(/[._-]+/).filter((x) => /^[a-z]{2,}$/.test(x)); return w.length >= 2 ? w.join(' ') : ''; };

// the invitees other than you, once each, by email or else by name
export function inviteesOf(event, { isMe = () => false } = {}) {
  const seen = new Set(), out = [];
  for (const a of event?.attendees ?? []) {
    const email = lower(a?.email), name = String(a?.name ?? '').trim();
    if ((!email && !name) || isMe({ name, email })) continue;
    const key = email || lower(name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, email });
  }
  return out;
}
export const displayName = (p) => p.name || p.email;

// the invitees the never-listen list (emails or domains) or the opt-out customer names cover. One is enough to leave
// the whole event without prep, so nothing about that meeting reaches a model or the vault
export function optedOut(invitees, { onNeverList = () => false, isExcluded = () => false } = {}) {
  return invitees.filter((p) => (p.email && onNeverList(p.email)) || (p.name && isExcluded(p.name)) || (p.email && isExcluded(p.email)));
}

// what text about a person is matched on: the email, the full name when it has two or more words, and the name read
// off the email. A one-word name alone matches too much to count
export function personTerms(p) {
  const out = new Set();
  if (p.email) out.add(lower(p.email));
  const n = words(p.name).join(' ');
  if (n.split(' ').length >= 2) out.add(n);
  const e = emailName(p.email);
  if (e) out.add(e);
  return [...out];
}
const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const termRe = (terms) => (terms.length ? new RegExp(`(^|[^a-z0-9])(${terms.map(escapeRe).join('|')})($|[^a-z0-9])`, 'i') : null);

// someone you have met before: their email or name is among the people of a past meeting
export function isKnown(p, known) {
  return personTerms(p).some((t) => known.has(t)) || (!!p.name && known.has(lower(p.name)));
}
// the "N or more invitees, or someone new" filter; minInvitees 0 lets every event through
export function wantsPrep(invitees, known, { minInvitees, orNew }) {
  if (!minInvitees) return true;
  if (invitees.length >= minInvitees) return true;
  return !!orNew && invitees.some((p) => !isKnown(p, known));
}

// a stamp for the invite as it stands: a changed title, time, invitee list or description writes the note again
export function inviteStamp(event, invitees) {
  const parts = [event?.title, event?.start, event?.end, invitees.map((p) => p.email || lower(p.name)).sort().join(','), stripCredentialsInText(event?.notes ?? '')];
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
}

const body = (text) => String(text ?? '').replace(/^---\n[\s\S]*?\n---\n?/, '');
const dateOf = (rel, text) => {
  const fm = String(text ?? '').match(/^---\n[\s\S]*?^date:\s*["']?(\d{4}-\d{2}-\d{2})/m);
  if (fm) return fm[1];
  const name = String(rel).match(/(\d{4}-\d{2}-\d{2})/);
  return name ? name[1] : null;
};
const slugOf = (s) => lower(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const baseSlug = (rel) => slugOf(String(rel).split('/').pop().replace(/\.md$/i, '').replace(/^\d{4}-\d{2}-\d{2}[-_ ]*/, ''));
const TASK_RE = /^\s*[-*+]\s+\[ \]\s+(.+)$/;
// the words of a title worth matching a topic on
const STOP = new Set(['meeting', 'sync', 'weekly', 'daily', 'call', 'chat', 'with', 'and', 'the', 'for', 'catch', 'catchup', 'check', 'standup', 'review', 'team', 'intro', 'prep', '1:1', 'one', 'on']);
const topicWords = (title) => words(title).filter((w) => w.length >= 4 && !STOP.has(w));

// lines around each match, joined, up to max characters
function around(text, re, max = 900) {
  const lines = body(text).split('\n'), keep = new Set();
  lines.forEach((l, i) => { if (re.test(l)) for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 2); j++) keep.add(j); });
  return [...keep].sort((a, b) => a - b).map((i) => lines[i]).join('\n').slice(0, max);
}

// Everything the vault says that bears on this meeting, each piece numbered as a source.
// notes: [{ rel, title, text }] (the vault index, already filtered by the guardrails and redacted);
// meetings: [{ rel, title, date, people }] (the meeting index, newest first); topicRels: notes a search on the title
// found; isPrepNote(rel) leaves earlier prep notes out so one prep never cites another.
export function gatherPrep({ event, invitees, notes, meetings, topicRels = [], isPrepNote = () => false, now = Date.now(), perPerson = 4, maxHistory = 6, maxTasks = 10 }) {
  const usable = notes.filter((n) => n?.rel && !isPrepNote(n.rel));
  const byRel = new Map(usable.map((n) => [n.rel, n]));
  const sources = [], idOf = new Map();
  const cite = (rel, excerpt) => {
    const n = byRel.get(rel);
    if (!n) return null;
    let s = idOf.get(rel);
    if (!s) { s = { id: sources.length + 1, rel, title: n.title || rel.split('/').pop().replace(/\.md$/i, ''), date: dateOf(rel, n.text), excerpt: '' }; sources.push(s); idOf.set(rel, s); }
    if (excerpt && !s.excerpt.includes(excerpt)) s.excerpt = `${s.excerpt}\n${excerpt}`.trim().slice(0, 2400);
    return s.id;
  };
  const past = meetings.filter((m) => m?.rel && byRel.has(m.rel) && (!m.date || new Date(m.date).getTime() <= now));
  const newest = (a, b) => String(b.date ?? '').localeCompare(String(a.date ?? ''));

  const people = invitees.map((p) => {
    const terms = personTerms(p), re = termRe(terms);
    const names = new Set([...terms, lower(p.name)].filter(Boolean));
    const met = past.filter((m) => (m.people ?? []).some((x) => names.has(lower(x)))).sort(newest);
    const slug = slugOf(p.name);
    const own = slug.includes('-') ? usable.filter((n) => baseSlug(n.rel) === slug) : [];
    const said = re ? usable.filter((n) => !own.includes(n) && re.test(body(n.text))).map((n) => ({ n, date: dateOf(n.rel, n.text) })).sort(newest).map((x) => x.n) : [];
    const ids = [
      ...own.map((n) => cite(n.rel, body(n.text).slice(0, 1500))),
      ...met.slice(0, 2).map((m) => cite(m.rel, re ? around(byRel.get(m.rel).text, re) || body(byRel.get(m.rel).text).slice(0, 900) : body(byRel.get(m.rel).text).slice(0, 900))),
      ...said.slice(0, perPerson).map((n) => cite(n.rel, around(n.text, re))),
    ].filter(Boolean);
    const last = met[0] ? { id: idOf.get(met[0].rel).id, date: met[0].date ?? null } : null;
    return { name: displayName(p), email: p.email, sources: [...new Set(ids)].slice(0, perPerson + 2), last };
  });

  // past meetings on this topic (a similar title) or with anyone invited, newest first
  const allNames = new Set(invitees.flatMap((p) => [...personTerms(p), lower(p.name)]).filter(Boolean));
  const historyRows = past.filter((m) => similarTitle(m.title, event?.title ?? '') || (m.people ?? []).some((x) => allNames.has(lower(x)))).sort(newest).slice(0, maxHistory);
  const history = historyRows.map((m) => ({ id: cite(m.rel, body(byRel.get(m.rel).text).slice(0, 1200)), date: m.date ?? null }));

  // topic notes the title search found, beyond the meetings already cited
  for (const rel of topicRels.filter((r) => byRel.has(r)).slice(0, 4)) {
    const tw = topicWords(event?.title);
    cite(rel, tw.length ? around(byRel.get(rel).text, termRe(tw)) || body(byRel.get(rel).text).slice(0, 900) : body(byRel.get(rel).text).slice(0, 900));
  }

  // unchecked tasks that name an invitee, or that sit in a note about this meeting or its topic
  const anyone = termRe([...allNames].filter((t) => t.includes(' ') || t.includes('@')));
  const topical = new Set([...historyRows.map((m) => m.rel), ...topicRels]);
  const tasks = [];
  for (const n of usable) {
    for (const line of body(n.text).split('\n')) {
      const m = line.match(TASK_RE);
      if (!m || !(topical.has(n.rel) || (anyone && anyone.test(m[1])))) continue;
      tasks.push({ text: m[1].trim().slice(0, 300), id: cite(n.rel, line.trim()), date: dateOf(n.rel, n.text) });
    }
  }
  tasks.sort(newest);
  return { people, history, tasks: tasks.slice(0, maxTasks).map(({ text, id }) => ({ text, id })), sources };
}

export const PREP_SYSTEM = `You prepare one person for an upcoming meeting from numbered notes in their own vault. Write plain, literal
sentences. No figures of speech. Use only what the sources say. Never guess a role, a relationship, a number or a
decision the sources do not state. Every item cites the numbers of the sources it comes from; an item you cannot cite,
leave out. Reply with JSON only:
{"people": [{"name": string, "summary": string, "refs": number[]}], "talking": [{"text": string, "refs": number[]}], "watch": [{"text": string, "refs": number[]}]}
- people: for each invitee listed with sources, one or two sentences: their role, what they last discussed with this
  person, and threads still open with them, as far as the sources say.
- talking: 3 to 5 specific things worth raising in this meeting, most useful first.
- watch: open disagreements or risks the sources show. An empty list when there are none.`;

// the prompt: the meeting, the vault's own instructions, who is invited (with their source numbers), then the sources
export function prepPrompt({ event, gathered, instructions = '', owner = 'the user', about = '', budget = 24000 }) {
  const who = gathered.people.map((p) => `- ${p.name}${p.email && p.email !== p.name ? ` <${p.email}>` : ''}: ${p.sources.length ? `sources ${p.sources.join(', ')}` : 'no sources'}`).join('\n');
  let left = budget;
  const src = [];
  for (const s of gathered.sources) {
    const block = `[${s.id}] ${s.title}${s.date ? ` (${s.date})` : ''}\n${s.excerpt || '(no excerpt)'}`;
    if (block.length > left) break;
    left -= block.length;
    src.push(block);
  }
  return [
    `Prepare ${owner} for this meeting.${about ? ` ${about}` : ''}`,
    ...(instructions.trim() ? [`<vault-instructions>\n${instructions.trim().slice(0, 4000)}\n</vault-instructions>`] : []),
    `<meeting>\nTitle: ${event?.title ?? ''}\nWhen: ${event?.start ?? ''} to ${event?.end ?? ''}${event?.notes ? `\nDescription: ${stripCredentialsInText(event.notes).slice(0, 2000)}` : ''}\n</meeting>`,
    `<invitees>\n${who || '(none listed)'}\n</invitees>`,
    `<sources>\n${src.join('\n\n')}\n</sources>`,
  ].join('\n\n');
}

// the model's reply, keeping only items that cite a source that exists; null when the reply is not the JSON asked for
export function parsePrep(text, sources) {
  const m = String(text ?? '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j;
  try { j = JSON.parse(m[0]); } catch { return null; }
  const ids = new Set(sources.map((s) => s.id));
  const refs = (r) => [...new Set((Array.isArray(r) ? r : []).map(Number).filter((n) => ids.has(n)))];
  const items = (list, key) => (Array.isArray(list) ? list : []).map((x) => ({ ...(key === 'summary' ? { name: String(x?.name ?? '').trim() } : {}), text: String(x?.[key] ?? '').trim(), refs: refs(x?.refs) })).filter((x) => x.text && x.refs.length);
  return { people: items(j.people, 'summary'), talking: items(j.talking, 'text').slice(0, 5), watch: items(j.watch, 'text') };
}

// a wiki link to a source note by its vault path, so the vault app and Quorum both resolve it
export const wikiLink = (s) => `[[${s.rel.replace(/\.md$/i, '')}|${String(s.title).replace(/[[\]|]/g, ' ').trim()}]]`;

const fmValue = (v) => JSON.stringify(String(v ?? ''));

// The note as saved in the vault. Who's in the room keeps every invitee: what the model wrote with its links, else the
// sources found with no summary, else "Nothing found." History and open items come straight from the vault.
export function renderPrep({ event, gathered, parsed, join = null, platformName = null, when = '', now = new Date() }) {
  const byId = new Map(gathered.sources.map((s) => [s.id, s]));
  const links = (ids) => ids.map((id) => byId.get(id)).filter(Boolean).map(wikiLink).join(', ');
  const said = new Map((parsed?.people ?? []).map((p) => [lower(p.name), p]));
  const safeJoin = join ? stripJoinCredentials(join) : null;
  const out = [
    '---',
    'type: meeting-prep',
    'generated_by: quorum',
    `title: ${fmValue(`Prep: ${event?.title ?? ''}`)}`,
    `event_start: ${fmValue(event?.start)}`,
    ...(safeJoin ? [`meeting_url: ${fmValue(safeJoin)}`] : []),
    `prepared: ${fmValue(now.toISOString())}`,
    '---',
    `# Prep: ${event?.title ?? ''}`,
    '',
    [when, safeJoin ? `[Join${platformName ? ` on ${platformName}` : ''}](${safeJoin})` : null].filter(Boolean).join(' · '),
    '',
    "## Who's in the room",
  ];
  if (!gathered.people.length) out.push('- Nobody else is listed on the invite.');
  for (const p of gathered.people) {
    const w = said.get(lower(p.name)) ?? (p.email ? said.get(lower(p.email)) : null);
    const last = p.last && byId.get(p.last.id) ? ` Last met: ${wikiLink(byId.get(p.last.id))}${p.last.date ? ` (${String(p.last.date).slice(0, 10)})` : ''}.` : '';
    if (w) out.push(`- **${p.name}**: ${w.text} (${links(w.refs)})${last}`);
    else if (p.sources.length) out.push(`- **${p.name}**: mentioned in ${links(p.sources)}.${last}`);
    else out.push(`- **${p.name}**: Nothing found.`);
  }
  out.push('', '## History');
  if (gathered.history.length) for (const h of gathered.history) out.push(`- ${wikiLink(byId.get(h.id))}${h.date ? ` (${String(h.date).slice(0, 10)})` : ''}`);
  else out.push('Nothing found.');
  out.push('', '## Open items');
  if (gathered.tasks.length) for (const t of gathered.tasks) out.push(`- ${t.text} (from ${wikiLink(byId.get(t.id))})`);
  else out.push('Nothing found.');
  out.push('', '## Talking points');
  if (parsed?.talking.length) parsed.talking.forEach((t, i) => out.push(`${i + 1}. ${t.text} (${links(t.refs)})`));
  else out.push('Nothing found.');
  if (parsed?.watch.length) { out.push('', '## Watch out for'); for (const t of parsed.watch) out.push(`- ${t.text} (${links(t.refs)})`); }
  return `${out.join('\n')}\n`;
}

// where a prep note goes: a prep folder inside the daily folder (next to the daily note, out of the daily naming), else
// inside the meetings folder, else at the top of the vault. Named by the event's date and title
export function prepRel({ daily = null, meetings = null, event }) {
  const base = daily ?? meetings ?? '';
  const date = String(event?.start ?? '').slice(0, 10) || 'undated';
  const name = `${date} ${String(event?.title ?? 'Meeting').replace(/[\\/:*?"<>|#^[\]]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Meeting'}.md`;
  return [base, 'prep', name].filter(Boolean).join('/');
}
export const isPrepRel = (rel) => /(^|\/)prep\/\d{4}-\d{2}-\d{2} [^/]+\.md$/i.test(String(rel ?? ''));
