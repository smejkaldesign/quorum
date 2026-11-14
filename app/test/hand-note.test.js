// New note and Record: the note text the main process writes, and what Record appends into an open note
import { describe, expect, it } from 'vitest';
import { cleanTitle, hashText, newNoteText, noteFileName, rewriteNote, screenRead, splitNote, UNTITLED, yamlStr, yamlValue } from '../handnote.js';
import { appendTurn, canStart, emptyWritten, newWords, recordChoices } from '../src/noteRecord.ts';
import { CALL_ACTIVE, LISTEN_OFF, recordDecision } from '../notetaker.js';

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
  const run = (body, turns) => turns.reduce((r, t) => appendTurn(r.body, r.written, t), { body, written: emptyWritten() });

  it('adds each final turn as a paragraph at the end, labeled You or Speaker 1 without a name', () => {
    const r = run('My notes', [{ id: 1, channel: 'me', text: 'Call the bank' }, { id: 2, channel: 'them', text: 'Sure, Tuesday works' }]);
    expect(r.body).toBe('My notes\n\n**You:** Call the bank\n\n**Speaker 1:** Sure, Tuesday works');
  });

  it('starts an empty note without blank lines', () => {
    expect(run('', [{ id: 1, channel: 'me', text: 'Hello' }]).body).toBe('**You:** Hello');
  });

  it('rewrites the last paragraph when its turn grows', () => {
    const r = run('', [{ id: 1, channel: 'me', text: 'Call the' }, { id: 1, channel: 'me', text: 'Call the bank today', replace: true }, { id: 1, channel: 'me', text: 'Call the bank today at noon', replace: true }]);
    expect(r.body).toBe('**You:** Call the bank today at noon');
  });

  it('adds only the gained words once something follows the turn', () => {
    let r = run('', [{ id: 1, channel: 'me', text: 'Call the' }]);
    r = appendTurn(`${r.body}\n\nmy own line`, r.written, { id: 1, channel: 'me', text: 'Call the bank', replace: true });
    expect(r.body).toBe('**You:** Call the\n\nmy own line\n\nbank');
    r = appendTurn(r.body, r.written, { id: 1, channel: 'me', text: 'Call the bank today', replace: true });
    expect(r.body).toBe('**You:** Call the\n\nmy own line\n\nbank today');
  });

  it('keeps the new words of a cleanup rewrite that does not extend the earlier text', () => {
    expect(newWords('**You:** um so call the bank', '**You:** So, call the bank today.')).toBe('today.');
    let r = run('', [{ id: 1, channel: 'me', text: 'um so call the bank' }, { id: 2, channel: 'them', text: 'Okay' }]);
    r = appendTurn(r.body, r.written, { id: 1, channel: 'me', text: 'So, call the bank today.', replace: true });
    expect(r.body).toBe('**You:** um so call the bank\n\n**Speaker 1:** Okay\n\ntoday.');
    // and a grown tail that was itself rewritten keeps its words too
    r = run('', [{ id: 1, channel: 'me', text: 'call the' }]);
    r = appendTurn(`${r.body}\n\nmine`, r.written, { id: 1, channel: 'me', text: 'call the bank', replace: true });
    r = appendTurn(r.body, r.written, { id: 1, channel: 'me', text: 'Call the bank, then email Sam', replace: true });
    expect(r.body).toBe('**You:** call the\n\nmine\n\nbank then email Sam');
  });

  it('rewrites the whole paragraph while it is still last, cleanup included', () => {
    const r = run('', [{ id: 1, channel: 'me', text: 'um so call the bank' }, { id: 1, channel: 'me', text: 'So, call the bank.', replace: true }]);
    expect(r.body).toBe('**You:** So, call the bank.');
  });

  it('writes a grown turn it never saw in full, and ignores empty text', () => {
    expect(run('x', [{ id: 9, channel: 'me', text: 'late words', replace: true }]).body).toBe('x\n\n**You:** late words');
    expect(run('x', [{ id: 9, channel: 'me', text: '  ' }]).body).toBe('x');
    expect(run('x', [{ id: 1, channel: 'me', text: 'same' }, { id: 1, channel: 'me', text: 'same', replace: true }]).body).toBe('x\n\n**You:** same');
  });

  it('uses the label attribution gave the turn', () => {
    expect(run('', [{ id: 1, channel: 'them', text: 'Hi', label: 'Ada Lovelace' }]).body).toBe('**Ada Lovelace:** Hi');
    // a later read that names the speaker relabels the paragraph while it is still last
    const r = run('', [{ id: 1, channel: 'them', text: 'Hi' }, { id: 1, channel: 'them', text: 'Hi there', replace: true, label: 'Ada Lovelace' }]);
    expect(r.body).toBe('**Ada Lovelace:** Hi there');
  });
});

describe('a screen read from the helper', () => {
  it('turns Screen off on a missing permission, skips empty and repeated reads, and sends the rest', () => {
    expect(screenRead({ granted: false, text: 'x' }, null)).toEqual({ action: 'denied' });
    expect(screenRead({ granted: true, text: '  ' }, null)).toEqual({ action: 'skip' });
    const first = screenRead({ granted: true, app: 'Figma', title: 'Home', text: 'Hero' }, null);
    expect(first.action).toBe('send');
    expect(first.event).toEqual({ app: 'Figma', title: 'Home', text: 'Hero' });
    expect(screenRead({ app: 'Figma', title: 'Home', text: 'Hero' }, first.key)).toEqual({ action: 'skip' });
    // the same text in another window is new
    expect(screenRead({ app: 'Figma', title: 'Pricing', text: 'Hero' }, first.key).action).toBe('send');
    // Quorum's own window is never kept, whatever the helper sent
    expect(screenRead({ app: 'Quorum', title: 'Untitled', text: 'My note' }, null)).toEqual({ action: 'skip' });
    expect(screenRead({ app: 'Quorum Dev', title: '', text: 'x' }, null)).toEqual({ action: 'skip' });
    expect(screenRead({ app: 'Quorumly', title: '', text: 'x' }, null).action).toBe('send');
  });
});

describe('Record and a call', () => {
  const g = { manualListen: true, meetingCapture: true };
  it('refuses while a noticed call is active, and when listening is off', () => {
    expect(recordDecision(g, { meetingActive: true })).toEqual({ ok: false, error: CALL_ACTIVE });
    expect(recordDecision({ ...g, manualListen: false }, { meetingActive: false })).toEqual({ ok: false, error: LISTEN_OFF });
  });
  it('allows a solo note when no call is noticed', () => {
    expect(recordDecision(g, { meetingActive: false })).toEqual({ ok: true });
    expect(recordDecision({ ...g, meetingCapture: false }, { meetingActive: true })).toEqual({ ok: true });
  });
});

describe('frontmatter titles', () => {
  it('reads back exactly what it writes, backslashes and quotes included, with line breaks folded to spaces', () => {
    for (const t of ['Plain', 'Say "hi"', 'C:\\Users\\ada', 'a \\"tricky\\" one', 'colon: here', "it's #1"]) {
      const raw = newNoteText({ id: 'x', title: t, body: '', date: 'd', owner: 'Ada' });
      expect(yamlValue(yamlStr(t))).toBe(t);
      expect(splitNote(raw).title).toBe(t);
      expect(splitNote(rewriteNote(raw, { title: t, body: 'b' })).title).toBe(t);
    }
    expect(splitNote(newNoteText({ id: 'x', title: 'two\nlines', body: '', date: 'd', owner: 'Ada' })).title).toBe('two lines');
  });
  it('reads single-quoted and plain titles written by other apps', () => {
    expect(splitNote("---\ntitle: 'It''s here'\n---\nx").title).toBe("It's here");
    expect(splitNote('---\ntitle: Plain words\n---\nx').title).toBe('Plain words');
  });
  it('keeps $ patterns in a title literal', () => {
    expect(rewriteNote('---\ntitle: "a"\n---\n\n# a\n\nbody\n', { title: 'Cost $& $1', body: 'body' })).toContain('title: "Cost $& $1"');
  });
});
