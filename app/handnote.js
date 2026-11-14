// Notes you write in the app: a fresh Untitled note or an existing one opened for editing, saved into the same folder
// and with the same frontmatter shape as a note Quorum writes at the end of a recording. Pure text in and out; the main
// process does the reading, writing and path checks.
import { createHash } from 'node:crypto';
import { eolOf, frontBlock, readFrontmatter, setFrontmatterKey, yamlValue } from './frontmatter.js';

export { yamlValue };

export const UNTITLED = 'Untitled note';

// a frontmatter string is written as a JSON string, which YAML reads as a double-quoted scalar; frontmatter.js reads it
// back with the same rules
export const yamlStr = (s) => JSON.stringify(String(s));
export const slug = (s, fallback = 'note') => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || fallback;
export const hashText = (text) => createHash('sha1').update(String(text)).digest('hex');
export const cleanTitle = (t) => String(t ?? '').replace(/\s+/g, ' ').trim() || UNTITLED;

// 2026-11-13-standup-ideas-4a5b6c7d.md, the name saveNotes gives a recorded note and a written one. The suffix is eight
// hex characters of the note's id, so two notes with the same title on the same day never share a name, and it never
// starts with a hyphen
export const idSuffix = (id) => hashText(String(id)).slice(0, 8);
export const noteFileName = ({ date, title, id }) => `${date}-${slug(cleanTitle(title))}-${idSuffix(id)}.md`;

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
// heading, and the body after that heading with \n line endings. gap is the blank space between the frontmatter and what
// follows, and eol the note's line ending, both kept on the way back
export function splitNote(raw) {
  const text = String(raw ?? '');
  const eol = eolOf(text);
  const fm = frontBlock(text);
  const rest = text.slice(fm.length).replace(/\r\n/g, '\n');
  const gap = rest.match(/^\n*/)[0];
  const h = rest.match(/^\s*#\s+(.+)\n?/);
  const title = (fm ? readFrontmatter(fm).title : '') || h?.[1].trim() || '';
  const body = (h ? rest.slice(h[0].length) : rest).replace(/^\n+/, '').replace(/\s+$/, '');
  return { fm, title, body, heading: !!h, gap, eol };
}

// the edited title and body put back into the note: the frontmatter keeps every line it had, with only its title
// changed, and the first heading follows the title
export function rewriteNote(raw, { title, body }) {
  const { fm, heading, gap, eol } = splitNote(raw);
  const t = cleanTitle(title);
  let front = fm ? setFrontmatterKey(fm, 'title', yamlStr(t)) : '';
  if (front && !/\r?\n$/.test(front)) front += eol;
  const text = String(body ?? '').replace(/\s+$/, '');
  const out = `${heading || !front ? `# ${t}\n\n` : ''}${text}\n`;
  return `${front}${front ? (gap || '').replace(/\n/g, eol) : ''}${out.replace(/\n/g, eol)}`;
}

// a note as the note view gets it: a note with withheld lines opens read-only, and every withheld line is replaced
// before it leaves, the frontmatter included, so the Properties panel never shows one
export const WITHHELD = '[withheld: opted-out customer]';
export function noteForEditor(raw, { isExcluded, redact }) {
  const readOnly = !!isExcluded(raw);
  const { fm: rawFm } = splitNote(raw);
  // a withheld frontmatter line keeps its key, so the panel still splits into rows; only the value is replaced
  const eol = eolOf(raw);
  const fm = readOnly ? rawFm.split(/\r?\n/).map((l) => {
    if (!isExcluded(l)) return l;
    const kv = /^([A-Za-z0-9_][A-Za-z0-9_ .-]*):/.exec(l);
    return kv ? `${kv[1]}: ${yamlStr(WITHHELD)}` : /^\s*-\s/.test(l) ? `${l.match(/^\s*-\s/)[0]}${yamlStr(WITHHELD)}` : WITHHELD;
  }).join(eol) : rawFm;
  const { title, body } = splitNote(readOnly ? redact(raw) : raw);
  return { title: isExcluded(title) ? WITHHELD : title, body, frontmatter: fm, readOnly, date: readFrontmatter(fm).date ?? null };
}

// what the Properties panel may save: nothing (no frontmatter), or one --- block that ends the way it starts
export const validFrontmatter = (fm) => typeof fm === 'string' && (fm === '' || (/^---\n[\s\S]*\n---\n$/.test(fm) && !fm.slice(4, -4).split('\n').includes('---')));

// Record's Screen option, one helper answer at a time: a missing permission turns Screen off for the recording (said
// once), an empty read, a read of Quorum, or one identical to the last (same app, title and text) is skipped, anything
// else is kept beside the recording
export function screenRead(r, lastKey) {
  if (r?.granted === false) return { action: 'denied' };
  const text = typeof r?.text === 'string' ? r.text.trim() : '';
  if (!text) return { action: 'skip' };
  const app = typeof r.app === 'string' ? r.app : '';
  const title = typeof r.title === 'string' ? r.title : '';
  // Quorum's own window is never context: the helper skips it, and a read that still names it is dropped
  if (/^quorum(\s|$)/i.test(app.trim())) return { action: 'skip' };
  const key = hashText(`${app}\n${title}\n${text}`);
  return key === lastKey ? { action: 'skip' } : { action: 'send', key, event: { app, title, text } };
}
