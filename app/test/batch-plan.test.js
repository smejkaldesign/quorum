import { describe, expect, it } from 'vitest';
import { buildPlan, checkFirst, checkOrder, effects, groupLabel, groupOf, planExclude, planLine } from '../batchPlan.js';

// synthetic items; every note name is made up
const relink = (id, target, to, sources, lines = {}) => ({ id, kind: 'link', target, title: target, autoFix: true, ops: [{ op: 'relink', target, to, sources, lines }] });
const alias = (id, target, rel) => ({ id, kind: 'link', target, title: target, autoFix: true, ops: [{ op: 'alias', rel, alias: target }] });
const unlink = (id, target, sources, lines = {}) => ({ id, kind: 'link', target, title: target, ops: [{ op: 'unlink', target, sources, lines }] });
const create = (id, target, rel) => ({ id, kind: 'link', target, title: target, reviewOnly: true, ops: [{ op: 'create', rel, sources: [] }] });
const trashStub = (id, target, rel) => ({ id, kind: 'pastfix', target, title: target, ops: [{ op: 'trash', rel }] });
const restore = (id, target, rel) => ({ id, kind: 'pastfix', target, title: target, ops: [{ op: 'restore', rel, before: 'old', expect: 'h' }] });
const tag = (id, rel, value) => ({ id, kind: 'finding', target: `tag:${rel}`, title: rel, autoFix: true, ops: [{ op: 'tag', rel, value }] });
const moveTag = (id, rel, to, value) => ({ id, kind: 'finding', target: `move:${rel}`, title: rel, ops: [{ op: 'tag', rel, value }, { op: 'move', rel, to }] });

describe('effects', () => {
  it('reads the regions an op writes and the note it points at', () => {
    expect(effects({ op: 'relink', target: 'Kite', to: 'b.md', sources: ['a.md'], lines: { 'a.md': [3] } })).toEqual({ writes: [{ rel: 'a.md', region: 'line:3' }], removes: [], creates: [], points: 'b.md' });
    expect(effects({ op: 'move', rel: 'a.md', to: 'x/a.md' })).toMatchObject({ removes: ['a.md'], creates: ['x/a.md'] });
    expect(effects({ op: 'tag', rel: 'a.md', value: 'team' }).writes).toEqual([{ rel: 'a.md', region: 'fm:confidential' }]);
  });
});

describe('buildPlan conflicts', () => {
  it('skips a duplicate item and a second item for the same target', () => {
    const a = relink('1', 'Kite', 'kite.md', ['a.md']);
    const p = buildPlan([a, a, relink('2', 'kite', 'other.md', ['b.md'])]);
    expect(p.ok).toEqual(['1']);
    expect(p.skipped.map((s) => s.reason)).toEqual(['The same item is in the list twice.', '“Kite” already fixes “kite”.']);
  });

  it('merges two link edits on the same line, and holds back two different edits of the same frontmatter key', () => {
    const p = buildPlan([relink('1', 'Kite', 'kite.md', ['a.md'], { 'a.md': [4] }), unlink('2', 'Lamp', ['a.md'], { 'a.md': [4] })]);
    expect(p.ok).toEqual(['1', '2']);
    expect(p.merged).toEqual([{ items: ['1', '2'], title: 'Lamp', reason: 'It changes line 5 of “a.md” together with “Kite”, as one edit.' }]);
    const t = buildPlan([{ ...tag('t1', 'n.md', 'team'), title: 'Folder mark' }, { ...tag('t2', 'n.md', 'legal'), target: 'other' }]);
    expect(t.ok).toEqual(['t1']);
    expect(t.held[0]).toMatchObject({ id: 't2', reason: '“Folder mark” marks “n.md” confidential: team.' });
  });

  it('runs a change that another item already makes only once', () => {
    const p = buildPlan([tag('t1', 'n.md', 'team'), { ...tag('t2', 'n.md', 'team'), target: 'other' }]);
    expect(p.ok).toEqual(['t1']);
    expect(p.skipped[0].reason).toBe('Every change it makes is already in the batch.');
  });

  it('holds back an edit of a note another item puts back whole', () => {
    const p = buildPlan([restore('p1', 'Kite', 'a.md'), relink('2', 'Lamp', 'lamp.md', ['a.md'], { 'a.md': [1] })]);
    expect(p.ok).toEqual(['p1']);
    expect(p.held[0].reason).toBe('“Kite” puts back the whole text of “a.md”. Approve it after this batch.');
  });

  it('skips a relink or alias onto a stub another item removes', () => {
    const p = buildPlan([relink('2', 'Lamp', 'stub.md', ['b.md']), alias('3', 'Lantern', 'stub.md'), trashStub('p1', 'Stub', 'stub.md')]);
    // corrective past fixes plan first, so the stub's removal wins
    expect(p.ok).toEqual(['p1']);
    expect(p.skipped.map((s) => s.id)).toEqual(['2', '3']);
    expect(p.skipped[0].reason).toMatch(/It points at “stub.md”, which “Stub” removes/);
  });

  it('skips an alias or relink onto a note a create in the same batch writes', () => {
    const p = buildPlan([create('1', 'Harbor', 'notes/Harbor.md'), alias('2', 'Harbour', 'notes/Harbor.md'), relink('3', 'Harbr', 'notes/Harbor.md', ['c.md'])]);
    expect(p.ok).toEqual(['1']);
    expect(p.skipped.map((s) => s.reason)).toEqual([
      'It points at “notes/Harbor.md”, the new note “Harbor” writes. A link is never pointed at a note written from links alone.',
      'It points at “notes/Harbor.md”, the new note “Harbor” writes. A link is never pointed at a note written from links alone.',
    ]);
  });

  it('runs an edit of a moved note before the move, and holds back a second move', () => {
    const p = buildPlan([moveTag('m1', 'loose.md', 'vault/loose.md', 'team'), alias('2', 'Loose note', 'loose.md'), { id: 'm2', kind: 'finding', target: 'm2', title: 'again', ops: [{ op: 'move', rel: 'loose.md', to: 'other/loose.md' }] }]);
    expect(p.ok).toEqual(['2', 'm1']);
    expect(p.held.map((h) => h.id)).toEqual(['m2']);
    expect(p.steps.map((s) => s.op.op)).toEqual(['tag', 'alias', 'move']);
    expect(p.merged[0].reason).toMatch(/changes “loose.md” first, then this moves it/);
    expect(checkOrder(p.steps, ['loose.md'])).toBeNull();
  });

  it('holds back an edit of a note another item removes', () => {
    const p = buildPlan([trashStub('p1', 'Stub', 'stub.md'), tag('t1', 'stub.md', 'team')]);
    expect(p.held[0]).toMatchObject({ id: 't1', reason: '“Stub” removes “stub.md”, the note this changes.' });
  });

  it('keeps an item with a known reason out, and items the person unticked', () => {
    const p = buildPlan([{ ...restore('p1', 'Kite', 'a.md'), hold: 'The note changed after the fix.' }, relink('2', 'Lamp', 'lamp.md', ['b.md'])], { exclude: ['2'] });
    expect(p.ok).toEqual([]);
    expect(p.held).toEqual([{ id: 'p1', title: 'Kite', reason: 'The note changed after the fix.' }]);
  });
});

describe('buildPlan order and groups', () => {
  it('orders steps so each precondition holds: put back, remove, edit, write, move', () => {
    const p = buildPlan([
      relink('1', 'Lamp', 'lamp.md', ['a.md']), create('2', 'Harbor', 'Harbor.md'), moveTag('m1', 'loose.md', 'team/loose.md', 'team'),
      trashStub('p1', 'Stub', 'stub.md'), restore('p2', 'Kite', 'k.md'),
    ]);
    expect(p.steps.map((s) => s.op.op)).toEqual(['restore', 'trash', 'tag', 'relink', 'create', 'move']);
    expect(checkOrder(p.steps, ['a.md', 'lamp.md', 'loose.md', 'stub.md', 'k.md'])).toBeNull();
    // the same steps in the wrong order fail the check
    expect(checkOrder([...p.steps].reverse(), ['a.md', 'lamp.md', 'loose.md', 'stub.md', 'k.md'])).not.toBeNull();
  });

  it('summarizes as groups with counts and the notes each item touches', () => {
    const p = buildPlan([
      trashStub('p1', 'A', 'stubs/a.md'), trashStub('p2', 'B', 'stubs/b.md'),
      relink('1', 'Lamp', 'lamp.md', ['x.md', 'y.md'], { 'x.md': [1, 7], 'y.md': [2] }),
      tag('t1', 'w/1.md', 'team'), tag('t2', 'w/2.md', 'team'), moveTag('m1', 'loose.md', 'w/loose.md', 'team'),
    ]);
    expect(p.groups.map((g) => [g.id, g.label])).toEqual([
      ['trash', 'Remove 2 notes earlier fixes created'], ['relink', 'Relink 3 links'], ['tag', 'Tag 2 notes confidential'], ['move-tag', 'Move and tag 1 note'],
    ]);
    expect(p.groups[1].items[0].notes).toEqual(['x.md', 'y.md']);
    expect(planLine(p)).toBe('Remove 2 notes earlier fixes created, Relink 3 links, Tag 2 notes confidential, Move and tag 1 note');
    expect(groupOf({ ops: [{ op: 'unalias', rel: 'a', alias: 'b' }] })).toBe('unalias');
  });
});

describe('bulk plan default selection', () => {
  const items = [
    relink('strong', 'Kite', 'kite.md', ['a.md']),
    { ...relink('weak', 'Lamp', 'lamp.md', ['b.md']), autoFix: false, reviewOnly: true },
    create('stub', 'Moth', 'moth.md'),
    tag('marked', 'c.md', 'team'),
    { ...tag('guessed', 'd.md', 'team'), autoFix: false },
    { id: 'move', kind: 'finding', target: 'move:e.md', title: 'e.md', ops: [{ op: 'move', rel: 'e.md', to: 'x/e.md' }] },
    moveTag('movetag', 'f.md', 'x/f.md', 'team'),
    restore('past', 'Owl', 'g.md'),
  ];

  it('leaves every review-only fix unticked and ticks the rest', () => {
    expect(items.filter((i) => checkFirst(i)).map((i) => i.id)).toEqual(['weak', 'stub', 'guessed', 'move', 'movetag']);
    const off = planExclude(items);
    expect([...off].sort()).toEqual(['guessed', 'move', 'movetag', 'stub', 'weak']);
    expect(buildPlan(items, { exclude: [...off] }).ok).toEqual(['past', 'strong', 'marked']);
  });

  it('gives each check-first group a one-line reason', () => {
    for (const i of items.filter((x) => checkFirst(x))) expect(checkFirst(i)).toMatch(/^[A-Z][^\n]+\.$/);
    expect(checkFirst(items[2])).toContain('links to it alone');
  });

  it('leaves an item the agent fixes when the plan runs unticked, with what the agent does as its reason', () => {
    const agentCreate = { ...create('agent', 'Lark', 'lark.md'), agent: { kind: 'create' } };
    const agentPoint = { id: 'p', kind: 'link', target: 'Finch', reviewOnly: true, agent: { kind: 'point', options: ['finch-notes.md'] }, ops: [{ op: 'relink', target: 'Finch', to: 'finch-notes.md', sources: ['a.md'] }] };
    expect(checkFirst(agentCreate)).toMatch(/the agent writes each note from the notes that link to it/);
    expect(checkFirst(agentPoint)).toMatch(/removes the dead link when no note fits/);
    expect([...planExclude([agentCreate, agentPoint])].sort()).toEqual(['agent', 'p']);
    expect([...planExclude([agentCreate, agentPoint], [], ['agent'])]).toEqual(['p']);
  });

  it('runs a check-first fix only when the person ticks it, and keeps a person\'s untick', () => {
    const off = planExclude(items, ['strong'], ['stub']);
    expect(off.has('stub')).toBe(false);
    expect(off.has('strong')).toBe(true);
    expect(off.has('weak')).toBe(true);
    expect(buildPlan(items, { exclude: [...off] }).ok).toEqual(['past', 'stub', 'marked']);
  });

  it('labels a split group from its own items', () => {
    expect(groupLabel('create', [items[2]])).toBe('Write 1 missing note');
    expect(groupLabel('relink', [items[0], items[1]])).toBe('Relink 2 links');
  });
});
