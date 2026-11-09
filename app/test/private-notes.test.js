// the Private notes section of the saved markdown: your text verbatim, None when you typed nothing
import { describe, expect, it } from 'vitest';
import { notesMarkdown } from '../notes.js';

const notes = { title: 'Standup', summary: 'Short.', sections: [], decisions: [], actions: [], questions: [] };
const section = (md) => md.split('\n## Summary')[0];

describe('private notes in the saved markdown', () => {
  it('keeps the text verbatim, lines, markdown and all', () => {
    const mine = '- ask about renewals\n  - and the Q3 number\n\n**Follow up** with Sam re: pricing, see [[Pricing review]]';
    expect(section(notesMarkdown(notes, { privateNotes: mine }))).toBe(`## Private notes\n${mine}\n`);
  });

  it('prints None when nothing was typed, or only whitespace', () => {
    expect(section(notesMarkdown(notes))).toBe('## Private notes\nNone\n');
    expect(section(notesMarkdown(notes, { privateNotes: '' }))).toBe('## Private notes\nNone\n');
    expect(section(notesMarkdown(notes, { privateNotes: '  \n\n' }))).toBe('## Private notes\nNone\n');
  });
});
