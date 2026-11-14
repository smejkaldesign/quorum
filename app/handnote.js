// Notes you write in the app: a fresh Untitled note or an existing one opened for editing, saved into the same folder
// and with the same frontmatter shape as a note Quorum writes at the end of a recording. Pure text in and out; the main
// process does the reading, writing and path checks.
import { createHash } from 'node:crypto';

export const UNTITLED = 'Untitled note';

const yamlStr = (s) => JSON.stringify(String(s));
export const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'note';
export const hashText = (text) => createHash('sha1').update(String(text)).digest('hex');
export const cleanTitle = (t) => String(t ?? '').replace(/\s+/g, ' ').trim() || UNTITLED;

// 2026-11-13-standup-ideas-4a5b6c7d.md, the name saveNotes gives a recorded note
export const noteFileName = ({ date, title, id }) => `${date}-${slug(cleanTitle(title))}-${String(id).slice(-8).toLowerCase()}.md`;

// the frontmatter and heading a recorded solo note gets, then the body as written
export function newNoteText({ id, title, body, date, owner }) {
  const t = cleanTitle(title);
  return [
    '---',
    `quorum_id: ${id}`,
    'type: note',
    `title: ${yamlStr(t)}`,
    `date: ${date}`,
    'participants:',
    `  - ${owner} (recorder)`,
    'participant_count: 1',
    'source: quorum',
    '---',
    '',
    `# ${t}`,
    '',
    String(body ?? '').replace(/\s+$/, ''),
    '',
  ].join('\n');
}

// a note on disk as the editor sees it: the frontmatter kept verbatim, the title from the frontmatter or the first
// heading, and the body after that heading
export function splitNote(raw) {
  const text = String(raw ?? '');
  const fm = text.match(/^---\n[\s\S]*?\n---\n/)?.[0] ?? '';
  const rest = text.slice(fm.length);
  const fmTitle = fm.match(/^title:\s*(.*)$/m)?.[1]?.trim().replace(/^"(.*)"$/, '$1').replace(/\\"/g, '"') ?? '';
  const h = rest.match(/^\s*#\s+(.+)\n?/);
  const title = fmTitle || h?.[1].trim() || '';
  const body = (h ? rest.slice(h[0].length) : rest).replace(/^\n+/, '').replace(/\s+$/, '');
  return { fm, title, body, heading: !!h };
}

// the edited title and body put back into the note: the frontmatter keeps every line it had, with only its title
// changed, and the first heading follows the title
export function rewriteNote(raw, { title, body }) {
  const { fm, heading } = splitNote(raw);
  const t = cleanTitle(title);
  let front = fm;
  if (front) front = /^title:.*$/m.test(front) ? front.replace(/^title:.*$/m, `title: ${yamlStr(t)}`) : front.replace(/\n---\n$/, `\ntitle: ${yamlStr(t)}\n---\n`);
  const text = String(body ?? '').replace(/\s+$/, '');
  return `${front}${front ? '\n' : ''}${heading || !front ? `# ${t}\n\n` : ''}${text}\n`;
}
