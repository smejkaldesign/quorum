// notes.js: the running summary state, when it runs, the prompts the model sees, partial JSON while the final notes
// stream, the markdown the vault gets, and the fallback to the last good state when a model call fails.
import { describe, expect, it, vi } from 'vitest';
import { SUMMARY_MIN, SUMMARY_MS, SUMMARY_TURNS, emptyState, finalNotes, mergeState, newTurns, notesFromState, notesMarkdown, notesPrompt, notesSystem, parsePartial, partialNotes, summaryBlock, summaryDue, summaryPrompt } from '../notes.js';

const turn = (id, channel, text) => ({ id, channel, text, start: id, end: id + 0.5, at: id * 1000 });
const turns = (n, from = 1) => Array.from({ length: n }, (_, i) => turn(from + i, i % 2 ? 'them' : 'me', `line ${from + i}`));
const label = { me: 'Ana', them: 'Sam' };
const context = { platform: 'Google Meet', solo: false, title: 'Pricing review' };
const sample = { title: 'Pricing review', summary: 'Ana and Sam set the seat price.', sections: [{ heading: 'Seat price', bullets: [{ text: 'Sam proposed $9', sub: ['up from $5'], refs: [3, 4] }] }, { heading: 'Rollout', bullets: [{ text: 'Existing customers keep $5 until March', sub: [], refs: [6] }] }], decisions: [{ text: 'Seat price is $9', status: 'confirmed', refs: [5] }, { text: 'Drop the annual discount', status: 'suggested', refs: [7] }], actions: [{ task: 'Send the pricing page draft', owner: 'Ana', due: 'Friday', refs: [7] }, { task: 'Check the annual plan', owner: null, due: null, refs: [8] }], questions: [{ text: 'Does the annual plan keep a discount?', refs: [8] }] };

describe('state merge', () => {
  it('replaces each field with the model reply and records the last turn it covered', () => {
    const next = { summary: ' Two topics so far. ', decisions: [{ text: 'Ship Friday', status: 'confirmed', refs: [2] }], actions: [{ task: 'Write the brief', owner: 'Sam', due: null, refs: ['t3'] }], questions: [{ text: 'Who demos?', refs: [4] }] };
    const s = mergeState(emptyState(), next, turns(10));
    expect(s.summary).toBe('Two topics so far.');
    expect(s.decisions).toEqual([{ text: 'Ship Friday', status: 'confirmed', refs: [2] }]);
    expect(s.actions).toEqual([{ task: 'Write the brief', owner: 'Sam', due: null, refs: [3] }]);
    expect(s.questions).toEqual([{ text: 'Who demos?', refs: [4] }]);
    expect(s.coveredUntil).toBe(10);
  });

  it('keeps the last good value for any field that came back malformed and drops refs to turns it does not have', () => {
    const prev = { ...emptyState(), summary: 'Kept.', decisions: [{ text: 'Old', status: 'suggested', refs: [1] }], coveredUntil: 4 };
    const s = mergeState(prev, { summary: 42, decisions: 'nope', actions: [{ task: 'Do it', refs: [1, 99] }, { nothing: true }], questions: [{ text: 'Why?', status: 'confirmed' }] }, turns(8));
    expect(s.summary).toBe('Kept.');
    expect(s.decisions).toEqual(prev.decisions);
    expect(s.actions).toEqual([{ task: 'Do it', owner: null, due: null, refs: [1] }]);
    expect(s.questions).toEqual([{ text: 'Why?', refs: [] }]);
    expect(s.coveredUntil).toBe(8);
    expect(mergeState(prev, null, []).coveredUntil).toBe(4);
  });

  it('unknown decision statuses become suggested', () => {
    expect(mergeState(emptyState(), { decisions: [{ text: 'X', status: 'maybe' }] }, turns(1)).decisions[0].status).toBe('suggested');
  });
});

describe('trigger rule', () => {
  const t0 = 1_000_000;
  it('never runs on fewer than SUMMARY_MIN new turns, whatever the clock says', () => {
    expect(summaryDue({ turns: turns(SUMMARY_MIN - 1), state: emptyState(), lastAt: t0, now: t0 + SUMMARY_MS * 3 })).toBe(false);
    expect(summaryDue({ turns: turns(SUMMARY_MIN), state: emptyState(), lastAt: t0, now: t0 + SUMMARY_MS })).toBe(true);
  });

  it('runs at SUMMARY_MS with enough turns, or at SUMMARY_TURNS new turns whenever that comes first', () => {
    expect(summaryDue({ turns: turns(SUMMARY_TURNS - 1), state: emptyState(), lastAt: t0, now: t0 + SUMMARY_MS - 1 })).toBe(false);
    expect(summaryDue({ turns: turns(SUMMARY_TURNS - 1), state: emptyState(), lastAt: t0, now: t0 + SUMMARY_MS })).toBe(true);
    expect(summaryDue({ turns: turns(SUMMARY_TURNS), state: emptyState(), lastAt: t0, now: t0 + 1000 })).toBe(true);
  });

  it('counts only turns after coveredUntil', () => {
    const state = { ...emptyState(), coveredUntil: 50 };
    const all = turns(57);
    expect(newTurns(all, state).map((t) => t.id)).toEqual([51, 52, 53, 54, 55, 56, 57]);
    expect(summaryDue({ turns: turns(50 + SUMMARY_MIN - 1), state, lastAt: t0, now: t0 + SUMMARY_MS })).toBe(false);
    expect(summaryDue({ turns: turns(50 + SUMMARY_MIN), state, lastAt: t0, now: t0 + SUMMARY_MS })).toBe(true);
  });
});

describe('prompt assembly', () => {
  it('the summary prompt names the platform and the topic, carries the state, and gives every turn its id', () => {
    const state = { ...emptyState(), summary: 'So far.', coveredUntil: 2 };
    const p = summaryPrompt({ state, turns: turns(3, 3), label, context });
    expect(p).toContain('Google Meet call, topic: Pricing review.');
    expect(p).toContain('"summary":"So far."');
    expect(p).not.toContain('coveredUntil');
    expect(p).toContain('[t3] Ana: line 3\n[t4] Sam: line 4\n[t5] Ana: line 5');
    expect(p.indexOf('Running state')).toBeLessThan(p.indexOf('New turns'));
  });

  it('a solo note says so instead of naming a platform, and redaction runs over the turn lines', () => {
    const p = summaryPrompt({ state: emptyState(), turns: turns(2), label, context: { platform: 'Zoom', solo: true, title: '' }, redact: (s) => s.replace(/line 2/, '[withheld]') });
    expect(p).toContain('Solo note, no call.');
    expect(p).not.toContain('Zoom');
    expect(p).toContain('[t2] Sam: [withheld]');
  });

  it('the final prompt puts the state before the turns and uses the private notes as the outline', () => {
    const state = { ...emptyState(), decisions: [{ text: 'Ship Friday', status: 'confirmed', refs: [2] }] };
    const p = notesPrompt({ state, turns: turns(3), label, context: { platform: 'Microsoft Teams', solo: false, title: 'Standup' }, outline: '- pricing\n- hiring' });
    expect(p).toContain('Microsoft Teams call, topic: Standup. Keep the topic as the title');
    expect(p.indexOf('Running summary')).toBeLessThan(p.indexOf('Full transcript'));
    expect(p.indexOf("Ana's own notes")).toBeLessThan(p.indexOf('Full transcript'));
    expect(p).toContain('- pricing\n- hiring');
    expect(p).toContain('[t1] Ana: line 1');
    expect(p).toContain('"refs": number[]');
  });

  it('with no state and no outline the final prompt leaves both blocks out and asks for a fresh title', () => {
    const p = notesPrompt({ state: emptyState(), turns: turns(2), label, context: { platform: 'Zoom', solo: false, title: '' } });
    expect(p).not.toContain('Running summary');
    expect(p).not.toContain('own notes');
    expect(p).toContain('Zoom call. Write a 2-5 word title.');
  });

  it('the system prompt carries the owner, the style rules and one example', () => {
    const s = notesSystem({ owner: 'Ana', about: 'Ana is a designer.' });
    for (const rule of ['exactly as spoken', 'Short bullets', '"confirmed" only when someone agreed', 'Never invent', '"refs"', 'Return only JSON']) expect(s).toContain(rule);
    expect(s).toContain('"status":"confirmed"');
    expect(s.endsWith('Ana is a designer.')).toBe(true);
    expect(s).not.toContain('—');
  });

  it('the ask block is empty for an empty state and compact otherwise', () => {
    expect(summaryBlock(emptyState())).toBe('');
    const b = summaryBlock({ ...emptyState(), summary: 'Two topics.', decisions: [{ text: 'Ship Friday', status: 'suggested', refs: [] }], actions: [{ task: 'Brief', owner: 'Sam', due: null, refs: [] }], questions: [{ text: 'Who demos?', refs: [] }] });
    expect(b).toBe('Summary so far:\nTwo topics.\nDecisions: Ship Friday (suggested)\nActions: Brief (Sam)\nOpen: Who demos?');
  });
});

describe('partial JSON', () => {
  const full = JSON.stringify(sample);

  it('every prefix of a streamed reply parses to an object once the first brace has arrived', () => {
    for (let i = 1; i <= full.length; i++) expect(parsePartial(full.slice(0, i)), `prefix ${i}`).toEqual(expect.any(Object));
    expect(parsePartial(full)).toEqual(sample);
    expect(parsePartial('no json here')).toBeNull();
  });

  it('a half-written summary shows as far as it got; a half-written key is cut back to the last complete value', () => {
    const mid = full.indexOf('seat price') + 4;
    expect(parsePartial(full.slice(0, mid))).toEqual({ title: 'Pricing review', summary: 'Ana and Sam set the seat' });
    const key = full.indexOf('"sections"') + 5;
    expect(parsePartial(full.slice(0, key))).toEqual({ title: 'Pricing review', summary: 'Ana and Sam set the seat price.' });
  });

  it('survives prose and a code fence before the object, and escaped quotes inside strings', () => {
    const wrapped = 'Here are the notes:\n```json\n' + JSON.stringify({ title: 'Q "two"', summary: 'a \\ b' });
    expect(parsePartial(wrapped.slice(0, -4))).toEqual({ title: 'Q "two"' });
    expect(parsePartial(wrapped)).toEqual({ title: 'Q "two"', summary: 'a \\ b' });
  });

  it('partialNotes renders only the sections that have closed and drops refs to turns not yet known', () => {
    const cut = full.indexOf('"Rollout"');
    const p = partialNotes(full.slice(0, cut), turns(5), 'Fallback');
    expect(p.title).toBe('Pricing review');
    expect(p.sections.map((s) => s.heading)).toEqual(['Seat price']);
    expect(p.sections[0].bullets[0].refs).toEqual([3, 4]);
    expect(p.decisions).toEqual([]);
    expect(partialNotes('{"summary": "x"}', [], 'Fallback').title).toBe('Fallback');
    expect(partialNotes('Working on it', [], 'Fallback')).toBeNull();
  });

  it('finalNotes needs a sections array and normalizes everything else', () => {
    expect(() => finalNotes({ title: 'x' }, [], 'T')).toThrow(/sections/);
    const n = finalNotes({ ...sample, actions: [{ task: 'Do', refs: ['t2', 2, 'x'] }] }, turns(8), 'T');
    expect(n.actions).toEqual([{ task: 'Do', owner: null, due: null, refs: [2, 2] }]);
    expect(n.sections[1].bullets[0].refs).toEqual([6]);
  });
});

describe('markdown', () => {
  it('writes H2 for every section, checkboxes with owner and due, decisions and open questions, and no refs by default', () => {
    const md = notesMarkdown(sample);
    expect(md.startsWith('## Private notes\nNone\n\n## Summary\nAna and Sam set the seat price.\n\n## Seat price\n\n- Sam proposed $9\n  - up from $5\n')).toBe(true);
    expect(md).toContain('## Rollout\n\n- Existing customers keep $5 until March\n');
    expect(md).toContain('## Decisions\n\n- Seat price is $9\n- Drop the annual discount (not agreed)\n');
    expect(md).toContain('## Action items\n\n- [ ] Send the pricing page draft (Ana, due Friday)\n- [ ] Check the annual plan (no owner, not agreed)\n');
    expect(md).toContain('## Open questions\n\n- Does the annual plan keep a discount?\n');
    expect(md).not.toMatch(/^# /m);
    expect(md).not.toContain('[^t');
  });

  it('with refs on every line carries its markers and the cited turns become footnotes', () => {
    const md = notesMarkdown(sample, { refs: true, turns: turns(8), label });
    expect(md).toContain('- Sam proposed $9 [^t3][^t4]\n');
    expect(md).toContain('- [ ] Send the pricing page draft (Ana, due Friday) [^t7]\n');
    expect(md).toContain('- Does the annual plan keep a discount? [^t8]\n');
    expect(md).toContain('[^t3]: Ana: line 3\n[^t4]: Sam: line 4\n[^t5]: Ana: line 5\n[^t6]: Sam: line 6\n[^t7]: Ana: line 7\n[^t8]: Sam: line 8\n');
  });

  it('private notes land under their heading and an owner with no due date reads as not agreed', () => {
    const md = notesMarkdown({ ...sample, actions: [{ task: 'Call back', owner: 'Sam', due: null, refs: [] }] }, { privateNotes: '- ask about renewals' });
    expect(md).toContain('## Private notes\n- ask about renewals\n');
    expect(md).toContain('- [ ] Call back (Sam, not agreed)\n');
  });
});

describe('fallback', () => {
  it('a failed final call saves the running state as the note', () => {
    const state = { ...emptyState(), summary: 'Two topics.', decisions: [{ text: 'Ship Friday', status: 'confirmed', refs: [2] }], coveredUntil: 9 };
    const n = notesFromState(state, 'Standup', 'Anthropic 529: overloaded\nmore');
    expect(n).toEqual({ title: 'Standup', summary: 'Two topics.', sections: [], decisions: state.decisions, actions: [], questions: [] });
    const bare = notesFromState(emptyState(), 'Standup', 'claude exited 1');
    expect(bare.summary).toBe("Quorum couldn't write notes for this call (claude exited 1). The transcript is saved next to this note.");
  });

  it('a failed running summary keeps the last good state and the next success merges on top of it', async () => {
    const model = vi.fn()
      .mockResolvedValueOnce('{"summary": "First five minutes.", "decisions": [], "actions": [], "questions": []}')
      .mockRejectedValueOnce(new Error('Ollama is not running at localhost:11434'))
      .mockResolvedValueOnce('{"summary": "Ten minutes in.", "decisions": [{"text": "Ship Friday", "status": "confirmed", "refs": [12]}], "actions": [], "questions": []}');
    let state = emptyState();
    const run = async (all) => {
      try { state = mergeState(state, JSON.parse(await model(summaryPrompt({ state, turns: newTurns(all, state), label, context }))), all); } catch { /* logged in main.js, the last state stands */ }
    };
    await run(turns(8));
    expect(state).toMatchObject({ summary: 'First five minutes.', coveredUntil: 8 });
    await run(turns(16));
    expect(state).toMatchObject({ summary: 'First five minutes.', coveredUntil: 8 });
    await run(turns(16));
    expect(state).toMatchObject({ summary: 'Ten minutes in.', coveredUntil: 16 });
    expect(state.decisions).toEqual([{ text: 'Ship Friday', status: 'confirmed', refs: [12] }]);
    expect(model).toHaveBeenCalledTimes(3);
    expect(model.mock.calls[2][0]).toContain('[t9] Ana: line 9');
    expect(model.mock.calls[2][0]).not.toContain('[t8]');
  });
});
