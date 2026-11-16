import { describe, expect, it } from 'vitest';
import { FEED_KINDS, FEED_SORTS, feedPage, feedRows, labelOf } from '../activityFeed.js';

const T = (m) => new Date(Date.UTC(2026, 10, 1, 9, m)).toISOString();
const ms = (m) => new Date(T(m)).getTime();

// a vault seen before and after Notifications began keeping marks (at minute 10)
const note = {
  abs: '/v/Meetings/2026-11-01-standup-f55bd1f8.md', rel: 'Meetings/2026-11-01-standup-f55bd1f8.md', title: 'Weekly standup',
  seenAt: T(5), reviewedAt: null, rejectedAt: null, agentWritten: true, writtenAt: T(1), writtenFrom: 'recording',
  events: [
    { at: T(1), kind: 'saved', text: 'Agent wrote the summary and saved the recording' },
    { at: T(4), kind: 'edited', text: 'You saved edits' },
    { at: T(19), kind: 'referenced', text: 'Agent referenced it to answer "who owns the launch"' },
  ],
  runs: [{ at: T(8), files: [{ rel: 'People/ana.md', abs: '/v/People/ana.md', label: 'Ana', title: 'Ana' }] }, { at: T(12), files: [] }],
};
const imported = { abs: '/v/Granola/kickoff.md', rel: 'Granola/kickoff.md', title: 'Kickoff', events: [], runs: [], imported: { at: ms(3), source: 'granola', sourceName: 'Granola', date: '2026-10-30' }, seenAt: null };
const memory = {
  abs: '/v/People/ana.md', rel: 'People/ana.md', title: 'Ana', seenAt: null,
  versions: [
    { id: 'a', at: ms(2), who: 'keeper', reason: 'Filed a meeting', created: true, removed: false },
    { id: 'b', at: ms(6), who: 'you', reason: '', created: false, removed: false },
    { id: 'c', at: ms(15), who: 'import', reason: 'From Granola', created: false, removed: false },
    { id: 'd', at: ms(17), who: 'keeper', reason: 'Filed the standup', created: false, removed: false },
  ],
  updates: [{ id: 'a', at: ms(2), approved: true, auto: true, changes: 1 }, { id: 'd', at: ms(17), approved: false, changes: 2, reason: 'Filed the standup' }],
};
const denials = [{ id: 'g1', t: T(16), path: '/x/private/bank.md', tool: 'Read', surface: 'agent', reason: 'Inside a private folder', guard: 'privateDirs', guardLabel: 'Private folders' }];
const state = { since: T(10), read: {}, unread: {} };
const rows = feedRows({ notes: [note, imported], memories: [memory], denials, state, guardFile: '/data/guard-denials.jsonl' });
const byId = (id) => rows.find((r) => r.id === id);

describe('feedRows', () => {
  it('reads file names the way the person named them', () => {
    expect(labelOf('Meetings/2026-11-15-kjhkjhkjh-f55bd1f8.md')).toBe('Kjhkjhkjh');
    expect(labelOf('Daily/2026-11-01.md')).toBe('Daily note 2026-11-01');
  });

  it('gives every row a kind from the Type list and a summary', () => {
    const known = FEED_KINDS.map(([k]) => k);
    for (const r of rows) { expect(known).toContain(r.kind); expect(r.summary.line).toBeTruthy(); }
  });

  it('marks rows from before Notifications began as history that starts out read', () => {
    const history = rows.filter((r) => r.backfill).map((r) => r.id).sort();
    expect(history).toEqual([`i:${imported.abs}`, `m:People/ana.md:a`, `m:People/ana.md:b`, `n:${note.abs}:${ms(1)}:saved`, `n:${note.abs}:${ms(4)}:edited`, `t:${note.rel}:${ms(8)}`].sort());
    expect(rows.filter((r) => r.backfill).every((r) => !r.unread)).toBe(true);
  });

  it('marks agent rows since then unread, the person\'s own never, and a mark on a row wins', () => {
    expect(rows.filter((r) => r.unread).map((r) => r.id).sort()).toEqual(['g:g1', `m:People/ana.md:c`, `m:People/ana.md:d`, `n:${note.abs}:${ms(19)}:referenced`, 'r:memory:People/ana.md', `t:${note.rel}:${ms(12)}`].sort());
    const marked = feedRows({ notes: [note], memories: [memory], denials, state: { since: T(10), read: { 'g:g1': T(20) }, unread: { [`t:${note.rel}:${ms(8)}`]: T(20) } } });
    expect(marked.find((r) => r.id === 'g:g1').unread).toBe(false);
    expect(marked.find((r) => r.id === `t:${note.rel}:${ms(8)}`).unread).toBe(true);
  });

  it('keeps review items out of history and joins a version to its update', () => {
    expect(byId(`r:note:${note.abs}`)).toMatchObject({ backfill: false, review: { kind: 'note' } });
    expect(byId('r:memory:People/ana.md')).toMatchObject({ review: { kind: 'memory', count: 1 }, detail: { changes: 2 } });
    expect(byId('m:People/ana.md:a').detail).toMatchObject({ changes: 1, approved: true, auto: true });
  });

  it('drops a note review once it is reviewed or rejected', () => {
    expect(feedRows({ notes: [{ ...note, reviewedAt: T(30) }] }).some((r) => r.review)).toBe(false);
    expect(feedRows({ notes: [{ ...note, rejectedAt: T(30) }] }).some((r) => r.review)).toBe(false);
  });
});

describe('feedPage', () => {
  it('counts All, Unread and Needs review, and shows the dot', () => {
    const p = feedPage(rows);
    expect(p.counts).toEqual({ all: rows.length, unread: 6, review: 2 });
    expect(p.dot).toBe(true);
  });

  it('narrows to review items with the Needs review filter, on either tab', () => {
    expect(feedPage(rows, { review: true }).items.map((r) => r.id).sort()).toEqual([`r:note:${note.abs}`, 'r:memory:People/ana.md'].sort());
    expect(feedPage(rows, { tab: 'unread', review: true }).items.map((r) => r.id)).toEqual(['r:memory:People/ana.md']);
  });

  it('sorts unread first, by time, or by title', () => {
    expect(FEED_SORTS).toEqual(['unread', 'recent', 'az']);
    const u = feedPage(rows, { sort: 'unread', limit: 100 }).items;
    const firstRead = u.findIndex((r) => !r.unread);
    expect(u.slice(firstRead).every((r) => !r.unread)).toBe(true);
    const recent = feedPage(rows, { sort: 'recent', limit: 100 }).items.map((r) => r.at);
    expect(recent).toEqual([...recent].sort((a, b) => b - a));
    const az = feedPage(rows, { sort: 'az', limit: 100 }).items.map((r) => r.target.title);
    expect(az[0]).toBe('Ana');
    expect(az[az.length - 1]).toBe('Weekly standup');
  });

  it('filters by type and by words in the summary or file', () => {
    expect(feedPage(rows, { kinds: ['guardrail', 'referenced'] }).items.map((r) => r.kind).sort()).toEqual(['guardrail', 'referenced']);
    expect(feedPage(rows, { q: 'launch' }).total).toBe(1);
    expect(feedPage(rows, { q: 'bank.md' }).items[0].kind).toBe('guardrail');
  });

  it('adds the details to each row on the page and pages the list', () => {
    const a = feedPage(rows, { sort: 'recent', offset: 0, limit: 4 });
    expect(a.items[0].details[0]).toEqual(['What', expect.any(String)]);
    expect(a.more).toBe(true);
    expect(feedPage(rows, { limit: 0 }).items).toEqual([]);
  });

  it('follows the Settings > Notifications switches and keeps reviews in Needs review', () => {
    const off = { noteUpdates: false, memoryChanges: false, reviews: false, guardrails: false };
    expect(feedPage(rows, { prefs: off }).total).toBe(0);
    expect(feedPage(rows, { prefs: off }).dot).toBe(false);
    expect(feedPage(rows, { prefs: off, review: true }).total).toBe(2);
    expect(feedPage(rows, { prefs: { guardrails: false }, kinds: ['guardrail'] }).total).toBe(0);
  });
});

// a fixture with the history a vault has before the list kept its own log: what the backfill brings back
describe('backfill fixture', () => {
  const versions = Array.from({ length: 6 }, (_, i) => ({ id: `v${i}`, at: ms(i), who: i % 3 === 2 ? 'you' : 'keeper', reason: 'Filed a meeting', created: i === 0, removed: false }));
  const notes = [
    { abs: '/v/Granola/a.md', rel: 'Granola/a.md', title: 'Design review', events: [], runs: [{ at: T(1), files: [] }], imported: { at: ms(0), source: 'granola', sourceName: 'Granola' } },
    { abs: '/v/Granola/b.md', rel: 'Granola/b.md', title: 'Pricing call', events: [], runs: [{ at: T(2), files: [{ rel: 'P/x.md', abs: '/v/P/x.md', title: 'X' }] }], imported: { at: ms(1), source: 'granola', sourceName: 'Granola' } },
    { abs: '/v/Q/c.md', rel: 'Q/c.md', title: 'Standup', events: [{ at: T(3), kind: 'saved', text: 'You saved the note' }], runs: [{ at: T(4), files: [] }] },
  ];
  const r = feedRows({ notes, memories: [{ abs: '/v/P/x.md', rel: 'P/x.md', title: 'X', versions, updates: [] }], state: { since: T(30) } });

  it('lists 12 past events, all read, with no bell dot', () => {
    expect(r.length).toBe(12);
    expect(r.every((x) => x.backfill && !x.unread)).toBe(true);
    expect(feedPage(r).dot).toBe(false);
    expect(feedPage(r, { tab: 'unread' }).total).toBe(0);
  });
});
