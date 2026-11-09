import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import * as assemblyai from '../lib/engines/assemblyai.js';
import * as deepgram from '../lib/engines/deepgram.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));

describe('assemblyai results to helper events', () => {
  const f = fixture('assemblyai');
  it('maps a running turn to a partial with word times in seconds', () => {
    assert.deepEqual(assemblyai.mapMessage(f.partial, 'me'), { event: 'transcript', channel: 'me', text: 'we ship on friday', isFinal: false, start: 1.2, end: 2.3 });
  });
  it('skips the unformatted end of turn and finals on the formatted one', () => {
    assert.equal(assemblyai.mapMessage(f.endUnformatted, 'me'), null);
    assert.deepEqual(assemblyai.mapMessage(f.endFormatted, 'them'), { event: 'transcript', channel: 'them', text: 'We ship on Friday.', isFinal: true, start: 1.2, end: 2.3 });
  });
  it('finals on the unformatted end when formatting is off', () => {
    assert.equal(assemblyai.mapMessage(f.endUnformatted, 'me', { formatTurns: false }).isFinal, true);
  });
  it('ignores empty turns and control messages', () => {
    assert.equal(assemblyai.mapMessage(f.empty, 'me'), null);
    assert.equal(assemblyai.mapMessage(f.begin, 'me'), null);
    assert.equal(assemblyai.mapMessage(f.termination, 'me'), null);
  });
  it('builds the socket url with the sample rate, raw PCM, formatting and keyterms', () => {
    const u = new URL(assemblyai.url({ sampleRate: 16000, terms: ['Ana', 'Q3'] }));
    assert.equal(u.host, 'streaming.assemblyai.com');
    assert.equal(u.searchParams.get('sample_rate'), '16000');
    assert.equal(u.searchParams.get('encoding'), 'pcm_s16le');
    assert.equal(u.searchParams.get('format_turns'), 'true');
    assert.deepEqual(JSON.parse(u.searchParams.get('keyterms_prompt')), ['Ana', 'Q3']);
    assert.equal(new URL(assemblyai.url({ sampleRate: 16000, terms: [] })).searchParams.has('keyterms_prompt'), false);
  });
});

describe('deepgram results to helper events', () => {
  const f = fixture('deepgram');
  it('maps interim results to partials', () => {
    assert.deepEqual(deepgram.mapMessage(f.interim, 'them'), { event: 'transcript', channel: 'them', text: 'the budget is forty', isFinal: false, start: 3.26, end: 4.2 });
  });
  it('maps is_final with punctuated words to a final', () => {
    assert.deepEqual(deepgram.mapMessage(f.final, 'me'), { event: 'transcript', channel: 'me', text: 'The budget is $40,000.', isFinal: true, start: 3.26, end: 5.1 });
  });
  it('ignores silence, metadata and utterance ends', () => {
    assert.equal(deepgram.mapMessage(f.silence, 'me'), null);
    assert.equal(deepgram.mapMessage(f.metadata, 'me'), null);
    assert.equal(deepgram.mapMessage(f.utteranceEnd, 'me'), null);
    assert.equal(deepgram.mapMessage(f.error, 'me'), null);
  });
  it('builds the listen url with nova-3, linear16 mono, interim results and keyterms', () => {
    const u = new URL(deepgram.url({ sampleRate: 16000, terms: ['Ana', 'Q3'], locale: 'en-US' }));
    assert.equal(u.searchParams.get('model'), 'nova-3');
    assert.equal(u.searchParams.get('encoding'), 'linear16');
    assert.equal(u.searchParams.get('channels'), '1');
    assert.equal(u.searchParams.get('interim_results'), 'true');
    assert.deepEqual(u.searchParams.getAll('keyterm'), ['Ana', 'Q3']);
    assert.equal(u.searchParams.has('language'), false);
    assert.equal(new URL(deepgram.url({ sampleRate: 16000, terms: [], locale: 'de-DE' })).searchParams.get('language'), 'de');
  });
});
