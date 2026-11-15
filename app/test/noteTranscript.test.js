import { describe, expect, it } from 'vitest';
import { parseSummary, parseTurns, splitNote, withSummary } from '../noteTranscript.js';

describe('a note split into summary and transcript', () => {
  it('reads turns, with plain paragraphs joining the turn before', () => {
    const t = parseTurns('**You:** That is here.\n\n**Unknown:** Got it.\n\nand more words\n\n**Ada:** Hi');
    expect(t.map((x) => [x.who, x.text])).toEqual([['You', 'That is here.'], ['Unknown', 'Got it.\n\nand more words'], ['Ada', 'Hi']]);
  });
  it('splits at a Transcript heading', () => {
    expect(splitNote('A short summary.\n\n## Transcript\n\n**You:** hi')).toEqual({ summary: 'A short summary.', transcript: '**You:** hi' });
  });
  it('treats a recorded note made of turns as all transcript, and anything else as summary', () => {
    expect(splitNote('**You:** one\n\n**You:** two\n\n**Ada:** three', { recorded: true })).toEqual({ summary: '', transcript: '**You:** one\n\n**You:** two\n\n**Ada:** three' });
    expect(splitNote('**You:** one\n\nMy own notes here\n\nMore notes', { recorded: true }).transcript).toBeNull();
    expect(splitNote('**You:** one', { recorded: false }).transcript).toBeNull();
  });
  it('keeps the transcript under its heading after a summary is written', () => {
    const body = withSummary('Summary text', '**You:** hi');
    expect(splitNote(body)).toEqual({ summary: 'Summary text', transcript: '**You:** hi' });
  });
  it('reads the model reply into a title and a body', () => {
    expect(parseSummary('Title: "Tiger talk"\n\nThey talked about tigers.')).toEqual({ title: 'Tiger talk', body: 'They talked about tigers.' });
    expect(parseSummary('Just a body')).toEqual({ title: null, body: 'Just a body' });
    expect(parseSummary('')).toBeNull();
  });
});
