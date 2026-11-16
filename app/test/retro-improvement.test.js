import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { approvePastFix, retargetText, retroCandidates, retroOf, retroOps, unlinkText } from '../reviewApprove.js';
import { checkDraft, createDrafter, draftKind, draftPrompt, evidenceRels, withDraft } from '../memoryDraft.js';
import { RETRO_TITLE, itemLine, pastFixItem } from '../reviewItems.js';
import { buildPlan, checkFirst } from '../batchPlan.js';
import { gateItem, kindOf } from '../qualityGate.js';
import { parseNote } from '../linkparse.js';
import { sha } from '../fixUndo.js';

// synthetic vaults only; every note name and line is made up. The model is always a fake
const vaultOf = (files) => ({
  rels: () => Object.keys(files).filter((r) => files[r] != null),
  note: (rel) => (files[rel] == null ? null : parseNote(rel, files[rel])),
  resolve: () => null,
  backlinks: () => [],
  read: (rel) => files[rel] ?? null,
});
const files = () => ({
  'a.md': '# A\n\nThe [[Lantern Plan]] covers the rollout.\n',
  'b.md': '# B\n\nSee [[Lantern Plan|the plan]] for dates.\n',
  'lantern-plan-old.md': '# Lantern Plan Old\n\nArchived.\n',
  'lantern-rollout-plan.md': '# Lantern rollout plan\n\nThe rollout starts in May.\n',
});
const relinkRun = { id: 'run-7', key: 'lantern', target: 'lantern', rel: 'a.md', status: 'success', outcome: 'Fixed 2 links in 2 notes', steps: [{ label: 'Pointing the 2 links at Lantern Plan' }], finding: { sources: ['a.md', 'b.md'], proposedFix: { action: 'relink', to: 'lantern-plan-old.md' } } };
const refused = { ok: false, kind: 'exact', why: 'Other links also point at the note, so Quorum cannot tell which ones this fix changed.', files: [] };

describe('what Quorum can still improve', () => {
  it('describes a relink it cannot undo, with the notes the links could mean', () => {
    const v = vaultOf(files());
    const a = approvePastFix(relinkRun, refused, { vault: v, reasons: ['It matched through a weak name.'] });
    expect(a.kind).toBe('keep');
    expect(a.retro).toMatchObject({ action: 'relink', wrong: 'lantern-plan-old.md', sources: ['a.md', 'b.md'], reasons: ['It matched through a weak name.'] });
    expect(a.retro.names).toContain('lantern-plan-old');
    expect(a.retro.names).toContain('Lantern Plan');
    expect(a.retro.candidates).toEqual(['lantern-rollout-plan.md']);
    expect(a.why).toMatch(/Turn on Let the agent draft fixes in Settings > Memory/);
    expect(approvePastFix(relinkRun, refused, { vault: v, drafting: true }).why).toMatch(/The agent drafts an improvement for it soon/);
  });
  it('has nothing to improve for an unlink', () => {
    const run = { ...relinkRun, outcome: 'Removed 1 dead link and kept the words', steps: [] };
    expect(retroOf(run, { action: 'unlink', sources: ['a.md'] }, { vault: vaultOf(files()) })).toBeNull();
    expect(approvePastFix(run, refused, { vault: vaultOf(files()) }).retro).toBeNull();
  });
  it('ranks candidates by the words of the name', () => {
    expect(retroCandidates('lantern-plan', ['x/lantern-plan-v2.md', 'y/lantern.md', 'z/other.md'])).toEqual(['x/lantern-plan-v2.md', 'y/lantern.md']);
  });
  it('points links at a new name, or replaces them with their words, keeping anchors and words', () => {
    const t = 'See [[Lantern Plan#Dates|the plan]] and ![[lantern-plan-old]] and [[other]].';
    expect(retargetText(t, ['Lantern Plan', 'lantern-plan-old'], 'lantern-rollout-plan')).toBe('See [[lantern-rollout-plan#Dates|the plan]] and ![[lantern-rollout-plan]] and [[other]].');
    expect(unlinkText(t, ['Lantern Plan', 'lantern-plan-old'])).toBe('See the plan and lantern-plan-old and [[other]].');
  });
});

describe('the agent drafts a Retroactive improvement', () => {
  const item = () => {
    const v = vaultOf(files());
    const plan = { ...refused, approve: approvePastFix(relinkRun, refused, { vault: v }) };
    return pastFixItem({ run: relinkRun, res: { action: 'relink' }, plan });
  };
  const notesOf = (it) => evidenceRels(it).map((rel) => ({ rel, text: files()[rel] }));
  const relinkReply = (to = 'lantern-rollout-plan.md') => JSON.stringify({ kind: 'retro', action: 'relink', to, quotes: [{ path: 'a.md', line: 3, text: 'covers the rollout' }], confidence: 'high' });

  it('asks about the earlier fix and offers only the candidates it read', () => {
    const it0 = item();
    expect(draftKind(it0)).toBe('retro');
    expect(evidenceRels(it0)).toEqual(['a.md', 'b.md', 'lantern-plan-old.md', 'lantern-rollout-plan.md']);
    const p = draftPrompt(it0, notesOf(it0));
    expect(p.prompt).toMatch(/An earlier automatic fix pointed the links to \[\[lantern\]\] at lantern-plan-old.md/);
    expect(p.prompt).toMatch(/point them there: lantern-rollout-plan.md/);
  });
  it('drops a draft that points at a note Quorum did not offer or answers another question', () => {
    const it0 = item();
    expect(checkDraft(it0, notesOf(it0), relinkReply('z.md')).why).toMatch(/did not offer/);
    expect(checkDraft(it0, notesOf(it0), JSON.stringify({ kind: 'retro', action: 'rewrite', text: 'x', quotes: [{ path: 'a.md', line: 3, text: 'covers the rollout' }], confidence: 'high' })).why).toMatch(/another question/);
    expect(checkDraft(it0, notesOf(it0), relinkReply()).draft).toMatchObject({ kind: 'retro', action: 'relink', to: 'lantern-rollout-plan.md' });
  });
  it('turns a relink draft into steps that point each link at the right note', () => {
    const it0 = item();
    const { draft } = checkDraft(it0, notesOf(it0), relinkReply());
    const f = files();
    const next = withDraft(it0, draft, (rel) => f[rel] ?? null);
    expect(next.group).toBe('retro');
    expect(next.keep).toBe(false);
    expect(next.ops).toEqual([
      { op: 'restore', rel: 'a.md', before: '# A\n\nThe [[lantern-rollout-plan]] covers the rollout.\n', expect: sha(f['a.md']) },
      { op: 'restore', rel: 'b.md', before: '# B\n\nSee [[lantern-rollout-plan|the plan]] for dates.\n', expect: sha(f['b.md']) },
    ]);
    expect(itemLine(next)).toBe('Point the links an earlier fix moved to “lantern-plan-old.md” at “lantern-rollout-plan.md”');
    expect(kindOf(next)).toBe('draft:retro');
    expect(checkFirst(next)).toBeNull();
    const plan = buildPlan([next]);
    expect(plan.groups.map((g) => g.label)).toEqual(['Make 1 retroactive improvement to earlier fixes']);
  });
  it('turns an unlink draft for a relink into its words, and an alias draft takes the alias back first', () => {
    const it0 = item();
    const f = files();
    const un = retroOps(it0.retro, { action: 'unlink' }, (rel) => f[rel] ?? null);
    expect(un.ops.map((o) => o.before)).toEqual(['# A\n\nThe Lantern Plan covers the rollout.\n', '# B\n\nSee the plan for dates.\n']);
    const g = { 'a.md': 'Use [[lantern]].\n', 'lantern-plan-old.md': '---\naliases:\n  - lantern\n---\n# Old\n', 'lantern-rollout.md': '# R\n' };
    const aliasRetro = { action: 'alias', target: 'lantern', wrong: 'lantern-plan-old.md', names: ['lantern'], sources: ['a.md'], candidates: ['lantern-rollout.md'] };
    const ops = retroOps(aliasRetro, { action: 'relink', to: 'lantern-rollout.md' }, (rel) => g[rel] ?? null).ops;
    expect(ops[0]).toEqual({ op: 'restore', rel: 'lantern-plan-old.md', before: '# Old\n', expect: sha(g['lantern-plan-old.md']) });
    expect(ops[1].before).toBe('Use [[lantern-rollout]].\n');
    expect(retroOps(aliasRetro, { action: 'unlink' }, (rel) => g[rel] ?? null).ops[1]).toEqual({ op: 'unlink', target: 'lantern', sources: ['a.md'] });
  });
  it('rewrites or removes a note an earlier fix wrote', () => {
    const g = { 'n/Kite.md': '---\nconfidential: team\n---\n# Kite\nQuorum made this note because 2 notes link to it.\nI added a line.\n', 'a.md': 'Fly the [[Kite]] on Sunday.\n' };
    const retro = { action: 'create', target: 'Kite', made: 'n/Kite.md', sources: ['a.md'], reasons: [] };
    const it0 = { id: 'r:pastfix:run-9', kind: 'pastfix', key: 'run-9', title: 'Kite', retro, keep: true, group: 'keep', ops: [{ op: 'keep' }] };
    const reply = JSON.stringify({ kind: 'retro', action: 'rewrite', text: '# Kite\nFlown on Sunday.', quotes: [{ path: 'a.md', line: 1, text: 'on Sunday' }], confidence: 'medium' });
    const notes = evidenceRels(it0).map((rel) => ({ rel, text: g[rel] }));
    const { draft } = checkDraft(it0, notes, reply);
    const next = withDraft(it0, draft, (rel) => g[rel] ?? null);
    expect(next.ops).toEqual([{ op: 'restore', rel: 'n/Kite.md', before: '---\nconfidential: team\n---\n# Kite\nFlown on Sunday.\n', expect: sha(g['n/Kite.md']) }]);
    expect(checkFirst(next)).toMatch(/The agent drafted these fixes/);
    expect(retroOps(retro, { action: 'remove' }, (rel) => g[rel] ?? null).ops).toEqual([{ op: 'trash', rel: 'n/Kite.md', expect: sha(g['n/Kite.md']) }]);
  });
  it('shows under its own title and starts ticked only after a second draft agrees', () => {
    const it0 = item();
    expect(RETRO_TITLE).toBe('Retroactive improvement');
    expect(gateItem(it0).bucket).toBe('show');
    const { draft } = checkDraft(it0, notesOf(it0), relinkReply());
    const f = files();
    expect(gateItem(withDraft(it0, draft, (rel) => f[rel])).bucket).toBe('check');
    expect(gateItem(withDraft(it0, { ...draft, confirmed: true }, (rel) => f[rel])).bucket).toBe('show');
  });
});

describe('a second draft confirms the first', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });
  it('records a disagreement when the second draft points elsewhere', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'qretro-'));
    const v = vaultOf({ ...files(), 'lantern-plan-new.md': '# Lantern Plan New\n' });
    const it0 = pastFixItem({ run: relinkRun, res: { action: 'relink' }, plan: { ...refused, approve: approvePastFix(relinkRun, refused, { vault: v }) } });
    const text = (rel) => v.read(rel);
    const replies = ['lantern-rollout-plan.md', 'lantern-plan-new.md'].map((to) => JSON.stringify({ kind: 'retro', action: 'relink', to, quotes: [{ path: 'a.md', line: 3, text: 'covers the rollout' }], confidence: 'high' }));
    const d = createDrafter({
      file: path.join(dir, 'drafts.json'), model: async () => replies.shift(), items: () => [it0],
      evidence: (i) => evidenceRels(i).map((rel) => ({ rel, text: text(rel) })), enabled: () => true, idleMs: () => Infinity,
    });
    expect((await d.tick()).drafted).toBe(it0.id);
    expect(await d.tick()).toEqual({ confirmed: it0.id, agree: false });
    const kept = d.draftFor(it0, evidenceRels(it0).map((rel) => ({ rel, text: text(rel) })));
    expect(kept.confirmed).toBe(false);
    expect(gateItem(withDraft(it0, kept, text)).reasons).toContain('drafts-disagree');
  });
});
