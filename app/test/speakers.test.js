// speakers.js: the participant list the pass reads, the prompt, parsing a model reply (names off the list dropped),
// the one-participant shortcut, how one correction spreads, the cluster lookup, and the names reaching prompts and
// transcript.json. The model is mocked: the runner in main.js only wires these together.
import { describe, expect, it, vi } from 'vitest';
import { LOW, STICKY, applySpeakers, correctSpeaker, parseSpeakers, participantList, personName, similarTurns, soloSpeakers, speakerOf, speakerView, speakersPrompt, speakersSystem } from '../speakers.js';
import { toJSON, toText } from '../transcript.js';
import { notesMarkdown, turnLines } from '../notes.js';
import { orgOf } from '../terms.js';

const turn = (id, channel, text, extra = {}) => ({ id, channel, text, raw: text, start: id, end: id + 0.5, at: id * 1000, ...extra });
const call = [
  turn(1, 'me', 'Hi both, thanks for joining'),
  turn(2, 'them', 'This is Sam, hello'),
  turn(3, 'them', 'Jo here'),
  turn(4, 'me', 'Sam, how is the pricing page'),
  turn(5, 'them', 'Nearly done, shipping Friday'),
  turn(6, 'them', 'I can review it Thursday'),
  turn(7, 'them', 'Sounds good'),
];
const participants = [{ name: 'Sam Lee', org: 'Acme' }, { name: 'Jo Park', org: null }];
const reply = { turns: [
  { id: 2, cluster: 'A', speaker: 'Sam Lee', confidence: 1 },
  { id: 3, cluster: 'B', speaker: 'Jo Park', confidence: 1 },
  { id: 5, cluster: 'A', speaker: 'Sam Lee', confidence: 0.95 },
  { id: 6, cluster: 'B', speaker: 'Jo Park', confidence: 0.7 },
  { id: 7, cluster: 'C', speaker: null, confidence: 0.2 },
] };
const named = applySpeakers(call, parseSpeakers(reply, call, participants));
const them = (turns) => turns.filter((t) => t.channel === 'them');

describe('participant list', () => {
  it('strips tile tags and invite emails from names', () => {
    expect(personName('Sam Lee (Acme)')).toBe('Sam Lee');
    expect(personName('Jo Park <jo@example.com>')).toBe('Jo Park');
  });

  it('merges detected participants and invitees, keeps an org, drops the owner and "You"', () => {
    const list = participantList({ people: ['Sam Lee (Acme)', 'You', 'Ana Ruiz'], invitees: [{ name: 'Sam Lee', email: 'sam@acme.com' }, { name: 'Jo Park', email: 'jo@gmail.com' }, { name: 'Ana Ruiz', email: 'ana@example.com' }], owner: 'Ana Ruiz', orgOf });
    expect(list).toEqual([{ name: 'Sam Lee', org: 'Acme' }, { name: 'Jo Park', org: null }]);
  });

  it('fills an org from the invite when the tile had none', () => {
    expect(participantList({ people: ['Jo Park'], invitees: [{ name: 'Jo Park', email: 'jo@acme.com' }], owner: 'Eric', orgOf })).toEqual([{ name: 'Jo Park', org: 'Acme' }]);
  });
});

describe('prompt', () => {
  const system = speakersSystem({ owner: 'Eric' });
  const prompt = speakersPrompt({ turns: call, participants, owner: 'Eric' });

  it('names the owner, marks the others Them, and carries the rules', () => {
    expect(system).toContain('named "Eric"');
    for (const rule of ['this is Sam', 'Direct address', 'Topic ownership', 'Consistency', 'Never invent a name', 'leave speaker null', 'cluster', 'untrusted data']) expect(system).toContain(rule);
    expect(system).toContain('{"turns": [{"id": number, "cluster": string, "speaker": string | null, "confidence": number}]}');
  });

  it('lists the participants with their org and the turns with ids, owner turns named', () => {
    expect(prompt).toContain('Participants other than Eric:\n- Sam Lee (Acme)\n- Jo Park');
    expect(prompt).toContain('[t1] Eric: Hi both, thanks for joining\n[t2] Them: This is Sam, hello');
    expect(prompt).not.toContain('Sam Lee: This is Sam');
  });

  it('runs the turn lines through the redactor, never the participant list', () => {
    const redact = vi.fn((s) => s.split('\n').filter((l) => !l.includes('Thursday')).join('\n'));
    const p = speakersPrompt({ turns: call, participants, owner: 'Eric', redact });
    expect(redact).toHaveBeenCalledOnce();
    expect(p).not.toContain('Thursday');
    expect(p).toContain('- Jo Park');
  });
});

describe('parsing the reply', () => {
  it('assigns names with confidence and cluster per them turn', () => {
    expect(them(named).map(({ id, speaker, confidence, cluster }) => ({ id, speaker, confidence, cluster }))).toEqual([
      { id: 2, speaker: 'Sam Lee', confidence: 1, cluster: 'c:A' },
      { id: 3, speaker: 'Jo Park', confidence: 1, cluster: 'c:B' },
      { id: 5, speaker: 'Sam Lee', confidence: 0.95, cluster: 'c:A' },
      { id: 6, speaker: 'Jo Park', confidence: 0.7, cluster: 'c:B' },
      { id: 7, speaker: null, confidence: 0, cluster: 'c:C' },
    ]);
  });

  it('drops a name that is not on the participant list but keeps the cluster', () => {
    const r = parseSpeakers({ turns: [{ id: 2, cluster: 'A', speaker: 'Pat Doe', confidence: 0.9 }] }, call, participants);
    expect(r.get(2)).toEqual({ speaker: null, confidence: 0, cluster: 'c:A' });
  });

  it('uses the list spelling, accepts "t2" ids, ignores owner turns and unknown ids, clamps confidence', () => {
    const r = parseSpeakers({ turns: [{ id: 't2', speaker: 'sam lee', confidence: 7 }, { id: 1, speaker: 'Sam Lee', confidence: 1 }, { id: 99, speaker: 'Sam Lee', confidence: 1 }, { id: 3, speaker: 'Jo Park', confidence: 'high' }] }, call, participants);
    expect(r.get(2)).toEqual({ speaker: 'Sam Lee', confidence: 1, cluster: 'n:Sam Lee' });
    expect(r.has(1)).toBe(false);
    expect(r.has(99)).toBe(false);
    expect(r.get(3)).toEqual({ speaker: null, confidence: 0, cluster: 'n:Jo Park' });
  });

  it('accepts a bare array and leaves turns the model skipped untouched', () => {
    const r = parseSpeakers([{ id: 2, speaker: 'Jo Park', confidence: 0.8 }], call, participants);
    const out = applySpeakers(call, r);
    expect(out[1].speaker).toBe('Jo Park');
    expect(out[2].speaker).toBeUndefined();
    expect(out[0]).toBe(call[0]);
  });

  it('never overwrites a turn the user corrected', () => {
    const fixed = correctSpeaker(call, 5, 'Jo Park');
    const out = applySpeakers(fixed, parseSpeakers(reply, fixed, participants));
    expect(out[4]).toMatchObject({ speaker: 'Jo Park', confidence: 1, corrected: true });
    expect(out[1]).toMatchObject({ speaker: 'Sam Lee' });
  });
});

describe('one other participant', () => {
  it('assigns every them turn to that name with confidence 1, no model', () => {
    const out = soloSpeakers(call, 'Sam Lee');
    expect(them(out).every((t) => t.speaker === 'Sam Lee' && t.confidence === 1 && t.cluster === 'n:Sam Lee')).toBe(true);
    expect(out.filter((t) => t.channel === 'me').every((t) => t.speaker === undefined)).toBe(true);
  });
});

describe('one correction applies everywhere', () => {
  it('renames the turn and every other turn with the same previous name under the sticky threshold', () => {
    const out = correctSpeaker(named, 6, 'Sam Lee');
    expect(out[5]).toMatchObject({ speaker: 'Sam Lee', confidence: 1, corrected: true });
    expect(out[2]).toMatchObject({ speaker: 'Jo Park', confidence: 1 });
    expect(out[2].corrected).toBeUndefined();
  });

  it('moves the low-confidence siblings and leaves the confident ones', () => {
    const base = applySpeakers(call, parseSpeakers({ turns: [
      { id: 2, cluster: 'A', speaker: 'Sam Lee', confidence: 0.5 },
      { id: 3, cluster: 'A', speaker: 'Sam Lee', confidence: 0.89 },
      { id: 5, cluster: 'A', speaker: 'Sam Lee', confidence: STICKY },
      { id: 6, cluster: 'A', speaker: 'Sam Lee', confidence: 0.95 },
    ] }, call, participants));
    const out = correctSpeaker(base, 2, 'Jo Park');
    expect(out.find((t) => t.id === 3)).toMatchObject({ speaker: 'Jo Park', corrected: true });
    expect(out.find((t) => t.id === 5)).toMatchObject({ speaker: 'Sam Lee', confidence: STICKY });
    expect(out.find((t) => t.id === 6)).toMatchObject({ speaker: 'Sam Lee', confidence: 0.95 });
  });

  it('renames an unnamed turn alone, and with similar also the turns the pass clustered with it', () => {
    const base = applySpeakers(call, parseSpeakers({ turns: [
      { id: 2, cluster: 'A', speaker: 'Sam Lee', confidence: 1 },
      { id: 3, cluster: 'C', speaker: null, confidence: 0 },
      { id: 5, cluster: 'C', speaker: null, confidence: 0 },
      { id: 6, cluster: 'C', speaker: null, confidence: 0 },
      { id: 7, cluster: 'B', speaker: null, confidence: 0 },
    ] }, call, participants));
    const alone = correctSpeaker(base, 3, 'Jo Park');
    expect(them(alone).map((t) => t.speaker)).toEqual(['Sam Lee', 'Jo Park', null, null, null]);
    const spread = correctSpeaker(base, 3, 'Jo Park', { similar: true });
    expect(them(spread).map((t) => t.speaker)).toEqual(['Sam Lee', 'Jo Park', 'Jo Park', 'Jo Park', null]);
    expect(spread.find((t) => t.id === 5).corrected).toBe(true);
  });

  it('Unknown clears the turn and spreads to the same previous name under the threshold', () => {
    const out = correctSpeaker(named, 6, 'Unknown');
    expect(out[5]).toMatchObject({ speaker: null, confidence: 0, corrected: true, cluster: 'c:B' });
    expect(out[2].speaker).toBe('Jo Park');
    expect(correctSpeaker(named, 6, null)[5].speaker).toBeNull();
  });

  it('a typed name not on the list works like any other and does not touch me turns or unknown ids', () => {
    const out = correctSpeaker(named, 7, 'Pat Doe');
    expect(out[6]).toMatchObject({ speaker: 'Pat Doe', confidence: 1, cluster: 'c:C' });
    expect(out[0]).toBe(named[0]);
    expect(correctSpeaker(named, 1, 'Pat Doe')).toBe(named);
    expect(correctSpeaker(named, 42, 'Pat Doe')).toBe(named);
  });
});

describe('cluster lookup', () => {
  it('finds the turns the pass grouped with one, skipping corrected ones, and nothing for an unclustered turn', () => {
    expect(similarTurns(named, 2).map((t) => t.id)).toEqual([5]);
    expect(similarTurns(correctSpeaker(named, 5, 'Jo Park'), 2)).toEqual([]);
    expect(similarTurns(call, 2)).toEqual([]);
  });

  it('exposes the per-turn view the renderer merges', () => {
    expect(speakerView(named)[0]).toEqual({ id: 2, speaker: 'Sam Lee', confidence: 1, cluster: 'c:A', corrected: false });
    expect(speakerView(call)[0]).toEqual({ id: 2, speaker: null, confidence: 0, cluster: null, corrected: false });
  });
});

describe('names reach the prompts and the files', () => {
  const label = { me: 'Eric', them: 'Others' };

  it('speakerOf prefers the name and falls back to the channel label', () => {
    expect(speakerOf(named[1], label)).toBe('Sam Lee');
    expect(speakerOf(named[6], label)).toBe('Others');
    expect(speakerOf(named[0], label)).toBe('Eric');
  });

  it('toText, turnLines and the footnotes use speaker ?? label', () => {
    expect(toText(named.slice(0, 3), label)).toBe('Eric: Hi both, thanks for joining\nSam Lee: This is Sam, hello\nJo Park: Jo here');
    expect(turnLines(named.slice(5), label)).toBe('[t6] Jo Park: I can review it Thursday\n[t7] Others: Sounds good');
    const md = notesMarkdown({ title: 't', summary: '', sections: [{ heading: 'Plan', bullets: [{ text: 'Friday', sub: [], refs: [5, 7] }] }], decisions: [], actions: [], questions: [] }, { refs: true, turns: named, label });
    expect(md).toContain('[^t5]: Sam Lee: Nearly done, shipping Friday');
    expect(md).toContain('[^t7]: Others: Sounds good');
  });

  it('transcript.json carries speaker, confidence and cluster only on turns the pass or a correction touched', () => {
    const json = toJSON(correctSpeaker(named, 7, 'Jo Park'));
    expect(json[0]).toEqual({ channel: 'me', text: 'Hi both, thanks for joining', raw: 'Hi both, thanks for joining', start: 1, end: 1.5, at: 1000 });
    expect(json[1]).toMatchObject({ channel: 'them', speaker: 'Sam Lee', confidence: 1, cluster: 'c:A' });
    expect(json[1].corrected).toBeUndefined();
    expect(json[6]).toMatchObject({ speaker: 'Jo Park', confidence: 1, corrected: true });
    expect(toJSON(call)[1]).not.toHaveProperty('speaker');
  });

  it('LOW marks a guess for the dotted underline', () => {
    expect(LOW).toBe(0.6);
    expect(named[5].confidence < LOW).toBe(false);
  });
});
