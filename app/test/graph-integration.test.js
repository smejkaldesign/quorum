// The memory graph end to end on a generated vault (test/fixtures/graphVault.js) through the real vault index: a full
// build, queries, supersession, edits, moves, deletions, a restart that skips unchanged notes, and withheld text.
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createVaultIndex } from '../vindex.js';
import { createMemoryGraph } from '../graph/index.js';
import { writeGraphVault } from './fixtures/graphVault.js';

const SECRET = /zorblax/i;
const open = [];
async function setup(opts = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'memgraph-'));
  const vault = path.join(root, 'v');
  const info = writeGraphVault(vault, { notes: 120, people: 20, projects: 5, companies: 3, meetings: 30, padWords: 10, ...opts });
  const ix = createVaultIndex({ vault, isExcludedPath: () => false, isExcludedText: (t) => SECRET.test(t), redact: (t) => t.split('\n').map((l) => (SECRET.test(l) ? '[withheld: opted-out customer]' : l)).join('\n'), onChange: () => {} });
  ix.sync();
  const dataDir = path.join(root, 'data');
  const make = () => { const g = createMemoryGraph({ dataDir, vault, vindex: ix, isExcluded: (t) => SECRET.test(t) }); open.push(g); return g; };
  const g = make();
  await g.build();
  const write = (rel, text) => { const abs = path.join(vault, rel); mkdirSync(path.dirname(abs), { recursive: true }); writeFileSync(abs, text); g.update(ix.syncPaths([rel])); };
  const edit = (rel, fn) => write(rel, fn(readFileSync(path.join(vault, rel), 'utf8')));
  const move = (from, to) => { mkdirSync(path.dirname(path.join(vault, to)), { recursive: true }); renameSync(path.join(vault, from), path.join(vault, to)); g.update(ix.syncPaths([from, to])); };
  const remove = (rel) => { rmSync(path.join(vault, rel)); g.update(ix.syncPaths([rel])); };
  return { root, vault, ix, g, make, info, write, edit, move, remove };
}
afterEach(() => { while (open.length) open.pop().close(); });

describe('memory graph on a generated vault', () => {
  it('builds every note and answers entity, decisions, path and budgeted queries', async () => {
    const { g, ix, info } = await setup();
    const st = g.status();
    expect(st.phase).toBe('ready');
    expect(st.notes).toBe(ix.size());
    expect(st.byKind.nodes.person).toBe(20);
    expect(st.byKind.nodes.meeting).toBe(30);

    const ana = g.entity('Ana Ruiz');
    expect(ana.node.id).toBe('person:ana-ruiz');
    expect(ana.rel).toBe('02-people/ana-ruiz.md');
    expect(ana.projects.map((p) => p.id)).toEqual(expect.arrayContaining(['project:project-a', 'company:company-0']));
    expect(ana.meetings.length).toBeGreaterThan(0);
    for (const m of ana.meetings) expect(m.id.startsWith('meeting:08-meetings/')).toBe(true);

    // every Project A meeting decides "Hosting: ...": only the newest one holds, the rest are history
    const all = g.decisions({ about: 'Project A', current: false, budget: 100000 }).decisions;
    const now = g.decisions({ about: 'Project A', budget: 100000 }).decisions;
    expect(all.length).toBe(6);
    expect(now.length).toBe(1);
    expect(now[0].date).toBe(Math.max(...all.map((d) => d.date)));
    expect(all.filter((d) => d.supersededBy).length).toBe(5);

    const p = g.graphPath('Ana Ruiz', 'Company 0');
    expect(p.path[0].id).toBe('person:ana-ruiz');
    expect(p.path.at(-1).id).toBe('company:company-0');

    const big = g.graphQuery({ q: 'Project A', budget: 100000 });
    const small = g.graphQuery({ q: 'Project A', budget: 200 });
    expect(small.nodes.length).toBeLessThan(big.nodes.length);
    expect(small.truncated.total).toBe(big.nodes.length);
    expect(small.truncated.budgetNeeded).toBeGreaterThan(200);
    expect(big.nodes[0].id).toBe('project:project-a');
    expect(info.personNames.length).toBe(20);
  });

  it('refuses a name that matches two things', async () => {
    const { g, write } = await setup();
    write('companies/Project A.md', '# Project A\n');
    const r = g.entity('Project A');
    expect(r.ambiguous.map((c) => c.id).sort()).toEqual(['company:project-a', 'project:project-a']);
    expect(g.graphQuery({ q: 'Project A' }).ambiguous).toHaveLength(2);
    expect(g.entity('person:ana-ruiz').node.id).toBe('person:ana-ruiz');
  });

  it('supersedes an edited fact and keeps it as history', async () => {
    const { g, edit } = await setup();
    edit('02-people/ana-ruiz.md', (t) => t.replace('company: "[[Company 0]]"', 'company: "[[Company 1]]"'));
    const ex = g.explain('person:ana-ruiz');
    expect(ex.out.filter((e) => e.kind === 'member_of').map((e) => e.dst)).toEqual(['company:company-1']);
    expect(ex.history.map((e) => [e.dst, e.supersededBy.dst])).toEqual([['company:company-0', 'company:company-1']]);
  });

  it('keeps edges and approved links through a move, and drops a deleted note with what it said', async () => {
    const { g, move, remove, info } = await setup();
    const rel = info.meetingRels[0];
    const approved = g.store.addEdge({ src: 'person:ben-ruiz', dst: `meeting:${rel}`, kind: 'attended', provenance: 'person', source_rel: '02-people/ben-ruiz.md' });
    move('02-people/ana-ruiz.md', 'people/archive/ana-ruiz.md');
    expect(g.store.node('person:ana-ruiz').rel).toBe('people/archive/ana-ruiz.md');
    expect(g.store.node('note:02-people/ana-ruiz.md')).toBe(null);
    expect(g.store.edgesOf('person:ana-ruiz', { kinds: ['works_on'] })).toHaveLength(1);

    const to = rel.replace('08-meetings/', '08-meetings/2026/');
    move(rel, to);
    expect(g.store.edge(approved).dst).toBe(`meeting:${to}`);
    expect(g.store.node(`meeting:${rel}`)).toBe(null);
    expect(g.store.edgesOf(`meeting:${to}`, { dir: 'in', kinds: ['attended'] }).length).toBeGreaterThan(1);

    // the newest Project A meeting goes: the decision it replaced holds again
    const before = g.decisions({ about: 'Project A' }).decisions[0];
    remove(before.rel);
    expect(g.store.node(`meeting:${before.rel}`)).toBe(null);
    const after = g.decisions({ about: 'Project A' }).decisions;
    expect(after).toHaveLength(1);
    expect(after[0].date).toBeLessThan(before.date);
    expect(after[0].supersededBy).toBe(null);
  });

  it('resolves a link once the note it names is written', async () => {
    const { g, write } = await setup();
    write('notes/waiting.md', '# Waiting\n\nSee [[later-note]].\n');
    expect(g.store.edgesOf('note:notes/waiting.md', { dir: 'out', kinds: ['links_to'] })).toHaveLength(0);
    write('notes/later-note.md', '# Later\n');
    expect(g.store.edgesOf('note:notes/waiting.md', { dir: 'out', kinds: ['links_to'] }).map((e) => e.dst)).toEqual(['note:notes/later-note.md']);
  });

  it('reads only changed notes after a restart', async () => {
    const { g, make, write } = await setup();
    write('notes/new.md', '# New\n');
    const before = g.status();
    g.close();
    open.pop();
    const again = make();
    const seen = [];
    again.onFileChange((c) => seen.push(c));
    await again.build();
    expect(seen).toEqual([]);
    expect(again.status().nodes).toBe(before.nodes);
    expect(again.status().edges).toBe(before.edges);
  });

  it('never stores withheld text', async () => {
    const { g, write } = await setup();
    write('08-meetings/2026-06-01 Zorblax call.md', '---\ndate: 2026-06-01\nparticipants: [Ana Ruiz]\n---\n# Call\n');
    write('notes/mixed.md', '---\npeople: [Zorblax Buyer, Ana Ruiz]\n---\n# Mixed\nDecision: sign with Zorblax\nDecision: keep Ana on it\n');
    const db = g.store.db();
    const hits = db.prepare("select id from nodes where id like '%zorblax%' or name like '%zorblax%' or props like '%zorblax%' union select node from aliases where alias like '%zorblax%' union select id from edges where source_rel like '%zorblax%' or props like '%zorblax%'").all();
    expect(hits).toEqual([]);
    expect(g.store.node('note:notes/mixed.md')).not.toBe(null);
    expect(g.decisions({ about: 'notes/mixed.md' }).decisions.map((d) => d.text)).toEqual(['keep Ana on it']);
  });
});
