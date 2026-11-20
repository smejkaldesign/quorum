import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPathIndex, createResolver, parseNote } from '../linkparse.js';
import { createVaultIndex } from '../vindex.js';
import { fileIssues, groupByLine, issueOf, LINE_KEY } from '../memoryHealth.js';
import { findingItem, itemLine, linkItem } from '../reviewItems.js';
import { buildPlan } from '../batchPlan.js';
import { RULES, runRules } from '../rules/index.js';
import * as entityAliases from '../rules/entityAliases.js';
import * as duplicates from '../rules/duplicates.js';
import * as nearDuplicates from '../rules/nearDuplicates.js';
import * as frontmatter from '../rules/frontmatter.js';
import * as missingEntity from '../rules/missingEntity.js';
import * as unplaced from '../rules/unplaced.js';
import { meetingInstance } from '../rules/common.js';
import { keptAs } from '../rules/entities.js';
import { instructionTexts, runSetupOp } from '../memorySetup.js';
import { createMemorySweep, staleFinding } from '../memorySweep.js';

// Quorum adapts to the vault: links, merges, frontmatter, people and placement follow the vault's own conventions.
// Every vault here is generated in a temp folder; every name and line is made up.
const NOW = Date.UTC(2026, 10, 15);
const DAY = 86400000;
const note = (rel, text, extra = {}) => ({ rel, text, note: parseNote(rel, text), mtime: NOW - DAY, size: text.length, inbound: 1, outbound: 1, ...extra });
const resolverOf = (notes) => createResolver(notes.map((n) => n.rel), (rel) => notes.find((n) => n.rel === rel)?.note?.aliases ?? []);
const ctx = (notes, extra = {}) => ({ notes, resolve: resolverOf(notes), now: NOW, ...extra });
const fm = (o) => `---\n${Object.entries(o).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n`;

const dirs = [];
const tmp = (name) => { const d = mkdtempSync(path.join(tmpdir(), `qvc-${name}-`)); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });
const put = (root, rel, text = '') => { mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); writeFileSync(path.join(root, rel), text); };
const indexOf = (vault, opts = {}) => { const i = createVaultIndex({ vault, isExcludedPath: () => false, isExcludedText: () => false, redact: (t) => t, onChange: () => {}, ...opts }); i.sync(); return i; };

describe('one resolver for the vault’s own link conventions', () => {
  it('opens a note by its frontmatter name:, its aliases, a folder, a file and a note in a dot folder', () => {
    const vault = tmp('links');
    put(vault, 'memory/feedback_tidy.md', `${fm({ name: 'tidy-rule' })}# Tidy rule\n`);
    put(vault, 'memory/other.md', `${fm({ aliases: '[Other Name]' })}# Other\n`);
    put(vault, '.claude/memory/reference_dash.md', `${fm({ name: 'dash-link', description: 'made up' })}# Dash\n`);
    put(vault, '.claude/skills/weekly-review/SKILL.md', '# Weekly review\n');
    put(vault, 'assets/chart.png', 'png');
    put(vault, 'hub.md', '# Hub\n\n[[tidy-rule]] [[Other Name]] [[dash-link]] [[.claude/skills/weekly-review]] [[weekly-review]] [[assets/chart.png]] [[chart.png]] [[nowhere at all]]\n');
    const index = indexOf(vault);
    expect(index.missingIn('hub.md').map((l) => l.target)).toEqual(['nowhere at all']);
    expect(index.linkHealth().map((m) => m.target)).toEqual(['nowhere at all']);
    expect(index.resolve('tidy-rule', 'hub.md')).toBe('memory/feedback_tidy.md');
    expect(index.pathOf('dash-link', 'hub.md')).toBe('.claude/memory/reference_dash');
    expect(index.pathOf('weekly-review', 'hub.md')).toBe('.claude/skills/weekly-review');
    // the graph reads the same resolver: only the link that opens nothing is a ghost node
    expect(index.graph().nodes.filter((n) => n.ghost).map((n) => n.name)).toEqual(['nowhere at all']);
  });

  it('opens folders and files at the brain root around a vault in a subfolder', () => {
    const root = tmp('root');
    put(root, '.claude/skills/morning-brief/SKILL.md', '# Morning brief\n');
    put(root, 'scripts/tidy.py', 'print(1)\n');
    put(root, 'Vault/a.md', '# A\n\n[[.claude/skills/morning-brief]] [[scripts/tidy.py]] [[missing one]]\n');
    const index = indexOf(path.join(root, 'Vault'), { root });
    expect(index.missingIn('a.md').map((l) => l.target)).toEqual(['missing one']);
  });

  it('matches like the note resolver: relative, exact, path suffix, then name', () => {
    const at = createPathIndex([{ rel: 'tools/.claude/skills/x', names: [] }, { rel: '.claude/mem/feedback_y', names: ['y'] }]);
    expect(at('skills/x', 'n.md')).toBe('tools/.claude/skills/x');
    expect(at('x/', 'n.md')).toBe('tools/.claude/skills/x');
    expect(at('Y', 'n.md')).toBe('.claude/mem/feedback_y');
    expect(at('feedback_y.md', 'n.md')).toBe('.claude/mem/feedback_y');
    expect(at('../outside', 'n.md')).toBeNull();
    expect(at('z', 'n.md')).toBeNull();
  });
});

describe('dead links grouped by the line that holds them', () => {
  const dead = (target, rel, line, extra = {}) => ({ target, sources: [rel], count: 1, links: 1, candidates: [], contexts: [{ rel, text: 'A line that lists a few things.' }], at: [{ rel, line }], ...extra });
  const callout = Array.from({ length: 15 }, (_, i) => dead(`Missing ${i + 1}`, 'hub.md', 4));

  it('makes one issue per line with one fix, and keeps a link with a better fix on its own', () => {
    const alias = dead('Alias me', 'hub.md', 4, { candidates: [{ rel: 'a.md', title: 'Alias me', name: null, exact: true, score: 1 }] });
    const elsewhere = dead('Two places', 'hub.md', 4, { at: [{ rel: 'hub.md', line: 4 }, { rel: 'other.md', line: 1 }], sources: ['hub.md', 'other.md'], count: 2 });
    const out = groupByLine([...callout, alias, elsewhere]);
    expect(out).toHaveLength(3);
    const g = out.find((m) => m.group);
    expect(g.target).toBe(`${LINE_KEY}hub.md#5`);
    expect(g.group.targets).toHaveLength(15);
    const issue = issueOf(g);
    expect(issue.title).toBe('Line 5 of “hub.md” links to 15 notes that do not exist');
    expect(issue.action).toBe('unlink');
    expect(issue.recommend).toBe('Remove the 15 dead links on that line and keep their words.');
    const item = linkItem(issue, { noteOf: () => ({ links: callout.map((m) => ({ target: m.target, line: 4 })) }) });
    expect(item.ops).toHaveLength(15);
    expect(item.ops.every((o) => o.op === 'unlink' && o.sources[0] === 'hub.md' && o.lines['hub.md'][0] === 4)).toBe(true);
    expect(itemLine(item)).toBe('Remove the 15 dead links on line 5 of “hub.md”');
    const plan = buildPlan([item]);
    expect(plan.ok).toEqual([item.id]);
    expect(plan.groups).toMatchObject([{ id: 'unlink', count: 15, label: 'Remove 15 dead links' }]);
  });

  it('leaves a single dead link and a dismissed one as they are, and shows a group once in the open note', () => {
    expect(groupByLine([dead('Only one', 'a.md', 2)]).map((m) => m.target)).toEqual(['Only one']);
    const two = [dead('One', 'a.md', 2), dead('Two', 'a.md', 2)];
    expect(groupByLine(two, { left: new Set(['one']) }).map((m) => m.target)).toEqual(['One', 'Two']);
    const items = groupByLine(two);
    const lines = [{ target: 'One', line: 2 }, { target: 'Two', line: 2 }];
    expect(fileIssues(lines, items).map((x) => x.issue.key)).toEqual([`${LINE_KEY}a.md#3`]);
  });
});

describe('dated meeting notes are never merged or sent to the Trash', () => {
  const series = [
    note('meetings/2026-09-01 All hands.md', `${fm({ type: 'meeting', date: '2026-09-01' })}# All hands\n\n${'We went over the plan for the quarter and who owns which part of it. '.repeat(5)}`, { inbound: 3 }),
    note('meetings/2026-10-01 All hands.md', `${fm({ type: 'meeting', date: '2026-10-01' })}# All hands\n\n${'We went over the plan for the quarter and who owns which part of it. '.repeat(5)}`, { inbound: 1 }),
    note('projects/2026-10-07 Ana 1-1.md', `${fm({ type: 'project', attendees: '[Ana Ruiz]' })}# Ana 1:1\n\n${'Notes from the weekly check in with a list of follow ups. '.repeat(6)}more`),
    note('projects/2026-10-14 Ana 1-1.md', `${fm({ type: 'project', attendees: '[Ana Ruiz]' })}# Ana 1:1\n\n${'Notes from the weekly check in with a list of follow ups. '.repeat(6)}other`),
  ];

  it('tells a dated meeting note by its date, its folder, its type or its attendees', () => {
    expect(meetingInstance('logs/2026-01-02.md')).toBe(true);
    expect(meetingInstance('meetings/Kickoff.md')).toBe(true);
    expect(meetingInstance('notes/Kickoff.md', { type: 'meeting' })).toBe(true);
    expect(meetingInstance('notes/Kickoff.md', { attendees: ['Ana Ruiz'] })).toBe(true);
    expect(meetingInstance('notes/Kickoff.md', { type: 'project' })).toBe(false);
  });

  it('no rule proposes a merge or a Trash that drops one, from any rule', () => {
    expect(entityAliases.run(ctx(series)).filter((f) => f.key.includes(':merge:'))).toEqual([]);
    expect(duplicates.run(ctx(series))).toEqual([]);
    expect(nearDuplicates.run(ctx(series))).toEqual([]);
    const { findings } = runRules(ctx(series, { optIn: { entityNotes: true, placement: true } }));
    for (const f of findings) {
      const ops = findingItem(f).ops ?? [];
      const drops = ops.filter((o) => o.op === 'merge' || o.op === 'trash').map((o) => o.drop ?? o.rel);
      expect(drops.filter((rel) => meetingInstance(rel, series.find((n) => n.rel === rel)?.note?.props))).toEqual([]);
    }
  });

  it('holds a merge item that would drop one, and the merge step refuses it and trashes nothing', async () => {
    const f = { ruleId: 'note.entity-alias', key: 'note.entity-alias:merge:x', rel: 'a.md', notes: ['a.md', 'meetings/2026-10-01 sync.md'], fix: { kind: 'ops', group: 'merge-entity', ops: [{ op: 'merge', rel: 'a.md', drop: 'meetings/2026-10-01 sync.md', alias: 'Sync' }] } };
    const item = findingItem(f);
    expect(item.ops).toEqual([]);
    expect(item.hold).toMatch(/dated meeting note/);
    const vault = tmp('merge');
    put(vault, 'a.md', '# A\n');
    put(vault, 'notes/Weekly sync.md', `${fm({ type: 'meeting' })}# Weekly sync\n`);
    const trashed = [];
    const vindex = { note: (rel) => parseNote(rel, rel === 'a.md' ? '# A\n' : `${fm({ type: 'meeting' })}# Weekly sync\n`), rels: () => ['a.md', 'notes/Weekly sync.md'], backlinks: () => [], resolve: () => null, sync: () => {} };
    await expect(runSetupOp({}, { op: 'merge', rel: 'a.md', drop: 'notes/Weekly sync.md', alias: 'Weekly sync' }, { step: async () => {}, keep: () => {}, vault }, { vindex, trash: async (p) => trashed.push(p) })).rejects.toThrow(/dated meeting note/);
    expect(trashed).toEqual([]);
    expect(existsSync(path.join(vault, 'notes/Weekly sync.md'))).toBe(true);
  });
});

describe('frontmatter consistency never adds an empty key', () => {
  it('drops a missing key Quorum cannot fill, from every finding', () => {
    const folder = Array.from({ length: 6 }, (_, i) => note(`specs/s${i}.md`, `${fm({ type: 'spec', owner: 'team' })}# S${i}`));
    expect(frontmatter.run(ctx([...folder, note('specs/bare.md', '# Bare')]))).toEqual([]);
  });
});

describe('people and projects follow where the vault keeps them', () => {
  const mention = (i, name) => note(`log/2026-11-0${i} call.md`, `${fm({ attendees: `[${name}]` })}# Call ${i}\n`);
  const calls = [1, 2, 3].map((i) => mention(i, 'Ana Ruiz'));

  it('reads a people folder or typed notes as one note each, an identity or team note as a list, else nothing', () => {
    expect(keptAs([note('people/bo.md', '# Bo')], 'person').mode).toBe('notes');
    expect(keptAs([note('a.md', `${fm({ type: 'person' })}# A`), note('b.md', `${fm({ type: 'person' })}# B`)], 'person').mode).toBe('notes');
    expect(keptAs([note('identity.md', '# Who\n\nAna Ruiz leads design.')], 'person').mode).toBe('list');
    expect(keptAs([note('notes/x.md', '# X')], 'person').mode).toBeNull();
  });

  it('proposes no person note in a vault that lists people, and none without a sign unless turned on', () => {
    expect(missingEntity.run(ctx([...calls, note('identity.md', '# Who\n\nAna Ruiz leads design.')]))).toEqual([]);
    expect(missingEntity.run(ctx([...calls, note('identity.md', '# Who\n\nAna Ruiz leads design.')], { optIn: { entityNotes: true } }))).toEqual([]);
    expect(missingEntity.run(ctx(calls))).toEqual([]);
    expect(missingEntity.run(ctx(calls, { optIn: { entityNotes: true } })).map((f) => f.target)).toEqual(['Ana Ruiz.md']);
  });

  it('in a vault with a people folder, skips a name its instructions already name', () => {
    const vault = [...calls, note('people/bo-li.md', '# Bo Li'), note('people/cy-do.md', '# Cy Do')];
    expect(missingEntity.run(ctx(vault)).map((f) => f.target)).toEqual(['people/ana-ruiz.md']);
    expect(missingEntity.run(ctx([...vault, note('CLAUDE.md', '# Vault\n\n| Ana Ruiz | design lead |')]))).toEqual([]);
  });
});

describe('placement follows the vault’s own layout', () => {
  const projects = ['a', 'b', 'c'].map((x) => note(`projects/${x}.md`, `${fm({ type: 'project' })}# ${x}`));
  const outside = note('status/finance-status.md', `${fm({ type: 'project' })}# Finance status`);

  it('flags a typed note outside a folder that holds most notes of its kind', () => {
    expect(unplaced.run(ctx([...projects, outside])).map((f) => f.fix.ops[0])).toEqual([{ op: 'move', rel: 'status/finance-status.md', to: 'projects/finance-status.md' }]);
  });
  it('never flags a note the instructions or a skill name, and is opt-in where the layout shows no convention', () => {
    expect(unplaced.run(ctx([...projects, outside], { instructions: ['Write status/finance-status.md every Monday.'] }))).toEqual([]);
    expect(unplaced.run(ctx([...projects, outside, note('CLAUDE.md', '# Vault\n\nThe weekly skill writes finance-status here.')]))).toEqual([]);
    const loose = [projects[0], outside, note('x/b.md', `${fm({ type: 'project' })}# b`), note('y/c.md', `${fm({ type: 'project' })}# c`)];
    expect(unplaced.run(ctx(loose))).toEqual([]);
    expect(unplaced.run(ctx(loose, { optIn: { placement: true } }))).toHaveLength(3);
  });
  it('reads the skills and instruction files the index leaves out', () => {
    const root = tmp('instr');
    put(root, 'CLAUDE.md', 'Root rules.');
    put(root, '.claude/skills/weekly/SKILL.md', 'Writes status/finance-status.md.');
    put(root, 'Vault/.claude/skills/daily/SKILL.md', 'Writes the daily note.');
    expect(instructionTexts({ root, vault: path.join(root, 'Vault') }).sort()).toEqual(['Root rules.', 'Writes status/finance-status.md.', 'Writes the daily note.']);
  });
});

describe('items the new rules no longer raise drop out on the next check', () => {
  it('runs a rule over the whole vault when it holds a finding from an older version', () => {
    const vault = tmp('sweep');
    const sweeps = createMemorySweep({ file: path.join(vault, 'sweeps.json'), now: () => NOW });
    const notes = [...Array.from({ length: 6 }, (_, i) => note(`specs/s${i}.md`, `${fm({ owner: 'team' })}# S${i}`)), note('specs/bare.md', '# Bare')];
    const old = { ruleId: 'note.frontmatter', ruleVersion: 1, key: 'note.frontmatter:specs/bare.md', notes: ['specs/bare.md'], title: 'old' };
    expect(staleFinding(old)).toBe(true);
    expect(staleFinding({ ...old, ruleVersion: RULES.find((r) => r.rule.id === 'note.frontmatter').rule.version })).toBe(false);
    sweeps.put(vault, { findings: [old], lastFull: NOW - DAY, lastIncremental: NOW - DAY });
    // a save of another note: the old finding goes, since the rule ran everywhere and no longer raises it
    const s = sweeps.run(vault, 'save', ctx(notes), { only: ['specs/s0.md'] });
    expect(s.findings.filter((f) => f.ruleId === 'note.frontmatter')).toEqual([]);
  });
});
