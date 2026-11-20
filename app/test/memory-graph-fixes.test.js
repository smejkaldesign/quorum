// Memory graph, search and tool regressions on generated temp vaults through the real vault index: cross-note
// supersession across edits, moves made while the app was closed, a note that throws, prefix lookups, budgets on explain
// and decisions, search opened during the index's first read, the embed queue with the model off, graph kinds in
// search, and an opt-out added after the build checked at every tool and window read.
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createVaultIndex } from '../vindex.js';
import { createMemoryGraph } from '../graph/index.js';
import { createTopics, inProcess } from '../graph/topics.js';
import { openStore } from '../graph/store.js';
import { createMemorySearch, createSearchIndex } from '../search/index.js';
import { openMemoryDb } from '../search/db.js';
import { createHybridSearch, topIndexes } from '../search/hybrid.js';
import { hashEmbedder } from '../search/embed.js';
import { MEMORY_TOOLS, fromActionHandlers, runMemoryTool, withholdAnswer } from '../cli/memoryTools.mjs';

const cleanup = [];
afterEach(() => { while (cleanup.length) { try { cleanup.pop()(); } catch { /* closed */ } } });

function tempVault() {
  const root = mkdtempSync(path.join(tmpdir(), 'mgfix-'));
  const vault = path.join(root, 'v');
  mkdirSync(vault, { recursive: true });
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const put = (rel, t) => { const a = path.join(vault, rel); mkdirSync(path.dirname(a), { recursive: true }); writeFileSync(a, t); };
  return { root, vault, put, dataDir: path.join(root, 'd') };
}

// the vault index and the graph wired the way main.js wires them
async function graphOn(v, { terms = [], vindexWrap = (ix) => ix } = {}) {
  // as suggest.js matches: the words, or their slug form
  const isExcluded = (t) => { const l = String(t).toLowerCase(); const p = l.replace(/[-_]+/g, ' '); return terms.some((x) => l.includes(x) || p.includes(x)); };
  const redact = (t) => t.split('\n').map((l) => (isExcluded(l) ? '[withheld: opted-out customer]' : l)).join('\n');
  let g = null;
  const ix = createVaultIndex({ vault: v.vault, isExcludedPath: isExcluded, isExcludedText: isExcluded, redact, onChange: () => {}, onIndexed: (r) => g?.update(r) });
  ix.sync();
  const make = () => { g = createMemoryGraph({ dataDir: v.dataDir, vault: v.vault, vindex: vindexWrap(ix), isExcluded }); cleanup.push(() => g.close()); return g; };
  make();
  await g.build();
  return { ix, get g() { return g; }, make, isExcluded, redact, terms };
}
const counts = (g) => Object.fromEntries(g.store.db().prepare("select kind, count(*) as n, sum(superseded_by is not null) as sup from edges where kind in ('decision_about', 'supersedes') group by kind").all().map((r) => [r.kind, { n: r.n, sup: r.sup }]));

describe('cross-note supersession', () => {
  const OLD = 'meetings/2026-01-05 Kickoff.md';
  const NEW = 'meetings/2026-03-05 Review.md';
  const older = (extra = '') => `---\ndate: 2026-01-05\nproject: "[[Heron]]"\n---\n# Kickoff\n\nDecision: Database: Postgres\n${extra}`;
  const newer = (extra = '', line = 'Decision: Database: SQLite') => `---\ndate: 2026-03-05\nproject: "[[Heron]]"\n---\n# Review\n\n${line}\n${extra}`;
  async function setup() {
    const v = tempVault();
    v.put('projects/Heron.md', '# Heron\n');
    v.put(OLD, older());
    v.put(NEW, newer());
    const w = await graphOn(v);
    return { v, w };
  }

  it('re-reading the older note keeps one superseded fact and one supersedes edge', async () => {
    const { v, w } = await setup();
    const before = counts(w.g);
    expect(before).toEqual({ decision_about: { n: 2, sup: 1 }, supersedes: { n: 1, sup: 0 } });
    for (let i = 0; i < 3; i++) { v.put(OLD, older(`\nedit ${i}\n`)); w.ix.syncPaths([OLD]); }
    expect(counts(w.g)).toEqual(before);
    expect(w.g.explain('project:heron').history).toHaveLength(1);
    const d = w.g.decisions({ about: 'Heron', current: false, budget: 99999 }).decisions;
    expect(d).toHaveLength(2);
    expect(d.find((x) => /Postgres/.test(x.text)).supersededBy.text).toMatch(/SQLite/);
  });

  it('an edit of the newer note keeps the supersedes edge; dropping its line restores the older fact', async () => {
    const { v, w } = await setup();
    v.put(NEW, newer('\nunrelated edit\n'));
    w.ix.syncPaths([NEW]);
    expect(counts(w.g)).toEqual({ decision_about: { n: 2, sup: 1 }, supersedes: { n: 1, sup: 0 } });
    v.put(NEW, newer('', 'Nothing decided.'));
    w.ix.syncPaths([NEW]);
    expect(counts(w.g)).toEqual({ decision_about: { n: 1, sup: 0 } });
    expect(w.g.decisions({ about: 'Heron' }).decisions.map((d) => d.text)).toEqual([expect.stringMatching(/Postgres/)]);
  });

  it('a restart over an unchanged vault leaves the edges as they were', async () => {
    const { w } = await setup();
    const before = counts(w.g);
    w.g.close();
    const g2 = w.make();
    await g2.build();
    expect(counts(g2)).toEqual(before);
  });
});

describe('graph build and updates', () => {
  it('a move made while the app was closed keeps its history when the new path sorts past the first batch', async () => {
    const v = tempVault();
    for (let i = 0; i < 250; i++) v.put(`n${String(i).padStart(3, '0')}.md`, `# N${i}\n\nSee [[n${String((i + 1) % 250).padStart(3, '0')}]].\n`);
    const w = await graphOn(v);
    const id = w.g.store.edgesOf('note:n005.md', { dir: 'out', kinds: ['links_to'] })[0].id;
    w.g.store.addEdge({ src: 'note:n005.md', dst: 'note:n100.md', kind: 'mentions', provenance: 'person', source_rel: 'n005.md' });
    w.g.close();
    renameSync(path.join(v.vault, 'n005.md'), path.join(v.vault, 'zz-moved.md'));
    w.ix.sync();
    const g2 = w.make();
    await g2.build();
    const out = g2.store.edgesOf('note:zz-moved.md', { dir: 'out' });
    expect(out.find((e) => e.kind === 'links_to').id).toBe(id);
    expect(out.filter((e) => e.provenance === 'person')).toHaveLength(1);
    expect(g2.store.node('note:n005.md')).toBeNull();
  });

  it('a note that throws is skipped; the rest of its batch is kept and the note is read again next build', async () => {
    const v = tempVault();
    for (let i = 0; i < 30; i++) v.put(`n${i}.md`, `# N${i}\n\nSee [[n${(i + 1) % 30}]].\n`);
    let broken = true;
    const vindexWrap = (ix) => ({ ...ix, resolve: (t, from) => { if (broken && from === 'n7.md') throw new Error('bad note'); return ix.resolve(t, from); } });
    const w = await graphOn(v, { vindexWrap });
    expect(w.g.status().notes).toBe(29);
    expect(w.g.store.fileHash('n7.md')).toBeNull();
    expect(w.g.store.node('note:n8.md')).not.toBeNull();
    broken = false;
    w.g.close();
    const g2 = w.make();
    await g2.build();
    expect(g2.status().notes).toBe(30);
  });

  it('a burst larger than a batch applies in batches, removals and moves included', async () => {
    const v = tempVault();
    for (let i = 0; i < 260; i++) v.put(`n${String(i).padStart(3, '0')}.md`, `# N${i}\n\nbody ${i}\n`);
    const w = await graphOn(v);
    const keep = w.g.store.node('note:n004.md');
    for (let i = 0; i < 260; i++) if (i % 2) v.put(`n${String(i).padStart(3, '0')}.md`, `# N${i}\n\nedited ${i}\n`);
    rmSync(path.join(v.vault, 'n002.md'));
    renameSync(path.join(v.vault, 'n004.md'), path.join(v.vault, 'zz-004.md'));
    const changed = w.ix.sync();
    expect(changed.length).toBeGreaterThan(100);
    await w.g.update(changed);
    expect(w.g.store.node('note:n002.md')).toBeNull();
    expect(w.g.store.node('note:zz-004.md').created_at).toBe(keep.created_at);
    expect(w.g.status().notes).toBe(259);
  });
});

describe('lookups never guess', () => {
  async function setup() {
    const v = tempVault();
    v.put('people/Ana Ruiz.md', '---\ntype: person\n---\n# Ana Ruiz\n');
    v.put('projects/Theory.md', '---\ntype: project\n---\n# Theory\n');
    v.put('projects/Heron.md', '---\ntype: project\n---\n# Heron\n\nWith [[Ana Ruiz]].\n');
    return graphOn(v);
  }
  it('a prefix needs three characters and comes back as candidates', async () => {
    const { g } = await setup();
    expect(g.store.find('a')).toEqual([]);
    expect(g.store.find('th')).toEqual([]);
    expect(g.store.find('the')).toEqual([expect.objectContaining({ id: 'project:theory', prefix: true })]);
    expect(g.store.find('the', { prefix: false })).toEqual([]);
    expect(g.resolveRef('the')).toEqual({ ambiguous: [expect.objectContaining({ id: 'project:theory' })] });
    expect(g.resolveRef('Theory').node.id).toBe('project:theory');
    expect(g.entity('Ana').ambiguous?.[0].id).toBe('person:ana-ruiz');
  });
  it('search seeds the graph from exact names only', async () => {
    const { g } = await setup();
    const db = g.store.db();
    const { db: sdb } = openMemoryDb({ store: g.store });
    const index = createSearchIndex({ db: sdb });
    await index.build(g.rels().map((rel) => ({ rel, text: g.textOf(rel), note: null, mtime: 0 })));
    const hybrid = createHybridSearch({ db, graph: () => g.store, version: index.version });
    const r = await hybrid.search({ q: 'the plan', signals: ['fts', 'graph'] });
    expect(r.results.some((x) => x.parts.graph)).toBe(false);
  });
});

describe('budgets', () => {
  it('explain caps every direction by the budget and says what it left out', async () => {
    const v = tempVault();
    for (let i = 0; i < 400; i++) v.put(`inbox/n${i}.md`, `# N${i}\n\n#busy body\n`);
    const { g } = await graphOn(v);
    const ex = g.explain('folder:inbox', { budget: 1500 });
    const size = Math.ceil(JSON.stringify(ex).length / 4);
    expect(size).toBeLessThan(2000);
    expect(ex.truncated.total).toBe(400);
    expect(ex.truncated.shown).toBe(ex.in.length);
    expect(ex.truncated.sections.in).toEqual({ shown: ex.in.length, total: 400 });
    expect(ex.truncated.budgetNeeded).toBeGreaterThan(1500);
  });
  it('decisions with no subject are newest first, current only, and cut to the budget', async () => {
    const v = tempVault();
    for (let i = 0; i < 300; i++) {
      const d = `2026-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`;
      v.put(`meetings/${d} M${i}.md`, `---\ndate: ${d}\n---\n# M${i}\n\nDecision: Topic ${i}: choice ${i}\n`);
    }
    const { g } = await graphOn(v);
    const r = g.decisions({ budget: 800 });
    expect(r.truncated.total).toBe(300);
    expect(r.decisions.length).toBeLessThan(300);
    expect(Math.ceil(JSON.stringify(r.decisions).length / 4)).toBeLessThanOrEqual(800);
    const dates = r.decisions.map((d) => d.date);
    expect([...dates].sort((a, b) => b - a)).toEqual(dates);
    const since = g.decisions({ since: '2026-12-01', budget: 99999 });
    expect(since.decisions.every((d) => d.date >= Date.parse('2026-12-01'))).toBe(true);
    expect(since.truncated.total).toBe(since.decisions.length);
  });
});

describe('search', () => {
  it('opened during the index first read waits, then reaches every note', async () => {
    const v = tempVault();
    for (let i = 0; i < 3000; i++) v.put(`n${i}.md`, `# Note ${i}\n\nbody word${i}\n`);
    let graph = null;
    let search = null;
    const ix = createVaultIndex({ vault: v.vault, isExcludedPath: () => false, isExcludedText: () => false, redact: (t) => t, onChange: () => {}, onIndexed: (r) => { graph?.update(r); search.changed(r); } });
    cleanup.push(() => ix.stop());
    graph = createMemoryGraph({ dataDir: v.dataDir, vault: v.vault, vindex: ix });
    cleanup.push(() => graph.close());
    search = createMemorySearch({ dataDir: v.dataDir, vault: () => v.vault, vindex: () => ix, graph: () => graph.store });
    cleanup.push(() => search.close());
    graph.on('ready', () => search.changed([]));
    const started = ix.start();
    await new Promise((r) => setImmediate(r));
    expect(ix.ready()).toBe(false);
    expect(search.status().state).toBe('waiting');
    expect(await search.search({ q: 'word1' })).toBeNull();
    await started;
    await graph.build();
    await search.changed([]);
    await search.idle();
    expect(search.status().notes).toBe(3000);
    const r = await search.search({ q: 'word2999' });
    expect(r.results[0].rel).toBe('n2999.md');
  });

  it('the kinds filter takes graph kinds', async () => {
    const v = tempVault();
    v.put('notes/sync.md', '---\ntype: meeting-note\n---\n# Sync\n\nfalcon plan\n');
    v.put('contacts/Ben.md', '---\ntype: person\n---\n# Ben\n\nfalcon owner\n');
    v.put('other.md', '# Other\n\nfalcon idea\n');
    const ix = createVaultIndex({ vault: v.vault, isExcludedPath: () => false, isExcludedText: () => false, redact: (t) => t, onChange: () => {} });
    ix.sync();
    const search = createMemorySearch({ dataDir: v.dataDir, vault: () => v.vault, vindex: () => ix });
    cleanup.push(() => search.close());
    expect((await search.search({ q: 'falcon', kinds: ['meeting'] })).results.map((x) => x.rel)).toEqual(['notes/sync.md']);
    expect((await search.search({ q: 'falcon', kinds: ['person'] })).results.map((x) => x.rel)).toEqual(['contacts/Ben.md']);
  });

  it('the embed queue stops while the model is off and starts again on resume', async () => {
    const v = tempVault();
    const { db } = openMemoryDb({ dataDir: v.dataDir, vault: v.vault });
    cleanup.push(() => db.close());
    const real = hashEmbedder();
    let off = true;
    let calls = 0;
    const embedder = { ...real, embed: async (t) => { calls++; if (off) throw new Error('The local embedding model is off'); return real.embed(t); } };
    const logs = [];
    const index = createSearchIndex({ db, embedder, retryMs: 1, log: (...a) => logs.push(a.join(' ')) });
    await index.update([{ rel: 'a.md', text: '# A\n\nalpha\n', note: null, mtime: 0 }]);
    await index.idle();
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toBe(1);
    expect(logs.filter((l) => l.includes('embed failed'))).toHaveLength(1);
    expect(index.status()).toMatchObject({ state: 'waiting', embedded: 0 });
    off = false;
    index.resume();
    await index.idle();
    expect(index.status()).toMatchObject({ state: 'idle', embedded: 1, error: null });
  });

  it('a failing embedder waits longer each time and logs a repeated error once', async () => {
    const v = tempVault();
    const { db } = openMemoryDb({ dataDir: v.dataDir, vault: v.vault });
    cleanup.push(() => db.close());
    const at = [];
    const embedder = { ...hashEmbedder(), embed: async () => { at.push(Date.now()); throw new Error('timed out'); } };
    const logs = [];
    const index = createSearchIndex({ db, embedder, retryMs: 8, retryMaxMs: 64, log: (...a) => logs.push(a.join(' ')) });
    cleanup.push(() => index.stop());
    await index.update([{ rel: 'a.md', text: '# A\n\nalpha\n', note: null, mtime: 0 }]);
    await new Promise((r) => setTimeout(r, 200));
    index.stop();
    const gaps = at.slice(1).map((t, i) => t - at[i]);
    expect(gaps.length).toBeGreaterThanOrEqual(3);
    expect(gaps[2]).toBeGreaterThan(gaps[0]);
    expect(logs.filter((l) => l.includes('embed failed'))).toHaveLength(1);
  });

  it('vectors added after the first query join the matrix without a full read and rank the same', async () => {
    const v = tempVault();
    const { db } = openMemoryDb({ dataDir: v.dataDir, vault: v.vault });
    cleanup.push(() => db.close());
    const embedder = hashEmbedder();
    const index = createSearchIndex({ db, embedder, embedBatch: 4 });
    const notes = Array.from({ length: 40 }, (_, i) => ({ rel: `n${i}.md`, text: `# N${i}\n\nterm${i % 7} shared word${i}\n`, note: null, mtime: 0 }));
    const live = createHybridSearch({ db, embedder, version: index.version, appended: index.appended });
    await index.update(notes.slice(0, 10));
    await index.idle();
    await live.search({ q: 'term3' });
    let reads = 0;
    const counted = { prepare: (sql) => { const st = db.prepare(sql); if (/FROM vectors WHERE model = \?$/.test(sql)) return { all: (...a) => { reads++; return st.all(...a); } }; return st; } };
    const watched = createHybridSearch({ db: counted, embedder, version: index.version, appended: index.appended });
    await watched.search({ q: 'term3' });
    expect(reads).toBe(1);
    const before = index.version();
    await index.drain();
    expect(index.version()).toBe(before);
    await watched.search({ q: 'term3' });
    expect(reads).toBe(1);
    const fresh = createHybridSearch({ db, embedder, version: index.version });
    expect((await watched.search({ q: 'term5 shared' })).results).toEqual((await fresh.search({ q: 'term5 shared' })).results);
  });

  it('topIndexes picks the highest scores in order', () => {
    const s = Float32Array.from([0.1, 0.9, 0.3, 0.9, -1, 0.5]);
    expect(topIndexes(s, 3)).toEqual([1, 3, 5]);
    expect(topIndexes(s, 10)).toHaveLength(6);
  });
});

describe('an opt-out added after the build', () => {
  it('leaves memory.db and never reaches a tool or a window read', async () => {
    const v = tempVault();
    v.put('companies/acme-corp.md', '# Acme Corp\n\nA customer.\n');
    v.put('people/Ana Ruiz.md', '---\ncompany: "[[acme-corp]]"\n---\n# Ana Ruiz\n\nWorks with Acme Corp on the rollout.\n');
    v.put('projects/Heron.md', '# Heron\n\nFor [[acme-corp]] with [[Ana Ruiz]].\n\nDecision: Vendor: Acme Corp\n');
    v.put('meetings/2026-02-01 Sync.md', '---\ndate: 2026-02-01\nattendees: Ana Ruiz\nproject: "[[Heron]]"\n---\n# Sync\n\nAcme Corp wants the rollout in March.\n');
    const terms = [];
    const w = await graphOn(v, { terms });
    const search = createMemorySearch({ dataDir: v.dataDir, vault: () => v.vault, vindex: () => w.ix, graph: () => w.g.store });
    cleanup.push(() => search.close());
    await search.changed([]);
    expect(w.g.store.node('company:acme-corp')).not.toBeNull();
    expect((await search.search({ q: 'acme rollout' })).results.length).toBeGreaterThan(0);
    // communities as main.js builds them after the graph (graph/topics.js), read again after the update below
    const topics = createTopics({ store: w.g.store, run: inProcess(w.g.store) });
    await topics.refresh();
    expect(JSON.stringify(w.g.store.db().prepare('select * from communities').all())).toMatch(/acme-corp/);

    // the person adds Acme Corp to the opt-out list: main.js re-reads the index, which reaches the graph and search
    terms.push('acme corp');
    const changed = w.ix.rebuild();
    await w.g.update(changed);
    await search.changed(changed);
    await search.idle();
    await topics.refresh();

    const ACME = /acme[\s_-]*corp/i;
    const db = w.g.store.db();
    for (const [t, cols] of [['nodes', ['id', 'name', 'rel', 'props']], ['aliases', ['node', 'alias']], ['edges', ['src', 'dst', 'source_rel', 'props']], ['chunks', ['rel', 'heading', 'text']], ['search_files', ['rel', 'title']], ['communities', ['node', 'community']], ['community_info', ['id', 'name', 'hub', 'props']]]) {
      for (const r of db.prepare(`select ${cols.join(', ')} from ${t}`).all()) expect(JSON.stringify(r), t).not.toMatch(ACME);
    }
    expect(db.prepare("select count(*) as n from chunks_fts where chunks_fts match 'acme'").get().n).toBe(0);

    // every handler the way main.js registers it: the window's IPC read and the tools' bridge share it
    const filters = { withheld: (rel) => w.isExcluded(rel), isExcluded: w.isExcluded, redact: w.redact };
    const out = (r) => withholdAnswer(r, filters);
    const g = w.g;
    const handlers = new Map([
      ['memory-graph-status', () => g.status()],
      ['memory-graph-query', (_e, a) => out(g.graphQuery(a))],
      ['memory-graph-explain', (_e, a) => out(g.explain(a.id, a))],
      ['memory-graph-entity', (_e, a) => out(g.entity(a.name, a))],
      ['memory-graph-decisions', (_e, a) => out(g.decisions(a))],
      ['memory-graph-path', (_e, a) => out(g.graphPath(a.a, a.b, a))],
      ['memory-graph-communities', (_e, a) => out(g.communities(a))],
      ['memory-graph-hubs', (_e, a) => out(g.hubs(a))],
      ['memory-search', async (_e, a) => out(await search.search(a))],
      ['memory-search-status', () => search.status()],
      ['memory-setup-status', () => ({ phase: 'done', gaps: [] })],
    ]);
    const asks = {
      search: [{ q: 'acme corp rollout' }, { q: 'rollout march' }, { q: 'vendor' }],
      graph_query: [{ q: 'Ana Ruiz', depth: 3, budget: 50000 }, { q: 'Heron', depth: 3, budget: 50000 }, { q: 'company:acme-corp' }],
      graph_path: [{ a: 'Ana Ruiz', b: 'Heron' }, { a: 'Ana Ruiz', b: 'company:acme-corp' }],
      explain: [{ id: 'person:ana-ruiz', budget: 50000 }, { id: 'project:heron', budget: 50000 }, { id: 'company:acme-corp' }, { id: 'Acme Corp' }],
      entity: [{ name: 'Ana Ruiz', budget: 50000 }, { name: 'Heron', budget: 50000 }, { name: 'acme-corp' }],
      decisions: [{ budget: 50000 }, { about: 'Heron', current: false, budget: 50000 }],
      communities: [{ budget: 50000 }, { id: 'Heron', budget: 50000 }, { id: 'company:acme-corp' }, { id: 'Acme Corp' }],
      hubs: [{ budget: 50000 }, { community: 'Ana Ruiz', budget: 50000 }],
      memory_status: [{}],
    };
    expect(Object.keys(asks).sort()).toEqual(MEMORY_TOOLS.map((t) => t.name).sort());
    const bridge = fromActionHandlers(handlers);
    for (const [tool, list] of Object.entries(asks)) {
      for (const args of list) {
        const t = MEMORY_TOOLS.find((x) => x.name === tool);
        const viaTool = await runMemoryTool(tool, args, { handler: bridge, ...filters }).catch((e) => ({ error: e.message }));
        expect(JSON.stringify(viaTool), `${tool} ${JSON.stringify(args)}`).not.toMatch(ACME);
        const viaWindow = await handlers.get(t.handler)(null, args);
        expect(JSON.stringify(viaWindow), `ipc ${t.handler} ${JSON.stringify(args)}`).not.toMatch(ACME);
      }
    }
    // the rest of the graph still answers
    expect(g.entity('Ana Ruiz').node.id).toBe('person:ana-ruiz');
    const status = await runMemoryTool('memory_status', {}, { handler: bridge, ...filters });
    expect(status.setup).toEqual({ phase: 'done', gaps: [] });
  });

  it('the tool filter drops slug ids and edge names', () => {
    const isExcluded = (t) => t.toLowerCase().includes('acme corp');
    const r = { nodes: [{ id: 'company:acme-corp', name: 'Acme' }, { id: 'person:ana-ruiz', name: 'Ana Ruiz' }], edges: [{ id: 3, src: 'person:ana-ruiz', srcName: 'Ana Ruiz', dst: 'company:acme_corp', dstName: 'x', kind: 'member_of' }, { id: 4, src: 'person:ana-ruiz', srcName: 'Ana Ruiz', dst: 'note:x.md', dstName: 'Acme Corp notes', kind: 'mentions' }] };
    expect(withholdAnswer(r, { isExcluded })).toEqual({ nodes: [{ id: 'person:ana-ruiz', name: 'Ana Ruiz' }], edges: [] });
    expect(withholdAnswer({ node: { id: 'company:acme-corp' }, out: [] }, { isExcluded })).toEqual({ error: 'That note is withheld.' });
  });
});

describe('main.js registrations', () => {
  it('memory-setup-status is an app action, so memory_status reaches it over the bridge', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(path.join(import.meta.dirname, '..', 'main.js'), 'utf8');
    expect(src).toMatch(/handleAction\('memory-setup-status'/);
    expect(src).not.toMatch(/ipcMain\.handle\('memory-setup-status'/);
    // opted-out names leave the memory database when the list changes
    expect(src).toMatch(/optOutsBefore\) setTimeout\(\(\) => vindex\?\.rebuild\(\)/);
  });
  it('opening a store whose schema is older drops only the graph tables', () => {
    const v = tempVault();
    const s = openStore({ dir: path.join(v.dataDir, 'memory'), vault: v.vault });
    s.db().exec("create table if not exists chunks(id integer primary key); update meta set value = '1' where key = 'graph_schema'");
    s.upsertFile({ rel: 'a.md', hash: 'h' });
    s.close();
    const s2 = openStore({ dir: path.join(v.dataDir, 'memory'), vault: v.vault });
    cleanup.push(() => s2.close());
    expect(s2.files().size).toBe(0);
    expect(s2.db().prepare("select name from sqlite_master where name = 'chunks'").get()).toBeTruthy();
  });
});
