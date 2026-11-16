import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FULL_EVERY, IDLE_FOR, INCREMENTAL_EVERY, createMemorySweep, dueSweep, scanTags } from '../memorySweep.js';
import { parseNote } from '../linkparse.js';
import { feedRows } from '../activityFeed.js';

let dir;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });
const fresh = () => { dir = mkdtempSync(path.join(tmpdir(), 'qsweep-')); return dir; };
const NOW = Date.UTC(2026, 10, 15, 12);
const note = (rel, text, mtime = NOW - 1000) => ({ rel, text, note: parseNote(rel, text), mtime, size: text.length, inbound: 1, outbound: 1 });
const stale = (rel, mtime) => note(rel, '---\nstatus: draft\nupdated: 2026-01-01\n---\n# Old plan', mtime);

describe('sweep cadence', () => {
  it('runs a first sweep at once, then incremental every 3.5 hours', () => {
    expect(dueSweep(null, { now: NOW })).toBe('first');
    const s = { lastFull: NOW, lastIncremental: NOW };
    expect(dueSweep(s, { now: NOW + INCREMENTAL_EVERY - 1 })).toBeNull();
    expect(dueSweep(s, { now: NOW + INCREMENTAL_EVERY })).toBe('incremental');
  });
  it('runs the daily full sweep only while the person is away and nothing records', () => {
    const s = { lastFull: NOW - FULL_EVERY, lastIncremental: NOW };
    expect(dueSweep(s, { now: NOW, idleMs: IDLE_FOR })).toBe('full');
    expect(dueSweep(s, { now: NOW, idleMs: IDLE_FOR - 1 })).toBeNull();
    expect(dueSweep(s, { now: NOW, idleMs: IDLE_FOR, recording: true })).toBeNull();
  });
  it('runs nothing while paused', () => {
    expect(dueSweep(null, { now: NOW, paused: true })).toBeNull();
    expect(dueSweep({ lastFull: 1, lastIncremental: 1 }, { now: NOW, paused: true, idleMs: IDLE_FOR })).toBeNull();
  });
});

describe('sweep state', () => {
  it('keeps the time a finding was first seen, checks only changed notes on save, and drops findings on gone notes', () => {
    fresh();
    let t = NOW;
    const sw = createMemorySweep({ file: path.join(dir, 'f.json'), now: () => t });
    const a = stale('p/a.md', NOW - 5000);
    const b = stale('p/b.md', NOW - 5000);
    const s1 = sw.run('/v', 'first', { notes: [a, b], resolve: () => null });
    expect(s1.findings.map((f) => [f.rel, f.at, f.initial])).toEqual([['p/a.md', NOW, true], ['p/b.md', NOW, true]]);
    t = NOW + 1000;
    const fixedA = note('p/a.md', '---\nstatus: done\n---\n# Old plan');
    const s2 = sw.run('/v', 'save', { notes: [fixedA, b], resolve: () => null }, { only: ['p/a.md'] });
    expect(s2.findings.map((f) => f.rel)).toEqual(['p/b.md']);
    expect(s2.findings[0].at).toBe(NOW);
    expect(s2.last).toMatchObject({ kind: 'save', notes: 1, found: 1 });
    const s3 = sw.run('/v', 'incremental', { notes: [fixedA], resolve: () => null });
    expect(s3.findings).toEqual([]);
    expect(createMemorySweep({ file: path.join(dir, 'f.json') }).state('/v').lastIncremental).toBe(NOW + 1000);
  });
  it('checks only the notes changed since the last sweep on an incremental one', () => {
    fresh();
    let t = NOW;
    const sw = createMemorySweep({ file: path.join(dir, 'f.json'), now: () => t });
    sw.run('/v', 'first', { notes: [note('p/ok.md', '# Fine', NOW - 9000)], resolve: () => null });
    t = NOW + 10;
    const s = sw.run('/v', 'incremental', { notes: [note('p/ok.md', '# Fine', NOW - 9000), stale('p/new.md', NOW + 5)], resolve: () => null });
    expect(s.last.notes).toBe(1);
    expect(s.findings.map((f) => [f.rel, f.initial])).toEqual([['p/new.md', false]]);
  });
});

describe('the confidential tag scan', () => {
  it('reads each note’s confidential value from its frontmatter only, and skips excluded paths', () => {
    fresh();
    const put = (rel, text) => { mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); writeFileSync(path.join(dir, rel), text); };
    put('a/tagged.md', '---\nconfidential: team-only\n---\n# A');
    put('a/plain.md', '# B');
    put('skip/hidden.md', '---\nconfidential: x\n---\n');
    put('.obsidian/x.md', '# no');
    expect(scanTags(dir, (rel) => rel.startsWith('skip/')).sort((x, y) => x.rel.localeCompare(y.rel))).toEqual([{ rel: 'a/plain.md', value: null }, { rel: 'a/tagged.md', value: 'team-only' }]);
  });
});

describe('findings in Notifications', () => {
  const f = { key: 'note.stale:p/a.md', rule: 'Notes that look out of date', rel: 'p/a.md', abs: '/v/p/a.md', title: '“Plan” looks out of date', problem: 'P', proposal: 'Do it.', evidence: ['Status “draft”'], meta: [['Note', 'p/a.md']], at: NOW, initial: false, archived: false };
  it('lists a finding as a review item with no automatic fix', () => {
    const [row] = feedRows({ findings: [f], state: {} });
    expect(row).toMatchObject({ id: 'r:find:note.stale:p/a.md', kind: 'memory-health', review: { kind: 'finding', key: f.key }, unread: true, target: { kind: 'memory', rel: 'p/a.md' } });
    expect(row.summary).toMatchObject({ line: f.title, recommendation: 'Do it.', ask: { suggest: 'dismiss' } });
    expect(row.detail.meta).toEqual(expect.arrayContaining([['Check', f.rule], ['Evidence', 'Status “draft”']]));
  });
  it('starts findings of a first sweep read, and marks archived ones', () => {
    const [row] = feedRows({ findings: [{ ...f, initial: true, archived: true }], state: {} });
    expect(row.unread).toBe(false);
    expect(row.review.left).toBe(true);
  });
});
