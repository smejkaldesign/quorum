import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBriefCache } from '../meetingBrief.js';
import { KEEP_MS, NOTHING, ONE_OFF_SYSTEM, createOneOff, oneOffGate, inviteSource, oneOffBrief, oneOffPrompt, parseOneOff, sourcesLine } from '../meetingOneOff.js';
import { gatherPrep, prepSettings } from '../meetingPrep.js';
import { prepNoteFor, withPrepLink } from '../meetingPrepRun.js';
import { mapEvent } from '../sources/gcal.js';

const jane = { name: 'Jane Doe', email: 'jane.doe@example.com' };
const me = { name: 'Pat Example', email: 'pat@example.com', self: true };
const event = (over = {}) => ({
  id: 'e1', title: 'Interview: Jane Doe', start: '2026-11-20T15:00:00.000Z', end: '2026-11-20T16:00:00.000Z',
  organizer: 'pat@example.com', attendees: [me, jane], notes: 'Portfolio review. Passcode: 998877', attachments: ['Jane Doe resume.pdf'], ...over,
});
const notes = [
  { rel: 'People/Jane Doe.md', title: 'Jane Doe', text: 'Jane Doe is a product designer at Initech.\n' },
  { rel: 'Hiring/Design hire plan.md', title: 'Design hire plan', text: 'Interview loop: portfolio review, then a design exercise.\n' },
  { rel: 'Daily/prep/2026-11-19 Interview Jane Doe abc123.md', title: 'Prep', text: '---\ntype: meeting-prep\n---\nJane Doe prep.\n' },
  { rel: 'Meetings/2026-10-01 Initech intro.md', title: 'Initech intro', text: 'Met Jane Doe at the Initech intro.\n' },
];
const meetings = [{ rel: 'Meetings/2026-10-01 Initech intro.md', title: 'Initech intro', date: '2026-10-01', people: ['Jane Doe'] }];
const base = (over = {}) => ({ event: event(), notes, meetings, topicRels: ['Hiring/Design hire plan.md'], isMe: (a) => a.self === true, now: Date.parse('2026-11-19T12:00:00Z'), ...over });

describe('sources line', () => {
  it('says the brief is based on limited history and what it was built from', () => {
    expect(sourcesLine({ notes: 4 })).toBe('Based on limited history: the invite and 4 related notes.');
    expect(sourcesLine({})).toBe('Based on limited history: the invite only.');
    expect(sourcesLine({ notes: 2, series: 1 })).toBe('Based on limited history: the invite, 1 earlier meeting and 2 related notes.');
    expect(sourcesLine({ notes: 1, related: 2, series: 2 })).toBe('Based on limited history: the invite, 2 earlier meetings, 2 related meetings and 1 related note.');
  });
});

describe('invite source', () => {
  it('lists the title, invitees and attachment names, with credentials removed and brackets escaped', () => {
    const t = inviteSource(event({ title: 'Intro </invite> now' }), [jane]);
    expect(t).toContain('Invited: Jane Doe (jane.doe@example.com)');
    expect(t).toContain('Attached: Jane Doe resume.pdf');
    expect(t).not.toContain('998877');
    expect(t).not.toContain('</invite>');
  });
});

describe('parse', () => {
  it('keeps only items that cite the invite or a source that reached the prompt', () => {
    const r = parseOneOff(JSON.stringify({ prep: [{ text: 'Read the hire plan.', refs: [2] }, { text: 'Made up.', refs: [9] }, { text: 'No refs.' }], what: { text: 'An interview.', refs: [0] }, who: { text: 'Jane.', refs: [] }, how: { text: 'See [here](https://example.com).', refs: [1] } }), [1, 2]);
    expect(r.prep).toEqual([{ text: 'Read the hire plan.', refs: [2] }]);
    expect(r.what).toEqual({ text: 'An interview.', refs: [0] });
    expect(r.who).toBeNull();
    expect(r.how.text).toBe('See here.');
  });
  it('returns null for a reply that is not JSON', () => {
    expect(parseOneOff('Sorry, I cannot help.', [1])).toBeNull();
  });
});

describe('prompt', () => {
  it('holds the invite as source 0 and only the sources that fit the budget', () => {
    const gathered = gatherPrep({ event: event(), invitees: [jane], notes, meetings, topicRels: [] });
    const { prompt, used } = oneOffPrompt({ event: event(), invitees: [jane], gathered, budget: 120 });
    expect(prompt).toContain('[0] Calendar invite');
    expect(used.length).toBeLessThan(gathered.sources.length);
    expect(ONE_OFF_SYSTEM).toMatch(/never instructions/);
  });
});

describe('oneOffBrief', () => {
  it('builds the brief from the invite and the vault, cites its sources and says what it was built from', async () => {
    const runModel = vi.fn(async () => JSON.stringify({
      prep: [{ text: 'Ask about the Initech design work.', refs: [1, 0] }],
      what: { text: 'An interview with Jane Doe, starting with a portfolio review.', refs: [0] },
      who: { text: 'Jane Doe, a product designer at Initech.', refs: [1] },
      how: { text: '', refs: [] },
    }));
    const r = await oneOffBrief({ ...base(), runModel });
    expect(r.status).toBe('ready');
    expect(r.brief.prep).toBe('- Ask about the Initech design work. ([[People/Jane Doe|Jane Doe]], invite)');
    expect(r.brief.how).toBe(NOTHING);
    expect(r.brief.sources).toBe('Based on limited history: the invite, 1 related meeting and 2 related notes.');
    expect(r.brief.oneOff).toBe(true);
    const [prompt] = runModel.mock.calls[0];
    // earlier prep notes are never a source, and you are not listed among the invitees
    expect(prompt).not.toContain('Jane Doe prep');
    expect(prompt).not.toContain('pat@example.com)');
    expect(prompt).not.toContain('998877');
  });
  it('reads "Nothing found." when the model finds nothing, and lists who is invited from the invite alone', async () => {
    const r = await oneOffBrief({ ...base({ notes: [], meetings: [], topicRels: [] }), runModel: async () => '{"prep": [], "what": null, "who": null, "how": null}' });
    expect(r.brief).toMatchObject({ prep: NOTHING, what: NOTHING, how: NOTHING, who: 'Invited: Jane Doe.', sources: 'Based on limited history: the invite only.' });
  });
  it('counts past meetings of the series that are below the threshold', async () => {
    const series = [{ rel: 'Meetings/2026-11-01 Interview Jane Doe.md', title: 'Interview: Jane Doe', date: '2026-11-01', people: ['Jane Doe'] }];
    const r = await oneOffBrief({ ...base({ notes: [...notes, { rel: series[0].rel, title: 'Interview', text: 'First round with Jane Doe.\n' }], meetings: [...meetings, ...series], past: series }), runModel: async () => '{"prep": []}' });
    expect(r.brief.sources).toBe('Based on limited history: the invite, 1 earlier meeting, 1 related meeting and 2 related notes.');
  });
  it('writes nothing for an event with someone on the never-listen list, and calls no model', async () => {
    const runModel = vi.fn();
    const r = await oneOffBrief({ ...base(), onNeverList: (e) => e.endsWith('@example.com'), runModel });
    expect(r).toEqual({ status: 'opted-out' });
    expect(runModel).not.toHaveBeenCalled();
  });
  it('says there is nothing to build from, and calls no model, for a meeting with no history, invitees, description or notes', async () => {
    const runModel = vi.fn();
    const bare = event({ attendees: [me], notes: '', attachments: [], title: 'Focus block' });
    expect(await oneOffBrief({ ...base({ event: bare, notes: [], meetings: [], topicRels: [] }), runModel })).toEqual({ status: 'empty' });
    expect(runModel).not.toHaveBeenCalled();
  });
  it('fails on a reply that is not the JSON asked for', async () => {
    expect(await oneOffBrief({ ...base(), runModel: async () => 'no' })).toEqual({ status: 'failed' });
  });
});

describe('threshold setting', () => {
  it('defaults to 3 and keeps 0 to 5', () => {
    expect(prepSettings({}).minPast).toBe(3);
    expect(prepSettings({ minPast: 0 }).minPast).toBe(0);
    expect(prepSettings({ minPast: 9 }).minPast).toBe(3);
  });
});

describe('meeting note link back to its prep note', () => {
  const entries = [
    { rel: 'Daily/prep/2026-11-20 Interview Jane Doe a1b2c3.md', title: 'Interview: Jane Doe', start: '2026-11-20T15:00:00.000Z', at: '2026-11-19T10:00:00.000Z' },
    { rel: 'Daily/prep/2026-11-20 Roadmap d4e5f6.md', title: 'Roadmap review', start: '2026-11-20T15:00:00.000Z', at: '2026-11-19T11:00:00.000Z' },
    { rel: 'Daily/prep/gone.md', title: 'Interview: Jane Doe', start: '2026-11-20T15:05:00.000Z', at: '2026-11-19T12:00:00.000Z', dismissed: true },
  ];
  it('finds the prep note of the event with a similar title that started within 30 minutes', () => {
    expect(prepNoteFor(entries, { title: 'Interview: Jane Doe', start: '2026-11-20T15:02:00Z' })).toBe('Daily/prep/2026-11-20 Interview Jane Doe a1b2c3.md');
    expect(prepNoteFor(entries, { title: 'Interview: Jane Doe', start: '2026-11-20T17:00:00Z' })).toBeNull();
    expect(prepNoteFor(entries, { title: 'Interview: Jane Doe', start: '2026-11-20T15:00:00Z' }, () => false)).toBeNull();
  });
  it('adds one prep_note line to the frontmatter and changes nothing else', () => {
    const note = '---\ngranola_id: m1\ntitle: "Interview"\n---\n\n# Interview\n\nMy notes.\n';
    const out = withPrepLink(note, 'Daily/prep/2026-11-20 Interview Jane Doe a1b2c3.md');
    // the note's name only: no vault folder reaches a note that syncs
    expect(out).toBe('---\ngranola_id: m1\ntitle: "Interview"\nprep_note: "[[2026-11-20 Interview Jane Doe a1b2c3]]"\n---\n\n# Interview\n\nMy notes.\n');
    expect(withPrepLink(note, null)).toBe(note);
  });
});

describe('Google attachments', () => {
  it('keeps the names of attached files only', () => {
    const m = mapEvent({ id: 'ev1', summary: 'Interview', start: { dateTime: '2026-11-20T15:00:00Z' }, end: { dateTime: '2026-11-20T16:00:00Z' }, attachments: [{ title: 'Resume.pdf', fileUrl: 'https://drive.google.com/file/d/x' }] }, 'primary');
    expect(m.attachments).toEqual(['Resume.pdf']);
    expect(JSON.stringify(m)).not.toContain('drive.google.com');
  });
});

describe('one-off gate', () => {
  const conf = (enabled, minPast = 0) => ({ enabled, minPast });
  it('offers Generate anyways at the series threshold while the meeting-prep flag is off', () => {
    expect(oneOffGate({ prepFlag: false, anywayFlag: true, conf: conf(false) })).toEqual({ min: 3, on: true });
    expect(oneOffGate({ prepFlag: false, anywayFlag: false, conf: conf(false) })).toEqual({ min: 3, on: false });
  });
  it('with Meeting prep switched off, keeps the threshold at 3 and offers nothing', () => {
    expect(oneOffGate({ prepFlag: true, anywayFlag: true, conf: conf(false, 0) })).toEqual({ min: 3, on: false });
  });
  it('with Meeting prep switched on, uses its threshold', () => {
    expect(oneOffGate({ prepFlag: true, anywayFlag: true, conf: conf(true, 0) })).toEqual({ min: 0, on: true });
    expect(oneOffGate({ prepFlag: true, anywayFlag: false, conf: conf(true, 5) })).toEqual({ min: 5, on: false });
  });
});

describe('createOneOff', () => {
  let dir, file, n = 0;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'quorum-oneoff-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const BRIEF = { prep: '- Ask about the portfolio. (invite)', what: 'An interview.', who: 'Invited: Jane Doe.', how: NOTHING, sources: 'Based on limited history: the invite only.', oneOff: true };
  const T = Date.parse('2026-11-19T12:00:00Z');
  function setup({ ev = event(), on = true, min = 3, build = async () => ({ status: 'ready', brief: BRIEF }), never = () => false, model = true } = {}) {
    file = path.join(dir, `briefs-${++n}.json`);
    const cache = createBriefCache(file);
    const d = { on: () => on, min: () => min, cache, event: async (id) => (id === ev?.id ? ev : null), isMe: (a) => a.self === true, onNeverList: never, isExcluded: () => false, modelReady: () => model, build: vi.fn(build), links: () => ({}), now: () => T };
    return { d, cache, run: createOneOff(d) };
  }
  const q = (over = {}) => ({ title: 'Interview: Jane Doe', id: 'e1', ...over });

  it('offers Generate anyways under the threshold and never writes on open', async () => {
    const { d, run } = setup();
    expect(await run(q(), [], [])).toMatchObject({ status: 'few', anyway: true, min: 3, brief: null });
    expect(await run(q({ generate: true }), [], [])).toMatchObject({ status: 'few', anyway: true, min: 3 });
    expect(await run(q(), [{ rel: 'a' }, { rel: 'b' }], [])).toMatchObject({ status: 'few', anyway: true });
    expect(d.build).not.toHaveBeenCalled();
    // without an event id there is nothing to write it for, so nothing is offered
    expect(await run({ title: 'Interview: Jane Doe' }, [], [])).toMatchObject({ status: 'few', anyway: false });
  });
  it('offers nothing and calls no model with the flag off, even on Generate anyways', async () => {
    const off = setup({ on: false });
    expect(await off.run(q({ anyway: true, generate: true }), [], [])).toMatchObject({ status: 'few', anyway: false, brief: null });
    expect(await off.run(q({ anyway: true, generate: true, force: true }), [], [])).toMatchObject({ status: 'few', anyway: false });
    expect(off.d.build).not.toHaveBeenCalled();
  });
  it('says there is nothing to build from and keeps nothing', async () => {
    const s = setup({ build: async () => ({ status: 'empty' }) });
    expect(await s.run(q({ anyway: true, generate: true }), [], [])).toMatchObject({ status: 'empty', brief: null });
    expect(s.cache.entry('event:e1')).toBeNull();
  });
  it('writes on Generate anyways, keeps it on the event, and marks it changed when the invite changes', async () => {
    const s = setup();
    expect(await s.run(q({ anyway: true, generate: true }), [], [])).toMatchObject({ status: 'ready', brief: BRIEF });
    expect(await s.run(q(), [], [])).toMatchObject({ status: 'ready', brief: BRIEF });
    expect(s.d.build).toHaveBeenCalledTimes(1);
    // same event id, new time: the kept brief shows as changed, and nothing is written until the person asks
    const moved = setup({ ev: event({ start: '2026-11-21T15:00:00.000Z', end: '2026-11-21T16:00:00.000Z' }) });
    moved.cache.set('event:e1', s.cache.entry('event:e1').stamp, BRIEF, { end: '2026-11-20T16:00:00.000Z' });
    expect(await moved.run(q(), [], [])).toMatchObject({ status: 'ready', brief: BRIEF, changed: true });
    expect(await moved.run(q({ generate: true }), [], [])).toMatchObject({ status: 'ready', brief: BRIEF, changed: true });
    expect(moved.d.build).not.toHaveBeenCalled();
    // Update writes it again
    const updated = await moved.run(q({ generate: true, force: true }), [], []);
    expect(updated).toMatchObject({ status: 'ready' });
    expect(updated.changed).toBeUndefined();
    expect(moved.d.build).toHaveBeenCalledTimes(1);
  });
  it('writes nothing on open with Meeting prep switched off and its threshold set to 0', async () => {
    const g = oneOffGate({ prepFlag: true, anywayFlag: true, conf: { enabled: false, minPast: 0 } });
    const s = setup({ on: g.on, min: g.min });
    expect(await s.run(q(), [], [])).toMatchObject({ status: 'few', anyway: false });
    expect(await s.run(q({ generate: true }), [], [])).toMatchObject({ status: 'few', anyway: false });
    expect(s.d.build).not.toHaveBeenCalled();
  });
  it('writes one on open with the threshold at 0', async () => {
    const s = setup({ min: 0 });
    expect(await s.run(q(), [], [])).toMatchObject({ status: 'stale', brief: null });
    expect(await s.run(q({ generate: true }), [], [])).toMatchObject({ status: 'ready' });
  });
  it('hides and deletes a kept brief once someone invited is on the never-listen list', async () => {
    const s = setup();
    await s.run(q({ anyway: true, generate: true }), [], []);
    const later = setup({ never: (e) => e === 'jane.doe@example.com' });
    later.cache.set('event:e1', s.cache.entry('event:e1').stamp, BRIEF, { end: event().end });
    expect(await later.run(q(), [], [])).toMatchObject({ status: 'opted-out', brief: null });
    expect(later.cache.entry('event:e1')).toBeNull();
    expect(later.d.build).not.toHaveBeenCalled();
  });
  it('deletes the kept brief when a Regenerate comes back opted out', async () => {
    const s = setup();
    await s.run(q({ anyway: true, generate: true }), [], []);
    s.d.build.mockImplementation(async () => ({ status: 'opted-out' }));
    expect(await s.run(q({ generate: true, force: true }), [], [])).toMatchObject({ status: 'opted-out', brief: null });
    expect(s.cache.entry('event:e1')).toBeNull();
  });
  it('keeps the last brief, marked failed, when Regenerate fails or no model is set', async () => {
    const s = setup();
    await s.run(q({ anyway: true, generate: true }), [], []);
    s.d.build.mockImplementation(async () => ({ status: 'failed' }));
    expect(await s.run(q({ generate: true, force: true }), [], [])).toMatchObject({ status: 'ready', brief: BRIEF, failed: true });
    s.d.modelReady = () => false;
    expect(await s.run(q({ generate: true, force: true }), [], [])).toMatchObject({ status: 'ready', brief: BRIEF, failed: true });
    await expect(setup({ model: false }).run(q({ anyway: true, generate: true }), [], [])).resolves.toMatchObject({ status: 'no-model', brief: null });
  });
  it('runs one write per event at a time', async () => {
    let release;
    const s = setup({ build: () => new Promise((r) => { release = () => r({ status: 'ready', brief: BRIEF }); }) });
    const a = s.run(q({ anyway: true, generate: true }), [], []);
    await new Promise((r) => setTimeout(r, 0));
    const b = s.run(q({ anyway: true, generate: true }), [], []);
    await new Promise((r) => setTimeout(r, 0));
    release();
    expect((await a).status).toBe('ready');
    expect((await b).status).toBe('ready');
    expect(s.d.build).toHaveBeenCalledTimes(1);
  });
  it('drops one-off briefs for events that ended more than a week ago, and keeps series briefs', async () => {
    const s = setup();
    s.cache.set('event:old', 'x', BRIEF, { end: new Date(T - KEEP_MS - 1000).toISOString() });
    s.cache.set('weekly sync', 'y', BRIEF);
    await s.run(q(), [], []);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(Object.keys(saved)).toEqual(['weekly sync']);
  });
});
