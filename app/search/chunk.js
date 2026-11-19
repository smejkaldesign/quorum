// Heading-scoped chunks of one note for search (search/index.js). Pure. Each chunk holds the lines under one heading,
// at most maxTokens estimated tokens with its heading path, and a window that runs long continues in the next chunk
// with a short overlap. heading is the path from the note title down (Title > Section > Subsection); lines are 0-based
// and inclusive, the same numbering vindex uses. Frontmatter is left out: the graph reads it.
import { createHash } from 'node:crypto';
import { parseFrontmatter } from '../linkparse.js';
import { CHARS_PER_TOKEN } from '../memoryModels.js';

export const MAX_CHUNK_TOKENS = 400;
export const OVERLAP_TOKENS = 40;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE = /^(```|~~~)/;

export const tokensOf = (s) => Math.ceil(String(s).length / CHARS_PER_TOKEN);
export const chunkHash = (heading, text) => createHash('sha256').update(`${heading}\n${text}`).digest('hex').slice(0, 32);
// what the embedder reads for a chunk: its heading path, then its text
export const embedText = (c) => (c.text ? `${c.heading}\n${c.text}` : c.heading);

// a line longer than a whole chunk, cut at spaces into pieces that fit
function pieces(line, maxChars) {
  if (line.length <= maxChars) return [line];
  const out = [];
  let rest = line;
  while (rest.length > maxChars) {
    let at = rest.lastIndexOf(' ', maxChars);
    if (at < maxChars / 2) at = maxChars;
    out.push(rest.slice(0, at));
    rest = rest.slice(at).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

// windows over one section's lines: [{ start, end, text }], each within budget tokens, the next starting overlap
// tokens before the last one ended
function windows(lines, budget, overlap) {
  const maxChars = budget * CHARS_PER_TOKEN;
  const items = [];
  for (const { n, text } of lines) for (const p of pieces(text, maxChars)) items.push({ n, text: p, t: tokensOf(p) + 1 });
  const out = [];
  let i = 0;
  while (i < items.length) {
    let j = i;
    let t = 0;
    while (j < items.length && (j === i || t + items[j].t <= budget)) { t += items[j].t; j++; }
    out.push({ start: items[i].n, end: items[j - 1].n, text: items.slice(i, j).map((x) => x.text).join('\n').trim() });
    if (j >= items.length) break;
    let k = j;
    let back = 0;
    while (k - 1 > i && back + items[k - 1].t <= overlap) { back += items[k - 1].t; k--; }
    i = k;
  }
  return out;
}

export function chunkNote({ text, title, maxTokens = MAX_CHUNK_TOKENS, overlap = OVERLAP_TOKENS }) {
  const src = String(text ?? '');
  const { end } = parseFrontmatter(src);
  const offset = src.slice(0, end).split('\n').length - 1;
  const lines = src.slice(end).split('\n');
  const name = String(title ?? '').trim();
  const sections = [];
  let path = [];
  let cur = { heading: name, lines: [], line: offset };
  let fenced = false;
  lines.forEach((line, i) => {
    const n = i + offset;
    if (FENCE.test(line.trim())) fenced = !fenced;
    const h = fenced ? null : line.match(HEADING);
    if (!h) { if (line.trim()) cur.lines.push({ n, text: line }); return; }
    sections.push(cur);
    const level = h[1].length;
    const label = h[2].trim();
    path = path.filter((p) => p.level < level);
    // a first-level heading that repeats the title adds nothing to the path
    if (!(level === 1 && label === name)) path.push({ level, label });
    cur = { heading: [name, ...path.map((p) => p.label)].filter(Boolean).join(' > '), lines: [], line: n };
  });
  sections.push(cur);
  const out = [];
  for (const s of sections) {
    if (!s.lines.length) continue;
    const budget = Math.max(16, maxTokens - tokensOf(s.heading) - 1);
    for (const w of windows(s.lines, budget, overlap)) {
      if (!w.text) continue;
      out.push({ heading: s.heading, start_line: w.start, end_line: w.end, text: w.text, hash: chunkHash(s.heading, w.text), tokens: tokensOf(s.heading) + 1 + tokensOf(w.text) });
    }
  }
  // a note with a title and no body still answers a search for its title
  if (!out.length && name) out.push({ heading: name, start_line: offset, end_line: offset, text: '', hash: chunkHash(name, ''), tokens: tokensOf(name) });
  return out;
}
