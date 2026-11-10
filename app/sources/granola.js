// Granola over its MCP server: list meetings, fetch notes, write markdown in the same shape the vault already holds
// for Granola notes (granola_id, participants, source: granola, granola_url) plus the generic source_id.
const ATTR = /(\w+)="([^"]*)"/g;
const decode = (s) => String(s ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');
const attrs = (tag) => { const o = {}; for (const m of tag.matchAll(ATTR)) o[m[1]] = decode(m[2]); return o; };
const inner = (block, tag) => { const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(block); return m ? m[1] : null; };
const selfClosed = (block, tag) => new RegExp(`<${tag}\\b[^>]*/>`).test(block);

// "Alex Rivera (note creator) from Acme (alex@example.com), Dana Lee from Globex (dana@example.com)"
export function parseParticipants(text) {
  return decode(text ?? '').replace(/\s+/g, ' ').trim().split(/,\s+(?=[A-Z][^,]*?(?: from | \(|$))/).map((p) => p.trim()).filter(Boolean).map((p) => {
    const recorder = /\(note creator\)/.test(p);
    const name = p.replace(/\s*\(note creator\)/, '').replace(/\s+from\s+.*$/, '').replace(/\s*\([^)]*@[^)]*\)\s*$/, '').trim();
    return { name, recorder };
  }).filter((p) => p.name);
}

export function parseMeetingList(text) {
  const pag = /<pagination\b([^>]*)\/?>/.exec(text);
  const p = pag ? attrs(pag[1]) : {};
  const meetings = [];
  for (const m of String(text).matchAll(/<meeting\b([^>]*)>([\s\S]*?)<\/meeting>/g)) {
    const a = attrs(m[1]);
    if (!a.id) continue;
    meetings.push({ id: a.id, title: a.title ?? '', meetingAt: a.meeting_at ?? null, url: a.url ?? null, participants: parseParticipants(inner(m[2], 'known_participants')) });
  }
  return { meetings, hasMore: p.has_more === 'true' && !!p.next_cursor, cursor: p.next_cursor ?? null, totalCount: p.total_count ? Number(p.total_count) : null };
}

export function parseMeetingDetails(text) {
  const out = [];
  for (const m of String(text).matchAll(/<meeting\b([^>]*)>([\s\S]*?)<\/meeting>/g)) {
    const a = attrs(m[1]);
    if (!a.id) continue;
    const body = m[2];
    const privateNotes = selfClosed(body, 'private_notes') ? '' : decode(inner(body, 'private_notes') ?? '').trim();
    out.push({
      id: a.id, title: a.title ?? '', meetingAt: a.meeting_at ?? a.created_at ?? null, createdAt: a.created_at ?? null, updatedAt: a.updated_at ?? null, url: a.url ?? null,
      participants: parseParticipants(inner(body, 'known_participants')),
      privateNotes, summary: decode(inner(body, 'summary') ?? '').trim(),
      folders: (inner(body, 'folders') ?? '').split(/\s*,\s*|\n/).map((s) => decode(s).trim()).filter(Boolean),
    });
  }
  return out;
}

// right after sign-in: does this identity have a Granola account? A plain error when it does not
export async function verify(mcp) {
  try { await mcp.call('get_account_info', {}); return { ok: true }; }
  catch (err) {
    if (/not created a Granola account|mcp-signup/i.test(err.message)) throw new Error('No Granola account for this sign-in. Use the account your Granola app is signed in with.');
    throw err;
  }
}

const yamlStr = (s) => JSON.stringify(String(s));
export const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'meeting';

// the markdown for one meeting; the first eight characters of the id tie the file to the meeting when titles repeat
export function noteMarkdown(m) {
  const lines = [
    '---',
    `granola_id: ${m.id}`,
    `source_id: ${m.id}`,
    `title: ${yamlStr(m.title || 'Untitled meeting')}`,
    `date: ${m.meetingAt ?? new Date().toISOString()}`,
    'participants:',
    ...m.participants.map((p) => `  - ${p.name}${p.recorder ? ' (recorder)' : ''}`),
    `participant_count: ${m.participants.length}`,
    'source: granola',
    'visibility: private',
    ...(m.url ? [`granola_url: ${m.url}`] : []),
    ...(m.folders?.length ? ['folders:', ...m.folders.map((f) => `  - ${yamlStr(f)}`)] : []),
    '---',
    '',
    `# ${m.title || 'Untitled meeting'}`,
    '',
  ];
  if (m.privateNotes) lines.push('## Private notes', '', m.privateNotes, '');
  if (m.summary) lines.push('## Summary', '', m.summary, '');
  return lines.join('\n');
}

export const fileNameFor = (m) => `${String(m.meetingAt ?? '').slice(0, 10) || 'undated'}-${slug(m.title || 'meeting')}.md`;

// lists everything since `since`, skips what the vault has, fetches the rest ten at a time and writes each note.
// write(fileName, text, meeting) returns the path it wrote; existing is a Set of meeting ids already in the vault
export async function sync({ mcp, existing, since = '2015-01-01', write, progress = () => {}, batch = 10 }) {
  const listed = [];
  let cursor = null;
  let totalCount = null;
  do {
    const args = { from_date: since, limit: 100, max_participants: 50 };
    if (cursor) args.cursor = cursor;
    let r;
    try { r = await mcp.call('search_meetings', args); }
    catch (err) {
      if (/not created a Granola account|mcp-signup/i.test(err.message)) throw new Error('No Granola account for this sign-in. Reconnect with your Granola email.');
      throw err;
    }
    const page = parseMeetingList(r.text);
    listed.push(...page.meetings);
    totalCount ??= page.totalCount;
    cursor = page.hasMore ? page.cursor : null;
    progress({ phase: 'list', message: totalCount ? `Found ${listed.length} of ${totalCount} meetings` : `Found ${listed.length} meetings`, done: listed.length, total: totalCount });
  } while (cursor);
  // a page boundary can repeat a meeting; one entry per id
  const unique = [...new Map(listed.map((m) => [m.id, m])).values()];
  const todo = unique.filter((m) => !existing.has(m.id));
  const failed = [];
  let done = 0, imported = 0;
  progress({ phase: 'import', phaseStartedAt: Date.now(), total: todo.length, done: 0, message: todo.length ? `Importing ${todo.length} new of ${unique.length} meetings` : 'Nothing new' });
  for (let i = 0; i < todo.length; i += batch) {
    const ids = todo.slice(i, i + batch).map((m) => m.id);
    let details = [];
    try { details = parseMeetingDetails((await mcp.call('get_meetings', { meeting_ids: ids, attachments: 'none' })).text); }
    catch (err) { for (const id of ids) failed.push({ id, title: todo.find((m) => m.id === id)?.title ?? '', error: err.message }); done += ids.length; progress({ done }); continue; }
    for (const id of ids) {
      const m = details.find((d) => d.id === id);
      if (!m) { failed.push({ id, title: todo.find((x) => x.id === id)?.title ?? '', error: 'Granola did not return this meeting.' }); done += 1; continue; }
      try { await write(fileNameFor(m), noteMarkdown(m), m); imported += 1; existing.add(id); }
      catch (err) { failed.push({ id, title: m.title, error: err.message }); }
      done += 1;
    }
    progress({ done, message: `Imported ${imported} of ${todo.length}` });
  }
  return { listed: unique.length, imported, skipped: unique.length - todo.length, failed };
}
