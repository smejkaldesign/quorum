import { describe, expect, it } from 'vitest';
import { openSpeech, SPEECH_ENGINES } from '../speech/provider.js';

// an engine whose sessions record what they were fed and can be driven from the test
function fakeEngine({ fail = false } = {}) {
  const sessions = [];
  return {
    sessions,
    open(opts) {
      const s = { opts, fed: [], closed: false, ready: fail ? Promise.reject(new Error('engine down')) : Promise.resolve(), send: (pcm) => s.fed.push(pcm), close: () => { s.closed = true; } };
      s.ready.catch(() => {});
      sessions.push(s);
      return s;
    },
  };
}

describe('the speech provider contract', () => {
  it('names the engines with adapters', () => { expect(SPEECH_ENGINES).toEqual(['assemblyai', 'deepgram']); });
  it('opens one engine stream per channel with the key and terms, and routes audio by channel', async () => {
    const e = fakeEngine();
    const events = [];
    const s = openSpeech({ engine: 'x', key: 'k', terms: ['Quorum'], onEvent: (ev) => events.push(ev), engines: { x: e } });
    expect(await s.ready).toEqual({ engine: 'x', counted: false });
    expect(e.sessions.map((x) => x.opts.channel)).toEqual(['me', 'them']);
    expect(e.sessions[0].opts).toMatchObject({ key: 'k', sampleRate: 16000, terms: ['Quorum'], locale: 'en-US' });
    s.send('them', Buffer.from([1, 2]));
    expect(e.sessions[1].fed.length).toBe(1); expect(e.sessions[0].fed.length).toBe(0);
    e.sessions[0].opts.onEvent({ event: 'transcript', channel: 'me', text: 'hi', isFinal: true, start: 0, end: 1 });
    expect(events).toEqual([{ event: 'transcript', channel: 'me', text: 'hi', isFinal: true, start: 0, end: 1 }]);
    s.close();
    expect(e.sessions.every((x) => x.closed)).toBe(true); expect(s.open).toBe(false);
  });
  it('rejects ready when an engine refuses, and reports one close when a stream drops', async () => {
    await expect(openSpeech({ engine: 'x', key: 'k', engines: { x: fakeEngine({ fail: true }) } }).ready).rejects.toThrow('engine down');
    const e = fakeEngine(); const closes = [];
    const s = openSpeech({ engine: 'x', key: 'k', onClose: (c) => closes.push(c), engines: { x: e } });
    await s.ready;
    e.sessions[1].opts.onClose(1006);
    expect(closes.length).toBe(1); expect(closes[0].error.message).toMatch(/them stream/); expect(s.open).toBe(false);
    expect(() => openSpeech({ engine: 'x', engines: { x: e } })).toThrow(/needs a key/);
    expect(() => openSpeech({ engine: 'nope', key: 'k', engines: {} })).toThrow(/no speech engine/);
  });
});
