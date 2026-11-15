import { describe, expect, it } from 'vitest';
import { joinParts, noteParts } from '../noteParts.js';

describe('noteParts', () => {
  it('splits a recorded note at its Summary heading, keeping later sections in the summary', () => {
    const body = '## Private notes\nask about budget\n\nfollow up Friday\n\n## Summary\nWe agreed on scope.\n\n## Decisions\n- Ship Monday';
    expect(noteParts(body, false)).toEqual({ note: 'ask about budget\n\nfollow up Friday', summary: 'We agreed on scope.\n\n## Decisions\n- Ship Monday', split: true });
  });
  it('reads None as an empty note', () => {
    expect(noteParts('## Private notes\nNone\n\n## Summary\nShort call.', false)).toEqual({ note: '', summary: 'Short call.', split: true });
  });
  it('keeps a summary with no subheadings out of the note', () => {
    expect(noteParts('## Private notes\nmine\n\n## Summary\nOne paragraph.', false).note).toBe('mine');
  });
  it('gives a hand note to Note and an imported note to Summary', () => {
    expect(noteParts('just my text', true)).toEqual({ note: 'just my text', summary: '', split: false });
    expect(noteParts('notetaker text', false)).toEqual({ note: '', summary: 'notetaker text', split: false });
  });
});

describe('joinParts', () => {
  it('writes a split note back with both headings', () => {
    expect(joinParts('mine', 'theirs', { split: true })).toBe('## Private notes\nmine\n\n## Summary\ntheirs');
    expect(joinParts('', 'theirs', { split: true })).toBe('## Private notes\nNone\n\n## Summary\ntheirs');
  });
  it('round-trips a recorded note unchanged in meaning', () => {
    const body = '## Private notes\nmine\n\n## Summary\nWe agreed.\n\n## Decisions\n- Ship';
    const p = noteParts(body, false);
    expect(noteParts(joinParts(p.note, p.summary, p), false)).toEqual(p);
  });
  it('keeps a single part bare', () => {
    expect(joinParts('only mine', '', { split: false })).toBe('only mine');
  });
});
