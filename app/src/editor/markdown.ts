// Markdown in and out of the note editor. A note opens as rich text only when it survives a round trip unchanged
// (parse, then write back, gives the same bytes); anything else opens as plain text, so opening a note never reformats it.
import type { JSONContent } from '@tiptap/core';
import { MarkdownManager } from '@tiptap/markdown';
import { noteExtensions } from './extensions';

let shared: MarkdownManager | null = null;
export const markdownManager = () => (shared ??= new MarkdownManager({ extensions: noteExtensions() }));

export const toDoc = (md: string): JSONContent => markdownManager().parse(md);
export const toMarkdown = (doc: JSONContent): string => markdownManager().serialize(doc).replace(/\s+$/, '');
export const roundTrip = (md: string) => toMarkdown(toDoc(md));
export const isLossless = (md: string) => roundTrip(md) === md.replace(/\s+$/, '');

// which picker the text before the cursor opens: "[[query" anywhere in the line links a note; "/query" opens the
// block commands only when the slash starts the block or follows a space, so a path or a date like 1/2 types normally
export function pickerQuery(before: string): { kind: 'link' | 'slash'; query: string; typed: string } | null {
  const link = /\[\[([^\]\n[]*)$/.exec(before);
  if (link) return { kind: 'link', query: link[1], typed: `[[${link[1]}` };
  const slash = /(?:^|\s)\/(\w*)$/.exec(before);
  return slash ? { kind: 'slash', query: slash[1], typed: `/${slash[1]}` } : null;
}

// the top-level block where two versions of the note first differ, given each block's markdown in the current doc.
// Blocks are joined by a blank line; everything before the returned index is unchanged and keeps its place (and the
// cursor in it), everything from it on is replaced. Record only ever changes the end, so this is the last block or
// the end of the doc
export function firstChangedBlock(blocks: string[], before: string, after: string): { index: number; offset: number } {
  let p = 0;
  const max = Math.min(before.length, after.length);
  while (p < max && before[p] === after[p]) p++;
  let offset = 0;
  for (let i = 0; i < blocks.length; i++) {
    const end = offset + blocks[i].length;
    // the block is untouched only when the shared prefix covers it and the blank line after it (the last block of the
    // old text has none, so the new text must start its next block there)
    const kept = p >= end && (p >= end + 2 || (end === before.length && after.slice(end, end + 2) === '\n\n'));
    if (!kept) return { index: i, offset };
    offset = end + 2;
  }
  return { index: blocks.length, offset: Math.min(offset, after.length) };
}
