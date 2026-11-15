// A name for a note saved without one: a 2 to 6 word title and a one-sentence summary. Pure: main.js makes the call.
import { UNTITLED } from './handnote.js';

export const NAME_SYSTEM = `You name a personal note from its text. Reply with exactly two lines:
Title: a 2 to 6 word title, plain and literal, no quotes, no trailing period
Summary: one short sentence saying what the note is about
If the text has no clear subject, name it from what it contains (for example "Checklist and scratch notes").`;

export const isUntitled = (t) => { const s = String(t ?? '').trim().toLowerCase(); return !s || s === 'untitled' || s === UNTITLED.toLowerCase(); };

export function parseName(text) {
  const title = String(text ?? '').match(/^\s*Title:\s*(.+)$/im)?.[1]?.replace(/^["'“]+|["'”.]+$/g, '').trim();
  if (!title || isUntitled(title)) return null;
  const summary = String(text).match(/^\s*Summary:\s*(.+)$/im)?.[1]?.trim() ?? '';
  return { title: title.slice(0, 80), summary: summary.slice(0, 240) };
}
