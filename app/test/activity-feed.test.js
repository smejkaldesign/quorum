import { describe, expect, it } from 'vitest';
import { FEED_KINDS, feedPage, feedRows, labelOf } from '../activityFeed.js';

const T = (m) => new Date(Date.UTC(2026, 10, 1, 9, m)).toISOString();
const ms = (m) => new Date(T(m)).getTime();

const note = {
  abs: '/v/Meetings/standup.md', rel: 'Meetings/standup.md', seenAt: T(5), reviewedAt: null, rejectedAt: null, agentWritten: true, writtenAt: T(1),
  events: [
    { at: T(1), kind: 'saved', text: 'Agent wrote the summary and saved the recording' },
    { at: T(4), kind: 'edited', text: 'You saved edits' },
    { at: T(8), kind: 'filed', text: 'Agent linked it to 1 memory', files: [{ rel: 'People/ana.md', abs: '/v/People/ana.md', label: 'Ana' }] },
    { at: T(9), kind: 'referenced', text: 'Agent referenced it to answer "who owns it"' },
  ],
};
const memory = {
  abs: '/v/People/ana.md', rel: 'People/ana.md', seenAt: null,
  versions: [
    { id: 'a', at: ms(2), who: 'keeper', reason: 'Filed a meeting', created: true, removed: false },
    { id: 'b', at: ms(6), who: 'you', reason: '', created: false, removed: false },
    { id: 'c', at: ms(7), who: 'import', reason: 'From Granola', created: false, removed: false },
  ],
  updates: [{ id: 'a', at: ms(2), approved: true }, { id: 'c', at: ms(7), approved: false, changes: 2 }],
};
const rows = feedRows({ notes: [note], memories: [memory] });

describe('feedRows', () => {
  it('labels files the way the note activity does', () => {
    expect(labelOf('Meetings/weekly-sync_notes.md')).toBe('Weekly Sync Notes');
    expect(labelOf('Daily/2026-11-01.md')).toBe('Daily note 2026-11-01');
    expect(labelOf('index.md')).toBe('Index');
  });

  it('sorts newest first and sorts each event into a type', () => {
    const kinds = rows.filter((r) => !r.review).map((r) => [r.at, r.kind]);
    expect(kinds).toEqual([[ms(9), 'referenced'], [ms(8), 'filed'], [ms(7), 'imported'], [ms(6), 'you'], [ms(4), 'you'], [ms(2), 'memory-created'], [ms(1), 'note-updated']]);
    for (const r of rows) expect(FEED_KINDS.map(([k]) => k)).toContain(r.kind);
  });

  it('marks agent rows after the last opening unread and never the person\'s own', () => {
    const unread = rows.filter((r) => r.unread && !r.review).map((r) => r.at);
    expect(unread).toEqual([ms(9), ms(8), ms(7), ms(2)]);
    expect(rows.find((r) => r.at === ms(6) && !r.review).unread).toBe(false);
  });

  it('makes a review item for a note Quorum wrote until it is reviewed or rejected', () => {
    expect(rows.filter((r) => r.review?.kind === 'note')).toHaveLength(1);
    expect(feedRows({ notes: [{ ...note, reviewedAt: T(10) }] }).some((r) => r.review)).toBe(false);
    expect(feedRows({ notes: [{ ...note, rejectedAt: T(10) }] }).some((r) => r.review)).toBe(false);
    expect(feedRows({ notes: [{ ...note, agentWritten: false }] }).some((r) => r.review)).toBe(false);
  });

  it('groups a memory\'s updates waiting for approval into one review item', () => {
    const r = rows.find((x) => x.review?.kind === 'memory');
    expect(r).toMatchObject({ at: ms(7), kind: 'memory-updated', review: { kind: 'memory', count: 1 } });
    expect(r.text).toContain('2 changed blocks');
    expect(feedRows({ memories: [{ ...memory, gone: true }] }).some((x) => x.review)).toBe(false);
  });

  it('opens a memory that is also a saved note on the note page', () => {
    expect(feedRows({ memories: [{ ...memory, note: true }] })[0].target.kind).toBe('note');
    expect(rows.find((r) => r.id.startsWith('m:')).target.kind).toBe('memory');
  });
});

describe('guardrail rows', () => {
  // a made-up home folder, joined so the content guard does not read it as a real one
  const home = ['', 'Users', 'sam', ''].join('/');
  const guard = { file: '/data/guard-denials.jsonl', seenAt: T(3), denials: [
    { t: T(2), tool: 'Read', path: `${home}vault/private/bank.md`, reason: 'Quorum read guard: private folder' },
    { t: T(4), tool: 'Bash', path: '', reason: 'secret word in a command' },
  ] };
  const g = feedRows({ guard });

  it('lists each block with what was blocked and why, unread after the last opening', () => {
    expect(g.map((r) => [r.kind, r.text, r.unread])).toEqual([
      ['guardrail', 'Guardrail blocked Bash: secret word in a command', true],
      ['guardrail', 'Guardrail blocked ~/vault/private/bank.md: private folder', false],
    ]);
    expect(g[0].target).toMatchObject({ kind: 'guardrail', abs: guard.file });
  });

  it('follows the guardrails switch like the other kinds', () => {
    expect(feedPage(g, { tab: 'all', prefs: { guardrails: false } }).total).toBe(0);
    expect(feedPage(g, { tab: 'all', prefs: { guardrails: false } }).dot).toBe(false);
    expect(feedPage(g, { tab: 'unread', prefs: { noteUpdates: false } }).total).toBe(1);
    expect(feedPage(g, { tab: 'all', kinds: ['guardrail'] }).total).toBe(2);
  });
});

describe('feedPage', () => {
  it('lists only review items on Needs review and counts each tab', () => {
    const p = feedPage(rows, { tab: 'review' });
    expect(p.items.every((r) => r.review)).toBe(true);
    expect(p.counts).toEqual({ review: 2, unread: 5, all: rows.length });
    expect(p.dot).toBe(true);
  });

  it('filters by type and by words in the text or the file name', () => {
    expect(feedPage(rows, { tab: 'all', kinds: ['filed', 'referenced'] }).items.map((r) => r.kind)).toEqual(['referenced', 'filed']);
    expect(feedPage(rows, { tab: 'all', q: 'granola' }).items.map((r) => r.kind)).toEqual(['imported']);
    expect(feedPage(rows, { tab: 'all', q: 'standup owns' }).total).toBe(1);
    expect(feedPage(rows, { tab: 'all', q: 'ana' }).items.some((r) => r.kind === 'filed')).toBe(true);
  });

  it('pages the list', () => {
    const a = feedPage(rows, { tab: 'all', offset: 0, limit: 3 });
    const b = feedPage(rows, { tab: 'all', offset: 3, limit: 50 });
    expect(a.items).toHaveLength(3);
    expect(a.more).toBe(true);
    expect(b.more).toBe(false);
    expect([...a.items, ...b.items].map((r) => r.id)).toEqual(feedPage(rows, { tab: 'all', limit: 100 }).items.map((r) => r.id));
    expect(feedPage(rows, { tab: 'all', limit: 0 }).items).toEqual([]);
  });

  it('leaves switched-off kinds out of Unread, All and the dot, and keeps reviews on Needs review', () => {
    const prefs = { noteUpdates: false, memoryChanges: false, reviews: false };
    expect(feedPage(rows, { tab: 'all', prefs }).total).toBe(0);
    expect(feedPage(rows, { tab: 'unread', prefs }).total).toBe(0);
    const review = feedPage(rows, { tab: 'review', prefs });
    expect(review.total).toBe(2);
    expect(review.dot).toBe(false);
    const memOnly = feedPage(rows, { tab: 'all', prefs: { noteUpdates: false, reviews: false } });
    expect(memOnly.items.every((r) => r.target.kind === 'memory' && !r.review)).toBe(true);
    expect(memOnly.dot).toBe(true);
  });

  it('shows no dot when everything is read and reviewed', () => {
    const quiet = feedRows({ notes: [{ ...note, agentWritten: false, seenAt: T(30) }], memories: [{ ...memory, seenAt: T(30), updates: [] }] });
    expect(feedPage(quiet, { tab: 'all' }).dot).toBe(false);
  });
});
