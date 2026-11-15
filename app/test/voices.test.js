import { describe, expect, it } from 'vitest';
import { mapMessage, url } from '../speech/engines/deepgram.js';
import { addFinal, toJSON } from '../transcript.js';
import { speakerOf } from '../speakers.js';

describe('voices told apart', () => {
  it('asks Deepgram to tell voices apart and labels a result with the voice most of its words have', () => {
    expect(new URL(url({ sampleRate: 16000, terms: [] })).searchParams.get('diarize')).toBe('true');
    const msg = { type: 'Results', is_final: true, channel: { alternatives: [{ transcript: 'hi there you', words: [{ start: 0, end: 0.2, speaker: 1 }, { start: 0.2, end: 0.4, speaker: 1 }, { start: 0.4, end: 0.6, speaker: 0 }] }] } };
    expect(mapMessage(msg, 'me')).toMatchObject({ text: 'hi there you', voice: 1 });
    const plain = { type: 'Results', is_final: true, channel: { alternatives: [{ transcript: 'hi', words: [{ start: 0, end: 0.2 }] }] } };
    expect(mapMessage(plain, 'me')).not.toHaveProperty('voice');
  });
  it('never joins two voices into one turn', () => {
    let t = addFinal([], { channel: 'me', text: 'Hello there', start: 0, end: 1, at: 0, voice: 0 }).turns;
    t = addFinal(t, { channel: 'me', text: 'Hi back', start: 1.2, end: 2, at: 1, voice: 1 }).turns;
    expect(t).toHaveLength(2);
    t = addFinal(t, { channel: 'me', text: 'and more', start: 2.1, end: 3, at: 2, voice: 1 }).turns;
    expect(t).toHaveLength(2);
    expect(toJSON(t).map((x) => x.voice)).toEqual([0, 1]);
  });
  it('names an unnamed voice Person N on the microphone and Speaker N on the Mac sound', () => {
    const label = { me: 'Unknown', them: 'Others' };
    expect(speakerOf({ channel: 'me', voice: 1 }, label)).toBe('Person 2');
    expect(speakerOf({ channel: 'them', voice: 0 }, label)).toBe('Speaker 1');
    expect(speakerOf({ channel: 'me', voice: 1, speaker: 'Ada' }, label)).toBe('Ada');
    expect(speakerOf({ channel: 'me' }, label)).toBe('Unknown');
  });
});
