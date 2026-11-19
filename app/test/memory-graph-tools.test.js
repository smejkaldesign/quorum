// The memory tools on the real graph (graph/index.js) over a generated vault: graph-core's answers go through
// runMemoryTool and formatMemory and come out as budgeted lines with source path and line, provenance and dates.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createVaultIndex } from '../vindex.js';
import { createMemoryGraph } from '../graph/index.js';
import { formatMemory, tokens } from '../cli/budget.mjs';
import { runMemoryTool } from '../cli/memoryTools.mjs';
import { writeGraphVault } from './fixtures/graphVault.js';

let root;
let vault;
let g;
// the IPC handlers as main.js registers them, each taking the tool's args as one object
let handler;
beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'memtools-'));
  vault = path.join(root, 'v');
  writeGraphVault(vault, { notes: 200, people: 20, projects: 5, companies: 3, meetings: 40, padWords: 10 });
  const ix = createVaultIndex({ vault, isExcludedPath: () => false, isExcludedText: () => false, redact: (t) => t, onChange: () => {} });
  ix.sync();
  g = createMemoryGraph({ dataDir: path.join(root, 'data'), vault, vindex: ix, isExcluded: () => false });
  await g.build();
  const fns = {
    'memory-graph-status': () => g.status(),
    'memory-graph-query': (a) => g.graphQuery(a),
    'memory-graph-explain': (a) => g.explain(a.id),
    'memory-graph-entity': (a) => g.entity(a.name, a),
    'memory-graph-decisions': (a) => g.decisions(a),
    'memory-graph-path': (a) => g.graphPath(a.a, a.b, a),
  };
  handler = (h) => fns[h] ?? null;
});
afterAll(() => { g?.close(); rmSync(root, { recursive: true, force: true }); });

const tool = async (name, args, budget = 1500) => formatMemory(name, await runMemoryTool(name, { ...args, budget }, { handler }), { budget, args });
const fits = (lines, budget) => lines.slice(0, -1).reduce((s, l) => s + tokens(l) + 1, 0) <= budget;

describe('memory tools on the real graph', () => {
  it('lists the current decision about a project, and its history on request, with the meeting line', async () => {
    const now = await tool('decisions', { about: 'Project A' });
    expect(now).toHaveLength(2);
    const out = await tool('decisions', { about: 'Project A', current: false }, 20000);
    expect(out.length).toBeGreaterThan(2);
    expect(out.some((l) => /superseded by decision:/.test(l))).toBe(true);
    // path:line points at the decision line as an editor numbers it
    const [, rel, n] = now[0].match(/\[(08-meetings\/[^:]+\.md):(\d+)/);
    expect(readFileSync(path.join(vault, rel), 'utf8').split('\n')[Number(n) - 1]).toMatch(/^Decision: /);
    for (const l of out.slice(0, -1)) expect(l).toMatch(/^2026-\d\d-\d\d {2}decision:.* {2}Hosting: option \d.*\[08-meetings\/.*\.md:\d+; (about project:project-a|superseded by decision:)/);
    expect(out.at(-1)).toMatch(/^All \d+ decisions shown/);
  });
  it('trims to the budget and names the budget that returns everything', async () => {
    const out = await tool('graph_query', { q: 'Project A', depth: 2 }, 300);
    expect(fits(out, 300)).toBe(true);
    expect(out.at(-1)).toMatch(/^Left out .* budget [\d,]+ returns everything/);
    expect(out.some((l) => / -\w+-> .*\[(explicit|rule)/.test(l))).toBe(true);
  });
  it('answers entity, explain and path in lines', async () => {
    const ent = await tool('entity', { name: 'Project A' });
    expect(ent[0]).toMatch(/^project:project-a/);
    expect(ent.some((l) => /^(Meetings|Decisions|People) \(\d+ of \d+\):$/.test(l))).toBe(true);
    const ex = await tool('explain', { id: 'project:project-a' });
    expect(ex[0]).toMatch(/^project:project-a/);
    expect(ex.some((l) => /^(Outgoing|Incoming) \(\d+ of \d+\):$/.test(l))).toBe(true);
    const p = await tool('graph_path', { a: 'Ana Ruiz', b: 'Project A' });
    expect(p[0]).toMatch(/^\d+ steps? from person:ana-ruiz to project:project-a:$|^No path/);
    const none = await tool('entity', { name: 'Nobody Here' });
    expect(none).toEqual(['No node named "Nobody Here". Try search, or graph_query with other words.']);
  });
  it('reports the graph in memory_status, with search not ready', async () => {
    const out = formatMemory('memory_status', await runMemoryTool('memory_status', {}, { handler }));
    expect(out).toContain('graph.phase: ready');
    expect(out.some((l) => l.startsWith('search: error'))).toBe(true);
  });
});
