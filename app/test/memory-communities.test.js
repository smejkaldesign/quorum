// Communities, hubs and topic summaries (graph/communities.js, graph/topics.js, rules/topicSummaries.js): detection on
// generated graphs, names with and without the person's model (runModel mocked; no real model calls), the communities
// and hubs tools through runMemoryTool and formatMemory, and the summary written on Approve in the Quorum folder only.
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { detectCommunities, louvain, nameCommunity } from '../graph/communities.js';
import { createTopics, cleanDraft, cleanName, inProcess, inWorker, stableIds, workerPath } from '../graph/topics.js';
import { openStore } from '../graph/store.js';
import { createVaultIndex } from '../vindex.js';
import { createMemoryGraph } from '../graph/index.js';
import { formatMemory, tokens } from '../cli/budget.mjs';
import { MEMORY_TOOLS, runMemoryTool } from '../cli/memoryTools.mjs';
import { TOOL_USE } from '../cli/about.mjs';
import { run as topicRule, topicFile, firstLine, MIN_NOTES } from '../rules/topicSummaries.js';
import { run as summaryRule } from '../rules/summaries.js';
import { runSetupOp, SETUP_OPS } from '../memorySetup.js';
import { itemLine } from '../reviewItems.js';
import { writeGraphVault } from './fixtures/graphVault.js';

const roots = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
const tmp = (p) => { const r = mkdtempSync(path.join(tmpdir(), p)); roots.push(r); return r; };

// planted groups: dense links inside each group, a few across, seeded so every run is the same graph
function planted({ groups = 4, size = 10, inside = 30, across = 3, seed = 3 } = {}) {
  let s = seed;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const nodes = [];
  const edges = [];
  for (let g = 0; g < groups; g++) for (let i = 0; i < size; i++) nodes.push({ id: `note:g${g}/n${i}.md`, kind: 'note', name: `n${g}-${i}`, rel: `g${g}/n${i}.md` });
  const id = (g, i) => `note:g${g}/n${i}.md`;
  for (let g = 0; g < groups; g++) {
    for (let i = 1; i < size; i++) edges.push({ src: id(g, i), dst: id(g, i - 1), kind: 'links_to', provenance: 'explicit' });
    for (let k = 0; k < inside; k++) edges.push({ src: id(g, Math.floor(rnd() * size)), dst: id(g, Math.floor(rnd() * size)), kind: 'mentions', provenance: 'rule' });
  }
  for (let k = 0; k < across; k++) edges.push({ src: id(k % groups, 0), dst: id((k + 1) % groups, 1), kind: 'links_to', provenance: 'explicit' });
  return { nodes, edges };
}

describe('community detection', () => {
  it('finds planted groups, each community one connected piece', () => {
    const { communities, modularity } = detectCommunities(planted());
    expect(communities).toHaveLength(4);
    for (const c of communities) expect(new Set(c.members.map((m) => m.id.split('/')[0])).size).toBe(1);
    expect(modularity).toBeGreaterThan(0.5);
  });
  it('gives the same communities for the same graph, whatever order the rows come in', () => {
    const g = planted({ groups: 6, size: 15 });
    const a = detectCommunities(g);
    const b = detectCommunities({ nodes: [...g.nodes].reverse(), edges: [...g.edges].reverse() });
    expect(b.communities.map((c) => [c.id, c.members.map((m) => m.id)])).toEqual(a.communities.map((c) => [c.id, c.members.map((m) => m.id)]));
  });
  it('splits a community with no edge inside it between its parts', () => {
    // two triangles with no edge between them, and a weight that would pull them together at a higher level
    const r = louvain(6, [[0, 1, 1], [1, 2, 1], [0, 2, 1], [3, 4, 1], [4, 5, 1], [3, 5, 1]]);
    expect(r.membership[0]).toBe(r.membership[2]);
    expect(r.membership[0]).not.toBe(r.membership[3]);
  });
  it('weights by kind and provenance, and tags and folders label communities without shaping them', () => {
    const g = planted({ groups: 2, size: 6, across: 0 });
    g.nodes.push({ id: 'tag:design', kind: 'tag', name: '#design' }, { id: 'folder:g0', kind: 'folder', name: 'g0' });
    // a tag on every note of both groups: it would join them if it were an edge to cluster on
    for (const n of g.nodes.filter((x) => x.kind === 'note')) g.edges.push({ src: n.id, dst: 'tag:design', kind: 'tagged', provenance: 'explicit' });
    for (const n of g.nodes.filter((x) => x.id.startsWith('note:g0'))) g.edges.push({ src: n.id, dst: 'folder:g0', kind: 'in_folder', provenance: 'rule' });
    const { communities } = detectCommunities(g);
    expect(communities).toHaveLength(2);
    const g0 = communities.find((c) => c.hub.startsWith('note:g0'));
    expect(g0.tags).toEqual(['#design']);
    expect(g0.folder).toBe('g0');
  });
  it('names a community from its strongest project, else from a shared tag or folder', () => {
    const nodes = new Map([['project:orca', { kind: 'project', name: 'Orca' }], ['note:a.md', { kind: 'note', name: 'a' }]]);
    expect(nameCommunity({ hub: 'note:a.md', members: [{ id: 'note:a.md' }, { id: 'project:orca' }], tags: ['#x'] }, (id) => nodes.get(id))).toBe('Orca');
    expect(nameCommunity({ hub: 'note:a.md', members: [{ id: 'note:a.md' }], tags: ['#design'] }, (id) => nodes.get(id))).toBe('design: a');
    expect(nameCommunity({ hub: 'note:a.md', members: [{ id: 'note:a.md' }], tags: [], folder: 'research' }, (id) => nodes.get(id))).toBe('research: a');
  });
});

// a store with a generated graph written straight into it: n nodes and m edges in planted groups of 40
function bigStore(dir, n = 4000, m = 12000) {
  const store = openStore({ dir, vault: path.join(dir, 'vault') });
  let s = 11;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  store.tx(() => {
    for (let i = 0; i < n; i++) store.upsertNode({ id: `note:n${i}.md`, kind: i % 10 === 0 ? 'project' : 'note', name: `Note ${i}`, rel: `n${i}.md` });
    for (let k = 0; k < m; k++) {
      const a = Math.floor(rnd() * n);
      const b = rnd() < 0.85 ? Math.floor(a / 40) * 40 + Math.floor(rnd() * 40) : Math.floor(rnd() * n);
      store.addEdge({ src: `note:n${a}.md`, dst: `note:n${b}.md`, kind: rnd() < 0.5 ? 'links_to' : 'mentions', provenance: rnd() < 0.5 ? 'explicit' : 'rule' });
    }
  });
  return store;
}

describe('topics on a 4,000 node, 12,000 edge graph', () => {
  let dir;
  let store;
  beforeAll(() => { dir = tmp('topics-big-'); store = bigStore(dir); });
  afterAll(() => store?.close());
  it('detects in a worker thread off the main thread, and writes the communities with rank', async () => {
    const t0 = performance.now();
    const r = await inWorker(store.path);
    const workerMs = Math.round(performance.now() - t0);
    expect(r.ok).toBe(true);
    const topics = createTopics({ store, run: async () => r });
    const t1 = performance.now();
    await topics.refresh();
    const writeMs = Math.round(performance.now() - t1);
    console.log(`communities on 4,000 nodes / 12,000 edges: worker ${workerMs} ms (read ${r.readMs} ms, detect ${r.ms} ms), naming and writing ${writeMs} ms, ${r.communities.length} communities, modularity ${r.modularity}`);
    expect(r.communities.length).toBeGreaterThan(50);
    expect(r.modularity).toBeGreaterThan(0.5);
    expect(workerMs).toBeLessThan(5000);
    const list = store.communities();
    expect(list[0].rank).toBe(1);
    expect(store.communityMembers(list[0].id)[0].rank).toBe(1);
    expect(store.community(store.communityMembers(list[0].id)[0].node).community).toBe(list[0].id);
  });
  it('answers the same in the worker and in this process', async () => {
    const a = await inWorker(store.path);
    const b = await inProcess(store)();
    expect(b.communities.map((c) => c.id)).toEqual(a.communities.map((c) => c.id));
  });
});

describe('names from the person\'s model', () => {
  const setup = () => {
    const dir = tmp('topics-model-');
    const store = openStore({ dir, vault: path.join(dir, 'v') });
    const g = planted({ groups: 3, size: 8 });
    store.tx(() => { for (const n of g.nodes) store.upsertNode(n); for (const e of g.edges) store.addEdge(e); });
    for (const n of g.nodes) store.upsertFile({ rel: n.rel, hash: `h-${n.rel}` });
    return { store, g };
  };
  it('makes no model call while the switch is off', async () => {
    const { store } = setup();
    const ask = vi.fn();
    const t = createTopics({ store, run: inProcess(store), model: { enabled: () => false, ask, textOf: () => 'text' } });
    await t.refresh();
    expect(ask).not.toHaveBeenCalled();
    expect(store.communities().every((c) => c.namedBy === 'rule')).toBe(true);
    store.close();
  });
  it('estimates first, then names and drafts with one call per summary, keeping the model name while the members hold', async () => {
    const { store, g } = setup();
    let on = false;
    const ask = vi.fn(async (prompt, system) => {
      if (system.startsWith('You name topics')) return JSON.stringify(Object.fromEntries(store.communities().map((c, i) => [c.id, `Topic — ${i}`])));
      return '---\nx: 1\n---\n## Summary\n\nThe group plans the launch [[g0/n1]].';
    });
    const t = createTopics({ store, run: inProcess(store), model: { enabled: () => on, ask, textOf: (rel) => `# ${rel}\n\nBody of ${rel}.` } });
    await t.refresh();
    const est = t.estimate();
    expect(est).toMatchObject({ names: 3, summaries: 3, calls: 4 });
    expect(est.costLabel).toMatch(/at API rates/);
    on = true;
    await t.modelPass();
    expect(ask).toHaveBeenCalledTimes(4);
    const list = store.communities();
    expect(list.every((c) => c.namedBy === 'model')).toBe(true);
    expect(list[0].name).toBe('Topic, 0');
    expect(list[0].props.draft.text).toBe('## Summary\n\nThe group plans the launch [[g0/n1]].');
    expect(list[0].props.draft.sig).toBe(list[0].props.sourceSig);
    expect(t.estimate().calls).toBe(0);
    // detection again with the same graph keeps the names; a changed note changes the draft's sources
    await t.refresh();
    expect(store.communities().every((c) => c.namedBy === 'model')).toBe(true);
    store.upsertFile({ rel: g.nodes[0].rel, hash: 'changed' });
    on = false;
    await t.refresh();
    const first = store.communities().find((c) => store.communityMembers(c.id).some((m) => m.node === g.nodes[0].id));
    expect(first.props.draft.sig).not.toBe(first.props.sourceSig);
    store.close();
  });
  it('cleans what the model writes', () => {
    expect(cleanName('"Launch plan."\n')).toBe('Launch plan');
    expect(cleanDraft('```markdown\n## Summary\n\nA — B\n```')).toBe('## Summary\n\nA, B');
  });
});

// the communities and hubs tools on the real graph over a generated vault
describe('the communities and hubs tools', () => {
  let g;
  let handler;
  let excluded = () => false;
  beforeAll(async () => {
    const root = tmp('topics-tools-');
    const vault = path.join(root, 'v');
    writeGraphVault(vault, { notes: 150, people: 16, projects: 5, companies: 3, meetings: 40, padWords: 8 });
    const ix = createVaultIndex({ vault, isExcludedPath: () => false, isExcludedText: () => false, redact: (t) => t, onChange: () => {} });
    ix.sync();
    g = createMemoryGraph({ dataDir: path.join(root, 'data'), vault, vindex: ix, isExcluded: () => false });
    await g.build();
    await createTopics({ store: g.store, run: inProcess(g.store) }).refresh();
    const fns = {
      'memory-graph-communities': (a) => g.communities(a),
      'memory-graph-hubs': (a) => g.hubs(a),
      'memory-graph-explain': (a) => g.explain(a.id, a),
      'memory-graph-entity': (a) => g.entity(a.name, a),
    };
    handler = (h) => fns[h] ?? null;
  });
  afterAll(() => g?.close());
  const tool = async (name, args, budget = 1500) => formatMemory(name, await runMemoryTool(name, { ...args, budget }, { handler, isExcluded: (t) => excluded(t) }), { budget, args });

  it('are listed, read only, with budget, and described in about', () => {
    for (const name of ['communities', 'hubs']) {
      const t = MEMORY_TOOLS.find((x) => x.name === name);
      expect(t.inputSchema.properties.budget).toBeTruthy();
      expect(TOOL_USE[name].useWhen).toBeTruthy();
    }
  });
  it('lists communities biggest first with name, size, hub and members, within the budget', async () => {
    const lines = await tool('communities', {}, 400);
    expect(lines[0]).toMatch(/^Communities found \d{4}-\d{2}-\d{2}, modularity/);
    expect(lines[1]).toMatch(/^c:\S+ {2}.+ {2}\(\d+ members\) {2}hub \S+ \d+ neighbors/);
    expect(lines.slice(0, -1).reduce((s, l) => s + tokens(l) + 1, 0)).toBeLessThanOrEqual(400);
    expect(lines.at(-1)).toMatch(/^Left out \d+ of \d+ topics .*budget [\d,]+ returns everything/);
  });
  it('shows one community\'s members by id, by name, or by a node in it', async () => {
    const first = g.communities({}).communities[0];
    const byId = await tool('communities', { id: first.id });
    expect(byId[0]).toContain(first.id);
    expect(byId[1]).toMatch(/neighbors.*rank 1\.00/);
    const byNode = await tool('communities', { id: first.hub.id });
    expect(byNode[0]).toBe(byId[0]);
    expect(await tool('communities', { id: 'nothing like this' })).toEqual(['No node named "nothing like this". Try search, or graph_query with other words.']);
  });
  it('lists hubs with counts, overall and in one community, leaving out tags and folders', async () => {
    const all = await tool('hubs', {});
    expect(all[0]).toMatch(/\d+ neighbors, \d+ edges {2}in c:/);
    expect(all.some((l) => /^(tag|folder):/.test(l))).toBe(false);
    const first = g.communities({}).communities[0];
    const one = await tool('hubs', { community: first.id });
    expect(one[0]).toBe(`Hubs of ${first.id}  ${first.name}`);
    expect(g.hubs({ community: first.id }).hubs.every((h) => h.community === first.id)).toBe(true);
  });
  it('shows a node\'s community in explain and entity', async () => {
    const proj = g.store.nodes({ kind: 'project' }).find((n) => g.store.community(n.id));
    const ex = await tool('explain', { id: proj.id });
    expect(ex.find((l) => l.startsWith('community: '))).toMatch(/^community: c:\S+ {2}\S/);
    const en = await tool('entity', { name: proj.id });
    expect(en[1]).toMatch(/^community: c:/);
  });
  it('withholds communities and hubs that name an opted-out customer', async () => {
    const first = g.communities({}).communities[0];
    excluded = (t) => t.includes(first.hub.name);
    try {
      expect((await tool('communities', {}, 50000)).some((l) => l.startsWith(`${first.id} `))).toBe(false);
      expect((await tool('hubs', {}, 50000)).some((l) => l.includes(first.hub.id))).toBe(false);
      await expect(runMemoryTool('communities', { id: first.id }, { handler, isExcluded: excluded })).rejects.toThrow(/withheld/);
      // a member that does not name the customer keeps its answer, with its community blanked
      const other = g.store.communityMembers(first.id).map((m) => m.node).find((id) => !g.store.node(id)?.name?.includes(first.hub.name) && !id.includes(first.hub.id.split(':')[1]));
      const ex = await tool('explain', { id: other }, 50000);
      expect(ex[0]).toContain(other);
      expect(ex.some((l) => l.startsWith('community: '))).toBe(false);
    } finally { excluded = () => false; }
  });
});

// a graph view for the rule, as rules/entities.js ruleGraph gives it
function ruleView(communities, nodes) {
  return { communities: () => communities, node: (id) => nodes.get(id) ?? null };
}
const note = (rel, text, props = {}, title = null) => ({ rel, text, chars: text.length, mtime: 1, note: { props, title: title ?? rel.split('/').pop().replace(/\.md$/, '') } });

describe('topic summaries', () => {
  const rels = Array.from({ length: 6 }, (_, i) => `projects/orca/n${i}.md`);
  const nodes = new Map([
    ['project:orca', { id: 'project:orca', kind: 'project', name: 'Orca', rel: 'projects/Orca.md' }],
    ['person:jane-doe', { id: 'person:jane-doe', kind: 'person', name: 'Jane Doe', rel: null }],
    ['decision:projects/orca/n1.md#3', { id: 'decision:projects/orca/n1.md#3', kind: 'decision', name: 'Ship in May', rel: 'projects/orca/n1.md', props: { text: 'Ship in May', date: Date.UTC(2026, 4, 1) } }],
    ...rels.map((r) => [`note:${r}`, { id: `note:${r}`, kind: 'note', name: r, rel: r }]),
  ]);
  const community = (props = {}) => ({ id: 'c:project:orca', name: 'Orca', namedBy: 'rule', size: 9, rank: 1, hub: 'project:orca', props: { sourceSig: 's1', ...props }, members: [...nodes.keys()].map((id, i) => ({ node: id, rank: 1 - i / 10 })) });
  const notes = () => [note('projects/Orca.md', '# Orca\n\nOrca is the new mobile app.\n'), ...rels.map((r, i) => note(r, `---\ntype: note\n---\n# N${i}\n\nNote ${i} covers the plan. More text.\n`))];

  it('offers a summary in the Quorum folder, marked as Quorum\'s, citing every source', () => {
    const [f] = topicRule({ notes: notes(), graph: ruleView([community()], nodes), learned: 'Quorum/learned-facts.md', now: Date.UTC(2026, 10, 20) });
    expect(f.title).toBe('Write a summary of “Orca”');
    const o = f.fix.ops[0];
    expect(o).toMatchObject({ op: 'summary', rel: 'Quorum/Topics/Orca.md', folder: 'Quorum/Topics', community: 'c:project:orca' });
    expect(o.text).toMatch(/^---\ntype: summary\nquorum: generated\ncommunity: "c:project:orca"\ngenerated_by: rule\nupdated: 2026-11-20\n/);
    for (const r of ['projects/Orca.md', ...rels]) expect(o.text).toContain(`[[${r.replace(/\.md$/, '')}`);
    expect(o.text).toContain('- 2026-05-01: Ship in May ([[projects/orca/n1]])');
    expect(o.text).toContain('Note 0 covers the plan.');
    expect(o.text).not.toMatch(/—/);
    expect(itemLine({ ops: f.fix.ops, kind: 'finding' })).toBe('Write the topic summary “Quorum/Topics/Orca.md”');
  });
  it('uses the model\'s draft only when it was written from the sources as they read now', () => {
    const draft = { sig: 's1', text: '## Summary\n\nOrca ships in May [[projects/orca/n1]].' };
    const [f] = topicRule({ notes: notes(), graph: ruleView([community({ draft })], nodes), learned: 'Quorum/learned-facts.md' });
    expect(f.fix.ops[0].text).toContain('generated_by: model');
    expect(f.fix.ops[0].text).toContain('Orca ships in May');
    const [old] = topicRule({ notes: notes(), graph: ruleView([community({ draft: { ...draft, sig: 'old' } })], nodes), learned: 'Quorum/learned-facts.md' });
    expect(old.fix.ops[0].text).toContain('generated_by: rule');
  });
  it('skips small communities and a community whose summary is written and current', () => {
    const small = { ...community(), members: community().members.slice(0, MIN_NOTES - 1) };
    expect(topicRule({ notes: notes(), graph: ruleView([small], nodes) })).toEqual([]);
    const [f] = topicRule({ notes: notes(), graph: ruleView([community()], nodes), learned: 'Quorum/learned-facts.md' });
    const written = note('Quorum/Topics/Orca.md', f.fix.ops[0].text, { quorum: 'generated', community: 'c:project:orca', source_hashes: f.fix.ops[0].text.match(/source_hashes: \[(.*)\]/)[1].split(', ').map((x) => JSON.parse(x)), type: 'summary', summary_of: ['[[projects/Orca]]'] });
    expect(topicRule({ notes: [...notes(), written], graph: ruleView([community()], nodes), learned: 'Quorum/learned-facts.md' })).toEqual([]);
    // the stale summary rule leaves Quorum's own summaries to this rule
    expect(summaryRule({ notes: [...notes(), written], resolve: (s) => `${s}.md` })).toEqual([]);
    // two of seven sources changed: under the share, no item; three changed: a refresh of Quorum's note only
    const edit = (n) => notes().map((x, i) => (i > 0 && i <= n ? note(x.rel, `${x.text}\nEdited.\n`) : x));
    expect(topicRule({ notes: [...edit(2), written], graph: ruleView([community()], nodes), learned: 'Quorum/learned-facts.md' })).toEqual([]);
    const [r] = topicRule({ notes: [...edit(3), written], graph: ruleView([community()], nodes), learned: 'Quorum/learned-facts.md' });
    expect(r.key).toBe('note.topic-summary:refresh:c:project:orca');
    expect(r.fix.ops[0]).toMatchObject({ op: 'summary', rel: 'Quorum/Topics/Orca.md', replace: true });
  });
  it('helpers: a safe file name and a note\'s first sentence', () => {
    expect(topicFile('a/b: c?')).toBe('a b c');
    expect(firstLine('---\nx: 1\n---\n# T\n\n- [[link]]\n- First line here. Second.')).toBe('First line here.');
  });
});

describe('the summary step on Approve', () => {
  const run = (vault, o) => runSetupOp({}, o, { step: async () => {}, keep: () => {}, vault }, { vindex: { sync: () => {}, rels: () => [] } });
  it('is a setup op that writes only in the Quorum folder', async () => {
    expect(SETUP_OPS.has('summary')).toBe(true);
    const vault = tmp('topics-op-');
    await run(vault, { op: 'summary', rel: 'Quorum/Topics/Orca.md', folder: 'Quorum/Topics', text: '---\nquorum: generated\n---\n# Orca\n' });
    expect(readFileSync(path.join(vault, 'Quorum/Topics/Orca.md'), 'utf8')).toContain('quorum: generated');
    await expect(run(vault, { op: 'summary', rel: 'notes/Orca.md', folder: 'Quorum/Topics', text: 'x' })).rejects.toThrow(/outside the Quorum folder/);
    expect(existsSync(path.join(vault, 'notes/Orca.md'))).toBe(false);
    await expect(run(vault, { op: 'summary', rel: 'Quorum/Topics/../../x.md', folder: 'Quorum/Topics', text: 'x' })).rejects.toThrow(/outside/);
  });
  it('writes over a summary Quorum wrote, never over a note of the person\'s', async () => {
    const vault = tmp('topics-op2-');
    mkdirSync(path.join(vault, 'Quorum/Topics'), { recursive: true });
    writeFileSync(path.join(vault, 'Quorum/Topics/Orca.md'), '---\nquorum: generated\n---\n# Orca\nold\n');
    writeFileSync(path.join(vault, 'Quorum/Topics/Mine.md'), '# Mine\nmy words\n');
    await run(vault, { op: 'summary', rel: 'Quorum/Topics/Orca.md', folder: 'Quorum/Topics', replace: true, text: '---\nquorum: generated\n---\n# Orca\nnew\n' });
    expect(readFileSync(path.join(vault, 'Quorum/Topics/Orca.md'), 'utf8')).toContain('new');
    await expect(run(vault, { op: 'summary', rel: 'Quorum/Topics/Mine.md', folder: 'Quorum/Topics', replace: true, text: 'x' })).rejects.toThrow(/a note of yours/);
    await expect(run(vault, { op: 'summary', rel: 'Quorum/Topics/Orca.md', folder: 'Quorum/Topics', text: 'x' })).rejects.toThrow(/already/);
    expect(readFileSync(path.join(vault, 'Quorum/Topics/Mine.md'), 'utf8')).toBe('# Mine\nmy words\n');
  });
});

// the review findings on #205: read guards, the Quorum folder, races, retries, lasting ids and the worker fallback
describe('topics never name, quote or send a confidential or read-guarded note', () => {
  it('the model never gets their names or text, and the rule name skips them', async () => {
    const dir = tmp('topics-guard-');
    const store = openStore({ dir, vault: path.join(dir, 'v') });
    const g = planted({ groups: 2, size: 8 });
    store.tx(() => { for (const n of g.nodes) store.upsertNode(n); for (const e of g.edges) store.addEdge(e); });
    const secret = new Set(g.nodes.filter((n, i) => i % 2 === 0).map((n) => n.rel));
    const prompts = [];
    const ask = vi.fn(async (prompt, system) => { prompts.push(prompt); return system.startsWith('You name') ? '{}' : '## Summary\n\nText.'; });
    const t = createTopics({ store, run: inProcess(store), mayRead: (rel) => !secret.has(rel), model: { enabled: () => true, ask, textOf: (rel) => (secret.has(rel) ? null : `Body of ${rel}`) } });
    await t.refresh();
    await t.modelPass();
    expect(ask).toHaveBeenCalled();
    for (const rel of secret) {
      const name = g.nodes.find((n) => n.rel === rel).name;
      for (const p of prompts) { expect(p).not.toContain(rel.replace(/\.md$/, '')); expect(p).not.toMatch(new RegExp(`\\b${name}\\b`)); }
      for (const c of store.communities()) expect(c.name).not.toMatch(new RegExp(`\\b${name}$`));
    }
    // ids name no note
    for (const c of store.communities()) expect(c.id).toMatch(/^c:[0-9a-f]{10}$/);
    store.close();
  });
  it('a community with no note to show is named by its tag or folder, never by a hidden note', () => {
    expect(nameCommunity({ hub: 'note:secret.md', members: [{ id: 'note:secret.md' }], tags: ['#ops'] }, () => null)).toBe('ops');
    expect(nameCommunity({ hub: 'note:secret.md', members: [{ id: 'note:secret.md' }], tags: [] }, () => null)).toBe('Unnamed topic');
  });
  it('the no-model summary leaves out confidential notes, their decisions and their first lines', () => {
    const rels = Array.from({ length: 7 }, (_, i) => `t/n${i}.md`);
    const nodes = new Map([...rels.map((r) => [`note:${r}`, { id: `note:${r}`, kind: 'note', name: r, rel: r }]), ['decision:t/n0.md#1', { id: 'decision:t/n0.md#1', kind: 'decision', name: 'Buy Acme', rel: 't/n0.md', props: { text: 'Buy Acme' } }]]);
    const community = { id: 'c:abc', name: 'T', size: 8, props: {}, members: [...nodes.keys()].map((id) => ({ node: id, rank: 1 })) };
    const notes = rels.map((r, i) => note(r, `# N${i}\n\n${i === 0 ? 'The secret plan.' : `Plain ${i}.`}\n`, i === 0 ? { confidential: 'true' } : {}));
    const [f] = topicRule({ notes, graph: ruleView([community], nodes), learned: 'Quorum/learned-facts.md' });
    const text = f.fix.ops[0].text;
    expect(text).not.toContain('secret plan');
    expect(text).not.toContain('Buy Acme');
    expect(text).not.toContain('[[t/n0');
    expect(f.notes).not.toContain('t/n0.md');
    // with the frontmatter mark gone the note is a source again; a confidential mark on its folder keeps every note out
    const plain = notes.map((n, i) => (i === 0 ? note(n.rel, n.text) : n));
    expect(topicRule({ notes: plain, graph: ruleView([community], nodes), learned: 'Quorum/learned-facts.md' })[0].fix.ops[0].text).toContain('secret plan');
    expect(topicRule({ notes: plain, folders: { t: 'true' }, graph: ruleView([community], nodes), learned: 'Quorum/learned-facts.md' })).toEqual([]);
  });
});

describe('summary refresh stays in the Quorum Topics folder', () => {
  const rels = Array.from({ length: 6 }, (_, i) => `p/n${i}.md`);
  const nodes = new Map(rels.map((r) => [`note:${r}`, { id: `note:${r}`, kind: 'note', name: r, rel: r }]));
  const community = (id = 'c:abc') => ({ id, name: 'P', size: 6, props: {}, members: [...nodes.keys()].map((n) => ({ node: n, rank: 1 })) });
  const notes = (edited = 0) => rels.map((r, i) => note(r, `# N${i}\n\nLine ${i}.${i < edited ? ' Edited.' : ''}\n`));
  const written = (rel, id = 'c:abc') => {
    const [f] = topicRule({ notes: notes(), graph: ruleView([community(id)], nodes), learned: 'Quorum/learned-facts.md' });
    const hashes = f.fix.ops[0].text.match(/source_hashes: \[(.*)\]/)[1].split(', ').map((x) => JSON.parse(x));
    return note(rel, f.fix.ops[0].text, { quorum: 'generated', community: id, source_hashes: hashes, type: 'summary' });
  };
  it('offers a refresh of the summary in the Topics folder, with the Topics folder on the op', () => {
    const [r] = topicRule({ notes: [...notes(3), written('Quorum/Topics/P.md')], graph: ruleView([community()], nodes), learned: 'Quorum/learned-facts.md' });
    expect(r.fix.ops[0]).toMatchObject({ op: 'summary', rel: 'Quorum/Topics/P.md', folder: 'Quorum/Topics', replace: true });
  });
  it('never refreshes a generated note outside it, and the op refuses one', async () => {
    const items = topicRule({ notes: [...notes(3), written('elsewhere/P.md')], graph: ruleView([community()], nodes), learned: 'Quorum/learned-facts.md' });
    expect(items.some((i) => i.key.includes('refresh'))).toBe(false);
    expect(items.every((i) => i.fix.ops[0].rel.startsWith('Quorum/Topics/'))).toBe(true);
    const vault = tmp('topics-out-');
    mkdirSync(path.join(vault, 'elsewhere'), { recursive: true });
    writeFileSync(path.join(vault, 'elsewhere/P.md'), '---\nquorum: generated\n---\nold\n');
    await expect(runSetupOp({}, { op: 'summary', rel: 'elsewhere/P.md', folder: 'Quorum/Topics', replace: true, text: 'x' }, { step: async () => {}, keep: () => {}, vault }, { vindex: { sync: () => {} } })).rejects.toThrow(/outside the Quorum folder/);
  });
  it('finds a summary whose community took a new id by its sources: no second summary, a refresh that writes the new id', () => {
    const old = written('Quorum/Topics/P.md', 'c:old');
    expect(topicRule({ notes: [...notes(), old], graph: ruleView([community('c:new')], nodes), learned: 'Quorum/learned-facts.md' })).toEqual([]);
    const [r] = topicRule({ notes: [...notes(3), old], graph: ruleView([community('c:new')], nodes), learned: 'Quorum/learned-facts.md' });
    expect(r.fix.ops[0]).toMatchObject({ rel: 'Quorum/Topics/P.md', replace: true, community: 'c:new' });
    expect(r.fix.ops[0].text).toContain('community: "c:new"');
  });
});

describe('topics: lasting ids, races, retries and the worker fallback', () => {
  const seeded = (groups = 3) => {
    const dir = tmp('topics-more-');
    const store = openStore({ dir, vault: path.join(dir, 'v') });
    const g = planted({ groups, size: 8 });
    store.tx(() => { for (const n of g.nodes) store.upsertNode(n); for (const e of g.edges) store.addEdge(e); });
    return { store, g };
  };
  it('keeps a community id when its hub changes and most members stay', () => {
    const prev = [{ id: 'c:keep', members: new Set(['a', 'b', 'c', 'd']) }];
    const [kept, fresh] = stableIds([{ id: 'c:x', hub: 'b', members: [{ id: 'b' }, { id: 'a' }, { id: 'c' }] }, { id: 'c:y', hub: 'z', members: [{ id: 'z' }, { id: 'y' }] }], prev);
    expect(kept.id).toBe('c:keep');
    expect(fresh.id).toMatch(/^c:[0-9a-f]{10}$/);
  });
  it('drops a model name when detection changed the community while the call ran', async () => {
    const { store, g } = seeded();
    let release;
    const gate = new Promise((r) => { release = r; });
    const ask = vi.fn(async () => { await gate; return JSON.stringify(Object.fromEntries(store.communities().map((c) => [c.id, 'Stale name']))); });
    const t = createTopics({ store, run: inProcess(store), model: { enabled: () => false, ask, textOf: () => null } });
    await t.refresh();
    const pass = t.modelPass();
    // the graph changes under the call: a member of every community goes, so each community's strongest members change
    for (let i = 0; i < 3; i++) store.dropNode(g.nodes[i * 8].id);
    await t.refresh();
    release();
    await pass;
    expect(store.communities().some((c) => c.name === 'Stale name')).toBe(false);
    store.close();
  });
  it('asks once per set of members, whatever the answer, and stops at the daily cap', async () => {
    const { store } = seeded(4);
    const ask = vi.fn(async () => 'not json');
    let day = Date.UTC(2026, 10, 20);
    const t = createTopics({ store, run: inProcess(store), now: () => day, cap: () => 1, model: { enabled: () => false, ask, textOf: () => 'text' } });
    await t.refresh();
    await t.modelPass();
    await t.refresh();
    await t.modelPass();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(t.estimate()).toMatchObject({ names: 0, left: 0 });
    // the summaries are still owed but wait for the next day's calls
    day += 86400000;
    expect(t.estimate().left).toBe(1);
    store.close();
  });
  it('falls back to this process when the worker cannot start on a small vault, and skips a large one', async () => {
    const { store } = seeded();
    const broken = async () => { throw new Error('no worker'); };
    const small = createTopics({ store, run: broken });
    expect((await small.refresh()).phase).toBe('ready');
    expect(store.communities().length).toBe(3);
    const large = createTopics({ store, run: broken, maxInProcess: 10 });
    const st = await large.refresh();
    expect(st.phase).toBe('error');
    expect(st.error).toMatch(/skipped for 24 nodes/);
    store.close();
  });
  it('a node that goes leaves its community, and the community it was the hub of goes', async () => {
    const { store } = seeded();
    await createTopics({ store, run: inProcess(store) }).refresh();
    const c = store.communities()[0];
    const before = store.communityMembers(c.id).length;
    const member = store.communityMembers(c.id).find((m) => m.node !== c.hub).node;
    store.dropNode(member);
    expect(store.community(member)).toBeNull();
    expect(store.communityMembers(c.id).length).toBe(before - 1);
    store.dropNode(c.hub);
    expect(store.communityInfo(c.id)).toBeNull();
    expect(store.communityMembers(c.id)).toEqual([]);
    store.close();
  });
  it('the packaged worker path points at the unpacked copy when there is one', () => {
    const root = tmp('topics-asar-');
    const inAsar = path.join(root, 'app.asar', 'graph', 'communityWorker.js');
    expect(workerPath(inAsar)).toBe(inAsar);
    mkdirSync(path.join(root, 'app.asar.unpacked', 'graph'), { recursive: true });
    writeFileSync(path.join(root, 'app.asar.unpacked', 'graph', 'communityWorker.js'), '');
    expect(workerPath(inAsar)).toBe(path.join(root, 'app.asar.unpacked', 'graph', 'communityWorker.js'));
  });
});
