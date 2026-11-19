// A vault note opened in the Knowledge editor. The body is the text after the frontmatter and the first heading, cut the
// way vault-note cuts it for the read view; everything around it (frontmatter, blank lines, the heading, the trailing
// line break) is kept byte for byte when the body is saved. The editor sees \n line endings; a note written with \r\n
// gets them back on save. A note that mixes the two can't round trip through a text field, so it is flagged mixed.

import { hashText } from './handnote.js';

const FRONT = /^---\n[\s\S]*?\n---\n/;
const lead = (s) => s.match(/^\s*/)[0].length;

export function editParts(raw) {
  const text = String(raw ?? '');
  const crlf = /\r\n/.test(text) && !/(^|[^\r])\n/.test(text);
  const norm = crlf ? text.replace(/\r\n/g, '\n') : text;
  const fm = norm.match(FRONT)?.[0] ?? '';
  const end = norm.replace(/\s+$/, '').length;
  let s = fm.length + lead(norm.slice(fm.length));
  const h1 = norm.slice(s, Math.max(s, end)).match(/^#\s+(.+)$/m);
  if (h1 && norm.startsWith(h1[0], s)) s += h1[0].length + lead(norm.slice(s + h1[0].length));
  const cut = s < end ? s : end;
  return { head: norm.slice(0, cut), body: norm.slice(cut, end), tail: norm.slice(end), fm, eol: crlf ? '\r\n' : '\n', mixed: norm.includes('\r') };
}

// the note with a new body; the rest of the file as it was
export function withBody(raw, body) {
  const p = editParts(raw);
  const b = String(body ?? '').replace(/\r\n/g, '\n').replace(/\s+$/, '');
  if (b === p.body) return String(raw ?? '');
  const out = !p.body ? `${p.head}${p.head ? '\n\n' : ''}${b}${p.tail}` : b ? `${p.head}${b}${p.tail}` : `${p.head.replace(/\s+$/, '')}${p.tail}`;
  return p.eol === '\r\n' ? out.replace(/\n/g, '\r\n') : out;
}

// a save from the editor against the file as it is now: a conflict when the file changed since the editor read it
// (hash), refused for a note this view can't edit, else the text to write (the file as it was when nothing changed)
export function planSave(raw, { hash, body, withheld }) {
  if (hashText(raw) !== hash) return { conflict: true };
  if (withheld || editParts(raw).mixed) return { error: 'This note can only be edited in the vault directly.' };
  return { text: typeof body === 'string' ? withBody(raw, body) : String(raw) };
}
