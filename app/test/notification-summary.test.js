import { describe, expect, it } from 'vitest';
import { detailsOf, summaryOf, titleOf } from '../notificationSummary.js';

const at = Date.UTC(2026, 10, 15, 9, 0);
const note = (over = {}) => ({ id: 'x', at, kind: 'filed', event: 'filed', who: 'agent', target: { kind: 'note', abs: '/v/a.md', rel: 'Meetings/a.md', title: 'Pricing call' }, files: [], detail: {}, ...over });

describe('titleOf', () => {
  it('prefers the given title, then the first heading, then a cleaned file name', () => {
    expect(titleOf({ title: 'Board prep', h1: 'Other', rel: 'x.md' })).toBe('Board prep');
    expect(titleOf({ h1: 'Board prep', rel: 'x.md' })).toBe('Board prep');
    expect(titleOf({ rel: 'Meetings/2026-11-15-kjhkjhkjh-f55bd1f8.md' })).toBe('Kjhkjhkjh');
    expect(titleOf({ rel: 'Meetings/2026-11-15_10-30-design-review.md' })).toBe('Design review');
    expect(titleOf({ rel: 'Meetings/2026-11-15-f55bd1f8.md' })).toBe('Note from 2026-11-15');
    expect(titleOf({ rel: 'index.md' })).toBe('Index');
  });
});

describe('summaryOf', () => {
  it('says what upkeep did with a note and names the memories it linked', () => {
    const files = ['Ana', 'Launch plan', 'Pricing', 'Q4 goals'].map((t) => ({ rel: `${t}.md`, abs: `/v/${t}.md`, title: t }));
    expect(summaryOf(note({ files }))).toEqual({ line: 'Filed “Pricing call” into your memory', sub: 'Linked it to Ana, Launch plan, Pricing and 1 more.' });
    expect(summaryOf(note({ files: files.slice(0, 2) })).sub).toBe('Linked it to Ana and Launch plan.');
    expect(summaryOf(note())).toEqual({ line: 'Checked “Pricing call” against your memory', sub: 'Nothing needed a new link or an update.' });
    expect(summaryOf(note({ detail: { skipped: 'it is a private note' } }))).toEqual({ line: 'Left “Pricing call” as it is', sub: 'It is a private note.' });
  });

  it('describes the note log in plain words', () => {
    expect(summaryOf(note({ kind: 'referenced', event: 'referenced', detail: { text: 'Agent referenced it to answer "who owns pricing"' } }))).toEqual({ line: 'Used “Pricing call” to answer a question', sub: 'You asked “who owns pricing”.' });
    expect(summaryOf(note({ kind: 'note-updated', event: 'saved' })).line).toBe('Wrote the summary of “Pricing call”');
    expect(summaryOf(note({ kind: 'you', event: 'saved', who: 'you' })).line).toBe('You saved “Pricing call”');
    expect(summaryOf(note({ kind: 'note-updated', event: 'named', detail: { text: 'Agent named it "Pricing call with Ana"' } })).line).toBe('Named a new note “Pricing call with Ana”');
  });

  it('describes memory changes with their reason and size', () => {
    const mem = (detail, over = {}) => note({ kind: 'memory-updated', event: 'version', target: { kind: 'memory', abs: '/v/Ana.md', rel: 'People/Ana.md', title: 'Ana' }, detail, ...over });
    expect(summaryOf(mem({ reason: 'filed the pricing call', changes: 3 }))).toEqual({ line: 'Updated the memory “Ana”', sub: 'Filed the pricing call. 3 changed blocks.' });
    expect(summaryOf(mem({ created: true, reason: '' }, { kind: 'memory-created' }))).toEqual({ line: 'Created the memory “Ana”', sub: null });
    expect(summaryOf(mem({ reason: 'Restored the version from Nov 3' }, { kind: 'you', who: 'you' })).line).toBe('You restored an earlier version of “Ana”');
  });

  it('names the app an imported meeting came from', () => {
    expect(summaryOf(note({ kind: 'imported', event: 'imported-note', detail: { sourceName: 'Granola', date: '2026-10-30' } }))).toEqual({ line: 'Imported “Pricing call” from Granola', sub: 'Meeting on Fri, Oct 30.' });
  });

  it('says what a guardrail stopped and which rule', () => {
    const g = (detail) => note({ kind: 'guardrail', event: 'denial', target: { kind: 'guardrail', abs: '', rel: 'Guardrails', title: 'Guardrails' }, detail });
    expect(summaryOf(g({ tool: 'Read', path: '/v/private/bank.md', surface: 'agent', guardLabel: 'Private folders', reason: 'inside a private folder' })))
      .toEqual({ line: 'Blocked the agent from reading bank.md', sub: 'Private folders rule: inside a private folder.' });
    expect(summaryOf(g({ tool: 'Bash', path: '', surface: 'keeper', guardLabel: 'Secrets' })).line).toBe('Blocked upkeep from running a command');
  });

  it('asks a question with a suggested answer and why for a decision', () => {
    const rev = summaryOf(note({ kind: 'note-written', event: 'review', review: { kind: 'note' }, detail: { writtenFrom: 'recording' } }));
    expect(rev.line).toBe('Keep “Pricing call” as Quorum wrote it?');
    expect(rev.ask.suggest).toBe('approve');
    expect(rev.sub).toMatch(/^Suggested: approve\. Quorum wrote it from your own recording/);
    const small = summaryOf(note({ kind: 'memory-updated', event: 'review', review: { kind: 'memory', count: 2 }, detail: { changes: 3, reason: 'Filed the pricing call' } }));
    expect(small.line).toBe('Keep the agent’s 2 updates to “Pricing call”?'.replace('’', "'"));
    expect(small.sub).toBe('Suggested: approve. A small change (3 changed blocks) the agent made when it filed the pricing call.');
    const big = summaryOf(note({ kind: 'memory-updated', event: 'review', review: { kind: 'memory', count: 1 }, detail: { changes: 40 } }));
    expect(big.ask.suggest).toBe('reject');
    expect(big.sub).toMatch(/^Suggested: disapprove\. It rewrites a large part of the page \(40 changed blocks\)/);
  });
});

describe('detailsOf', () => {
  it('lists what is known about a guardrail block', () => {
    const d = detailsOf(note({ kind: 'guardrail', event: 'denial', target: { kind: 'guardrail', abs: '', rel: 'Guardrails', title: 'Guardrails' }, detail: { tool: 'Read', path: '/v/private/bank.md', surface: 'agent', guardLabel: 'Private folders', reason: 'inside a private folder' } }));
    expect(Object.fromEntries(d)).toMatchObject({ What: 'Guardrail blocked', Rule: 'Private folders', Tool: 'Read', Where: 'The agent, answering in chat', Path: '/v/private/bank.md', Reason: 'inside a private folder' });
  });

  it('lists the file, who, the size and approval of a memory change, and says when it is history', () => {
    const d = Object.fromEntries(detailsOf(note({ kind: 'memory-updated', event: 'version', backfill: true, target: { kind: 'memory', abs: '/v/Ana.md', rel: 'People/Ana.md', title: 'Ana' }, detail: { who: 'keeper', reason: 'Filed a meeting', changes: 2, approved: true, auto: true } })));
    expect(d).toMatchObject({ Memory: 'People/Ana.md', By: 'Upkeep', Reason: 'Filed a meeting', Changes: '2 changed blocks', Approval: 'Approved automatically' });
    expect(d.History).toMatch(/starts out read/);
  });
});

describe('meeting dates in summaries', () => {
  it('reads a timestamp and a bare day the same way', async () => {
    const { meetingDay } = await import('../notificationSummary.js');
    expect(meetingDay('2026-11-12T15:00:00.000-08:00')).toBe('Thu, Nov 12');
    expect(meetingDay('2026-11-12')).toBe('Thu, Nov 12');
    expect(meetingDay('soon')).toBe('soon');
  });
});
