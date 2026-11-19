import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
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
import { approvedEdges, createMemorySetup, endEdges, freshness, linkMention, mergeText, outsideInstructions, recordContradictions, resolveContradiction, runSetupOp, setupReport, splitText } from '../memorySetup.js';
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
    const { findings } = runRules(ctx(notes));
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
    const fs = missingEntity.run(ctx(notes, { owner: 'Rae Owner' }));
    expect(fs.map((f) => f.target)).toEqual(['Blaze M.md']);
  });
  it('reads names from the graph when it is built', () => {
    const notes = [1, 2, 3].map((i) => note(`n${i}.md`, `# N${i}\n`));
    const store = fakeStore({ nodes: [{ id: 'project:atlas', kind: 'project', name: 'Atlas', rel: null }], edges: notes.map((n) => ({ src: `note:${n.rel}`, dst: 'project:atlas', kind: 'mentions', source_rel: n.rel })) });
    const [f] = missingEntity.run(ctx(notes, { graph: ruleGraph(store) }));
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
    const notes = [note('people/Ana Ruiz.md', '# Ana Ruiz\n\nLead.\n', { inbound: 4 }), note('people/ana-ruiz.md', '# ana-ruiz\n\nOther text.\n', { inbound: 1 })];
    const [f] = entityAliases.run(ctx(notes));
    expect(f.fix.ops).toEqual([{ op: 'merge', rel: 'people/Ana Ruiz.md', drop: 'people/ana-ruiz.md', alias: 'ana-ruiz' }]);
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
  it('sets the type of a people note with none, and leaves index notes', () => {
    const fs = entityType.run(ctx([note('people/ana.md', '# Ana\n'), note('people/index.md', '# People\n'), note('people/ben.md', `${fm({ type: 'person' })}# Ben`)]));
    expect(fs.map((f) => f.fix.ops[0])).toEqual([{ op: 'setkey', rel: 'people/ana.md', key: 'type', value: 'person' }]);
  });
  it('moves a typed note into its kind folder, and a root note into the folder its links go to', () => {
    const notes = [
      note('people/ana.md', '# Ana\n'), note('Ben.md', `${fm({ type: 'person' })}# Ben`),
      note('projects/a.md', '# A'), note('projects/b.md', '# B'), note('projects/c.md', '# C'),
      note('Roadmap.md', '# Roadmap\n\n[[a]] [[b]] [[c]]\n'),
    ];
    expect(unplaced.run(ctx(notes)).map((f) => f.fix.ops[0])).toEqual([{ op: 'move', rel: 'Ben.md', to: 'people/Ben.md' }, { op: 'move', rel: 'Roadmap.md', to: 'projects/Roadmap.md' }]);
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
  it('moves the largest sections out until the file fits its budget', () => {
    const f = instructions.run(ctx([note('CLAUDE.md', big(6))])).find((x) => x.key.includes(':size:'));
    const parts = f.fix.ops[0].parts;
    expect(parts.length).toBeGreaterThan(0);
    expect(parts[0].to).toBe('claude-part-0.md');
    const { text } = splitText(big(6), parts, { from: 'CLAUDE.md' });
    expect(text.length).toBeLessThanOrEqual(instructions.BUDGET);
  });
  it('removes links to notes that are gone, and marks lines the graph holds as superseded', () => {
    const n = note('AGENTS.md', '# Agents\n\nSee [[Gone note]].\nAna leads Atlas.\n');
    const store = fakeStore({ edges: [{ src: 'note:people/ana.md', dst: 'note:projects/atlas.md', kind: 'works_on', source_rel: 'AGENTS.md', source_line: 3, superseded_by: 9 }] });
    const fs = instructions.run(ctx([n], { graph: ruleGraph(store) }));
    expect(fs.find((f) => f.key.includes(':links:')).fix.ops[0]).toMatchObject({ op: 'unlink', target: 'Gone note', lines: { 'AGENTS.md': [3] } });
    expect(fs.find((f) => f.key.includes(':graph:')).fix.ops[0]).toMatchObject({ op: 'annotate', line: 4, text: 'Ana leads Atlas.' });
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
    const item = findingItem(missingEntity.run(ctx(notes))[0]);
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
    const notes = [note('people/ana.md', '# Ana', { outbound: 2, mtime: NOW - 200 * DAY }), note('meetings/m.md', `${fm({ type: 'meeting' })}# M`, { outbound: 1 })];
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

