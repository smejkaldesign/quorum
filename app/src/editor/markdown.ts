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

// each top-level block on its own, the way the editor writes it; an empty paragraph writes nothing and is left out
const blocksOf = (doc: JSONContent) => (doc.content ?? []).map((n) => toMarkdown({ type: 'doc', content: [n] })).filter((b) => b !== '');

// the text cut into its top-level blocks as written, each with the blank space after it, and the space before the first
function rawBlocks(md: string) {
  let lead = '';
  const blocks: { text: string; after: string }[] = [];
  for (const t of markdownManager().instance.lexer(md)) {
    // some tokenizers (checklists) take the blank lines before them; those belong to the gap
    const [, before, text, after] = /^(\n*)([\s\S]*?)(\n*)$/.exec(t.raw)!;
    if (blocks.length) blocks[blocks.length - 1].after += before; else lead += before;
    if (t.type === 'space' || !text) { if (blocks.length) blocks[blocks.length - 1].after += text + after; else lead += text + after; continue; }
    blocks.push({ text, after });
  }
  return { lead, blocks };
}

let cached: { md: string; old: string[]; raw: ReturnType<typeof rawBlocks> } | null = null;
const baseOf = (md: string) => (cached?.md === md ? cached : (cached = { md, old: blocksOf(toDoc(md)), raw: rawBlocks(md) }));

// a note opens as rich text only when it survives the round trip and its written blocks line up one to one with the
// editor's, so a save can keep every block that wasn't edited exactly as written
export const canSplice = (md: string) => { const b = baseOf(md); return isLossless(md) && b.raw.blocks.length === b.old.length; };

// the edited document written over the text it was opened from: a block that matches one of the original blocks keeps
// that block's original text, and only new or edited blocks are written by the editor. The longest common run of
// blocks decides which survived. If the result would not read back as the edited document, the whole document is
// written instead
export function splice(base: string, doc: JSONContent): string {
  const next = blocksOf(doc);
  const { old, raw } = baseOf(base);
  if (raw.blocks.length !== old.length) return toMarkdown(doc);
  let a = 0;
  while (a < old.length && a < next.length && old[a] === next[a]) a++;
  let z = 0;
  while (z < old.length - a && z < next.length - a && old[old.length - 1 - z] === next[next.length - 1 - z]) z++;
  const n = old.length - a - z, m = next.length - a - z;
  const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = old[a + i] === next[a + j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  // each output block: the original block it keeps (at, its index) or -1 and the editor's text. src is the original
  // block whose place it takes: the block itself when kept, and for an edited block the original it replaced (the k-th
  // new block between two kept ones takes the place of the k-th dropped one there), -1 for one that is only added
  const out: { at: number; src: number; text: string }[] = [];
  for (let k = 0; k < a; k++) out.push({ at: k, src: k, text: raw.blocks[k].text });
  let i = 0, j = 0;
  let dropped: number[] = [], added: { at: number; src: number; text: string }[] = [];
  const pair = () => { added.forEach((b, k) => { b.src = dropped[k] ?? -1; }); dropped = []; added = []; };
  while (j < m) {
    if (i < n && old[a + i] === next[a + j]) { pair(); out.push({ at: a + i, src: a + i, text: raw.blocks[a + i].text }); i++; j++; }
    else if (i < n && L[i + 1][j] >= L[i][j + 1]) { dropped.push(a + i); i++; }
    else { const b = { at: -1, src: -1, text: next[a + j] }; added.push(b); out.push(b); j++; }
  }
  while (i < n) dropped.push(a + i++);
  pair();
  for (let k = old.length - z; k < old.length; k++) out.push({ at: k, src: k, text: raw.blocks[k].text });
  // two blocks in the places of blocks that were next to each other keep the space that was between them; any other
  // pair gets a blank line. If that doesn't read back as the edited document, the edited blocks get blank lines only
  const join = (keepEdited: boolean) => {
    let md = out.length ? raw.lead : '';
    out.forEach((b, k) => {
      md += b.text;
      const nb = out[k + 1];
      if (!nb) return;
      const src = b.at >= 0 || keepEdited ? b.src : -1;
      const after = src >= 0 ? raw.blocks[src].after : '';
      md += src >= 0 && nb.src === src + 1 ? after : /\n\n/.test(after) ? after : '\n\n';
    });
    return md;
  };
  const reads = (md: string) => { const same = blocksOf(toDoc(md)); return same.length === next.length && same.every((x, k) => x === next[k]); };
  const md = join(true);
  if (reads(md)) return md;
  const plain = join(false);
  return reads(plain) ? plain : toMarkdown(doc);
}

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
