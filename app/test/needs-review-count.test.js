import { describe, expect, it } from 'vitest';
import { feedPage, feedRows, needsReview } from '../activityFeed.js';

// One Needs review for Memory health: the Memory health button, the folder counts in the notes tree, the Needs review
// toggle and the list itself all read needsReview, so they agree
const link = (target, sources, extra = {}) => ({ target, sources, count: sources.length, candidates: [], lastAt: 5, abs: `/v/${sources[0]}`, ...extra });
const finding = (key, rel, extra = {}) => ({ key, rule: 'Notes that look out of date', rel, abs: `/v/${rel}`, title: `“${key}”`, problem: 'P', proposal: 'Do it.', evidence: [], meta: [], at: '2026-11-01T09:00:00.000Z', initial: false, archived: false, ...extra });
const pastFix = (id, main) => ({
  run: { id, key: id, target: id, status: 'success', endedAt: Date.parse('2026-11-01T09:20:00Z'), outcome: 'Wrote the note' },
  res: { flagged: true, action: 'create', main, reasons: [{ id: 'few-sources', text: 'Only one note links to it.' }], evidence: [] },
  plan: { ok: true, kind: 'trash', why: 'Quorum moves it to the Trash.' }, abs: `/v/${main}`,
});
const fixRun = { id: 'fix:busy:1', key: 'busy', target: 'Busy', rel: 'People/ana.md', status: 'running', queuedAt: Date.now() - 1000, startedAt: Date.now() - 900, endedAt: null, steps: [] };

const rows = feedRows({
  links: [
    link('Roadmap', ['Projects/plan.md', 'People/ana.md']),
    link('Orbit', ['Projects/deep/orbit-notes.md']),
    link('Top', ['root-note.md']),
    link('Left', ['Projects/plan.md'], { left: true }),
    link('Held', ['People/bo.md']),
    link('Busy', ['People/ana.md']),
  ],
  findings: [
    finding('note.stale:People/ana.md', 'People/ana.md'),
    finding('contradiction:Projects/plan.md', 'Projects/plan.md'),
    finding('archived:People/bo.md', 'People/bo.md', { archived: true }),
  ],
  pastFixes: [pastFix('fix:lantern:1', 'Projects/Lantern.md'), pastFix('fix:retro:1', 'People/retro.md')],
  ignores: [{ id: 'ig1', at: '2026-11-01T09:00:00.000Z', title: 'Stop flagging Daily', rule: 'note.stale', field: 'folder', value: 'Daily', count: 3, findings: [] }],
  runs: [fixRun],
  held: new Map([['r:link:held', { bucket: 'quiet', why: 'Keep only.' }]]),
  state: {},
});

describe('Needs review count', () => {
  const opts = { archived: ['r:pastfix:fix:retro:1'] };
  const r = needsReview(rows, opts);
  const top = (folders) => Object.entries(folders).filter(([f]) => !f.includes('/')).reduce((s, [, n]) => s + n, 0);

  it('the header count, the folder badges and the list agree', () => {
    const list = feedPage(rows, { ...opts, review: true, kinds: ['memory-health'], limit: 1000 }).items.filter((x) => !x.fixRun);
    expect(r.total).toBe(list.length);
    expect(r.items.map((x) => x.id).sort()).toEqual(list.map((x) => x.id).sort());
    const withFolder = r.items.filter((x) => x.review?.kind !== 'ignore' && x.target.rel.includes('/'));
    expect(top(r.folders)).toBe(withFolder.length);
    expect(Object.values(r.files).reduce((s, n) => s + n, 0)).toBe(r.items.filter((x) => x.review?.kind !== 'ignore' && /\.md$/.test(x.target.rel)).length);
  });

  it('holds links, findings, past fixes and proposed rules, after the gate, without archived or busy items', () => {
    expect(r.items.map((x) => x.id).sort()).toEqual([
      'r:find:contradiction:Projects/plan.md', 'r:find:note.stale:People/ana.md', 'r:ignore:ig1',
      'r:link:orbit', 'r:link:roadmap', 'r:link:top', 'r:pastfix:fix:lantern:1',
    ]);
    expect(r.total).toBe(7);
  });

  it('counts each item once, toward the note it is about and every folder above it', () => {
    expect(r.folders).toEqual({ Projects: 4, 'Projects/deep': 1, People: 1 });
    expect(r.files['Projects/plan.md']).toBe(2);
    expect(r.files['root-note.md']).toBe(1);
  });

  it('moves together when an item is archived', () => {
    const next = needsReview(rows, { archived: [...opts.archived, 'r:link:roadmap'] });
    expect(next.total).toBe(r.total - 1);
    expect(next.folders.Projects).toBe(r.folders.Projects - 1);
  });
});
