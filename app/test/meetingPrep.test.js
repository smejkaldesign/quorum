import { describe, expect, it } from 'vitest';
import {
  gatherPrep, inPrepWindow, inviteStamp, inviteesOf, isKnown, isPrepRel, optedOut, parsePrep, prepPrompt, prepRel, prepSettings,
  prepUntil, renderPrep, stripCredentialsInText, stripJoinCredentials, wantsPrep, wikiLink,
} from '../meetingPrep.js';

const jane = { name: 'Jane Doe', email: 'jane.doe@example.com' };
const sam = { name: 'Sam Lee', email: 'sam@example.com' };
const event = (over = {}) => ({ id: 'e1', title: 'Acme roadmap review', start: '2026-11-19T15:00:00.000Z', end: '2026-11-19T16:00:00.000Z', attendees: [jane, sam], ...over });

describe('settings', () => {
  it('defaults to off, the rest of today, and 3 or more people or someone new', () => {
    expect(prepSettings(undefined)).toEqual({ enabled: false, ahead: 'today', minInvitees: 3, orNew: true });
  });
  it('keeps only known values', () => {
    expect(prepSettings({ enabled: 'yes', ahead: 7, minInvitees: 99, orNew: 'x' })).toEqual({ enabled: false, ahead: 'today', minInvitees: 3, orNew: true });
    expect(prepSettings({ enabled: true, ahead: 4, minInvitees: 0, orNew: false })).toEqual({ enabled: true, ahead: 4, minInvitees: 0, orNew: false });
  });
});

describe('prepare-ahead window', () => {
  const now = new Date(2026, 10, 19, 9, 0).getTime();
  const at = (h, m = 0, len = 30) => ({ start: new Date(2026, 10, 19, h, m).toISOString(), end: new Date(2026, 10, 19, h, m + len).toISOString() });
  it('reaches midnight tonight for today', () => {
    expect(prepUntil(now, 'today')).toBe(new Date(2026, 10, 19, 23, 59, 59, 999).getTime());
    expect(inPrepWindow(at(22), now, 'today')).toBe(true);
    expect(inPrepWindow({ start: new Date(2026, 10, 20, 8).toISOString(), end: new Date(2026, 10, 20, 9).toISOString() }, now, 'today')).toBe(false);
  });
  it('reaches the given hours ahead', () => {
    expect(inPrepWindow(at(10, 30), now, 2)).toBe(true);
    expect(inPrepWindow(at(11, 30), now, 2)).toBe(false);
  });
  it('keeps a meeting that has started until it ends, and drops one that is over', () => {
    expect(inPrepWindow(at(8, 45), now, 2)).toBe(true);
    expect(inPrepWindow(at(8, 0), now, 2)).toBe(false);
    expect(inPrepWindow({ start: 'nope' }, now, 2)).toBe(false);
  });
});

describe('join link credentials', () => {
  it('drops passwords and tokens from the query and keeps the meeting', () => {
    expect(stripJoinCredentials('https://acme.zoom.us/j/123456789?pwd=abcDEF123&from=addon')).toBe('https://acme.zoom.us/j/123456789?from=addon');
    expect(stripJoinCredentials('https://zoom.us/j/1?tk=xyz&passcode=9')).toBe('https://zoom.us/j/1');
    expect(stripJoinCredentials('https://meet.google.com/abc-defg-hij')).toBe('https://meet.google.com/abc-defg-hij');
  });
  it('drops a user and password before the host and the fragment', () => {
    expect(stripJoinCredentials('https://me:hunter2@example.com/j/1#pwd=2')).toBe('https://example.com/j/1');
  });
  it('refuses anything other than https', () => {
    expect(stripJoinCredentials('http://zoom.us/j/1?pwd=2')).toBeNull();
    expect(stripJoinCredentials('not a link')).toBeNull();
  });
  it('cleans every link and passcode line in invite text', () => {
    const out = stripCredentialsInText('Join: https://zoom.us/j/1?pwd=abc\nPasscode: 445566\nMeeting ID: 1');
    expect(out).toBe('Join: https://zoom.us/j/1\nPasscode: [removed]\nMeeting ID: 1');
    expect(out).not.toContain('abc');
    expect(out).not.toContain('445566');
  });
  it('writes the stripped link into the saved note', () => {
    const gathered = { people: [], history: [], tasks: [], sources: [] };
    const text = renderPrep({ event: event(), gathered, parsed: null, join: 'https://zoom.us/j/1?pwd=secretvalue', platformName: 'Zoom' });
    expect(text).toContain('[Join on Zoom](https://zoom.us/j/1)');
    expect(text).not.toContain('secretvalue');
  });
});

describe('invitees and the filter', () => {
  it('leaves you out and lists everyone else once', () => {
    const e = event({ attendees: [{ name: 'Alex Me', email: 'me@example.com', self: true }, jane, { ...jane, email: 'JANE.DOE@example.com' }, sam, { name: '', email: '' }] });
    expect(inviteesOf(e, { isMe: (a) => a.email === 'me@example.com' })).toEqual([{ name: 'Jane Doe', email: 'jane.doe@example.com' }, sam]);
  });
  it('knows someone by email, full name, or the name read off the email', () => {
    expect(isKnown(jane, new Set(['jane doe']))).toBe(true);
    expect(isKnown({ name: '', email: 'jane.doe@example.com' }, new Set(['jane doe']))).toBe(true);
    expect(isKnown(sam, new Set(['jane doe']))).toBe(false);
  });
  it('prepares meetings with enough people, or with someone new', () => {
    const known = new Set(['jane doe', 'sam lee']);
    const conf = { minInvitees: 3, orNew: true };
    expect(wantsPrep([jane, sam], known, conf)).toBe(false);
    expect(wantsPrep([jane, sam, { name: 'Ann Bo', email: 'ann@example.com' }], new Set([...known, 'ann bo']), conf)).toBe(true);
    expect(wantsPrep([jane, { name: 'New Person', email: 'new@example.com' }], known, conf)).toBe(true);
    expect(wantsPrep([jane, { name: 'New Person', email: 'new@example.com' }], known, { minInvitees: 3, orNew: false })).toBe(false);
    expect(wantsPrep([], known, { minInvitees: 0, orNew: false })).toBe(true);
  });
  it('changes its stamp when the invite changes, and not for a new join password alone', () => {
    const a = inviteStamp(event({ notes: 'https://zoom.us/j/1?pwd=one' }), [jane, sam]);
    expect(inviteStamp(event({ notes: 'https://zoom.us/j/1?pwd=two' }), [jane, sam])).toBe(a);
    expect(inviteStamp(event({ notes: 'https://zoom.us/j/1?pwd=one' }), [jane])).not.toBe(a);
    expect(inviteStamp(event({ start: '2026-11-19T17:00:00.000Z', notes: 'https://zoom.us/j/1?pwd=one' }), [jane, sam])).not.toBe(a);
  });
});

describe('opt-outs', () => {
  const onNeverList = (email) => email === 'sam@example.com' || email === 'vip@example.com';
  it('names the invitees the never-listen list covers, by email', () => {
    expect(optedOut([jane, sam], { onNeverList })).toEqual([sam]);
    expect(optedOut([jane, { name: 'V', email: 'vip@example.com' }], { onNeverList })).toHaveLength(1);
    expect(optedOut([jane], { onNeverList })).toEqual([]);
  });
  it('names the invitees an opted-out customer name covers', () => {
    const isExcluded = (t) => t.toLowerCase().includes('initech');
    expect(optedOut([jane, { name: 'Bill (Initech)', email: 'b@example.com' }], { isExcluded })).toHaveLength(1);
  });
  it('keeps withheld lines out of the prompt as withheld', () => {
    const notes = [{ rel: 'people/jane-doe.md', title: 'Jane Doe', text: '# Jane Doe\nPM at Acme\n[withheld: opted-out customer]' }];
    const gathered = gatherPrep({ event: event(), invitees: [jane], notes, meetings: [] });
    const prompt = prepPrompt({ event: event(), gathered });
    expect(prompt).toContain('[withheld: opted-out customer]');
    expect(prompt).not.toMatch(/initech/i);
  });
});

describe('gathering and the prompt', () => {
  const notes = [
    { rel: 'people/jane-doe.md', title: 'Jane Doe', text: '---\ntitle: Jane Doe\n---\n# Jane Doe\nProduct lead at Acme.' },
    { rel: 'meetings/2026-11-10-acme-roadmap-review.md', title: 'Acme roadmap review', text: '---\ndate: 2026-11-10\n---\nJane Doe wants the Q1 dates.\n- [ ] Send Jane Doe the pricing sheet\n- [x] Done thing' },
    { rel: 'projects/acme.md', title: 'Acme', text: 'Roadmap risk: the API is late.\n- [ ] Confirm roadmap scope' },
    { rel: 'daily/prep/2026-11-12 Acme roadmap review.md', title: 'Prep', text: 'Jane Doe old prep' },
    { rel: 'notes/random.md', title: 'Random', text: 'nothing here' },
  ];
  const meetings = [{ rel: 'meetings/2026-11-10-acme-roadmap-review.md', title: 'Acme roadmap review', date: '2026-11-10', people: ['Jane Doe'] }];
  const now = new Date('2026-11-19T12:00:00Z').getTime();
  const g = gatherPrep({ event: event(), invitees: [jane, sam], notes, meetings, topicRels: ['projects/acme.md'], isPrepNote: isPrepRel, now });

  it('finds the people note, the last meeting and the mentions for an invitee, and nothing for a stranger', () => {
    const j = g.people.find((p) => p.name === 'Jane Doe');
    const rels = j.sources.map((id) => g.sources.find((s) => s.id === id).rel);
    expect(rels).toEqual(expect.arrayContaining(['people/jane-doe.md', 'meetings/2026-11-10-acme-roadmap-review.md']));
    expect(j.last.date).toBe('2026-11-10');
    expect(g.people.find((p) => p.name === 'Sam Lee').sources).toEqual([]);
  });
  it('never cites an earlier prep note', () => {
    expect(g.sources.map((s) => s.rel)).not.toContain('daily/prep/2026-11-12 Acme roadmap review.md');
  });
  it('lists unchecked tasks that name an invitee or sit in a topic note', () => {
    expect(g.tasks.map((t) => t.text)).toEqual(expect.arrayContaining(['Send Jane Doe the pricing sheet', 'Confirm roadmap scope']));
    expect(g.tasks.map((t) => t.text)).not.toContain('Done thing');
  });
  it('lists past meetings on the topic or with the invitees', () => {
    expect(g.history.map((h) => g.sources.find((s) => s.id === h.id).rel)).toEqual(['meetings/2026-11-10-acme-roadmap-review.md']);
  });
  it('numbers every source in the prompt and lists the invitees with theirs', () => {
    const prompt = prepPrompt({ event: event(), gathered: g, instructions: 'Use plain words.', owner: 'Alex' });
    for (const s of g.sources) expect(prompt).toContain(`[${s.id}] ${s.title}`);
    expect(prompt).toMatch(/- Jane Doe <jane\.doe@example\.com>: sources \d/);
    expect(prompt).toContain('- Sam Lee <sam@example.com>: no sources');
    expect(prompt).toContain('<vault-instructions>\nUse plain words.\n</vault-instructions>');
  });
  it('keeps join credentials out of the prompt', () => {
    const prompt = prepPrompt({ event: event({ notes: 'https://zoom.us/j/1?pwd=abc123' }), gathered: g });
    expect(prompt).not.toContain('abc123');
  });

  it('keeps only model items that cite a real source', () => {
    const reply = JSON.stringify({
      people: [{ name: 'Jane Doe', summary: 'Product lead at Acme.', refs: [1] }, { name: 'Sam Lee', summary: 'Probably an engineer.', refs: [] }],
      talking: [{ text: 'Ask about Q1 dates.', refs: [2] }, { text: 'Invented point.', refs: [99] }],
      watch: [],
    });
    const p = parsePrep(`Here you go: ${reply}`, g.sources);
    expect(p.people).toEqual([{ name: 'Jane Doe', text: 'Product lead at Acme.', refs: [1] }]);
    expect(p.talking).toEqual([{ text: 'Ask about Q1 dates.', refs: [2] }]);
    expect(parsePrep('no json', g.sources)).toBeNull();
  });
  it('links every claim to its source note and says nothing found where the vault has nothing', () => {
    const parsed = { people: [{ name: 'Jane Doe', text: 'Product lead at Acme.', refs: [1] }], talking: [{ text: 'Ask about Q1 dates.', refs: [2] }], watch: [] };
    const text = renderPrep({ event: event(), gathered: g, parsed, now: new Date('2026-11-19T12:00:00Z') });
    const s1 = g.sources.find((s) => s.id === 1), s2 = g.sources.find((s) => s.id === 2);
    expect(text).toContain(`- **Jane Doe**: Product lead at Acme. (${wikiLink(s1)})`);
    expect(text).toContain('- **Sam Lee**: Nothing found.');
    expect(text).toContain(`1. Ask about Q1 dates. (${wikiLink(s2)})`);
    expect(text).toContain('[[people/jane-doe|Jane Doe]]');
    expect(text).not.toContain('## Watch out for');
    expect(text).toMatch(/^---\ntype: meeting-prep\ngenerated_by: quorum\n/);
    expect(text).not.toContain('- [ ]');
  });
});

describe('where the note goes', () => {
  it('sits in a prep folder in the daily folder, else the meetings folder', () => {
    expect(prepRel({ daily: '01-daily', meetings: 'meetings', event: event() })).toBe('01-daily/prep/2026-11-19 Acme roadmap review.md');
    expect(prepRel({ meetings: 'meetings', event: event({ title: 'A/B: test?' }) })).toBe('meetings/prep/2026-11-19 A B test.md');
    expect(prepRel({ event: event() })).toBe('prep/2026-11-19 Acme roadmap review.md');
    expect(isPrepRel('01-daily/prep/2026-11-19 Acme roadmap review.md')).toBe(true);
    expect(isPrepRel('01-daily/2026-11-19.md')).toBe(false);
  });
});
