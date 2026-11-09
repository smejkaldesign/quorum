import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cleanHello, demux, pcmSeconds } from '../lib/frames.js';

describe('frame demux', () => {
  const channels = ['me', 'them'];
  it('splits the channel byte from the PCM', () => {
    const f = demux(Buffer.from([1, 10, 0, 20, 0]), channels);
    assert.equal(f.channel, 'them');
    assert.deepEqual([...f.pcm], [10, 0, 20, 0]);
  });
  it('drops a stray odd byte so no half sample reaches the engine', () => {
    const f = demux(Buffer.from([0, 1, 2, 3]), channels);
    assert.equal(f.channel, 'me');
    assert.equal(f.pcm.length, 2);
  });
  it('ignores unknown channels and frames with no samples', () => {
    assert.equal(demux(Buffer.from([2, 1, 2]), channels), null);
    assert.equal(demux(Buffer.from([0, 1]), channels), null);
    assert.equal(demux(Buffer.from([0]), channels), null);
  });
  it('counts seconds from bytes at the sample rate', () => assert.equal(pcmSeconds(32000, 16000), 1));
});

describe('hello', () => {
  it('fills defaults', () => {
    assert.deepEqual(cleanHello({ workspaceId: 'W' }), { token: null, workspaceId: 'W', meetingId: null, channels: ['me', 'them'], sampleRate: 16000, terms: [], locale: 'en-US' });
  });
  it('keeps two channels, up to 100 short terms, a known sample rate and a plain locale', () => {
    const h = cleanHello({ token: 't', workspaceId: 'W', meetingId: 7, channels: ['me', 'them', 'extra'], sampleRate: 48000, terms: ['Ana', 'Ana', ' Q3 ', 'x'.repeat(51), ''], locale: 'de-DE' });
    assert.equal(h.token, 't');
    assert.equal(h.meetingId, '7');
    assert.deepEqual(h.channels, ['me', 'them']);
    assert.equal(h.sampleRate, 48000);
    assert.deepEqual(h.terms, ['Ana', 'Q3']);
    assert.equal(h.locale, 'de-DE');
    assert.equal(cleanHello({ sampleRate: 11025, locale: 'nope!' }).sampleRate, 16000);
    assert.equal(cleanHello({ locale: 'nope!' }).locale, 'en-US');
  });
});
