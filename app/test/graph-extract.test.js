// Extraction from one note with no model (graph/extract.js): links, frontmatter, folder conventions, meetings,
// decision lines and the keeper's link lines, checked against hand-written notes.
import { describe, expect, it } from 'vitest';
import { entityId, entityIds, extractNote, folderKind, isHub, noteKind, slugKey } from '../graph/extract.js';

// a resolver over a fixed set of notes, by basename, case-insensitive, like vindex's
const resolverOf = (rels) => (target) => rels.find((r) => r.toLowerCase().replace(/\.md$/, '').split('/').pop() === target.toLowerCase().replace(/\.md$/, '').split('/').pop()) ?? null;
const RELS = ['02-people/ana-ruiz.md', '02-people/Ben Ode.md', '04-projects/Atlas.md', 'companies/Acme.md', '08-meetings/2026-03-04 Atlas sync.md', 'notes/ideas.md'];
// the kinds the graph holds for those notes once the vault is read (graph/index.js kindOf)
const KINDS = { '02-people/ana-ruiz.md': 'person', '02-people/Ben Ode.md': 'person', '04-projects/Atlas.md': 'project', 'companies/Acme.md': 'company', '08-meetings/2026-03-04 Atlas sync.md': 'meeting' };
const run = (rel, text) => extractNote({ rel, text, resolve: resolverOf(RELS), kindOf: (to) => KINDS[to] ?? 'note' });
const has = (ex, src, kind, dst) => ex.edges.some((e) => e.src === src && e.kind === kind && e.dst === dst);

describe('folder conventions', () => {
  it('reads the deepest known folder, ignoring numeric prefixes, and leaves folder indexes as notes', () => {
    expect(folderKind('02-people/ana.md')).toBe('person');
    expect(folderKind('04-projects/atlas/meetings/kickoff.md')).toBe('meeting');
    expect(folderKind('notes/a.md')).toBe(null);
    expect(noteKind('02-people/README.md', {}).kind).toBe('note');
    expect(noteKind('notes/x.md', { type: 'person' })).toEqual({ kind: 'person', provenance: 'explicit' });
  });

  it('reads a note in a people, projects or companies folder as that entity only when something says so', () => {
    // a spec, a PRD and a plain note in a project folder are notes
    for (const rel of ['04-projects/atlas-prd.md', '04-projects/Atlas/spec.md', '02-people/reading list.md', 'companies/acme/pricing.md']) expect(noteKind(rel, {}).kind).toBe('note');
    // its type says so
    expect(noteKind('04-projects/atlas-prd.md', { type: 'project' })).toEqual({ kind: 'project', provenance: 'explicit' });
    // another note links it as one (graph/index.js linkedAs)
    expect(noteKind('02-people/ana-ruiz.md', {}, undefined, 'person')).toEqual({ kind: 'person', provenance: 'rule' });
    expect(noteKind('02-people/ana-ruiz.md', {}, undefined, 'project').kind).toBe('note');
    // the hub note of the entity's own folder, named like it
    expect(isHub('04-projects/Atlas/Atlas.md')).toBe(true);
    expect(isHub('04-projects/02-atlas-app/Atlas App.md')).toBe(true);
    expect(isHub('04-projects/Atlas/overview.md')).toBe(false);
    expect(isHub('04-projects/projects.md')).toBe(false);
    expect(noteKind('04-projects/Atlas/Atlas.md', {})).toEqual({ kind: 'project', provenance: 'rule' });
    // meetings and decisions keep their folder convention
    expect(noteKind('08-meetings/2026-03-04 sync.md', {}).kind).toBe('meeting');
  });

  it('makes no entity of a link to a folder note that is not one', () => {
    const ex = extractNote({ rel: 'notes/ideas.md', text: 'See [[atlas-prd]] and [[Atlas]].', resolve: resolverOf([...RELS, '04-projects/atlas-prd.md']), kindOf: (to) => KINDS[to] ?? 'note' });
    expect(ex.edges.filter((e) => e.kind === 'mentions').map((e) => e.dst)).toEqual(['project:atlas']);
    expect(ex.nodes.some((n) => n.id === 'project:atlas-prd')).toBe(false);
  });

  it('lists the folder notes a meeting names as entities, so the graph can read them again', () => {
    const ex = extractNote({ rel: '08-meetings/2026-03-04 Atlas sync.md', text: '---\nattendees: [Ana Ruiz]\nproject: "[[Atlas]]"\n---\n# Sync\n', resolve: resolverOf(['02-people/Ana Ruiz.md', ...RELS]) });
    expect(ex.refs.sort()).toEqual(['02-people/Ana Ruiz.md', '04-projects/Atlas.md']);
    expect(ex.edges.some((e) => e.src === 'person:ana-ruiz' && e.kind === 'attended')).toBe(true);
  });
});

describe('extractNote', () => {
  it('turns a meeting note into attendance, topics and decisions', () => {
    const text = [
      '---',
      'date: 2026-03-04',
      'participants: [Ana Ruiz, "[[Ben Ode]]", Cy Dale (recorder)]',
      'project: "[[Atlas]]"',
      '---',
      '# Atlas sync',
      'Attendees: Dee Fox',
      '**Decision:** Database: Postgres for [[Atlas]]',
      '## Decisions',
      '- [x] Ship the beta on Friday',
      '- [ ] Maybe hire later',
      '## Notes',
      '- not a decision',
    ].join('\n');
    const rel = '08-meetings/2026-03-04 Atlas sync.md';
    const ex = run(rel, text);
    const m = `meeting:${rel}`;
    expect(ex.kind).toBe('meeting');
    expect(has(ex, `note:${rel}`, 'about', m)).toBe(true);
    for (const p of ['person:ana-ruiz', 'person:ben-ode', 'person:cy-dale']) expect(has(ex, p, 'attended', m)).toBe(true);
    expect(ex.edges.find((e) => e.src === 'person:dee-fox' && e.kind === 'attended').provenance).toBe('rule');
    expect(has(ex, m, 'about', 'project:atlas')).toBe(true);
    const decisions = ex.nodes.filter((n) => n.kind === 'decision');
    expect(decisions.map((d) => d.name).sort()).toEqual(['Database: Postgres for Atlas', 'Ship the beta on Friday']);
    const pg = decisions.find((d) => d.name.startsWith('Database'));
    expect(pg.props.key).toBe('database');
    expect(has(ex, pg.id, 'decided_in', m)).toBe(true);
    expect(has(ex, pg.id, 'decision_about', 'project:atlas')).toBe(true);
    // a decision with no link on its line is about the meeting's project
    const beta = decisions.find((d) => d.name.startsWith('Ship'));
    expect(has(ex, beta.id, 'decision_about', 'project:atlas')).toBe(true);
    expect(ex.edges.every((e) => e.valid_from === Date.parse('2026-03-04') || ['links_to', 'embeds', 'tagged', 'in_folder'].includes(e.kind))).toBe(true);
  });

  it('reads a person note: role, company, and the keeper meeting lines', () => {
    const text = ['---', 'type: person', 'aliases: [Ana]', 'project: Atlas', 'role: lead', 'company: "[[Acme]]"', '---', '# Ana Ruiz', '## Meetings', '- 2026-03-04 [[2026-03-04 Atlas sync]] Atlas sync'].join('\n');
    const ex = run('02-people/ana-ruiz.md', text);
    const me = ex.nodes.find((n) => n.id === 'person:ana-ruiz');
    expect(me.rel).toBe('02-people/ana-ruiz.md');
    expect(me.aliases).toEqual(expect.arrayContaining(['Ana Ruiz', 'Ana', 'ana-ruiz']));
    expect(ex.edges.find((e) => e.kind === 'about').provenance).toBe('explicit');
    expect(ex.edges.find((e) => e.kind === 'works_on')).toMatchObject({ src: 'person:ana-ruiz', dst: 'project:atlas', props: { role: 'lead' } });
    expect(has(ex, 'person:ana-ruiz', 'member_of', 'company:acme')).toBe(true);
    const kept = ex.edges.find((e) => e.kind === 'attended');
    expect(kept).toMatchObject({ dst: 'meeting:08-meetings/2026-03-04 Atlas sync.md', provenance: 'rule', valid_from: Date.parse('2026-03-04') });
  });

  it('links to people notes count as mentions, tags and folders are recorded, code is skipped', () => {
    const text = ['# Ideas #draft', 'Talked to [[ana-ruiz|Ana]] and ![[Atlas]].', '```', '[[Ben Ode]] Decision: not real', '```', 'A [[missing note]].'].join('\n');
    const ex = run('notes/ideas.md', text);
    expect(has(ex, 'note:notes/ideas.md', 'links_to', 'note:02-people/ana-ruiz.md')).toBe(true);
    expect(has(ex, 'note:notes/ideas.md', 'embeds', 'note:04-projects/Atlas.md')).toBe(true);
    expect(has(ex, 'note:notes/ideas.md', 'mentions', 'person:ana-ruiz')).toBe(true);
    expect(has(ex, 'note:notes/ideas.md', 'mentions', 'project:atlas')).toBe(true);
    expect(has(ex, 'note:notes/ideas.md', 'tagged', 'tag:draft')).toBe(true);
    expect(has(ex, 'note:notes/ideas.md', 'in_folder', 'folder:notes')).toBe(true);
    expect(ex.edges.some((e) => e.dst.includes('ben-ode'))).toBe(false);
    expect(ex.nodes.some((n) => n.kind === 'decision')).toBe(false);
  });

  it('keeps names the opt-out list holds out of the graph', () => {
    const ex = extractNote({ rel: 'notes/x.md', text: '---\npeople: [Secret Co Person, Ana Ruiz]\n---\n', resolve: resolverOf(RELS), isExcluded: (t) => /secret co/i.test(t) });
    expect(ex.nodes.map((n) => n.id)).not.toContain('person:secret-co-person');
    expect(ex.nodes.map((n) => n.id)).toContain('person:ana-ruiz');
  });
});

describe('entity ids when two notes share a name', () => {
  const T = { type: 'project' };
  const ids = (entries) => Object.fromEntries(entityIds(entries));
  it('keeps notes in unrelated folders apart by path, and keeps the slug id for one note', () => {
    expect(ids([{ rel: '04-projects/alpha/Orca.md', props: T }, { rel: '04-projects/beta/Orca.md', props: T }])).toEqual({
      '04-projects/alpha/Orca.md': { id: 'project:04-projects/alpha/Orca', backs: true },
      '04-projects/beta/Orca.md': { id: 'project:04-projects/beta/Orca', backs: true },
    });
    expect(ids([{ rel: '04-projects/Orca.md', props: T }])).toEqual({});
    expect(entityId('project', '04-projects/Atlas.md')).toBe('project:atlas');
    expect(slugKey('04-projects/alpha/Orca.md', {})).toBe('project:orca');
    expect(slugKey('notes/Orca.md', { type: 'person' })).toBe('person:orca');
    expect(slugKey('notes/Orca.md', {})).toBe(null);
  });
  it('reads a hub and the note beside its folder as one entity, backed by the typed note, else the deeper one', () => {
    expect(ids([{ rel: '04-projects/Orca.md', props: {} }, { rel: '04-projects/Orca/Orca.md', props: T }])).toEqual({
      '04-projects/Orca.md': { id: 'project:orca', backs: false },
      '04-projects/Orca/Orca.md': { id: 'project:orca', backs: true },
    });
    expect(ids([{ rel: '04-projects/Orca.md', props: T }, { rel: '04-projects/Orca/Orca.md', props: {} }])['04-projects/Orca.md'].backs).toBe(true);
    expect(ids([{ rel: '04-projects/Orca.md', props: {} }, { rel: '04-projects/Orca/Orca.md', props: {} }])['04-projects/Orca/Orca.md'].backs).toBe(true);
    // a hub and a note inside its folder are one entity too; a third Orca elsewhere gets its own path id
    const three = ids([{ rel: 'p/Orca/Orca.md', props: T }, { rel: 'p/Orca/old/Orca.md', props: {} }, { rel: 'q/Orca.md', props: T }]);
    expect(three['p/Orca/old/Orca.md']).toEqual({ id: 'project:p/Orca/Orca', backs: false });
    expect(three['q/Orca.md']).toEqual({ id: 'project:q/Orca', backs: true });
  });
  it('makes the note the other one backs a note about the entity, and links reach the entity', () => {
    const map = entityIds([{ rel: '04-projects/Orca.md', props: {} }, { rel: '04-projects/Orca/Orca.md', props: T }]);
    const shared = (kind, rel) => map.get(rel) ?? null;
    const side = extractNote({ rel: '04-projects/Orca.md', text: '---\ntype: project\n---\n# Orca\n', shared });
    expect(side.kind).toBe('note');
    expect(side.edges.some((e) => e.src === 'note:04-projects/Orca.md' && e.kind === 'about' && e.dst === 'project:orca')).toBe(true);
    expect(side.nodes.find((x) => x.id === 'project:orca').rel).toBeUndefined();
    const resolve = (t) => (t === 'Orca' ? '04-projects/Orca.md' : null);
    const linker = extractNote({ rel: 'notes/x.md', text: 'See [[Orca]].', resolve, kindOf: () => 'project', shared });
    expect(linker.edges.find((e) => e.kind === 'mentions').dst).toBe('project:orca');
  });
});
