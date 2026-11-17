// Check everything now: the plan before a pass, the note count, what a pass added, the last pass on disk, and the
// words the app shows for them. Every number here is made up.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PAIRS_PER_NOTE, SECONDS_PER_CALL, createLastRunStore, diffReview, planOf, progressOf, secondsPerCall } from '../catchupPlan.js';
import { CONFIRM_AFTER_MS, STOP_BODY, STOP_TITLE, addedText, duration, needsConfirm, planRows, planSentence, progressShare, progressText, showSummary, summaryOf } from '../src/catchupView.ts';

let dirs = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });
const tmp = () => { const d = mkdtempSync(path.join(tmpdir(), 'qplan-')); dirs.push(d); return d; };

describe('the plan before a pass', () => {
  it('counts the notes to check with the saved ones, and estimates pairs and time from defaults', () => {
    const p = planOf({ saved: 300, read: 100, claimCalls: 10, draftCalls: 4 });
    expect(p.toCheck).toBe(400);
    expect(p.saved).toBe(300);
    expect(p.pairs).toBe(Math.round(100 * PAIRS_PER_NOTE));
    expect(p.seconds).toBe((10 + 4 + p.pairs) * SECONDS_PER_CALL);
  });
  it('learns the pairs per note from the stored verdicts once enough notes were read', () => {
    expect(planOf({ read: 100, claimed: 200, judged: 20 }).pairs).toBe(10);
    // too few notes read to say: the default applies
    expect(planOf({ read: 100, claimed: 10, judged: 9 }).pairs).toBe(Math.round(100 * PAIRS_PER_NOTE));
  });
  it('takes the time per call from the last pass, within bounds', () => {
    expect(secondsPerCall(null)).toBe(SECONDS_PER_CALL);
    expect(secondsPerCall({ done: 2, startedAt: 0, endedAt: 600000 })).toBe(SECONDS_PER_CALL);
    expect(secondsPerCall({ done: 10, startedAt: 0, endedAt: 200000 })).toBe(20);
    expect(secondsPerCall({ done: 10, startedAt: 0, endedAt: 10 })).toBe(5);
    expect(planOf({ claimCalls: 3 }, { done: 10, startedAt: 0, endedAt: 300000 }).seconds).toBe(3 * 30);
  });
});

describe('the note count while a pass runs', () => {
  it('starts at the saved notes, so a resumed pass never reads 0 of N', () => {
    expect(progressOf(0, { saved: 120, read: 0, left: 80 })).toEqual({ checked: 120, of: 200 });
  });
  it('never lowers the total during a pass', () => {
    expect(progressOf(200, { saved: 120, read: 40, left: 10 })).toEqual({ checked: 160, of: 200 });
    expect(progressOf(200, { saved: 120, read: 40, left: 90 })).toEqual({ checked: 160, of: 250 });
  });
});

describe('what a pass added to Needs review', () => {
  it('counts new contradictions, drafted fixes and other items, and the drafts it added to items already there', () => {
    const before = [{ id: 'a', type: 'other', drafted: false }, { id: 'b', type: 'other', drafted: true }, { id: 'c', type: 'contradiction', drafted: false }];
    const after = [
      { id: 'a', type: 'other', drafted: true },
      { id: 'b', type: 'other', drafted: true },
      { id: 'c', type: 'contradiction', drafted: false },
      { id: 'd', type: 'contradiction', drafted: false },
      { id: 'e', type: 'other', drafted: true },
      { id: 'f', type: 'other', drafted: false },
    ];
    expect(diffReview(before, after)).toEqual({ contradictions: 1, drafts: 2, other: 1, ids: ['a', 'd', 'e', 'f'] });
  });
  it('adds nothing when the list is the same', () => {
    const list = [{ id: 'a', type: 'other', drafted: false }];
    expect(diffReview(list, list)).toEqual({ contradictions: 0, drafts: 0, other: 0, ids: [] });
  });
});

describe('the last pass on disk', () => {
  it('reads back what was saved, and a pass saved as running as crashed at its last save', () => {
    const file = path.join(tmp(), 'last.json');
    const store = createLastRunStore(file, () => 9000);
    expect(store.load()).toBeNull();
    store.save({ end: 'done', done: 4, total: 4, notes: 10, startedAt: 1000, endedAt: 8000 });
    expect(store.load()).toMatchObject({ end: 'done', endedAt: 8000 });
    store.save({ end: 'running', done: 2, total: 4, notes: 10, startedAt: 1000 });
    expect(store.load()).toMatchObject({ end: 'crashed', endedAt: 9000, done: 2 });
  });
  it('reads a broken file as no last pass', () => {
    const file = path.join(tmp(), 'last.json');
    writeFileSync(file, '{not json');
    expect(createLastRunStore(file).load()).toBeNull();
  });
});

describe('the words the app shows', () => {
  it('asks before Cancel only after the first minute', () => {
    expect(needsConfirm(0, CONFIRM_AFTER_MS - 1000)).toBe(false);
    expect(needsConfirm(0, CONFIRM_AFTER_MS)).toBe(false);
    expect(needsConfirm(0, CONFIRM_AFTER_MS + 1)).toBe(true);
    expect(needsConfirm(null, 10 * CONFIRM_AFTER_MS)).toBe(false);
    expect(STOP_TITLE).toBe('Stop the check?');
    expect(STOP_BODY).toBe('What it found so far is kept. The rest runs later under the daily limit, or when you start the check again.');
  });
  it('rounds a length of time to minutes and hours', () => {
    expect(duration(20)).toBe('under a minute');
    expect(duration(60)).toBe('about 1 minute');
    expect(duration(25 * 60)).toBe('about 25 minutes');
    expect(duration(2 * 3600)).toBe('about 2 hours');
    expect(duration(2 * 3600 + 10 * 60)).toBe('about 2 hours 10 minutes');
  });
  it('lists the plan and marks the estimates', () => {
    const e = { notes: 2000, read: 400, claimCalls: 20, draftCalls: 3, calls: 23, drafting: true, saved: 1100, toCheck: 1500, pairs: 200, seconds: 3 * 3600 };
    const rows = Object.fromEntries(planRows(e));
    expect(rows['Notes to check']).toBe('1,500 notes');
    expect(rows['Already checked']).toBe('1,100 notes, saved from earlier checks');
    expect(rows['Left to read']).toBe('400 notes');
    expect(rows['Pairs to judge']).toBe('About 200, an estimate');
    expect(rows.Time).toBe('About 3 hours, an estimate');
    expect(planSentence(e)).toBe('1,500 notes to check (1,100 already checked), about 200 pairs to judge, about 3 hours. The pairs and the time are estimates.');
    // an older main without the plan fields
    expect(Object.fromEntries(planRows({ notes: 5, read: 5, claimCalls: 1, draftCalls: 0, calls: 1, drafting: true }))).toEqual({ 'Notes to check': '5 notes', 'Left to read': '5 notes' });
  });
  it('shows the notes checked of the notes to check, or the calls before it knows them', () => {
    const run = { running: true, done: 3, total: 10, notes: 50, id: 'x' };
    expect(progressText({ ...run, checked: 120, of: 1470 })).toBe('Checked 120 of 1,470 notes');
    expect(progressShare({ ...run, checked: 735, of: 1470 })).toBe(0.5);
    expect(progressText(run)).toBe('Checking all 50 notes: 3 of 10 calls');
    expect(progressShare(run)).toBe(0.3);
  });
  it('sums up the last pass, with a crash read as stopped early', () => {
    const last = { end: 'crashed', done: 9, total: 30, notes: 50, startedAt: 0, endedAt: 60000, checked: 40, of: 50, added: { contradictions: 2, drafts: 1, other: 0, ids: ['a', 'b', 'c'] } };
    const s = summaryOf(last);
    expect(s.head).toBe('Stopped early');
    expect(s.state).toBe('error');
    expect(s.line).toBe('Checked 40 of 50 notes. Quorum closed while it ran. What it checked until then is saved.');
    expect(s.added).toBe('Added to Needs review: 2 contradictions, 1 drafted fix.');
    expect(s.ids).toEqual(['a', 'b', 'c']);
    expect(summaryOf({ ...last, end: 'done', added: null }).state).toBe('success');
    expect(addedText({ contradictions: 0, drafts: 0, other: 0, ids: [] })).toBe('It added nothing to Needs review.');
    expect(showSummary({ running: false, last })).toBe(true);
    expect(showSummary({ running: false, last: { ...last, dismissed: true } })).toBe(false);
    expect(showSummary({ running: true, done: 0, total: 0, notes: 0, id: 'x' })).toBe(false);
  });
});
