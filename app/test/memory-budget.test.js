// The memory tools' budgets and formatting (cli/budget.mjs) and the app side that runs them (cli/memoryTools.mjs): one
// line per node, edge or passage with source and dates, strongest first, trimmed to the budget, a last line that says
// what was left out, candidates for an ambiguous name, and withheld notes and lines taken out.
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { budgetOf, day, decisionLine, edgeLine, fit, formatMemory, passageLine, tokens } from '../cli/budget.mjs';
import { DEFAULT_BUDGET, MEMORY_TOOLS, NOT_READY, runMemoryTool, withhold } from '../cli/memoryTools.mjs';

const line = (i, len = 200) => ({ text: `${String(i).padStart(3, '0')} ${'x'.repeat(len)}`, noun: 'passage' });

describe('fit', () => {
  it('keeps the strongest lines that fit and says what a larger budget returns', () => {
    const items = Array.from({ length: 40 }, (_, i) => line(i));
    const out = fit({ items, budget: 500, noun: 'passage' });
    const body = out.slice(0, -1);
    expect(body[0]).toMatch(/^000 /);
    expect(body.map((l) => l.slice(0, 3))).toEqual(body.map((_, i) => String(i).padStart(3, '0')));
    expect(body.reduce((s, l) => s + tokens(l) + 1, 0)).toBeLessThanOrEqual(500);
    const shown = body.length;
    const all = items.reduce((s, it) => s + tokens(it.text) + 1, 0);
    expect(out.at(-1)).toBe(`Left out ${40 - shown} of 40 passages (about ${(all - body.reduce((s, l) => s + tokens(l) + 1, 0)).toLocaleString('en-US')} tokens). budget ${(Math.ceil(all / 100) * 100).toLocaleString('en-US')} returns everything; or ask a narrower question.`);
    const again = fit({ items, budget: Math.ceil(all / 100) * 100, noun: 'passage' });
    expect(again).toHaveLength(41);
    expect(again.at(-1)).toMatch(/^All 40 passages shown/);
  });
  it('never puts a weaker line ahead of a stronger one that did not fit', () => {
    const out = fit({ items: [line(0, 100), line(1, 3000), line(2, 10)], budget: 200, noun: 'passage' });
    expect(out.slice(0, -1).map((l) => l.slice(0, 3))).toEqual(['000']);
    expect(out.at(-1)).toMatch(/^Left out 2 of 3 passages/);
  });
  it('counts what the handler already left out', () => {
    const out = fit({ items: [line(0, 40)], budget: 1500, upstream: { shown: 1, total: 11, budgetNeeded: 9000 }, noun: 'passage' });
    expect(out.at(-1)).toMatch(/^Left out 10 of 11 passages .* budget 9,000 returns everything/);
  });
  it('lets each group keep its strongest lines', () => {
    const groups = [
      { title: 'Decisions', items: Array.from({ length: 20 }, (_, i) => ({ text: `d${i} ${'y'.repeat(120)}`, noun: 'decision' })) },
      { title: 'Meetings', items: [{ text: 'm0', noun: 'meeting' }, { text: 'm1', noun: 'meeting' }] },
    ];
    const out = fit({ head: ['project:atlas'], groups, budget: 300 });
    expect(out[0]).toBe('project:atlas');
    expect(out).toContain('  m0');
    expect(out).toContain('  m1');
    expect(out.find((l) => l.startsWith('Decisions ('))).toMatch(/^Decisions \(\d+ of 20\):$/);
    expect(out.at(-1)).toMatch(/^Left out \d+ of 20 decisions/);
  });
  it('clamps the budget and defaults to 1,500 tokens', () => {
    expect(budgetOf(undefined)).toBe(DEFAULT_BUDGET);
    expect(budgetOf('abc')).toBe(1500);
    expect(budgetOf(5)).toBe(100);
    expect(budgetOf(1e9)).toBe(50000);
  });
});

describe('lines', () => {
  it('give an edge its provenance, source line, dates and supersession', () => {
    expect(edgeLine({ src: 'person:jane', dst: 'project:atlas', kind: 'works_on', provenance: 'explicit', source_rel: 'people/Jane.md', source_line: 4, valid_from: 1767225600, valid_to: 1772323200000, superseded_by: 9 }))
      .toBe('person:jane -works_on-> project:atlas  [explicit, people/Jane.md:4, 2026-01-01..2026-03-01, superseded by edge 9]');
    expect(edgeLine({ src: 'a', dst: 'b', kind: 'mentions', provenance: 'model', confidence: 0.6 })).toBe('a -mentions-> b  [model, confidence 0.60]');
  });
  it('give a passage its path, lines and heading, on one line', () => {
    expect(passageLine({ rel: 'notes/a.md', startLine: 3, endLine: 9, heading: 'Plan > Q1', score: 0.5, text: 'one\n\ntwo' })).toBe('notes/a.md:3-9  # Plan > Q1  (0.500)  one two');
  });
  it('give a decision its date, source, subject and what replaced it', () => {
    expect(decisionLine({ id: 'decision:a', text: 'Ship in March', rel: 'meetings/m.md', line: 12, date: '2026-02-02T10:00:00Z', about: ['project:atlas'], superseded_by: 'decision:b' }))
      .toBe('2026-02-02  decision:a  Ship in March  [meetings/m.md:12; about project:atlas; superseded by decision:b]');
  });
  it('read dates in seconds, milliseconds and ISO', () => {
    expect([day(1767225600), day(1767225600000), day('2026-01-01'), day('nope'), day(null)]).toEqual(['2026-01-01', '2026-01-01', '2026-01-01', null, null]);
  });
});

describe('formatMemory', () => {
  it('returns the candidates for an ambiguous name and never guesses', () => {
    const out = formatMemory('entity', { ambiguous: [{ id: 'person:alex-kim', name: 'Alex Kim', rel: 'people/Alex Kim.md' }, { id: 'person:alex-ng', name: 'Alex Ng' }] }, { args: { name: 'Alex' } });
    expect(out).toEqual(['"Alex" matches 2 nodes. Call again with one id:', '  person:alex-kim  Alex Kim  (people/Alex Kim.md)', '  person:alex-ng  Alex Ng']);
  });
  it('puts each graph edge under the strongest of its ends', () => {
    const out = formatMemory('graph_query', {
      nodes: [{ id: 'project:atlas', name: 'Atlas' }, { id: 'person:jane', name: 'Jane' }],
      edges: [{ src: 'person:jane', dst: 'project:atlas', kind: 'works_on', provenance: 'explicit' }, { src: 'person:jane', dst: 'topic:x', kind: 'about', provenance: 'rule' }],
    });
    expect(out).toEqual([
      'project:atlas  Atlas',
      '  person:jane -works_on-> project:atlas  [explicit]',
      'person:jane  Jane',
      '  person:jane -about-> topic:x  [rule]',
      expect.stringMatching(/^All 2 nodes and 2 edges shown/),
    ]);
  });
  it('formats graph-core\'s explain, entity, path and decisions answers', () => {
    const edge = { id: 3, src: 'person:ana-ruiz', dst: 'project:atlas', kind: 'works_on', provenance: 'explicit', source_rel: 'people/Ana Ruiz.md', source_line: 5, valid_from: 1767225600000, valid_to: null, superseded_by: null };
    expect(formatMemory('explain', { node: { id: 'person:ana-ruiz', kind: 'person', name: 'Ana Ruiz', rel: 'people/Ana Ruiz.md' }, source: { rel: 'people/Ana Ruiz.md' }, aliases: ['ana'], community: null, out: [edge], in: [], history: [] }))
      .toEqual(['person:ana-ruiz  Ana Ruiz  (people/Ana Ruiz.md)', 'source: people/Ana Ruiz.md', 'aliases: ana', 'Outgoing (1 of 1):', `  ${edgeLine(edge)}`, expect.stringMatching(/^All 1 edge shown/)]);
    const ent = formatMemory('entity', { node: { id: 'project:atlas', name: 'Atlas' }, rel: 'projects/Atlas.md', meetings: [{ id: 'meeting:meetings/m.md', name: 'Kickoff', rel: 'meetings/m.md' }], decisions: [], notes: [], people: [{ id: 'person:ana-ruiz', name: 'Ana Ruiz' }], projects: [{ id: 'project:beacon', name: 'Beacon' }], truncated: { shown: 3, total: 3, budgetNeeded: 200 } });
    expect(ent).toEqual(['project:atlas  Atlas  (projects/Atlas.md)', 'Meetings (1 of 1):', '  meeting:meetings/m.md  Kickoff', 'People (1 of 1):', '  person:ana-ruiz  Ana Ruiz', 'Projects (1 of 1):', '  project:beacon  Beacon', expect.stringMatching(/^All 1 meeting and 1 person and 1 project shown/)]);
    expect(formatMemory('graph_path', { path: [{ id: 'person:ana-ruiz' }, { id: 'project:atlas' }], edges: [edge] })).toEqual(['1 step from person:ana-ruiz to project:atlas:', edgeLine(edge), expect.stringMatching(/^All 1 edge shown/)]);
    expect(formatMemory('graph_path', { path: null, edges: [] }, { args: { a: 'Ana', b: 'Zed' } })).toEqual(['No path between Ana and Zed.']);
    expect(formatMemory('decisions', { about: { id: 'project:atlas' }, decisions: [{ id: 'decision:meetings/m.md#ab12cd34', text: 'Ship in March', date: 1770000000000, rel: 'meetings/m.md', line: 9, about: [{ id: 'project:atlas', name: 'Atlas' }], decidedIn: 'meeting:meetings/m.md', supersededBy: null }] })[0])
      .toBe('2026-02-02  decision:meetings/m.md#ab12cd34  Ship in March  [meetings/m.md:9; about project:atlas]');
    expect(formatMemory('entity', { notFound: 'Zed' })).toEqual(['No node named "Zed". Try search, or graph_query with other words.']);
  });
  it('follows graph-core\'s final shapes: superseding edges as objects, path ambiguity, edges left out', () => {
    expect(edgeLine({ src: 'a', dst: 'b', kind: 'works_on', provenance: 'explicit', superseded_by: 7, supersededBy: { id: 7 } })).toBe('a -works_on-> b  [explicit, superseded by edge 7]');
    expect(formatMemory('graph_path', { ambiguous: [{ id: 'person:alex-kim' }, { id: 'person:alex-ng' }], for: 'b' }, { args: { a: 'Atlas', b: 'Alex' } })[0]).toBe('"Alex" matches 2 nodes. Call again with one id:');
    const out = formatMemory('graph_query', { nodes: [{ id: 'project:atlas' }], edges: [], truncated: { shown: 1, total: 1, budgetNeeded: 2000, edgesShown: 0, edgesTotal: 12 } });
    expect(out.at(-1)).toMatch(/^Left out 12 of 12 edges/);
  });
  it('says when nothing matched', () => {
    expect(formatMemory('decisions', { decisions: [] })).toEqual(['Nothing found.']);
    expect(formatMemory('graph_path', { found: false }, { args: { a: 'x', b: 'y' } })).toEqual(['No path between x and y.']);
  });
});

describe('runMemoryTool', () => {
  const vault = mkdtempSync('/tmp/qmb-');
  afterAll(() => rmSync(vault, { recursive: true, force: true }));
  // a generated vault: 300 notes, some in a withheld folder, some naming an opted-out customer
  for (const dir of ['projects', 'private', 'meetings']) mkdirSync(path.join(vault, dir));
  for (let i = 0; i < 300; i += 1) {
    const dir = i % 10 === 0 ? 'private' : i % 3 ? 'projects' : 'meetings';
    const customer = i % 7 === 0 ? 'Acme Corp renewal is at risk.\n' : '';
    writeFileSync(path.join(vault, dir, `note ${i}.md`), `# Note ${i}\n\nAtlas launch plan, part ${i}.\n${customer}Decision: keep Atlas on track ${i}.\n`);
  }
  // a stand-in for the search handler: every note that mentions the query, one passage per note
  const searchHandler = ({ q }) => ({
    results: readdirSync(vault).flatMap((dir) => readdirSync(path.join(vault, dir)).map((f) => `${dir}/${f}`))
      .map((rel) => ({ rel, text: readFileSync(path.join(vault, rel), 'utf8') }))
      .filter((c) => c.text.toLowerCase().includes(String(q).toLowerCase()))
      .map((c, i) => ({ rel: c.rel, heading: c.text.split('\n')[0].slice(2), start_line: 1, end_line: 5, text: c.text, score: 1 / (i + 1) })),
  });
  const filters = { withheld: (rel) => rel.startsWith('private/'), isExcluded: (t) => /acme/i.test(t), redact: (t) => t.split('\n').map((l) => (/acme/i.test(l) ? '[withheld: opted-out customer]' : l)).join('\n') };
  const handler = (h) => ({ 'memory-search': searchHandler, 'memory-graph-entity': () => ({ node: { id: 'company:acme', name: 'Acme Corp' } }) }[h] ?? null);

  it('withholds notes and lines, then fits the budget', async () => {
    const r = await runMemoryTool('search', { q: 'atlas', budget: 1500 }, { handler, ...filters });
    expect(r.results.length).toBe(270);
    expect(r.results.some((c) => c.rel.startsWith('private/'))).toBe(false);
    expect(r.results.some((c) => /acme/i.test(c.text))).toBe(false);
    expect(r.results.filter((c) => c.text.includes('[withheld: opted-out customer]')).length).toBeGreaterThan(0);
    const out = formatMemory('search', r, { budget: 1500 });
    expect(out.slice(0, -1).reduce((s, l) => s + tokens(l) + 1, 0)).toBeLessThanOrEqual(1500);
    expect(out.at(-1)).toMatch(/^Left out \d+ of 270 passages/);
  });
  it('refuses a withheld entity, and says the index is not ready when nothing is registered', async () => {
    await expect(runMemoryTool('entity', { name: 'Acme' }, { handler, ...filters })).rejects.toThrow('That note is withheld.');
    await expect(runMemoryTool('decisions', {}, { handler, ...filters })).rejects.toThrow(NOT_READY);
    await expect(runMemoryTool('memory_status', {}, { handler, ...filters })).rejects.toThrow(NOT_READY);
    await expect(runMemoryTool('nope', {}, { handler, ...filters })).rejects.toThrow('Unknown memory tool nope');
    await expect(runMemoryTool('decisions', {}, { handler: () => () => null, ...filters })).rejects.toThrow(NOT_READY);
  });
  it('answers memory_status with whatever part is ready', async () => {
    const r = await runMemoryTool('memory_status', {}, { handler: (h) => (h === 'memory-search-status' ? () => ({ chunks: 4000, embedded: 1200 }) : null), ...filters });
    expect(r).toEqual({ graph: { error: NOT_READY }, search: { chunks: 4000, embedded: 1200 } });
    const all = await runMemoryTool('memory_status', {}, { handler: (h) => () => ({ 'memory-graph-status': { phase: 'ready', nodes: 10 }, 'memory-search-status': { chunks: 4 }, 'memory-setup-status': { phase: 'done', gaps: 3 } }[h]), ...filters });
    expect(all).toEqual({ graph: { phase: 'ready', nodes: 10 }, search: { chunks: 4 }, setup: { phase: 'done', gaps: 3 } });
    expect(formatMemory('memory_status', r)).toEqual([`graph: error ${NOT_READY}`, 'search: chunks 4,000, embedded 1,200']);
  });
  it('calls each graph handler with the tool\'s args as one object', async () => {
    const seen = [];
    const rec = (h) => (...a) => { seen.push([h, a]); return {}; };
    for (const [name, args] of [['explain', { id: 'person:ana', budget: 1500 }], ['entity', { name: 'Ana', budget: 900 }], ['graph_path', { a: 'Ana', b: 'Atlas', budget: 1500 }]]) {
      await runMemoryTool(name, args, { handler: rec, ...filters });
    }
    expect(seen).toEqual([
      ['memory-graph-explain', [{ id: 'person:ana', budget: 1500 }]],
      ['memory-graph-entity', [{ name: 'Ana', budget: 900 }]],
      ['memory-graph-path', [{ a: 'Ana', b: 'Atlas', budget: 1500 }]],
    ]);
  });
  it('names a handler for every tool', () => {
    for (const t of MEMORY_TOOLS) expect(t.handler, t.name).toMatch(/^memory-(graph|search)/);
    expect(withhold({ a: [{ rel: 'private/x.md' }, { rel: 'ok.md' }] }, filters)).toEqual({ a: [{ rel: 'ok.md' }] });
  });
});

describe('fromActionHandlers', () => {
  it('passes the tool\'s args to the registered handler as one object, with no IPC event', async () => {
    const seen = [];
    const handlers = new Map([['memory-graph-path', async (e, ...a) => { seen.push([e, ...a]); return { path: [], edges: [] }; }]]);
    const { fromActionHandlers } = await import('../cli/memoryTools.mjs');
    await runMemoryTool('graph_path', { a: 'Ada', b: 'Atlas', undirected: true }, { handler: fromActionHandlers(handlers), withheld: () => false, isExcluded: () => false, redact: (t) => t }).catch(() => null);
    expect(seen[0]).toEqual([null, { a: 'Ada', b: 'Atlas', undirected: true }]);
  });
  it('answers null for a handler that is not registered', async () => {
    const { fromActionHandlers } = await import('../cli/memoryTools.mjs');
    expect(fromActionHandlers(new Map())('memory-search')).toBe(null);
  });
});
