import { describe, expect, it, vi } from 'vitest';
import { NOTHING, ONE_OFF_SYSTEM, inviteSource, oneOffBrief, oneOffPrompt, parseOneOff, sourcesLine } from '../meetingOneOff.js';
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
  it('says what the brief was built from and that the series has no past meetings', () => {
    expect(sourcesLine({ notes: 4 })).toBe('Built from the invite and 4 vault notes. No past meetings in this series.');
    expect(sourcesLine({})).toBe('Built from the invite. No past meetings in this series.');
    expect(sourcesLine({ notes: 1, related: 2, series: 1 })).toBe('Built from the invite, 1 vault note, 2 related meetings and 1 past meeting in this series.');
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
    expect(r.brief.sources).toBe('Built from the invite, 2 vault notes and 1 related meeting. No past meetings in this series.');
    expect(r.brief.oneOff).toBe(true);
    const [prompt] = runModel.mock.calls[0];
    // earlier prep notes are never a source, and you are not listed among the invitees
    expect(prompt).not.toContain('Jane Doe prep');
    expect(prompt).not.toContain('pat@example.com)');
    expect(prompt).not.toContain('998877');
  });
  it('reads "Nothing found." when the model finds nothing, and lists who is invited from the invite alone', async () => {
    const r = await oneOffBrief({ ...base({ notes: [], meetings: [], topicRels: [] }), runModel: async () => '{"prep": [], "what": null, "who": null, "how": null}' });
    expect(r.brief).toMatchObject({ prep: NOTHING, what: NOTHING, how: NOTHING, who: 'Invited: Jane Doe.', sources: 'Built from the invite. No past meetings in this series.' });
  });
  it('counts past meetings of the series that are below the threshold', async () => {
    const series = [{ rel: 'Meetings/2026-11-01 Interview Jane Doe.md', title: 'Interview: Jane Doe', date: '2026-11-01', people: ['Jane Doe'] }];
    const r = await oneOffBrief({ ...base({ notes: [...notes, { rel: series[0].rel, title: 'Interview', text: 'First round with Jane Doe.\n' }], meetings: [...meetings, ...series], past: series }), runModel: async () => '{"prep": []}' });
    expect(r.brief.sources).toBe('Built from the invite, 2 vault notes, 1 related meeting and 1 past meeting in this series.');
  });
  it('writes nothing for an event with someone on the never-listen list, and calls no model', async () => {
    const runModel = vi.fn();
    const r = await oneOffBrief({ ...base(), onNeverList: (e) => e.endsWith('@example.com'), runModel });
    expect(r).toEqual({ status: 'opted-out' });
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
    expect(out).toBe('---\ngranola_id: m1\ntitle: "Interview"\nprep_note: "[[Daily/prep/2026-11-20 Interview Jane Doe a1b2c3]]"\n---\n\n# Interview\n\nMy notes.\n');
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
