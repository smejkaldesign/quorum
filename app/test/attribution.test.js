// Record with Screen on: who said each paragraph, from timed turns and the call app's timed speaker reads
import { describe, expect, it } from 'vitest';
import { labelFor, othersIn, speakerLabels, timedTurn } from '../src/attribution.ts';

const turn = (id, channel, startMs, endMs, extra = {}) => ({ id, channel, startMs, endMs, ...extra });

describe('speaker labels', () => {
  it('labels the microphone You, always', () => {
    expect(speakerLabels([turn(1, 'me', 0, 1000)], [{ at: 500, names: ['Ada'], active: ['Ada'] }])).toEqual({ 1: 'You' });
  });

  it('names a turn after the speaker the call app showed while it was said', () => {
    const reads = [
      { at: 1000, names: ['Ada Lovelace', 'Grace Hopper'], active: ['Ada Lovelace'] },
      { at: 3000, names: ['Ada Lovelace', 'Grace Hopper'], active: ['Ada Lovelace'] },
      { at: 9000, names: ['Ada Lovelace', 'Grace Hopper'], active: ['Grace Hopper'] },
    ];
    expect(speakerLabels([turn(1, 'them', 500, 3500), turn(2, 'them', 8500, 9500)], reads, { slack: 500 })).toEqual({ 1: 'Ada Lovelace', 2: 'Grace Hopper' });
  });

  it('takes the name shown most often inside the turn', () => {
    const reads = [{ at: 100, names: [], active: ['Grace'] }, { at: 200, names: [], active: ['Ada'] }, { at: 300, names: [], active: ['Ada'] }];
    expect(speakerLabels([turn(1, 'them', 0, 400)], reads, { slack: 0 })).toEqual({ 1: 'Ada' });
  });

  it('never picks your own tile', () => {
    const reads = [{ at: 100, names: ['Sam Rivera (me)', 'Ada'], active: ['Sam Rivera (me)'] }];
    expect(speakerLabels([turn(1, 'them', 0, 200)], reads, { slack: 0 })).toEqual({ 1: 'Ada' });
    const named = [{ at: 100, names: ['Sam Rivera', 'Ada', 'Grace'], active: ['Sam Rivera'] }];
    expect(speakerLabels([turn(1, 'them', 0, 200)], named, { self: ['sam rivera'], slack: 0 })).toEqual({ 1: 'Speaker 1' });
  });

  it('uses the one other person when nobody is shown speaking', () => {
    const reads = [{ at: 100, names: ['You', 'Ada Lovelace'], active: [] }];
    expect(speakerLabels([turn(1, 'them', 5000, 6000)], reads)).toEqual({ 1: 'Ada Lovelace' });
  });

  it('numbers unknown speakers by diarization cluster in the order they first speak, else one per channel', () => {
    const turns = [turn(3, 'them', 3000, 4000, { cluster: 'b' }), turn(1, 'them', 0, 1000, { cluster: 'a' }), turn(2, 'them', 1500, 2000, { cluster: 'b' }), turn(4, 'them', 5000, 6000, { cluster: 'a' })];
    expect(speakerLabels(turns, [])).toEqual({ 1: 'Speaker 1', 2: 'Speaker 2', 3: 'Speaker 2', 4: 'Speaker 1' });
    expect(speakerLabels([turn(1, 'them', 0, 1), turn(2, 'them', 2, 3)], [])).toEqual({ 1: 'Speaker 1', 2: 'Speaker 1' });
  });

  it('keeps a name the speaker pass already gave the turn', () => {
    expect(speakerLabels([turn(1, 'them', 0, 1, { speaker: 'Grace' })], [{ at: 0, names: [], active: ['Ada'] }])).toEqual({ 1: 'Grace' });
  });

  it('places a final turn on the wall clock from its length and arrival', () => {
    expect(timedTurn({ id: 7, channel: 'them', start: 10, end: 12.5 }, 100000)).toEqual({ id: 7, channel: 'them', startMs: 97500, endMs: 100000, cluster: null, speaker: null });
  });
  it('labels one incoming turn from the reads in its own window only', () => {
    const reads = [{ at: 1000, names: ['Ada', 'Grace'], active: ['Ada'] }, { at: 50000, names: ['Ada', 'Grace'], active: ['Grace'] }];
    const prior = [turn(1, 'them', 0, 1500, { cluster: 'a' })];
    expect(labelFor(turn(2, 'them', 49000, 50500), prior, reads, othersIn(reads), { slack: 500 })).toBe('Grace');
    expect(labelFor(turn(3, 'them', 20000, 21000, { cluster: 'b' }), prior, [], new Set())).toBe('Speaker 2');
    expect(labelFor(turn(4, 'them', 20000, 21000, { cluster: 'a' }), prior, [], new Set())).toBe('Speaker 1');
  });
});
