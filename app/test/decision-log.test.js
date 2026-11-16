import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DECISIONS, createDecisionLog, fingerprint, trim } from '../decisionLog.js';
import { LINK_RULE, LINK_RULE_VERSION } from '../linkRules.js';

let dir;
const fresh = () => { dir = mkdtempSync(path.join(tmpdir(), 'qdecide-')); return createDecisionLog(dir); };
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });
const finding = (sources, extra = {}) => ({ ruleId: LINK_RULE, ruleVersion: LINK_RULE_VERSION, key: 'orbit', target: 'Orbit', sources, evidence: { links: sources.length, sources }, proposedFix: { action: 'unlink' }, ...extra });

describe('finding fingerprints', () => {
  it('is the same for the same rule, target and linking notes in any order or case', () => {
    expect(fingerprint('link.missing', 'Orbit.md', ['b.md', 'a.md'])).toBe(fingerprint('link.missing', ' orbit ', ['a.md', 'b.md', 'a.md']));
  });
  it('changes with the rule, the target or the linking notes', () => {
    const base = fingerprint('link.missing', 'orbit', ['a.md']);
    expect(fingerprint('link.other', 'orbit', ['a.md'])).not.toBe(base);
    expect(fingerprint('link.missing', 'orbits', ['a.md'])).not.toBe(base);
    expect(fingerprint('link.missing', 'orbit', ['a.md', 'b.md'])).not.toBe(base);
  });
});

describe('decision log', () => {
  it('keeps each decision with its rule, evidence, fix, actor, time and empty team fields', () => {
    const log = fresh();
    const r = log.record('/v1', { ...finding(['a.md']), decision: 'approved', at: 1000 });
    expect(r).toMatchObject({ ruleId: 'link.missing', ruleVersion: LINK_RULE_VERSION, key: 'orbit', fingerprint: fingerprint('link.missing', 'Orbit', ['a.md']), evidence: { links: 1 }, proposedFix: { action: 'unlink' }, decision: 'approved', actor: 'you', at: 1000, owner: null, approver: null });
    expect(DECISIONS).toEqual(['approved', 'archived', 'undone', 'reopened', 'auto']);
  });
  it('refuses an unknown decision and keeps vaults apart', () => {
    const log = fresh();
    expect(log.record('/v1', { ...finding(['a.md']), decision: 'maybe' })).toBeNull();
    log.record('/v1', { ...finding(['a.md']), decision: 'archived' });
    expect(log.list('/v1')).toHaveLength(1);
    expect(log.list('/v2')).toEqual([]);
  });
  it('reads back from disk in a new session', () => {
    const log = fresh();
    log.record('/v1', { ...finding(['a.md']), decision: 'archived' });
    log.record('/v1', { ...finding(['a.md']), decision: 'reopened' });
    const again = createDecisionLog(dir);
    expect(again.list('/v1').map((r) => r.decision)).toEqual(['archived', 'reopened']);
    expect(again.latest('/v1', 'orbit').decision).toBe('reopened');
  });
  it('writes a bulk decision once and reads the latest record of every key in one pass', () => {
    const log = fresh();
    const recs = ['a', 'b', 'c'].map((k) => ({ ...finding([`${k}.md`], { key: k, target: k }), decision: 'archived' }));
    expect(log.recordMany('/v1', [...recs, { ...recs[0], decision: 'nope' }])).toHaveLength(3);
    log.recordMany('/v1', [{ ...recs[1], decision: 'reopened' }]);
    const again = createDecisionLog(dir);
    const latest = again.latestAll('/v1');
    expect([...latest].map(([k, r]) => [k, r.decision])).toEqual([['a', 'archived'], ['b', 'reopened'], ['c', 'archived']]);
    expect(latest.get('b')).toEqual(again.latest('/v1', 'b'));
  });
  it('moves a log that does not parse aside instead of writing over it', () => {
    const log = fresh();
    log.record('/v1', { ...finding(['a.md']), decision: 'archived' });
    writeFileSync(log.file('/v1'), '{"vault":"/v1","records":[{"id"');
    const again = createDecisionLog(dir);
    again.record('/v1', { ...finding(['a.md']), decision: 'approved' });
    const aside = readdirSync(dir).filter((f) => f.includes('.corrupt-'));
    expect(aside).toHaveLength(1);
    expect(readFileSync(path.join(dir, aside[0]), 'utf8')).toBe('{"vault":"/v1","records":[{"id"');
    expect(createDecisionLog(dir).list('/v1').map((r) => r.decision)).toEqual(['approved']);
    expect(readdirSync(dir).some((f) => f.endsWith('.tmp'))).toBe(false);
  });
  it('keeps an archived finding archived until its evidence changes', () => {
    const log = fresh();
    log.record('/v1', { ...finding(['a.md']), decision: 'archived' });
    const same = new Map([['orbit', fingerprint(LINK_RULE, 'Orbit', ['a.md'])]]);
    const grown = new Map([['orbit', fingerprint(LINK_RULE, 'Orbit', ['a.md', 'c.md'])]]);
    expect(log.changedArchives('/v1', same)).toEqual([]);
    expect(log.changedArchives('/v1', grown)).toEqual(['orbit']);
    log.record('/v1', { ...finding(['a.md', 'c.md']), decision: 'reopened', actor: 'quorum' });
    expect(log.changedArchives('/v1', grown)).toEqual([]);
  });
});

describe('decision log cap', () => {
  it('keeps the latest record of every fingerprint when it trims', () => {
    const recs = [
      { id: 'a1', fingerprint: 'A', decision: 'archived' },
      { id: 'b1', fingerprint: 'B', decision: 'approved' },
      { id: 'b2', fingerprint: 'B', decision: 'reopened' },
      { id: 'c1', fingerprint: 'C', decision: 'approved' },
      { id: 'b3', fingerprint: 'B', decision: 'archived' },
    ];
    expect(trim([...recs], 3).map((r) => r.id)).toEqual(['a1', 'c1', 'b3']);
    // more fingerprints than the cap: each keeps its latest record
    expect(trim([...recs], 2).map((r) => r.id)).toEqual(['a1', 'c1', 'b3']);
    expect(trim([...recs], 10)).toHaveLength(5);
  });
});
