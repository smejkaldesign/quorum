import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PRIORS, SHOW_AT, WINDOW, demoted, demotions, expected, gateItem, kindOf, kindOfRecord, logGate, readGateLog, ruleDemotion, runGate, signature, stability, summarize, tallies } from '../qualityGate.js';

const alias = (id = 'r:link:a', extra = {}) => ({ id, kind: 'link', target: 'a', reviewOnly: false, match: { exact: true, score: 1 }, ops: [{ op: 'alias', rel: 'notes/a-note.md', alias: 'a' }], hashes: { 'x.md': 'h1' }, ...extra });
const finding = (ruleId, ops, extra = {}) => ({ id: `r:find:${ruleId}`, kind: 'finding', ruleId, ops, ...extra });
const rec = (ruleId, decision, proposedFix = null, at = undefined) => ({ ruleId, decision, proposedFix, ...(at !== undefined ? { at } : {}) });

describe('kinds', () => {
  it('reads the kind of each item', () => {
    expect(kindOf(alias())).toBe('link:alias');
    expect(kindOf(alias('x', { reviewOnly: true }))).toBe('link:alias-weak');
    expect(kindOf({ id: 'l', kind: 'link', match: { exact: false, score: 0.33 }, ops: [{ op: 'relink', to: 'b.md' }] })).toBe('link:relink-weak');
    expect(kindOf({ id: 'l', kind: 'link', match: { exact: false, score: 0.8 }, ops: [{ op: 'relink', to: 'b.md' }] })).toBe('link:relink');
    expect(kindOf({ id: 'l', kind: 'link', ops: [{ op: 'create', rel: 'a.md' }] })).toBe('link:create');
    expect(kindOf({ id: 'p', kind: 'pastfix', ops: [{ op: 'trash', rel: 'a.md' }] })).toBe('pastfix:undo');
    expect(kindOf({ id: 'p', kind: 'pastfix', keep: true, ops: [{ op: 'keep' }] })).toBe('pastfix:keep');
    expect(kindOf({ id: 'p', kind: 'pastfix', retro: { action: 'relink' }, draft: { kind: 'retro' }, ops: [{ op: 'unlink' }] })).toBe('draft:retro');
    expect(kindOf(finding('note.stale', [{ op: 'setkey' }]))).toBe('finding:note.stale');
  });
  it('reads the kind of a decision record, old or new', () => {
    expect(kindOfRecord(rec('link.missing', 'approved', { action: 'relink', reviewOnly: true }))).toBe('link:relink-weak');
    expect(kindOfRecord(rec('link.missing', 'approved', { action: 'unlink' }))).toBe('link:unlink');
    expect(kindOfRecord(rec('note.orphan', 'archived'))).toBe('finding:note.orphan');
    expect(kindOfRecord(rec('fix.recheck', 'approved', { kind: 'keep' }))).toBe('pastfix:keep');
    expect(kindOfRecord(rec('link.missing', 'approved', { action: 'alias', gateKind: 'draft:point' }))).toBe('draft:point');
  });
});

describe('calibrated precision', () => {
  it('starts at the prior and moves with the vault\'s decisions', () => {
    expect(expected('link:alias')).toBe(PRIORS['link:alias'].p);
    expect(expected('link:create')).toBe(0);
    const down = expected('link:alias', { approved: 0, auto: 0, archived: 3, undone: 1 });
    expect(down).toBeLessThan(SHOW_AT);
    const up = expected('link:relink-weak', { approved: 40, auto: 0, archived: 1, undone: 0 });
    expect(up).toBeGreaterThan(SHOW_AT);
  });
  it('counts decisions per kind', () => {
    const t = tallies([rec('link.missing', 'approved', { action: 'alias' }), rec('link.missing', 'archived', { action: 'alias' }), rec('link.missing', 'reopened', { action: 'alias' }), rec('note.stale', 'undone')]);
    expect(t['link:alias']).toEqual({ approved: 1, auto: 0, archived: 1, undone: 0, agent: { approved: 0, archived: 0, undone: 0 }, recent: { approved: 1, archived: 1, undone: 0 } });
    expect(t['finding:note.stale'].undone).toBe(1);
  });
});

describe('live precision guard', () => {
  it('demotes a kind under 90% approved over 10 or more decisions', () => {
    expect(demoted({ approved: 8, auto: 0, archived: 1, undone: 0 })).toBeNull();
    expect(demoted({ approved: 8, auto: 0, archived: 2, undone: 1 })).toEqual({ approved: 8, total: 11 });
    expect(demoted({ approved: 9, auto: 5, archived: 1, undone: 0 })).toBeNull();
  });
  it('lists the demoted kinds of a log and sums them per rule', () => {
    const log = [...Array(7)].map(() => rec('link.missing', 'approved', { action: 'unlink' })).concat([...Array(4)].map(() => rec('link.missing', 'archived', { action: 'unlink' })));
    expect(demotions(log)).toEqual({ 'link:unlink': { approved: 7, total: 11 } });
    expect(ruleDemotion('link.missing', log)).toEqual({ approved: 7, total: 11 });
    expect(ruleDemotion('note.stale', log)).toBeNull();
  });
  it('reads only each kind\'s last 50 decisions, and lifts the demotion once the window is back at 90%', () => {
    const unlink = { action: 'unlink' };
    // 20 early dismissals, then 50 approvals: the window holds only the approvals
    const early = [...Array(20)].map((_, i) => rec('link.missing', 'archived', unlink, i));
    const later = [...Array(WINDOW)].map((_, i) => rec('link.missing', 'approved', unlink, 100 + i));
    expect(WINDOW).toBe(50);
    expect(demotions(early)).toEqual({ 'link:unlink': { approved: 0, total: 20 } });
    expect(demotions([...early, ...later.slice(0, 10)])).toEqual({ 'link:unlink': { approved: 10, total: 30 } });
    expect(demotions([...early, ...later])).toEqual({});
    // the counts keep every decision; only the guard reads the window
    const t = tallies([...early, ...later])['link:unlink'];
    expect(t.archived).toBe(20);
    expect(t.recent).toEqual({ approved: 50, archived: 0, undone: 0 });
    // 45 of the last 50 approved is exactly 90%: no demotion; 44 of 50 is under
    const mix = (bad) => [...Array(WINDOW)].map((_, i) => rec('link.missing', i < bad ? 'undone' : 'approved', unlink, i));
    expect(demotions(mix(5))).toEqual({});
    expect(demotions(mix(6))).toEqual({ 'link:unlink': { approved: 44, total: 50 } });
  });
  it('orders the window by time, and leaves decisions applied on its own and reopenings out', () => {
    const unlink = { action: 'unlink' };
    // the dismissals are older by time even though they come last in the log
    const log = [...[...Array(WINDOW)].map((_, i) => rec('link.missing', 'approved', unlink, 100 + i)), ...[...Array(10)].map((_, i) => rec('link.missing', 'archived', unlink, i))];
    expect(demotions(log)).toEqual({});
    const auto = [...Array(30)].map((_, i) => rec('link.missing', i < 10 ? 'archived' : 'auto', unlink, i));
    expect(tallies(auto)['link:unlink'].recent).toEqual({ approved: 0, archived: 10, undone: 0 });
  });
  it('lets the prior decide until a kind has 10 decisions', () => {
    const nine = [...Array(9)].map((_, i) => rec('link.missing', 'archived', { action: 'unlink' }, i));
    expect(demotions(nine)).toEqual({});
    expect(gateItem({ id: 'u', kind: 'link', target: 'x', ops: [{ op: 'unlink', sources: ['a.md'] }] }, { tally: tallies(nine)['link:unlink'] }).reasons).not.toContain('demoted');
  });
  it('moves a demoted kind to Check these first, and keeps a keep-only item with nothing to act on out of view', () => {
    const tally = { approved: 2, auto: 0, archived: 9, undone: 0 };
    expect(gateItem(alias(), { tally }).bucket).toBe('check');
    expect(gateItem(alias(), { tally }).why).toMatch(/^Demoted: 2 of the last 11 approved/);
    expect(gateItem(finding('note.secret', [{ op: 'keep' }]), { tally }).bucket).toBe('check');
    expect(gateItem(finding('note.oversized', [{ op: 'keep' }]), { tally }).bucket).toBe('quiet');
  });
});

describe('stability', () => {
  it('holds an item whose fix or notes change between passes', () => {
    const a = alias();
    const moved = alias('r:link:a', { ops: [{ op: 'alias', rel: 'notes/other.md', alias: 'a' }] });
    const edited = alias('r:link:a', { hashes: { 'x.md': 'h2' } });
    expect(stability([[a], [alias()]]).get(a.id).stable).toBe(true);
    expect(stability([[a], [moved]]).get(a.id).stable).toBe(false);
    expect(stability([[a], [edited]]).get(a.id).stable).toBe(false);
    expect(stability([[a], []]).get(a.id).stable).toBe(false);
    expect(gateItem(a, { stable: { stable: false } }).bucket).toBe('check');
  });
  it('ignores line numbers and expected hashes in the signature, but not drafted text', () => {
    const o = { op: 'restore', rel: 'a.md', before: 'one', expect: 'e1', lines: { 'a.md': [1] } };
    expect(signature({ ops: [o] })).toBe(signature({ ops: [{ ...o, expect: 'e2', lines: { 'a.md': [2] } }] }));
    expect(signature({ ops: [o] })).not.toBe(signature({ ops: [{ ...o, before: 'two' }] }));
  });
});

describe('the gate', () => {
  it('shows a strong alias ticked, and a create or a weak relink unticked under Check these first', () => {
    expect(gateItem(alias()).bucket).toBe('show');
    expect(gateItem({ id: 'c', kind: 'link', ops: [{ op: 'create', rel: 'a.md' }] }).bucket).toBe('check');
    const weak = gateItem({ id: 'w', kind: 'link', reviewOnly: true, ops: [{ op: 'relink', to: 'b.md' }] });
    expect(PRIORS['link:relink-weak'].p).toBeLessThan(SHOW_AT);
    expect(weak.bucket).toBe('check');
    expect(weak.reasons).toContain('low-precision');
    const t = { approved: 40, auto: 0, archived: 1, undone: 0 };
    expect(gateItem({ id: 'w', kind: 'link', reviewOnly: true, ops: [{ op: 'relink', to: 'b.md' }] }, { tally: t }).bucket).toBe('show');
  });
  it('never ticks a link onto a note Quorum wrote from links alone', () => {
    const v = gateItem(alias(), { isStub: (rel) => rel === 'notes/a-note.md' });
    expect(v.bucket).toBe('check');
    expect(v.reasons).toContain('onto-stub');
  });
  it('hides keep-only items unless they tell the person something, also when held', () => {
    expect(gateItem({ id: 'h', kind: 'finding', ruleId: 'note.oversized', hold: 'A note in the draft is gone.', ops: [] }).bucket).toBe('quiet');
    expect(gateItem(finding('note.oversized', [{ op: 'keep' }])).bucket).toBe('quiet');
    expect(gateItem(finding('note.secret', [{ op: 'keep' }])).bucket).toBe('show');
    expect(gateItem({ id: 'p', kind: 'pastfix', keep: true, ops: [{ op: 'keep' }] }).bucket).toBe('quiet');
    expect(gateItem({ id: 'p', kind: 'pastfix', keep: true, retro: { action: 'relink' }, ops: [{ op: 'keep' }] }).bucket).toBe('show');
  });
  it('ticks a drafted fix only when a second draft agreed', () => {
    const d = (confirmed) => ({ id: 'd', kind: 'link', draft: { kind: 'create', confirmed }, ops: [{ op: 'create', rel: 'a.md', text: 'x' }] });
    expect(gateItem(d(undefined)).bucket).toBe('check');
    expect(gateItem(d(false)).reasons).toContain('drafts-disagree');
    expect(gateItem(d(true)).bucket).toBe('show');
  });
  it('runs over passes and summarizes per kind', () => {
    const items = [alias(), { id: 'c', kind: 'link', ops: [{ op: 'create', rel: 'a.md' }] }];
    const g = runGate([items, items], []);
    expect(g.counts).toEqual({ show: 1, check: 1, quiet: 0 });
    const s = summarize(g.verdicts);
    expect(s['link:create'].check).toBe(1);
    expect(s['link:create'].reasons['low-precision']).toBe(1);
  });
});

describe('gate log', () => {
  it('appends one line per run and reads it back', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gate-'));
    try {
      const file = path.join(dir, 'gate.jsonl');
      const g = runGate([[alias()]], []);
      logGate(file, '/vault', g, { at: 1 });
      logGate(file, '/vault', g, { at: 2 });
      const lines = readGateLog(file);
      expect(lines.map((l) => l.at)).toEqual([1, 2]);
      expect(lines[0].items[0]).toMatchObject({ id: 'r:link:a', kind: 'link:alias', bucket: 'show' });
      expect(lines[0].vault).not.toContain('vault');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('decisions AI tools made', () => {
  const rec = (decision, actor, at) => ({ ruleId: 'link.missing', proposedFix: { action: 'relink', gateKind: 'link:relink' }, decision, actor, at });
  it('count under agent only, so they neither demote a kind nor lift a demotion', () => {
    const person = Array.from({ length: WINDOW }, (_, i) => rec('archived', 'you', i));
    const agent = Array.from({ length: WINDOW }, (_, i) => rec('approved', 'claude-code', 100 + i));
    const t = tallies([...person, ...agent])['link:relink'];
    expect(t.agent).toEqual({ approved: WINDOW, archived: 0, undone: 0 });
    expect([t.approved, t.archived, t.recent.approved]).toEqual([0, WINDOW, 0]);
    expect(Object.keys(demotions(person))).toEqual(['link:relink']);
    expect(demotions([...person, ...agent])).toEqual(demotions(person));
    const archivedByTool = Array.from({ length: WINDOW }, (_, i) => rec('archived', 'codex', i));
    expect(demotions(archivedByTool)).toEqual({});
  });
});
