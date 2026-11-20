import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseNote, createResolver } from '../linkparse.js';
import { RULES, SETUP_RULES, runRules } from '../rules/index.js';
import * as missingEntity from '../rules/missingEntity.js';
import * as entityAliases from '../rules/entityAliases.js';
import * as meetingLinks from '../rules/meetingLinks.js';
import * as entityType from '../rules/entityType.js';
import * as unplaced from '../rules/unplaced.js';
import * as summaries from '../rules/summaries.js';
import * as instructions from '../rules/instructions.js';
import * as orphans from '../rules/orphans.js';
import * as duplicates from '../rules/duplicates.js';
import { ruleGraph } from '../rules/entities.js';
import { noteHash } from '../rules/common.js';
import { findingItem, itemLine } from '../reviewItems.js';
import { buildPlan, checkOrder } from '../batchPlan.js';
import { approvedEdges, createMemorySetup, endEdges, freshness, graphFreshness, linkMention, mergeText, nodeIdOf, outsideInstructions, pickItem, recordContradictions, resolveContradiction, runSetupOp, setupReport, splitText, unindexedLinkers } from '../memorySetup.js';
import * as oversized from '../rules/oversized.js';
import { isName } from '../rules/entities.js';
import { itemUndo } from '../batchItemUndo.js';
import { batchItems } from '../batchItems.js';
import { applyUndo, undoRecord } from '../fixUndo.js';
import { hashNotes } from '../fixJournal.js';
import { walk } from '../vault.js';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemorySetupView } from '../src/MemorySetup.tsx';
import { keeperRow, phaseName } from '../src/memorySetupView.ts';
import { meetingEdges } from '../keeper.js';
import { createVaultIndex } from '../vindex.js';
import { createMemoryGraph } from '../graph/index.js';
import { openStore } from '../graph/store.js';
import { writeGraphVault } from './fixtures/graphVault.js';

// Synthetic notes. Every name and line is made up.
const NOW = Date.UTC(2026, 10, 15);
const DAY = 86400000;
const note = (rel, text, extra = {}) => ({ rel, text, note: parseNote(rel, text), mtime: NOW - DAY, size: text.length, inbound: 1, outbound: 1, ...extra });
const resolverOf = (notes) => createResolver(notes.map((n) => n.rel), (rel) => notes.find((n) => n.rel === rel)?.note?.aliases ?? []);
const ctx = (notes, extra = {}) => ({ notes, resolve: resolverOf(notes), now: NOW, ...extra });
const fm = (o) => `---\n${Object.entries(o).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n`;
const meeting = (i, people, body = 'We met.') => note(`meetings/2026-11-0${i} sync.md`, `${fm({ type: 'meeting', date: `2026-11-0${i}`, attendees: `[${people.join(', ')}]` })}# Sync ${i}\n\n${body}\n`);

// an in-memory stand-in for graph/store.js with the calls the setup code makes
function fakeStore({ nodes = [], edges = [] } = {}) {
  let next = edges.length + 1;
  const es = edges.map((e, i) => ({ id: i + 1, valid_to: null, superseded_by: null, ...e }));
  const ns = new Map(nodes.map((x) => [x.id, x]));
  const cur = (e) => e.valid_to == null && e.superseded_by == null;
  return {
    edges: es,
    ready: () => true,
    tx: (fn) => fn(),
    node: (id) => ns.get(id) ?? null,
    nodes: ({ kind }) => [...ns.values()].filter((x) => x.kind === kind),
    upsertNode: (x) => ns.set(x.id, x),
    aliasesOf: (id) => ns.get(id)?.aliases ?? [],
    nodesByRel: (rel) => [...ns.values()].filter((x) => x.rel === rel),
    removeEdge: (id) => { const i = es.findIndex((x) => x.id === id); es.splice(i, 1); },
    addEdge: (e) => { const id = next++; es.push({ id, valid_to: null, superseded_by: null, ...e }); return id; },
    supersede: (id, by, at) => { const e = es.find((x) => x.id === id); e.valid_to = at; e.superseded_by = by; },
    edgesOf: (id, { dir = 'both', kinds = null, current = true } = {}) => es.filter((e) => (dir === 'in' ? e.dst === id : dir === 'out' ? e.src === id : e.src === id || e.dst === id) && (!kinds || kinds.includes(e.kind)) && (!current || cur(e))),
    edgesBySource: (rel) => es.filter((e) => e.source_rel === rel && e.provenance !== 'person'),
  };
}

describe('the setup rules', () => {
  it('are registered, documented ids, and none applies on its own', () => {
    const ids = RULES.map((r) => r.rule.id);
    for (const id of SETUP_RULES) expect(ids).toContain(id);
    const notes = [meeting(1, ['Ana Ruiz']), meeting(2, ['Ana Ruiz']), meeting(3, ['Ana Ruiz'])];
    const { findings } = runRules(ctx(notes, { optIn: { entityNotes: true } }));
    expect(findings.some((f) => f.ruleId === 'note.missing-entity')).toBe(true);
    expect(findings.every((f) => f.autoFix === false)).toBe(true);
  });
});

describe('note.missing-entity', () => {
  it('writes a note for a name three notes mention and links each mention', () => {
    const notes = [meeting(1, ['Ana Ruiz', 'Ben Ode']), meeting(2, ['Ana Ruiz']), meeting(3, ['Ana Ruiz']), note('people/cai-lu.md', '# Cai Lu\n'), note('people/dee-mo.md', '# Dee Mo\n')];
    const fs = missingEntity.run(ctx(notes));
    expect(fs).toHaveLength(1);
    const [f] = fs;
    // the people folder names notes as slugs, so the new note does too and keeps the name as an alias
    expect(f.target).toBe('people/ana-ruiz.md');
    const [create, ...mentions] = f.fix.ops;
    expect(create.text).toMatch(/^---\ntype: person\naliases: \["Ana Ruiz"\]/);
    expect(create.text).toContain('[[meetings/2026-11-01 sync]]');
    expect(mentions.map((m) => [m.rel, m.edge])).toEqual(notes.slice(0, 3).map((n) => [n.rel, 'attended']));
  });
  it('leaves out names only confidential notes mention, and names a note already goes by', () => {
    const secret = [1, 2, 3].map((i) => meeting(i, ['Eve Sol']));
    for (const n of secret) n.note.props.confidential = 'private';
    expect(missingEntity.run(ctx(secret))).toEqual([]);
    const known = [meeting(1, ['Ana Ruiz']), meeting(2, ['Ana Ruiz']), meeting(3, ['Ana Ruiz']), note('people/ana.md', `${fm({ aliases: '[Ana Ruiz]' })}# Ana`)];
    expect(missingEntity.run(ctx(known))).toEqual([]);
  });
  it('leaves out the vault owner, and drops a trailing period from the file name', () => {
    const notes = [1, 2, 3].map((i) => meeting(i, ['Rae Owner', 'Blaze M.']));
    const fs = missingEntity.run(ctx(notes, { owner: 'Rae Owner', optIn: { entityNotes: true } }));
    expect(fs.map((f) => f.target)).toEqual(['Blaze M.md']);
  });
  it('reads names from the graph when it is built', () => {
    const notes = [1, 2, 3].map((i) => note(`n${i}.md`, `# N${i}\n`));
    const store = fakeStore({ nodes: [{ id: 'project:atlas', kind: 'project', name: 'Atlas', rel: null }], edges: notes.map((n) => ({ src: `note:${n.rel}`, dst: 'project:atlas', kind: 'mentions', source_rel: n.rel })) });
    const [f] = missingEntity.run(ctx(notes, { graph: ruleGraph(store), optIn: { entityNotes: true } }));
    expect(f.target).toBe('Atlas.md');
    expect(f.evidence).toContain('Found in the memory graph');
  });
});

describe('note.entity-alias', () => {
  it('matches first name and last initial, and equal names once normalized', () => {
    expect(entityAliases.sameEntity('Ana R.', 'Ana Ruiz')).toBe(true);
    expect(entityAliases.sameEntity('ana-ruiz', 'Ana Ruiz')).toBe(true);
    expect(entityAliases.sameEntity('Ana', 'Ana Ruiz')).toBe(false);
    expect(entityAliases.sameEntity('Project A', 'Project A26')).toBe(false);
    expect(entityAliases.sameEntity('Ana R.', 'Ana Ruiz', { initials: false })).toBe(false);
    expect(entityAliases.sameEntity('Ana Ruiz', 'Ana Ruiz')).toBe(false);
  });
  it('merges two notes for one person into the one more notes link to', () => {
    const notes = [note('people/Ana Ruiz.md', `${fm({ type: 'person' })}# Ana Ruiz\n\nLead.\n`, { inbound: 4 }), note('people/ana-ruiz.md', '# ana-ruiz\n\nOther text.\n', { inbound: 1 })];
    const [f] = entityAliases.run(ctx(notes));
    expect(f.fix.ops).toEqual([{ op: 'merge', rel: 'people/Ana Ruiz.md', drop: 'people/ana-ruiz.md', alias: 'ana-ruiz' }]);
    // two folder notes that nothing names as a person are two notes
    const plainPair = [note('people/Ana Ruiz.md', '# Ana Ruiz\n\nLead.\n'), note('people/ana-ruiz.md', '# ana-ruiz\n\nOther text.\n')];
    expect(entityAliases.run(ctx(plainPair))).toEqual([]);
  });
  it('adds a mentioned short name as an alias, and leaves a name two notes could be', () => {
    const one = [note('people/ana-ruiz.md', '# Ana Ruiz\n'), note('m.md', `${fm({ people: '[Ana R.]' })}# M`)];
    expect(entityAliases.run(ctx(one)).map((f) => f.fix.ops[0])).toEqual([{ op: 'alias', rel: 'people/ana-ruiz.md', alias: 'Ana R.' }]);
    const two = [...one, note('people/ana-rey.md', '# Ana Rey\n')];
    expect(entityAliases.run(ctx(two)).filter((f) => f.fix.ops[0].op === 'alias')).toEqual([]);
  });
});

describe('note.meeting-links', () => {
  it('links attendees who have notes, from frontmatter and an Attendees line', () => {
    const m = note('meetings/kickoff.md', `${fm({ attendees: '[Ana Ruiz, Zed Unknown]' })}# Kickoff\n\nAttendees: Ben Ode\n`);
    const notes = [m, note('people/Ana Ruiz.md', '# Ana Ruiz\n'), note('people/Ben Ode.md', '# Ben Ode\n')];
    const [f] = meetingLinks.run(ctx(notes));
    expect(f.fix.ops.map((o) => [o.name, o.to])).toEqual([['Ana Ruiz', 'people/Ana Ruiz.md'], ['Ben Ode', 'people/Ben Ode.md']]);
  });
  it('leaves a meeting that links its attendees already', () => {
    const m = note('meetings/k.md', `${fm({ attendees: '["[[Ana Ruiz]]"]' })}# K\n`);
    expect(meetingLinks.run(ctx([m, note('people/Ana Ruiz.md', '# Ana Ruiz\n')]))).toEqual([]);
  });
});

describe('note.entity-type and note.unplaced', () => {
  it('sets the type of the people notes a meeting names, in one item per folder, and leaves the other folder notes', () => {
    const notes = [
      note('people/Ana Ruiz.md', '# Ana Ruiz\n'), note('people/Ben Ode.md', '# Ben Ode\n'), note('people/reading list.md', '# Reading list\n'),
      note('people/index.md', '# People\n'), note('people/Cy Dale.md', `${fm({ type: 'person' })}# Cy Dale`),
      note('meetings/kick.md', `${fm({ type: 'meeting', attendees: '[Ana Ruiz, Ben Ode, Cy Dale]' })}# Kick`),
    ];
    const fs = entityType.run(ctx(notes));
    expect(fs).toHaveLength(1);
    expect(fs[0].notes).toEqual(['people/Ana Ruiz.md', 'people/Ben Ode.md']);
    expect(fs[0].fix).toMatchObject({ pick: true, ops: [{ op: 'setkey', rel: 'people/Ana Ruiz.md', key: 'type', value: 'person' }, { op: 'setkey', rel: 'people/Ben Ode.md', key: 'type', value: 'person' }] });
    expect(fs[0].evidence[0]).toBe('people/Ana Ruiz.md: meetings/kick.md names it');
  });
  it('moves a typed note into its kind folder, and a root note into the folder its links go to', () => {
    const notes = [
      note('people/ana.md', '# Ana\n'), note('Ben.md', `${fm({ type: 'person' })}# Ben`),
      note('projects/a.md', '# A'), note('projects/b.md', '# B'), note('projects/c.md', '# C'),
      note('Roadmap.md', '# Roadmap\n\n[[a]] [[b]] [[c]]\n'),
    ];
    expect(unplaced.run(ctx(notes, { optIn: { placement: true } })).map((f) => f.fix.ops[0])).toEqual([{ op: 'move', rel: 'Ben.md', to: 'people/Ben.md' }, { op: 'move', rel: 'Roadmap.md', to: 'projects/Roadmap.md' }]);
  });
});

describe('note.summary-stale', () => {
  const src = note('a.md', '# A\n\nThe plan.\n', { mtime: NOW - 2 * DAY });
  it('records the hashes of a summary that has none', () => {
    const s = note('s.md', `${fm({ type: 'summary', sources: '["[[a]]"]' })}# S`);
    const [f] = summaries.run(ctx([src, s]));
    expect(f.fix.ops[0].value).toBe(`["a.md@${noteHash(src.text)}"]`);
  });
  it('marks a summary stale once a source changed, and records again after the summary was edited', () => {
    const s = (mtime) => note('s.md', `${fm({ type: 'summary', sources: '["[[a]]"]', source_hashes: '["a.md@00000000:1"]' })}# S`, { mtime });
    expect(summaries.run(ctx([src, s(NOW - 3 * DAY)]))[0].fix.ops).toEqual([{ op: 'setkey', rel: 's.md', key: 'status', value: 'stale' }]);
    expect(summaries.run(ctx([src, s(NOW)]))[0].fix.ops[0].key).toBe('source_hashes');
  });
});

describe('note.instructions', () => {
  const big = (n) => `# CLAUDE\n\nIntro.\n\n${Array.from({ length: n }, (_, i) => `## Part ${i}\n\n${'rule line. '.repeat(300)}\n`).join('\n')}`;
  it('lists a file over its budget with its largest sections, and offers no split: agents do not follow wikilinks', () => {
    const f = instructions.run(ctx([note('CLAUDE.md', big(6))])).find((x) => x.key.includes(':size:'));
    expect(f.fix).toBeUndefined();
    expect(f.proposal).toMatch(/do not follow wikilinks, so a rule moved into a linked note stops loading/);
    expect(f.evidence.filter((e) => e.startsWith('Section '))).toHaveLength(3);
  });
  it('leaves dead links to the broken link check, so one link is one item', () => {
    const fs = instructions.run(ctx([note('AGENTS.md', '# Agents\n\nSee [[Gone note]].\n')]));
    expect(fs).toEqual([]);
  });
  it('reads a note named instructions as an agent file only at the root or in .github', () => {
    expect(instructions.isInstruction('instructions.md')).toBe(true);
    expect(instructions.isInstruction('.github/instructions.md')).toBe(true);
    expect(instructions.isInstruction('recipes/bread/instructions.md')).toBe(false);
    expect(instructions.isInstruction('team/CLAUDE.md')).toBe(true);
  });
});

describe('graph reads in the existing rules', () => {
  it('orphans count a graph edge into a note as a link', () => {
    const notes = [note('k/a.md', '# A', { inbound: 0, outbound: 0 }), note('k/b.md', '# B'), note('k/c.md', '# C')];
    expect(orphans.run(ctx(notes))).toHaveLength(1);
    const store = fakeStore({ edges: [{ src: 'note:m.md', dst: 'note:k/a.md', kind: 'mentions', source_rel: 'm.md' }] });
    expect(orphans.run(ctx(notes, { graph: ruleGraph(store) }))).toEqual([]);
  });
  it('duplicates offer a merge into the copy more notes link to', () => {
    const body = 'Shared body text that is long enough to count as a duplicate of the other note. '.repeat(4);
    const notes = [note('x/one.md', `${fm({ title: 'One' })}${body}`, { inbound: 1 }), note('y/two.md', `${fm({ title: 'Two' })}${body}`, { inbound: 3 })];
    const [f] = duplicates.run(ctx(notes));
    expect(f.fix.ops).toEqual([{ op: 'merge', rel: 'y/two.md', drop: 'x/one.md', alias: 'One' }]);
  });
});

describe('review items and the plan', () => {
  it('turn a setup finding into one item whose note is written before its mentions are linked', () => {
    const notes = [meeting(1, ['Ana Ruiz']), meeting(2, ['Ana Ruiz']), meeting(3, ['Ana Ruiz'])];
    const item = findingItem(missingEntity.run(ctx(notes, { optIn: { entityNotes: true } }))[0]);
    expect(itemLine(item)).toBe('Write “Ana Ruiz.md” and link 3 mentions to it');
    const plan = buildPlan([item]);
    expect(plan.ok).toEqual([item.id]);
    expect(plan.steps.map((s) => s.op.op)).toEqual(['create', 'mention', 'mention', 'mention']);
    expect(checkOrder(plan.steps, notes.map((n) => n.rel))).toBeNull();
  });
});

describe('text edits', () => {
  it('links the first plain mention in the body, else the frontmatter entry', () => {
    expect(linkMention('# M\n\nAna Ruiz said hi.\n', 'Ana Ruiz', 'ana-ruiz')).toBe('# M\n\n[[ana-ruiz|Ana Ruiz]] said hi.\n');
    expect(linkMention('# M\n\nAna Ruiz said hi.\n', 'Ana Ruiz', 'Ana Ruiz')).toBe('# M\n\n[[Ana Ruiz]] said hi.\n');
    expect(linkMention('---\nattendees: [Ben Ode, Ana Ruiz]\n---\n# M\n', 'Ana Ruiz', 'ana-ruiz')).toBe('---\nattendees: [Ben Ode, "[[ana-ruiz|Ana Ruiz]]"]\n---\n# M\n');
    expect(linkMention('---\npeople:\n  - Ana Ruiz\n---\n# M\n', 'Ana Ruiz', 'Ana Ruiz')).toBe('---\npeople:\n  - "[[Ana Ruiz]]"\n---\n# M\n');
  });
  it('merges a body once and adds the names as aliases', () => {
    const out = mergeText('---\ntype: person\n---\n# Ana Ruiz\n\nLead.\n', '# ana-ruiz\n\nLikes tea.\n', { title: 'ana-ruiz', names: ['ana-ruiz', 'Ana R.'] });
    expect(out).toContain('aliases:\n  - ana-ruiz\n  - Ana R.');
    expect(out).toContain('## From ana-ruiz\n\nLikes tea.');
    expect(mergeText(out, '# ana-ruiz\n\nLikes tea.\n', { title: 'ana-ruiz', names: ['ana-ruiz'] })).toBe(out);
  });
  it('refuses a split whose heading moved', () => {
    expect(() => splitText('# A\n\nIntro\n', [{ heading: 'Gone', start: 2, end: 3, to: 'a-gone.md' }], { from: 'a.md' })).toThrow(/moved/);
  });
});

describe('the graph edges', () => {
  it('records approved mentions with person provenance, attended from person to meeting', () => {
    const edges = approvedEdges([{ kind: 'finding', ops: [{ op: 'mention', rel: 'meetings/m.md', to: 'people/ana.md', edge: 'attended' }, { op: 'mention', rel: 'n.md', to: 'projects/a.md' }] }], { at: 5 });
    expect(edges.map((e) => [e.src, e.dst, e.kind, e.provenance])).toEqual([['person:ana', 'meeting:meetings/m.md', 'attended', 'person'], ['note:n.md', 'project:a', 'mentions', 'person']]);
  });
  it('records a contradiction once, ends it when it resolves, and supersedes the losing line', () => {
    const store = fakeStore({ edges: [{ src: 'note:people/ana.md', dst: 'note:projects/a.md', kind: 'works_on', source_rel: 'old.md', source_line: 2 }] });
    const f = { ruleId: 'note.contradiction', notes: ['old.md', 'new.md'], evidence: ['Older: old.md line 3: “x”'] };
    expect(recordContradictions(store, [f], { at: 1 })).toEqual({ added: 1, ended: 0 });
    expect(recordContradictions(store, [f], { at: 2 })).toEqual({ added: 0, ended: 0 });
    const id = resolveContradiction(store, { ruleId: 'note.contradiction', notes: ['old.md', 'new.md'], ops: [{ op: 'annotate', rel: 'old.md', line: 3 }] }, { at: 3 });
    const byKind = (k) => store.edges.find((e) => e.kind === k);
    expect(byKind('supersedes').id).toBe(id);
    expect(byKind('contradicts').superseded_by).toBe(id);
    expect(byKind('works_on').superseded_by).toBe(id);
  });
  it('the keeper builds a meeting\'s typed edges with the graph\'s ids, leaving the ones it holds', () => {
    const edges = meetingEdges({ rel: 'meetings/s.md', date: '2026-11-02', people: ['people/ana-ruiz.md'], projects: ['projects/atlas.md'], decisions: [{ id: 'decision:meetings/s.md#abcd1234', line: 5 }], at: 9, have: (e) => e.kind === 'decided_in' });
    expect(edges.map((e) => [e.src, e.dst, e.kind])).toEqual([['person:ana-ruiz', 'meeting:meetings/s.md', 'attended'], ['meeting:meetings/s.md', 'project:atlas', 'mentions']]);
    expect(edges[0]).toMatchObject({ provenance: 'rule', source_rel: 'meetings/s.md', valid_from: Date.UTC(2026, 10, 2) });
  });
});

describe('the report and the scan', () => {
  it('counts what the scan found and the fixes waiting', () => {
    const notes = [note('people/ana.md', `${fm({ type: 'person' })}# Ana`, { outbound: 2, mtime: NOW - 200 * DAY }), note('meetings/m.md', `${fm({ type: 'meeting' })}# M`, { outbound: 1 })];
    const findings = [{ ruleId: 'note.entity-type', key: 'note.entity-type:people/ana.md', title: 'x', fix: { kind: 'ops', ops: [{ op: 'setkey' }] } }, { ruleId: 'note.contradiction', key: 'note.contradiction:k', title: 'y' }];
    const r = setupReport({ notes, missing: 1, findings, now: NOW });
    expect(r.counts.links).toEqual({ resolved: 3, total: 4 });
    expect(r.counts.entities).toMatchObject({ people: 1, meetings: 1, source: 'notes' });
    expect(r.gaps.find((g) => g.id === 'note.entity-type')).toMatchObject({ count: 1, fixable: 1 });
    expect(r.freshness).toMatchObject({ confirmed: 0.5, basis: 'notes', contradictions: 1 });
    expect(freshness({ graph: { freshness: () => ({ confirmed: 3, total: 4 }) }, now: NOW }).confirmed).toBe(0.75);
  });
  it('runs its phases in order with progress, and keeps the last report', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'qms-'));
    const seen = [];
    const steps = { index: async (p) => p(1, 2), graph: async () => {}, checks: async () => {}, report: async () => ({ at: 1, gaps: [] }) };
    const s = createMemorySetup({ file: path.join(dir, 'setup.json'), steps, emit: (v) => seen.push(v.phase) });
    const done = await s.run('/v');
    expect(done).toMatchObject({ running: false, done: true, report: { at: 1 } });
    expect([...new Set(seen)]).toEqual(['index', 'graph', 'checks', 'report', 'done']);
    expect(createMemorySetup({ file: path.join(dir, 'setup.json'), steps }).status('/v').report).toEqual({ at: 1, gaps: [] });
  });
});

// a generated vault on disk: the rules find the gaps, and the setup ops fix them through runSetupOp as a batch would
describe('on a generated vault', () => {
  it('finds the gaps and fixes them, keeping every note it changes', async () => {
    const vault = mkdtempSync(path.join(tmpdir(), 'qms-vault-'));
    const files = {
      'people/Ben Ode.md': '# Ben Ode\n\nWorks on Atlas and leads the weekly sync.\n',
      'people/ben-ode.md': '# ben-ode\n\nPrefers mornings.\n',
      'Ref.md': '# Ref\n\nSee [[ben-ode]].\n',
      ...Object.fromEntries([1, 2, 3].map((i) => [`meetings/2026-11-0${i} sync.md`, `${fm({ type: 'meeting', attendees: '[Ana Ruiz, Ben Ode]' })}# Sync ${i}\n\nAna Ruiz showed the plan.\n`])),
    };
    for (const [rel, text] of Object.entries(files)) { mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true }); writeFileSync(path.join(vault, rel), text); }
    const load = () => Object.keys(files).filter((r) => existsSync(path.join(vault, r))).map((rel) => note(rel, readFileSync(path.join(vault, rel), 'utf8')));
    const notes = load();
    const { findings } = runRules(ctx(notes));
    const by = (id) => findings.filter((f) => f.ruleId === id);
    expect(by('note.missing-entity').map((f) => f.target)).toEqual(['people/Ana Ruiz.md']);
    expect(by('note.entity-alias').map((f) => f.fix.ops[0].op)).toEqual(['merge']);
    const kept = [];
    const trashed = [];
    const vindex = { backlinks: (rel) => load().filter((n) => n.note.links.some((l) => resolverOf(load())(l.target, n.rel) === rel)).map((n) => ({ rel: n.rel })), resolve: (t, f) => resolverOf(load())(t, f), rels: () => load().map((n) => n.rel), sync: () => {} };
    const items = [...by('note.missing-entity'), ...by('note.entity-alias')].map(findingItem);
    const plan = buildPlan(items);
    expect(plan.held).toEqual([]);
    for (const s of plan.steps) await runSetupOp(items.find((i) => i.id === s.item), s.op, { step: async () => {}, keep: (rel) => kept.push(rel), vault }, { vindex, trash: async (abs) => { trashed.push(abs); const fsMod = await import('node:fs'); fsMod.rmSync(abs); } });
    const ana = readFileSync(path.join(vault, 'people/Ana Ruiz.md'), 'utf8');
    expect(ana).toMatch(/^---\ntype: person\ncreated: /);
    expect(readFileSync(path.join(vault, 'meetings/2026-11-01 sync.md'), 'utf8')).toContain('[[Ana Ruiz]] showed the plan.');
    const keptBen = readdirSync(path.join(vault, 'people')).filter((x) => x.startsWith('Ben') || x.startsWith('ben'));
    expect(keptBen).toHaveLength(1);
    const ben = readFileSync(path.join(vault, 'people', keptBen[0]), 'utf8');
    expect(ben).toContain('Prefers mornings.');
    expect(trashed).toHaveLength(1);
    // the link to the merged note now points at the kept one, and each changed note went through keep first
    expect(readFileSync(path.join(vault, 'Ref.md'), 'utf8')).not.toContain('[[ben-ode]]');
    expect(kept).toEqual(expect.arrayContaining(['people/Ana Ruiz.md', 'meetings/2026-11-01 sync.md', 'Ref.md']));
  });
  it('lists instruction files outside the vault folder', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'qms-root-'));
    mkdirSync(path.join(root, 'vault'));
    writeFileSync(path.join(root, 'CLAUDE.md'), `# Rules\n\n[[Missing]]\n${'x'.repeat(13000)}`);
    const text = readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
    expect(outsideInstructions({ root, vault: path.join(root, 'vault') })).toEqual([{ file: 'CLAUDE.md', chars: text.length, budget: instructions.BUDGET, over: true, dead: ['Missing'] }]);
  });
});

// the real memory graph on a generated vault: the store main writes, the read-only view the engine reads
describe('with the memory graph built', () => {
  async function built(extra = {}) {
    const root = mkdtempSync(path.join(tmpdir(), 'qms-graph-'));
    const vault = path.join(root, 'v');
    writeGraphVault(vault, { notes: 40, people: 6, projects: 3, companies: 1, meetings: 8, padWords: 10 });
    for (const [rel, text] of Object.entries(extra)) { mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true }); writeFileSync(path.join(vault, rel), text); }
    const ix = createVaultIndex({ vault, isExcludedPath: () => false, isExcludedText: () => false, redact: (t) => t, onChange: () => {} });
    ix.sync();
    const dataDir = path.join(root, 'data');
    const g = createMemoryGraph({ dataDir, vault, vindex: ix });
    await g.build();
    const notes = ix.snapshot();
    return { vault, ix, g, dataDir, notes, view: openStore({ dir: path.join(dataDir, 'memory'), vault, readOnly: true }) };
  }
  it('the rules read names, edges and aliases from the read-only view', async () => {
    const meetings = Object.fromEntries([1, 2, 3].map((i) => [`meetings/2026-10-1${i} review.md`, `${fm({ type: 'meeting', date: `2026-10-1${i}`, attendees: '[Quill Ambersmith]' })}# Review ${i}\n`]));
    const { g, ix, notes, view } = await built(meetings);
    const graph = ruleGraph(view);
    const [f] = missingEntity.run({ notes, resolve: (t, from) => ix.resolve(t, from), graph, now: NOW });
    expect(f.target).toMatch(/Quill Ambersmith|quill-ambersmith/);
    expect(f.evidence).toContain('Found in the memory graph');
    // a note only the graph links to (an attendee field) is no orphan
    const person = graph.nodes('person').find((x) => x.rel);
    expect(graph.inbound(person.rel).length).toBeGreaterThan(0);
    view.close();
    g.close();
  });
  it('records approved edges, contradictions and their resolution in the store, and Undo puts them back', async () => {
    const { g } = await built({ 'old.md': '# Old\n\nAtlas ships in March.\n', 'new.md': '# New\n\nAtlas ships in May.\n' });
    const store = g.store;
    const ids = [];
    store.tx(() => { for (const e of approvedEdges([{ kind: 'finding', ops: [{ op: 'mention', rel: 'old.md', to: 'new.md' }] }], { at: 1 })) ids.push(store.addEdge(e)); });
    expect(store.edge(ids[0])).toMatchObject({ provenance: 'person', kind: 'mentions', props: { by: 'review' } });
    const f = { ruleId: 'note.contradiction', notes: ['old.md', 'new.md'], evidence: ['Older: old.md line 3: “x”'] };
    expect(recordContradictions(store, [f], { at: 2 })).toEqual({ added: 1, ended: 0 });
    const sup = resolveContradiction(store, { ...f, ops: [{ op: 'annotate', rel: 'old.md', line: 3 }] }, { at: 3 });
    const contra = store.edgesOf('note:old.md', { kinds: ['contradicts'], current: false })[0];
    expect(contra.superseded_by).toBe(sup);
    endEdges(store, [sup]);
    expect(store.edgesOf('note:old.md', { kinds: ['contradicts'], current: true })).toHaveLength(1);
    g.close();
  });
});


// ---- the review of the setup rules, keeper and card: one block per finding ----

const keeperInput = (html) => html.match(/<input[^>]*aria-label="Update the vault after each meeting"[^>]*>/)?.[0] ?? '';
describe('the keeper offer', () => {
  it('shows the keeper selected and pending on a connected vault until the person chooses, and never offers again', () => {
    expect(keeperRow({ offer: true, made: null, choice: null, on: false })).toEqual({ on: true, pending: true });
    expect(keeperRow({ offer: true, made: null, choice: 'off', on: false })).toEqual({ on: false, pending: false });
    expect(keeperRow({ offer: true, made: 'quorum', choice: null, on: true })).toEqual({ on: true, pending: false });
    expect(keeperRow({ offer: false, made: null, choice: null, on: false })).toEqual({ on: false, pending: false });
  });
  it('keeps the choice per vault, and finishing setup never overrides a choice made on the card', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'qms-keeper-')), 'setup.json');
    const a = createMemorySetup({ file, steps: {} });
    expect(a.status('/v').keeperChoice).toBe(null);
    expect(a.chooseKeeper('/v', false)).toBe(true);
    // finishing onboarding with the offer: recorded only when no choice was made
    expect(a.chooseKeeper('/v', true, { offer: true })).toBe(false);
    expect(a.chooseKeeper('/w', true, { offer: true })).toBe(true);
    const b = createMemorySetup({ file, steps: {} });
    expect(b.status('/v').keeperChoice).toBe('off');
    expect(b.status('/w').keeperChoice).toBe('on');
  });
  it('renders the pending offer without writing anything, so mounting the card twice changes nothing', () => {
    const calls = [];
    const status = { running: false, phase: null, progress: null, phases: [], error: null, report: null, done: false, keeperChoice: null, made: null, keeper: { on: false, editVault: false }, graph: true };
    for (let i = 0; i < 2; i++) {
      const html = renderToStaticMarkup(createElement(MemorySetupView, { s: status, offerKeeper: true, heading: false, onRun: () => calls.push('run'), onKeeper: (on) => calls.push(on), onRetry: () => {} }));
      expect(html).toContain('Update the vault after each meeting');
      expect(html).toContain('Selected: it turns on when you finish setup.');
      expect(keeperInput(html)).toContain('checked=""');
    }
    expect(calls).toEqual([]);
    const off = renderToStaticMarkup(createElement(MemorySetupView, { s: { ...status, keeperChoice: 'off' }, offerKeeper: true, onRun() {}, onKeeper() {}, onRetry() {} }));
    expect(off).not.toContain('Selected:');
    expect(keeperInput(off)).not.toContain('checked=""');
  });
  it('never says nothing changes until you approve it, and uses plain titles', () => {
    const status = { running: false, phase: null, progress: null, phases: [], error: null, report: null, done: false, keeperChoice: null, made: null, keeper: { on: true, editVault: false }, graph: true };
    const html = renderToStaticMarkup(createElement(MemorySetupView, { s: status, onRun() {}, onKeeper() {}, onRetry() {} }));
    expect(html).not.toMatch(/Nothing changes until you approve/);
    expect(html).not.toMatch(/in step|crowd out/);
    expect(html).toContain('The scan writes nothing to your notes.');
  });
});

describe('the setup card states', () => {
  const base = { running: true, phase: 'graph', progress: { done: 1.5, total: 4, label: 'Building the memory graph: 120 of 400 notes' }, phases: [{ id: 'index', label: 'Reading the notes' }, { id: 'graph', label: 'Building the memory graph' }], error: null, report: null, done: false, keeperChoice: 'on', made: null, keeper: { on: true, editVault: false }, graph: true };
  const render = (props) => renderToStaticMarkup(createElement(MemorySetupView, { onRun() {}, onKeeper() {}, onRetry() {}, ...props }));
  it('announces the phase only, and gives the bar its progressbar values', () => {
    const html = render({ s: base });
    expect(html).toContain('<span class="sr-only" aria-live="polite">Building the memory graph</span>');
    expect(html).toMatch(/role="progressbar" aria-label="Building the memory graph" aria-valuemin="0" aria-valuemax="100" aria-valuenow="38"/);
    expect(html).toMatch(/<div class="src-progress-text" aria-hidden="true">/);
    expect(phaseName(base)).toBe('Building the memory graph');
  });
  it('shows an error as an alert, a loading row before the first status, and an error row when the status failed', () => {
    expect(render({ s: { ...base, running: false, error: 'Building the memory graph took more than 5 minutes.' } })).toMatch(/role="alert">Building the memory graph took more than 5 minutes\./);
    const loading = render({ s: null });
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain('Loading the last scan');
    const failed = render({ s: null, failed: 'The window lost its connection' });
    expect(failed).toContain('<span role="alert">The window lost its connection</span>');
    expect(failed).toContain('Try again');
  });
});

describe('the scan steps', () => {
  it('passes each step the vault, and saves no report when a step stops', async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'qms-steps-')), 'setup.json');
    const seen = [];
    const steps = { index: async (_p, o) => seen.push(o.vault), graph: async () => { throw new Error('Building the memory graph took more than 5 minutes'); }, checks: async () => {}, report: async () => ({ at: 1 }) };
    const m = createMemorySetup({ file, steps });
    const st = await m.run('/v');
    expect(seen).toEqual(['/v']);
    expect(st).toMatchObject({ running: false, error: 'Building the memory graph took more than 5 minutes', report: null, done: false });
    expect(existsSync(file)).toBe(false);
  });
});

describe('split targets', () => {
  it('refuses two sections that go to one note, and an oversized split never names one twice', async () => {
    const vault = mkdtempSync(path.join(tmpdir(), 'qms-split-'));
    const text = '# Big\n\n## Tools\n\nA\n\n## Tools!\n\nB\n';
    writeFileSync(path.join(vault, 'big.md'), text);
    const parts = [{ heading: 'Tools', start: 2, end: 6, to: 'big-tools.md' }, { heading: 'Tools!', start: 6, end: 9, to: 'big-tools.md' }];
    const vindex = { sync() {}, rels: () => ['big.md'] };
    await expect(runSetupOp({}, { op: 'split', rel: 'big.md', parts }, { step: async () => {}, keep: () => {}, vault }, { vindex })).rejects.toThrow(/Two sections of big.md would go to the same note/);
    expect(readFileSync(path.join(vault, 'big.md'), 'utf8')).toBe(text);
    const long = `# L\n\n${['Tools', 'Tools!', 'Tools?'].map((h) => `## ${h}\n\n${'word '.repeat(13000)}\n`).join('\n')}`;
    const [f] = oversized.run(ctx([note('l.md', long), note('s.md', 'short')]));
    const tos = f.fix.ops[0].parts.map((p) => p.to);
    expect(new Set(tos).size).toBe(tos.length);
  });
  it('leaves instruction files to the instruction rule, so no split takes rules out of agent context', () => {
    const long = `# G\n\n${['A', 'B'].map((h) => `## ${h}\n\n${'rule '.repeat(14000)}\n`).join('\n')}`;
    expect(oversized.run(ctx([note('GEMINI.md', long), note('x.md', 'short')]))).toEqual([]);
  });
});

describe('the out of date mark', () => {
  const line3 = 'Decision: Database: Postgres';
  const doc = `# Claude\n\nRules.\n${line3}\n`;
  const decision = { id: 'decision:CLAUDE.md#a1', kind: 'decision', name: 'Database: Postgres', rel: 'CLAUDE.md', props: { text: 'Database: Postgres', key: 'database' } };
  const edges = (extra = []) => [{ src: decision.id, dst: 'note:CLAUDE.md', kind: 'decided_in', source_rel: 'CLAUDE.md', source_line: 3, superseded_by: 7, valid_to: 5 }, ...extra];
  const lost = { src: 'decision:new.md#b2', dst: decision.id, kind: 'supersedes', source_rel: 'new.md', source_line: 0 };
  const run = (text, es) => instructions.run(ctx([note('CLAUDE.md', text)], { graph: ruleGraph(fakeStore({ nodes: [decision], edges: es })) })).filter((f) => f.key.includes(':graph:'));
  it('marks a line that still states a decision this file lost to a newer one', () => {
    const [f] = run(doc, edges([lost]));
    expect(f.fix.ops[0]).toMatchObject({ op: 'annotate', line: 4, text: line3 });
  });
  it('leaves a line whose text changed since the edge was read, a decision nothing replaced, and contradictions', () => {
    expect(run(`# Claude\n\nRules.\nShip on Friday.\n${line3}\n`, edges([lost]))).toEqual([]);
    expect(run(doc, edges())).toEqual([]);
    const contra = [{ src: 'note:new.md', dst: 'note:CLAUDE.md', kind: 'contradicts', source_rel: 'CLAUDE.md', source_line: 3, valid_to: 9 }];
    expect(run(doc, contra)).toEqual([]);
  });
});

describe('false positives', () => {
  const store = (rels, aliases = {}) => ruleGraph(fakeStore({ nodes: rels.map((r) => ({ id: `note:${r}`, kind: 'note', name: r, rel: r, aliases: aliases[r] ?? [] })) }));
  it('two meetings with one title are two meetings', () => {
    const notes = [note('meetings/2026-03-04 Weekly sync.md', '# Weekly sync\n\nWe planned the launch.\n'), note('meetings/2026-03-11 Weekly sync.md', '# Weekly sync\n\nWe hired a designer.\n')];
    const fs = duplicates.run(ctx(notes, { graph: store(notes.map((n) => n.rel), { [notes[0].rel]: ['weekly sync'], [notes[1].rel]: ['weekly sync'] }) }));
    expect(fs).toEqual([]);
  });
  it('two notes under one name merge only when one sets it as an alias and the bodies share their words', () => {
    const body = 'The billing service moves to the new queue in March and the team owns the runbook.';
    const a = note('ops/billing.md', `${fm({ aliases: '[Payments]' })}# Billing\n\n${body}\n`);
    const b = note('notes/Payments.md', `# Payments\n\n${body} Also the alerts.\n`);
    const c = note('notes/Overview.md', '# Overview\n\nA list of reading.\n');
    const d = note('ops/Overview two.md', `${fm({ title: 'Overview' })}# Overview\n\nBudget numbers for the year.\n`);
    const graph = store([a.rel, b.rel, c.rel, d.rel]);
    expect(duplicates.run(ctx([a, b], { graph })).map((f) => f.fix.ops[0].op)).toEqual(['merge']);
    expect(duplicates.run(ctx([c, d], { graph }))).toEqual([]);
    const off = note('notes/Payments.md', `# Payments\n\nLunch plans for Friday and a list of films.\n`);
    expect(duplicates.run(ctx([a, off], { graph }))).toEqual([]);
  });
  it('the same file name in two project folders is not one project', () => {
    const notes = [note('projects/alpha/overview.md', `${fm({ type: 'project' })}# Overview\n`), note('projects/beta/overview.md', `${fm({ type: 'project' })}# Overview\n`), note('projects/alpha/notes.md', '# Notes\n'), note('projects/beta/notes.md', '# Notes\n')];
    expect(entityAliases.run(ctx(notes))).toEqual([]);
  });
  it('a short name that matches one person note is an alias item and never a new note too', () => {
    const notes = [note('people/Ana Ruiz.md', `${fm({ type: 'person' })}# Ana Ruiz\n`), ...[1, 2, 3].map((i) => meeting(i, ['Ana R.', 'Bo Li']))];
    const all = runRules(ctx(notes)).findings;
    expect(all.filter((f) => f.ruleId === 'note.entity-alias').map((f) => f.fix.ops[0])).toEqual([{ op: 'alias', rel: 'people/Ana Ruiz.md', alias: 'Ana R.' }]);
    expect(all.filter((f) => f.ruleId === 'note.missing-entity').map((f) => f.target)).toEqual(['people/Bo Li.md']);
  });
  it('emails, Everyone and speaker labels from the graph name nobody', () => {
    for (const x of ['ana@acme.com', 'Everyone', 'TBD', 'Speaker 1', 'Unknown', 'Team']) expect(isName(x)).toBe(false);
    const notes = [1, 2, 3].map((i) => note(`m${i}.md`, `# M${i}\n`));
    const names = ['ana@acme.com', 'Everyone', 'Speaker 1'];
    const store = fakeStore({ nodes: names.map((n, i) => ({ id: `person:x${i}`, kind: 'person', name: n, rel: null })), edges: names.flatMap((_, i) => notes.map((n) => ({ src: `person:x${i}`, dst: `note:${n.rel}`, kind: 'attended', source_rel: n.rel }))) });
    expect(missingEntity.run(ctx(notes, { graph: ruleGraph(store) }))).toEqual([]);
    expect(entityAliases.run(ctx(notes, { graph: ruleGraph(store) }))).toEqual([]);
  });
  it('a name that matches two person notes merges with neither', () => {
    const p = (n) => note(`people/${n}.md`, `${fm({ type: 'person' })}# ${n}\n`);
    expect(entityAliases.run(ctx([p('Ana R.'), p('Ana Ruiz'), p('Ana Rios')]))).toEqual([]);
    expect(entityAliases.run(ctx([p('Ana R.'), p('Ana Ruiz')])).map((f) => f.fix.ops[0].op)).toEqual(['merge']);
  });
  it('root hub notes stay at the root', () => {
    const inProjects = ['a', 'b', 'c'].map((x) => note(`04-projects/${x}.md`, `# ${x}`));
    const hubs = [
      note('Projects.md', '# Projects\n\nSee [[a]], [[b]] and [[c]] for now.\n'),
      note('Roadmap.md', '# Roadmap\n\n- [[a]] first\n- [[b]] next\n- [[c]] later\n'),
      note('Inbox.md', '# Inbox\n\n[[a]] [[b]] [[c]] [[Home page]]\n'),
      note('Home page.md', '# Home\n\nStart at [[Inbox]].\n'),
    ];
    expect(unplaced.run(ctx([...inProjects, ...hubs]))).toEqual([]);
  });
  it('confidential notes are never moved or merged across the confidential line', () => {
    const notes = [note('private/Ben.md', `${fm({ type: 'person' })}# Ben`), note('people/a.md', `${fm({ type: 'person' })}# A`)];
    expect(unplaced.run(ctx(notes, { folders: { private: 'confidential' } }))).toEqual([]);
    expect(unplaced.run(ctx(notes, { optIn: { placement: true } })).map((f) => f.fix.ops[0].to)).toEqual(['people/Ben.md']);
    const body = 'Shared body text that is long enough to count as a duplicate of the other note. '.repeat(4);
    const twins = [note('x/one.md', `${fm({ confidential: 'client' })}${body}`), note('y/two.md', body)];
    expect(duplicates.run(ctx(twins))).toEqual([]);
  });
});

describe('freshness from the graph', () => {
  it('counts only dated facts, so undated notes do not read as unconfirmed', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'qms-fresh-'));
    const store = openStore({ dir: root, vault: path.join(root, 'v') });
    try {
      const now = Date.UTC(2026, 10, 15);
      for (let i = 0; i < 5; i++) store.addEdge({ src: `note:n${i}.md`, dst: 'person:ana', kind: 'mentions', provenance: 'rule', source_rel: `n${i}.md`, valid_from: null });
      store.addEdge({ src: 'person:ana', dst: 'meeting:m.md', kind: 'attended', provenance: 'explicit', source_rel: 'm.md', valid_from: now - DAY });
      store.addEdge({ src: 'person:ana', dst: 'meeting:old.md', kind: 'attended', provenance: 'explicit', source_rel: 'old.md', valid_from: now - 200 * DAY });
      expect(graphFreshness(store, now - 90 * DAY)).toEqual({ total: 2, confirmed: 1 });
    } finally { store.close(); }
  });
});

describe('grouped items', () => {
  it('keeps only the ticked notes, their ops and their hashes', () => {
    const item = { id: 'r:find:x', ops: [{ op: 'setkey', rel: 'p/a.md' }, { op: 'setkey', rel: 'p/b.md' }], notes: ['p/a.md', 'p/b.md'], hashes: { 'p/a.md': 'h1', 'p/b.md': 'h2' } };
    expect(pickItem(item, ['p/b.md'])).toMatchObject({ ops: [{ rel: 'p/b.md' }], notes: ['p/b.md'], hashes: { 'p/b.md': 'h2' } });
    expect(pickItem(item, null)).toBe(item);
    expect(() => pickItem(item, [])).toThrow('Tick at least one note to approve');
  });
  it('records an approved attended edge on the person node of a folder note nothing linked yet', () => {
    expect(nodeIdOf(null, 'people/Ana Ruiz.md')).toBe('person:ana-ruiz');
    expect(nodeIdOf(null, 'notes/x.md')).toBe('note:notes/x.md');
  });
});

// the setup ops through the batch run's per-item path: batchItems with the real itemUndo, the vault hashes taken at
// the scan, runSetupOp for each step, and Undo from the run's record
describe('setup ops in a batch run', () => {
  let vault;
  const put = (rel, text) => { mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true }); writeFileSync(path.join(vault, rel), text); };
  const get = (rel) => (existsSync(path.join(vault, rel)) ? readFileSync(path.join(vault, rel), 'utf8') : null);
  const load = () => walk(vault, '', () => false, []).map((rel) => note(rel, get(rel)));
  const vindexOf = (hidden = []) => ({
    rels: () => load().map((n) => n.rel).filter((r) => !hidden.includes(r)),
    resolve: (t, f) => resolverOf(load())(t, f),
    backlinks: (rel) => load().filter((n) => !hidden.includes(n.rel) && n.note.links.some((l) => resolverOf(load())(l.target, n.rel) === rel)).map((n) => ({ rel: n.rel })),
    sync() {},
  });
  function batch(items, { trash = async (abs) => rmSync(abs), hidden = [] } = {}) {
    const kept = [];
    const keep = (rel, created = false, gone = false) => { if (kept.some((k) => k.rel === rel)) return; kept.push({ rel, before: created ? null : get(rel), ...(gone ? { gone: true } : {}) }); };
    const status = new Map();
    const undo = itemUndo(vault);
    const b = batchItems({ items, undo, mark: (id, st, why) => status.set(id, { st, why }), release: (rels) => { for (const r of rels) { const i = kept.findIndex((k) => k.rel === r); if (i >= 0) kept.splice(i, 1); } }, journal: () => {}, trash });
    const written = new Set();
    const vindex = vindexOf(hidden);
    const go = async () => {
      const plan = buildPlan(items);
      await b.runSteps(plan.steps, async (item, s) => { await runSetupOp(item, s.op, { step: async () => {}, keep: undo.track(item.id, keep), vault, written }, { vindex, trash }); });
      return status;
    };
    return { go, kept, status };
  }
  const scan = (f) => { const item = findingItem(f); return { ...item, hashes: hashNotes(vault, [...new Set([...f.notes, ...item.ops.flatMap((o) => [o.rel, o.drop].filter(Boolean))])]) }; };
  const mergeFinding = () => entityAliases.run(ctx(load()))[0];
  beforeEach(() => {
    vault = mkdtempSync(path.join(tmpdir(), 'qms-batch-'));
    put('people/Ben Ode.md', `${fm({ type: 'person' })}# Ben Ode\n\nLeads the sync.\n`);
    put('people/ben-ode.md', '# ben-ode\n\nPrefers mornings.\n');
    put('Ref.md', '# Ref\n\nSee [[ben-ode]].\n');
  });
  afterEach(() => rmSync(vault, { recursive: true, force: true }));

  it('refuses a note that changed after the scan and writes nothing', async () => {
    const item = scan(mergeFinding());
    put('people/ben-ode.md', '# ben-ode\n\nPrefers mornings. Edited after the scan.\n');
    const t = batch([item]);
    const st = await t.go();
    expect(st.get(item.id)).toMatchObject({ st: 'error', why: expect.stringMatching(/“people\/ben-ode.md” changed after Quorum checked it/) });
    expect(get('people/Ben Ode.md')).toBe(`${fm({ type: 'person' })}# Ben Ode\n\nLeads the sync.\n`);
    expect(get('Ref.md')).toBe('# Ref\n\nSee [[ben-ode]].\n');
  });
  it('puts back a merge that fails partway, and keeps the other item fixed', async () => {
    put('people/Cy Dale.md', `${fm({ type: 'person' })}# Cy Dale\n`);
    const merge = scan(mergeFinding());
    const alias = { ...findingItem({ ruleId: 'note.entity-alias', key: 'note.entity-alias:alias:x', notes: ['people/Cy Dale.md'], fix: { kind: 'ops', group: 'alias', ops: [{ op: 'alias', rel: 'people/Cy Dale.md', alias: 'Cy D.' }] } }), hashes: hashNotes(vault, ['people/Cy Dale.md']) };
    const t = batch([alias, merge], { trash: async () => { throw new Error('The Trash is not available'); } });
    const st = await t.go();
    expect(st.get(merge.id)).toMatchObject({ st: 'error', why: 'The Trash is not available' });
    expect(st.get(alias.id).st).toBe('success');
    expect(get('Ref.md')).toBe('# Ref\n\nSee [[ben-ode]].\n');
    expect(get('people/Ben Ode.md')).not.toContain('Prefers mornings');
    expect(get('people/ben-ode.md')).toBe('# ben-ode\n\nPrefers mornings.\n');
    expect(get('people/Cy Dale.md')).toContain('Cy D.');
  });
  it('puts back a split whose target appeared after the scan, alone', async () => {
    put('big.md', '# Big\n\n## One\n\nA\n\n## Two\n\nB\n');
    const split = { ...findingItem({ ruleId: 'note.oversized', key: 'note.oversized:big.md', notes: ['big.md'], fix: { kind: 'ops', group: 'split', ops: [{ op: 'split', rel: 'big.md', parts: [{ heading: 'One', start: 2, end: 6, to: 'big-one.md' }, { heading: 'Two', start: 6, end: 9, to: 'big-two.md' }] }] } }), hashes: hashNotes(vault, ['big.md']) };
    put('big-two.md', '# Someone else wrote this\n');
    const st = await batch([split]).go();
    expect(st.get(split.id)).toMatchObject({ st: 'error', why: 'A note is already at “big-two.md”, so Quorum did not split big.md' });
    expect(get('big.md')).toBe('# Big\n\n## One\n\nA\n\n## Two\n\nB\n');
    expect(get('big-one.md')).toBe(null);
  });
  it('refuses a merge when a note the index leaves out links to the dropped note', async () => {
    put('private/secret.md', '# Secret\n\nAsk [[ben-ode]].\n');
    expect(unindexedLinkers(vault, 'people/ben-ode.md', new Set(['people/Ben Ode.md', 'people/ben-ode.md', 'Ref.md']))).toEqual(['private/secret.md']);
    const item = scan(mergeFinding());
    const st = await batch([item], { hidden: ['private/secret.md'] }).go();
    expect(st.get(item.id)).toMatchObject({ st: 'error', why: expect.stringMatching(/A note Quorum does not read links to “people\/ben-ode.md”/) });
    expect(get('people/ben-ode.md')).toBe('# ben-ode\n\nPrefers mornings.\n');
  });
  it('Undo puts back the merged note from the Trash, the kept note and the relinked note', async () => {
    const item = scan(mergeFinding());
    const t = batch([item]);
    const st = await t.go();
    expect(st.get(item.id).st).toBe('success');
    expect(get('people/ben-ode.md')).toBe(null);
    expect(get('Ref.md')).not.toContain('[[ben-ode]]');
    await applyUndo(vault, undoRecord(vault, t.kept), async (abs) => rmSync(abs));
    expect(get('people/ben-ode.md')).toBe('# ben-ode\n\nPrefers mornings.\n');
    expect(get('people/Ben Ode.md')).toBe(`${fm({ type: 'person' })}# Ben Ode\n\nLeads the sync.\n`);
    expect(get('Ref.md')).toBe('# Ref\n\nSee [[ben-ode]].\n');
  });
});
