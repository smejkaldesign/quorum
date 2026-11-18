import { describe, expect, it } from 'vitest';
import { ignoreProposals, ignored, patternsOf, ruleRecords } from '../ruleRecords.js';

// Synthetic decision records; every note name is made up
let n = 0;
const rec = (ruleId, decision, { key = `k${n++}`, target = key, notes = [], facts = [], fingerprint = key, at = 1 } = {}) => ({ ruleId, decision, key, target, fingerprint, at, evidence: { notes, lines: [], facts } });

describe('rule records', () => {
  it('counts each decision per rule', () => {
    const r = ruleRecords([rec('note.stale', 'approved'), rec('note.stale', 'archived'), rec('note.stale', 'undone', { at: 9 }), rec('note.orphan', 'auto')]);
    expect(r['note.stale']).toMatchObject({ approved: 1, archived: 1, undone: 1, auto: 0, last: 9 });
    expect(r['note.orphan'].auto).toBe(1);
  });
});

describe('ignore proposals', () => {
  it('proposes a folder after three archives of one rule in that folder', () => {
    const recs = [1, 2, 3].map((i) => rec('note.orphan', 'archived', { key: `note.orphan:drafts/d${i}.md`, target: `drafts/d${i}.md`, notes: [`drafts/d${i}.md`] }));
    const [p] = ignoreProposals(recs, { labels: { 'note.orphan': 'Notes nothing links to' } });
    expect(p).toMatchObject({ ruleId: 'note.orphan', field: 'folder', value: 'drafts', count: 3, findings: 3 });
    expect(p.title).toBe('Stop flagging notes nothing links to in the folder drafts');
  });

  it('proposes a frontmatter key and a link target archived again and again', () => {
    const keyRecs = [1, 2, 3].map((i) => rec('note.frontmatter', 'archived', { notes: [`f${i}/x.md`], facts: ['missing:status'] }));
    expect(ignoreProposals(keyRecs).map((p) => [p.field, p.value])).toContainEqual(['key', 'status']);
    const linkRecs = [1, 2, 3].map((i) => ({ ruleId: 'link.missing', decision: 'archived', key: 'zephyr', target: 'zephyr', fingerprint: `fp${i}`, evidence: { sources: [`s${i}/a.md`] } }));
    expect(ignoreProposals(linkRecs).map((p) => [p.field, p.value])).toEqual([['target', 'zephyr']]);
  });

  it('counts an archive once per finding and evidence, and leaves out stored, turned down and past-fix proposals', () => {
    const same = [1, 2, 3].map(() => rec('note.orphan', 'archived', { key: 'one', fingerprint: 'same', notes: ['drafts/a.md'] }));
    expect(ignoreProposals(same)).toEqual([]);
    const recs = [1, 2, 3].map((i) => rec('note.orphan', 'archived', { notes: [`drafts/d${i}.md`] }));
    const [p] = ignoreProposals(recs);
    expect(ignoreProposals(recs, { ignores: [{ id: p.id }] })).toEqual([]);
    expect(ignoreProposals(recs, { dismissed: [p.id] })).toEqual([]);
    expect(ignoreProposals([1, 2, 3].map(() => rec('fix.recheck', 'archived', { notes: ['drafts/a.md'] })))).toEqual([]);
    expect(ignoreProposals(recs.map((r) => ({ ...r, decision: 'approved' })))).toEqual([]);
  });

  it('reads no folder pattern from notes in different folders or at the vault root', () => {
    expect(patternsOf(rec('note.orphan', 'archived', { target: 'a\nb', notes: ['x/a.md', 'y/b.md'] }))).toEqual([]);
    expect(patternsOf(rec('note.orphan', 'archived', { target: 'a\nb', notes: ['a.md'] }))).toEqual([]);
  });
});

describe('ignored', () => {
  const rules = [
    { id: '1', ruleId: 'note.orphan', field: 'folder', value: 'drafts' },
    { id: '2', ruleId: 'note.frontmatter', field: 'key', value: 'status' },
    { id: '3', ruleId: 'link.missing', field: 'target', value: 'zephyr' },
  ];
  it('covers only the findings of its own rule that match it', () => {
    expect(ignored(rules, 'note.orphan', { notes: ['drafts/sub/a.md'] })).toBeTruthy();
    expect(ignored(rules, 'note.orphan', { notes: ['drafted/a.md'] })).toBeNull();
    expect(ignored(rules, 'note.stale', { notes: ['drafts/a.md'] })).toBeNull();
    expect(ignored(rules, 'note.frontmatter', { notes: ['a/b.md'], facts: ['missing:status'] })).toBeTruthy();
    expect(ignored(rules, 'note.frontmatter', { notes: ['a/b.md'], facts: ['missing:status', 'missing:date'] })).toBeNull();
    expect(ignored(rules, 'link.missing', { notes: ['a.md'], target: 'Zephyr.md' })).toBeTruthy();
  });
});
