// Extraction from one note with no model (graph/extract.js): links, frontmatter, folder conventions, meetings,
// decision lines and the keeper's link lines, checked against hand-written notes.
import { describe, expect, it } from 'vitest';
import { extractNote, folderKind, noteKind } from '../graph/extract.js';

// a resolver over a fixed set of notes, by basename, case-insensitive, like vindex's
const resolverOf = (rels) => (target) => rels.find((r) => r.toLowerCase().replace(/\.md$/, '').split('/').pop() === target.toLowerCase().replace(/\.md$/, '').split('/').pop()) ?? null;
const RELS = ['02-people/ana-ruiz.md', '02-people/Ben Ode.md', '04-projects/Atlas.md', 'companies/Acme.md', '08-meetings/2026-03-04 Atlas sync.md', 'notes/ideas.md'];
const run = (rel, text) => extractNote({ rel, text, resolve: resolverOf(RELS) });
const has = (ex, src, kind, dst) => ex.edges.some((e) => e.src === src && e.kind === kind && e.dst === dst);

describe('folder conventions', () => {
  it('reads the deepest known folder, ignoring numeric prefixes, and leaves folder indexes as notes', () => {
    expect(folderKind('02-people/ana.md')).toBe('person');
    expect(folderKind('04-projects/atlas/meetings/kickoff.md')).toBe('meeting');
    expect(folderKind('notes/a.md')).toBe(null);
    expect(noteKind('02-people/README.md', {}).kind).toBe('note');
    expect(noteKind('notes/x.md', { type: 'person' })).toEqual({ kind: 'person', provenance: 'explicit' });
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
