import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildPlan, checkFirst } from '../batchPlan.js';
import { WRONG_NOTE_FIX, checkDraft, createDrafter, draftKind, draftPrompt, evidenceRels, fallbackItem, pointOptions, trustedDraft, verifyQuotes, withDraft } from '../memoryDraft.js';
import { sha } from '../fixUndo.js';

// Synthetic items and notes; every name and line is made up. The model is always a fake
const createItem = { id: 'r:link:zephyr', kind: 'link', key: 'zephyr', target: 'zephyr', title: 'zephyr', reviewOnly: true, ops: [{ op: 'create', rel: 'notes/zephyr.md', sources: ['notes/a.md', 'notes/b.md'] }] };
const pointItem = { id: 'r:link:orbit', kind: 'link', key: 'orbit', target: 'orbit', title: 'orbit', reviewOnly: true, ops: [{ op: 'relink', target: 'orbit', to: 'notes/orbit-plan.md', sources: ['notes/a.md'] }] };
const mergeItem = { id: 'r:find:near', kind: 'finding', ruleId: 'note.near-duplicate', key: 'near', target: 'x', title: 'notes/one.md', notes: ['notes/one.md', 'notes/two.md'], ops: [{ op: 'link', rel: 'notes/one.md', to: 'notes/two.md' }] };
const A = { rel: 'notes/a.md', text: '# A\nThe zephyr project ships in March.\nOther line.' };
const B = { rel: 'notes/b.md', text: '# B\nzephyr owner is the platform group.' };
const ONE = { rel: 'notes/one.md', text: '---\ntitle: One\n---\n# One\nThe launch is on Tuesday.' };
const TWO = { rel: 'notes/two.md', text: '# Two\nThe launch is on Tuesday.\nIt needs two reviewers.' };
const reply = (o) => `Here it is:\n${JSON.stringify(o)}`;

describe('what the agent drafts', () => {
  it('drafts a missing note, a weak relink and a near-duplicate, and nothing the rules decide', () => {
    expect(draftKind(createItem)).toBe('create');
    expect(draftKind(pointItem)).toBe('point');
    expect(draftKind(mergeItem)).toBe('merge');
    expect(draftKind({ ...pointItem, reviewOnly: false })).toBeNull();
    expect(draftKind({ kind: 'finding', ruleId: 'note.stale', ops: [] })).toBeNull();
    expect(evidenceRels(pointItem)).toEqual(['notes/a.md', 'notes/orbit-plan.md']);
    expect(evidenceRels(mergeItem)).toEqual(['notes/one.md', 'notes/two.md']);
  });

  it('numbers each note line in the prompt and asks for JSON only', () => {
    const p = draftPrompt(createItem, [A, B]);
    expect(p.prompt).toContain('<note path="notes/a.md">\n1: # A\n2: The zephyr project ships in March.');
    expect(p.system).toMatch(/no tools and change nothing/);
    expect(p.system).toMatch(/one JSON object/);
  });
});

describe('quote checks', () => {
  it('passes only a quote that sits on the line it names', () => {
    const q = verifyQuotes([
      { path: 'notes/a.md', line: 2, text: 'ships in March' },
      { path: 'notes/a.md', line: 3, text: 'ships in March' },
      { path: 'notes/c.md', line: 1, text: 'anything' },
      { path: 'notes/a.md', line: 2, text: 'ships in april' },
    ], [A]);
    expect(q.map((x) => x.ok)).toEqual([true, false, false, false]);
  });

  it('drops a draft when any quote fails, or when it has no quote or no confidence', () => {
    const good = { kind: 'create', text: 'Zephyr ships in March.', quotes: [{ path: 'notes/a.md', line: 2, text: 'The zephyr project ships in March.' }], confidence: 'high' };
    expect(checkDraft(createItem, [A, B], reply(good)).draft).toMatchObject({ kind: 'create', confidence: 'high', verified: true });
    expect(checkDraft(createItem, [A, B], reply({ ...good, quotes: [...good.quotes, { path: 'notes/b.md', line: 2, text: 'made up words' }] })).why).toMatch(/does not match/);
    expect(checkDraft(createItem, [A, B], reply({ ...good, quotes: [] })).why).toMatch(/quotes no evidence/);
    expect(checkDraft(createItem, [A, B], reply({ ...good, confidence: 'sure' })).why).toMatch(/no confidence/);
    expect(checkDraft(createItem, [A, B], 'no json here').why).toMatch(/did not answer/);
  });

  it('drops a frontmatter block from the drafted text, so a draft cannot set aliases or marks', () => {
    const quotes = [{ path: 'notes/a.md', line: 2, text: 'The zephyr project ships in March.' }];
    const text = '---\naliases: [orbit]\nconfidential: false\n---\nZephyr ships in March.';
    expect(checkDraft(createItem, [A, B], reply({ kind: 'create', text, quotes, confidence: 'high' })).draft.text).toBe('Zephyr ships in March.');
    expect(checkDraft(createItem, [A, B], reply({ kind: 'create', text: '---\naliases: [orbit]\n---\n', quotes, confidence: 'high' })).why).toMatch(/no note text/);
  });

  it('keeps a point draft only for the note Quorum offered', () => {
    const notes = [A, { rel: 'notes/orbit-plan.md', text: '# Orbit plan\nThe orbit plan.' }];
    const q = [{ path: 'notes/orbit-plan.md', line: 2, text: 'The orbit plan.' }];
    expect(checkDraft(pointItem, notes, reply({ kind: 'point', to: 'notes/orbit-plan.md', quotes: q, confidence: 'medium' })).draft.to).toBe('notes/orbit-plan.md');
    expect(checkDraft(pointItem, notes, reply({ kind: 'point', to: 'notes/elsewhere.md', quotes: q, confidence: 'high' })).why).toMatch(/did not offer/);
    const no = checkDraft(pointItem, notes, reply({ kind: 'point', to: null, quotes: q, confidence: 'high' })).draft;
    expect(withDraft(pointItem, no, () => '')).toMatchObject({ wrongNote: true, ops: [{ op: 'unlink', target: 'orbit', sources: ['notes/a.md'] }] });
    expect(WRONG_NOTE_FIX).toMatch(/Approve removes the dead link and keeps its words/);
  });

  it('turns a wrong-match link into removing the dead link, which the bulk plan runs', () => {
    const notes = [A, { rel: 'notes/orbit-plan.md', text: '# Orbit plan\nThe orbit plan.' }];
    const q = [{ path: 'notes/orbit-plan.md', line: 2, text: 'The orbit plan.' }];
    const no = checkDraft(pointItem, notes, reply({ kind: 'point', to: null, quotes: q, confidence: 'high' })).draft;
    const item = withDraft(pointItem, no, () => '');
    expect(item.hold).toBeUndefined();
    expect(item.autoFix).toBe(false);
    expect(item.draft.wrong).toBe(true);
    const plan = buildPlan([{ ...item, hashes: {} }]);
    expect(plan.ok).toEqual([pointItem.id]);
    expect(plan.steps.map((s) => s.op.op)).toEqual(['unlink']);
    expect(plan.groups.map((g) => g.label)).toEqual(['Remove 1 dead link']);
  });
});

describe('a draft as a fix', () => {
  const q = [{ path: 'notes/two.md', line: 3, text: 'It needs two reviewers.', ok: true }];
  const texts = { 'notes/one.md': ONE.text, 'notes/two.md': TWO.text };
  it('merges into the kept note with its frontmatter, adds the other name as an alias, and trashes the other', () => {
    const d = checkDraft(mergeItem, [ONE, TWO], reply({ kind: 'merge', keep: 'notes/one.md', text: '# One\nThe launch is on Tuesday.\nIt needs two reviewers.', quotes: q, confidence: 'high' })).draft;
    const item = withDraft(mergeItem, d, (rel) => texts[rel]);
    expect(item.group).toBe('merge');
    expect(item.autoFix).toBe(false);
    expect(item.ops[0].op).toBe('restore');
    expect(item.ops[0].before).toContain('title: One');
    expect(item.ops[0].before).toContain('aliases:\n  - two');
    expect(item.ops[0].before).toContain('It needs two reviewers.');
    expect(item.ops[1]).toEqual({ op: 'trash', rel: 'notes/two.md' });
    const plan = buildPlan([{ ...item, hashes: {} }]);
    expect(plan.ok).toEqual(['r:find:near']);
    expect(plan.groups.map((g) => g.label)).toEqual(['Merge 1 pair of notes']);
  });

  it('carries the dropped note\'s aliases onto the kept note once each', () => {
    const d = checkDraft(mergeItem, [ONE, TWO], reply({ kind: 'merge', keep: 'notes/one.md', text: '# One\nIt needs two reviewers.', quotes: q, confidence: 'high' })).draft;
    const aliases = { 'notes/one.md': ['First'], 'notes/two.md': ['Second', 'first'] };
    const before = withDraft(mergeItem, d, (rel) => texts[rel], (rel) => aliases[rel] ?? []).ops[0].before;
    expect(before).toContain('  - two\n  - Second');
    expect(before).not.toMatch(/- first/);
  });

  it('rewrites one note for a contradiction', () => {
    const d = checkDraft(mergeItem, [ONE, TWO], reply({ kind: 'contradiction', rel: 'notes/two.md', text: '# Two\nThe launch is on Monday.', quotes: q, confidence: 'medium' })).draft;
    const item = withDraft(mergeItem, d, (rel) => texts[rel]);
    expect(item.group).toBe('rewrite');
    expect(item.ops).toEqual([{ op: 'restore', rel: 'notes/two.md', before: '# Two\nThe launch is on Monday.\n' }]);
  });

  it('starts ticked in a bulk plan only at high confidence with every quote checked', () => {
    const d = { kind: 'create', text: 'x', quotes: [{ path: 'a', line: 1, text: 'abc', ok: true }], confidence: 'high', verified: true };
    expect(checkFirst(withDraft(createItem, d, () => ''))).toBeNull();
    expect(trustedDraft(d)).toBe(true);
    expect(checkFirst(withDraft(createItem, { ...d, confidence: 'medium' }, () => ''))).toMatch(/agent drafted/);
    expect(checkFirst(withDraft(createItem, { ...d, quotes: [{ ...d.quotes[0], ok: false }] }, () => ''))).toMatch(/agent drafted/);
    expect(withDraft(createItem, d, () => '').ops[0].text).toBe('x');
  });
});

describe('the drafter', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
  const setup = (opts = {}) => {
    dir = mkdtempSync(path.join(tmpdir(), 'qdraft-'));
    const calls = [];
    const notes = { 'notes/a.md': A.text, 'notes/b.md': B.text };
    const good = reply({ kind: 'create', text: 'Zephyr ships in March.', quotes: [{ path: 'notes/a.md', line: 2, text: 'ships in March' }], confidence: 'high' });
    const d = createDrafter({
      file: path.join(dir, 'drafts.json'),
      model: async (prompt, system) => { calls.push({ prompt, system }); if (opts.cancel) throw Object.assign(new Error('Cancelled'), { cancelled: true }); return opts.reply ?? good; },
      items: () => [createItem],
      evidence: (item) => (opts.guarded ? null : evidenceRels(item).map((rel) => ({ rel, text: notes[rel] }))),
      enabled: () => opts.enabled ?? true,
      cap: () => opts.cap ?? 40,
      busy: () => opts.busy ?? false,
      idleMs: () => opts.idle ?? 10 * 60000,
      now: () => opts.now ?? Date.UTC(2026, 10, 16, 12),
    });
    return { d, calls, notes };
  };

  it('drafts once per item and keeps the draft while its notes read the same', async () => {
    const { d, calls, notes } = setup();
    expect((await d.tick()).drafted).toBe('r:link:zephyr');
    const ev = () => evidenceRels(createItem).map((rel) => ({ rel, text: notes[rel] }));
    expect(d.draftFor(createItem, ev()).confirmed).toBeUndefined();
    // the next tick drafts the same item again, independently, to confirm the first draft
    expect(await d.tick()).toEqual({ confirmed: 'r:link:zephyr', agree: true });
    expect((await d.tick()).skipped).toBe('nothing');
    expect(calls).toHaveLength(2);
    expect(d.draftFor(createItem, ev())).toMatchObject({ kind: 'create', confidence: 'high', confirmed: true });
    notes['notes/a.md'] = '# A\nchanged';
    expect(d.draftFor(createItem, ev())).toBeNull();
  });

  it('waits while off, while busy (a recording or a fix run), while the person typed in the last two minutes, and past the daily cap', async () => {
    expect((await setup({ enabled: false }).d.tick()).skipped).toBe('off');
    expect((await setup({ busy: true }).d.tick()).skipped).toBe('busy');
    expect((await setup({ idle: 30000 }).d.tick()).skipped).toBe('typing');
    const capped = setup({ cap: 1 });
    capped.d.status();
    await capped.d.tick();
    expect(capped.d.status()).toMatchObject({ used: 1, cap: 1, waiting: 'cap' });
  });

  it('gives a cancelled call its place under the daily cap back and drafts the item again later', async () => {
    const run = setup({ cap: 1, cancel: true });
    expect(await run.d.tick()).toEqual({ cancelled: 'r:link:zephyr' });
    expect(run.d.status()).toMatchObject({ used: 0, waiting: null });
    expect(await run.d.tick()).toEqual({ cancelled: 'r:link:zephyr' });
    expect(run.calls).toHaveLength(2);
  });

  it('never calls the model when the read guard or a confidential mark keeps a needed note away', async () => {
    const { d, calls } = setup({ guarded: true });
    expect((await d.tick()).skipped).toBe('nothing');
    expect(calls).toHaveLength(0);
  });

  it('drops a draft whose quotes do not match and does not retry it the same day', async () => {
    const { d, calls } = setup({ reply: reply({ kind: 'create', text: 'x', quotes: [{ path: 'notes/a.md', line: 2, text: 'invented words' }], confidence: 'high' }) });
    expect((await d.tick()).why).toMatch(/does not match/);
    expect((await d.tick()).skipped).toBe('nothing');
    expect(calls).toHaveLength(1);
  });
});

describe('Approve runs the agent on demand', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });
  const notes = { 'notes/a.md': A.text, 'notes/b.md': B.text };
  const ev = (item) => evidenceRels(item).map((rel) => ({ rel, text: notes[rel] }));
  const setup = (replies, opts = {}) => {
    dir = mkdtempSync(path.join(tmpdir(), 'qdemand-'));
    const calls = [];
    const d = createDrafter({
      file: path.join(dir, 'drafts.json'),
      model: async (prompt, system, o) => { calls.push({ prompt, signal: o?.signal ?? null }); if (opts.cancel) throw Object.assign(new Error('Cancelled'), { cancelled: true }); return replies.shift(); },
      items: () => [], evidence: ev, enabled: () => false, cap: () => opts.cap ?? 40, busy: () => true, idleMs: () => 0,
      now: () => Date.UTC(2026, 10, 16, 12),
    });
    return { d, calls };
  };
  const good = reply({ kind: 'create', text: 'Zephyr ships in March.', quotes: [{ path: 'notes/a.md', line: 2, text: 'ships in March' }], confidence: 'high' });

  it('drafts a missing note while background drafting is off, busy and the person is typing, and counts it under the cap', async () => {
    const { d, calls } = setup([good]);
    const res = await d.onDemand(createItem, ev(createItem));
    expect(res.draft).toMatchObject({ kind: 'create', text: 'Zephyr ships in March.', confidence: 'high' });
    expect(calls).toHaveLength(1);
    expect(d.status().used).toBe(1);
    expect(d.fallbackFor(createItem, ev(createItem))).toBeNull();
    expect(withDraft(createItem, res.draft, () => '').ops[0].text).toBe('Zephyr ships in March.');
  });

  it('writes nothing and keeps the reason when a quote fails or the agent is not sure, until the notes change', async () => {
    const bad = reply({ kind: 'create', text: 'x', quotes: [{ path: 'notes/a.md', line: 2, text: 'invented words' }], confidence: 'high' });
    const low = reply({ kind: 'create', text: 'x', quotes: [{ path: 'notes/a.md', line: 2, text: 'ships in March' }], confidence: 'low' });
    const { d } = setup([bad, low]);
    const r1 = await d.onDemand(createItem, ev(createItem));
    expect(r1).toMatchObject({ keep: true });
    expect(r1.why).toMatch(/does not match its note, so Quorum wrote nothing/);
    expect(d.fallbackFor(createItem, ev(createItem))).toBe(r1.why);
    expect((await d.onDemand(createItem, ev(createItem))).why).toMatch(/not sure enough/);
    expect(d.fallbackFor(createItem, [{ rel: 'notes/a.md', text: 'changed' }])).toBeNull();
  });

  it('never calls the model for a note the read guard keeps away, and offers the fallback', async () => {
    const { d, calls } = setup([good]);
    const res = await d.onDemand(createItem, null);
    expect(res.keep).toBe(true);
    expect(res.why).toMatch(/read guard or a confidential mark/);
    expect(calls).toHaveLength(0);
    expect(d.fallbackFor(createItem, null)).toBe(res.why);
  });

  it('stops at the daily cap and keeps no fallback, since the cap resets', async () => {
    const { d, calls } = setup([good], { cap: 0 });
    const res = await d.onDemand(createItem, ev(createItem));
    expect(res).toMatchObject({ keep: false });
    expect(res.why).toMatch(/daily limit/);
    expect(calls).toHaveLength(0);
  });

  it('gives a cancelled call its place under the cap back and passes the signal to the model', async () => {
    const { d, calls } = setup([], { cancel: true });
    const ctl = new AbortController();
    const res = await d.onDemand(createItem, ev(createItem), { signal: ctl.signal });
    expect(res).toMatchObject({ cancelled: true, keep: false });
    expect(calls[0].signal).toBe(ctl.signal);
    expect(d.status().used).toBe(0);
  });

  it('runs one model call at a time with the background drafter', async () => {
    let release;
    const order = [];
    dir = mkdtempSync(path.join(tmpdir(), 'qdemand-'));
    const d = createDrafter({
      file: path.join(dir, 'drafts.json'),
      model: async (prompt) => { order.push(prompt.includes('zephyr') ? 'start' : 'other'); if (!release) await new Promise((r) => { release = r; }); order.push('end'); return good; },
      items: () => [createItem], evidence: ev, enabled: () => true, idleMs: () => 10 * 60000, now: () => Date.UTC(2026, 10, 16, 12),
    });
    const bg = d.tick();
    await new Promise((r) => setTimeout(r, 0));
    const fg = d.onDemand(createItem, ev(createItem));
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(['start']);
    release();
    await bg;
    await fg;
    expect(order).toEqual(['start', 'end', 'start', 'end']);
  });

  it('checks a weak match against the notes Approve offers and relinks to a better one', () => {
    const notes2 = { ...notes, 'notes/orbit-plan.md': '# Orbit plan', 'notes/orbit-launch.md': '# Orbit launch\nThe orbit launch window.' };
    const item = { ...pointItem, agentKind: 'point', options: ['notes/orbit-plan.md', 'notes/orbit-launch.md'] };
    expect(pointOptions(item)).toEqual(['notes/orbit-plan.md', 'notes/orbit-launch.md']);
    const read = evidenceRels(item).map((rel) => ({ rel, text: notes2[rel] }));
    expect(read.map((n) => n.rel)).toEqual(['notes/a.md', 'notes/orbit-plan.md', 'notes/orbit-launch.md']);
    expect(draftPrompt(item, read).prompt).toMatch(/Decide which of these notes the links mean: notes\/orbit-plan.md, notes\/orbit-launch.md/);
    const q = [{ path: 'notes/orbit-launch.md', line: 2, text: 'orbit launch window' }];
    const better = checkDraft(item, read, reply({ kind: 'point', to: 'notes/orbit-launch.md', quotes: q, confidence: 'high' })).draft;
    expect(better.to).toBe('notes/orbit-launch.md');
    expect(checkDraft(item, read, reply({ kind: 'point', to: 'notes/b.md', quotes: q, confidence: 'high' })).why).toMatch(/did not offer/);
    const texts = { 'notes/a.md': 'See [[orbit]] and [[orbit|the plan]].' };
    const next = withDraft(item, better, (rel) => texts[rel] ?? null);
    expect(next).toMatchObject({ direct: true, relinkTo: 'notes/orbit-launch.md', group: 'relink' });
    expect(next.ops).toEqual([{ op: 'restore', rel: 'notes/a.md', before: 'See [[orbit-launch]] and [[orbit-launch|the plan]].', expect: sha(texts['notes/a.md']) }]);
    const same = withDraft(item, { ...better, to: 'notes/orbit-plan.md' }, () => '');
    expect(same.ops).toEqual(pointItem.ops);
    expect(same.direct).toBeUndefined();
  });

  it('turns an item the agent could not fix into removing the dead link, with the reason', () => {
    const f = fallbackItem({ ...createItem, agentKind: 'create', ops: [{ op: 'create', rel: 'notes/zephyr.md', sources: ['notes/a.md', 'notes/b.md'], lines: { 'notes/a.md': [1] } }] }, 'A quote does not match.');
    expect(f).toMatchObject({ fallback: 'A quote does not match.', wrongNote: true, group: 'unlink', autoFix: false, ops: [{ op: 'unlink', target: 'zephyr', sources: ['notes/a.md', 'notes/b.md'], lines: { 'notes/a.md': [1] } }] });
    expect(f.agentKind).toBeUndefined();
  });
});
