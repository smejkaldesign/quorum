// New note and Record: the note text the main process writes, and what Record appends into an open note
import { describe, expect, it } from 'vitest';
import { cleanTitle, hashText, newNoteText, noteFileName, rewriteNote, splitNote, UNTITLED } from '../handnote.js';
import { appendScreen, appendTurn, canStart, recordChoices, screenBlock } from '../src/noteRecord.ts';

describe('a note written in the app', () => {
  const fresh = newNoteText({ id: '2026-11-13T10-00-00-000Z', title: 'Pricing ideas', body: 'First line\n\n- a bullet\n', date: '2026-11-13T10:00:00.000-08:00', owner: 'Ada' });

  it('gets the frontmatter shape of a recorded solo note', () => {
    expect(fresh).toBe([
      '---', 'quorum_id: 2026-11-13T10-00-00-000Z', 'type: note', 'title: "Pricing ideas"', 'date: 2026-11-13T10:00:00.000-08:00',
      'participants:', '  - Ada (recorder)', 'participant_count: 1', 'source: quorum', '---', '', '# Pricing ideas', '', 'First line\n\n- a bullet', '',
    ].join('\n'));
  });

  it('reads back the title and body it was written with', () => {
    const n = splitNote(fresh);
    expect(n.title).toBe('Pricing ideas');
    expect(n.body).toBe('First line\n\n- a bullet');
    expect(n.heading).toBe(true);
  });

  it('is named like a recorded note, with Untitled note for an empty title', () => {
    expect(noteFileName({ date: '2026-11-13', title: 'Pricing ideas!', id: 'x2026abcd' })).toBe('2026-11-13-pricing-ideas-2026abcd.md');
    expect(noteFileName({ date: '2026-11-13', title: '  ', id: 'abcdefgh12345678' })).toBe('2026-11-13-untitled-note-12345678.md');
    expect(cleanTitle('')).toBe(UNTITLED);
  });

  it('keeps every other frontmatter line when the title and body change', () => {
    const raw = '---\ntitle: "Standup"\ndate: 2026-11-01\nparticipants:\n  - Ada (recorder)\nsource: granola\n---\n\n# Standup\n\n## Summary\nOld text\n';
    const next = rewriteNote(raw, { title: 'Standup, Monday', body: '## Summary\nOld text\n\nMore from Record' });
    expect(next).toBe('---\ntitle: "Standup, Monday"\ndate: 2026-11-01\nparticipants:\n  - Ada (recorder)\nsource: granola\n---\n\n# Standup, Monday\n\n## Summary\nOld text\n\nMore from Record\n');
    expect(splitNote(next).title).toBe('Standup, Monday');
  });

  it('leaves a note without a heading without one, and adds a title line to frontmatter that lacked it', () => {
    const raw = '---\ndate: 2026-11-01\n---\nJust text\n';
    expect(rewriteNote(raw, { title: 'Named', body: 'Just text' })).toBe('---\ndate: 2026-11-01\ntitle: "Named"\n---\n\nJust text\n');
  });

  it('hashes text so a save can tell the file changed underneath it', () => {
    expect(hashText('a')).toBe(hashText('a'));
    expect(hashText('a')).not.toBe(hashText('b'));
  });
});

describe('Record choices', () => {
  it('defaults to transcription alone, and offers Screen only when it is allowed', () => {
    expect(recordChoices(true)).toEqual({ audio: true, screen: false });
    expect(recordChoices(true, { screen: true })).toEqual({ audio: true, screen: true });
    expect(recordChoices(false, { screen: true })).toEqual({ audio: true, screen: false });
  });

  it('needs at least one of the two to start', () => {
    expect(canStart({ audio: false, screen: false })).toBe(false);
    expect(canStart({ audio: false, screen: true })).toBe(true);
  });
});

describe('what Record appends to the note', () => {
  it('adds each final turn as a paragraph at the end of the note', () => {
    let r = appendTurn('My notes', null, { id: 1, channel: 'me', text: 'Call the bank' });
    expect(r.body).toBe('My notes\n\nCall the bank');
    r = appendTurn(r.body, r.last, { id: 2, channel: 'them', text: 'Sure, Tuesday works' });
    expect(r.body).toBe('My notes\n\nCall the bank\n\n**Others:** Sure, Tuesday works');
  });

  it('starts an empty note without blank lines', () => {
    expect(appendTurn('', null, { id: 1, channel: 'me', text: 'Hello' }).body).toBe('Hello');
  });

  it('rewrites the last paragraph when its turn grows', () => {
    let r = appendTurn('', null, { id: 1, channel: 'me', text: 'Call the' });
    r = appendTurn(r.body, r.last, { id: 1, channel: 'me', text: 'Call the bank today', replace: true });
    expect(r.body).toBe('Call the bank today');
    r = appendTurn(r.body, r.last, { id: 1, channel: 'me', text: 'Call the bank today at noon', replace: true });
    expect(r.body).toBe('Call the bank today at noon');
  });

  it('adds only the gained words once something follows the turn', () => {
    let r = appendTurn('', null, { id: 1, channel: 'me', text: 'Call the' });
    const typed = `${r.body}\n\nmy own line`;
    r = appendTurn(typed, r.last, { id: 1, channel: 'me', text: 'Call the bank', replace: true });
    expect(r.body).toBe('Call the\n\nmy own line\n\nbank');
    r = appendTurn(r.body, r.last, { id: 1, channel: 'me', text: 'Call the bank today', replace: true });
    expect(r.body).toBe('Call the\n\nmy own line\n\nbank today');
  });

  it('ignores a grown turn it never wrote, and empty text', () => {
    expect(appendTurn('x', null, { id: 9, channel: 'me', text: 'late', replace: true }).body).toBe('x');
    expect(appendTurn('x', null, { id: 9, channel: 'me', text: '  ' }).body).toBe('x');
  });

  it('writes a screen read as a folded callout naming the window, capped in length', () => {
    const at = new Date(2026, 10, 13, 10, 42).getTime();
    const block = screenBlock({ app: 'Figma', title: 'Homepage', text: 'Hero\n\n  Pricing table  \n', at });
    expect(block.split('\n')[0]).toMatch(/^> \[!info\]- Screen at .*10:42.*, Figma: Homepage$/);
    expect(block.split('\n').slice(1)).toEqual(['> Hero', '> Pricing table']);
    const long = screenBlock({ text: Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n'), at });
    expect(long.split('\n')).toHaveLength(32);
    expect(long.endsWith('> …')).toBe(true);
    expect(appendScreen('Notes', { text: ' ', at })).toBe('Notes');
    expect(appendScreen('Notes', { text: 'Hi', at })).toMatch(/^Notes\n\n> \[!info\]- Screen at/);
  });
});
