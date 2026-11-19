// A vault note opened in the Knowledge editor. The body is the text after the frontmatter and the first heading, cut the
// way vault-note cuts it for the read view; everything around it (frontmatter, blank lines, the heading, the trailing
// line break) is kept byte for byte when the body is saved. The editor sees \n line endings; a note written with \r\n
// gets them back on save. A note that mixes the two can't round trip through a text field, so it is flagged mixed.
// No Node imports: the renderer's fidelity check (src/editor/fidelity.ts) uses this module too.

// frontmatter, empty (---, ---) included, and one that ends the file without a line break
const FRONT = /^---\n(?:[\s\S]*?\n)?---(?:\n|$)/;
// blank lines only: spaces at the start of the first line are part of it (an indented code block stays code)
const lead = (s) => s.match(/^(?:[ \t]*\r?\n)*/)[0].length;

export function editParts(raw) {
  const text = String(raw ?? '');
  const crlf = /\r\n/.test(text) && !/(^|[^\r])\n/.test(text);
  const norm = crlf ? text.replace(/\r\n/g, '\n') : text;
  // a byte order mark stays first in the head; frontmatter and the heading are found after it
  const bom = norm.startsWith('\ufeff') ? 1 : 0;
  const fm = norm.slice(bom).match(FRONT)?.[0] ?? '';
  const end = Math.max(bom, norm.replace(/\s+$/, '').length);
  let s = bom + fm.length + lead(norm.slice(bom + fm.length));
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
  const out = !p.body ? `${p.head}${p.head.replace(/^\ufeff/, '') ? '\n\n' : ''}${b}${p.tail}` : b ? `${p.head}${b}${p.tail}` : `${p.head.replace(/\s+$/, '')}${p.tail}`;
  return p.eol === '\r\n' ? out.replace(/\n/g, '\r\n') : out;
}

// the note with new frontmatter (the Properties rows); '' removes it, with the blank lines that followed it
export function withFrontmatter(raw, fm) {
  const p = editParts(raw);
  const f = String(fm ?? '').replace(/\r\n/g, '\n');
  if (f === p.fm) return String(raw ?? '');
  const all = `${p.head}${p.body}${p.tail}`;
  // a byte order mark stays first
  const bom = all.startsWith('\ufeff') ? '\ufeff' : '';
  const rest = all.slice(bom.length + p.fm.length);
  const out = bom + (!f ? rest.replace(/^\n+/, '') : p.fm ? `${f}${rest}` : `${f}${rest ? `\n${rest.replace(/^\n+/, '')}` : ''}`);
  return p.eol === '\r\n' ? out.replace(/\n/g, '\r\n') : out;
}
