// How Markdown.tsx reads one line: a bullet, a heading or a paragraph, and the text inside it. noteDiff.ts reads lines
// the same way, so a line and its earlier wording are compared as they are shown.
export type MdLine = { kind: 'bullet' | 'heading' | 'text'; level: number; text: string };

export function mdLine(line: string): MdLine {
  const bullet = line.match(/^(\s*)[-*]\s+(.*)$/);
  if (bullet) return { kind: 'bullet', level: Math.floor(bullet[1].length / 2), text: bullet[2].replace(/^\[ \]\s*/, '☐ ').replace(/^\[x\]\s*/i, '☑ ') };
  const h = line.match(/^(#{1,4})\s+(.*)$/);
  if (h) return { kind: 'heading', level: h[1].length, text: h[2] };
  return { kind: 'text', level: 0, text: line.replace(/^#+\s*/, '') };
}

// bold, code, link, wiki link, image. Each is one piece: a comparison never splits one
export const inlineRe = () => /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|!?\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]|!\[([^\][]*)\]\(([^)\s]+)\)/g;
