// The about tool of the quorum MCP server (cli/about.mjs): it lists exactly the tools the server lists, each with what
// it returns and when to use it, states the data, graph and search facts, and the instructions point agents to it.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { TOOL_USE } from '../cli/about.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'quorum.mjs');
const homes = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));
function home(settings) {
  const h = mkdtempSync('/tmp/qab-');
  homes.push(h);
  const dir = path.join(h, 'Library/Application Support/Quorum');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings));
  return h;
}

async function session(h, env = {}) {
  const proc = spawn(process.execPath, [CLI, 'mcp'], { env: { ...process.env, HOME: h, QUORUM_ENV: '', QUORUM_MCP_TOOLS: '', ...env } });
  const requests = [
    { id: 1, method: 'initialize', params: {} },
    { id: 2, method: 'tools/list' },
    { id: 3, method: 'tools/call', params: { name: 'about', arguments: {} } },
  ];
  const answers = new Map();
  const done = new Promise((resolve) => {
    createInterface({ input: proc.stdout }).on('line', (line) => {
      const msg = JSON.parse(line);
      answers.set(msg.id, msg);
      if (answers.size === requests.length) resolve();
    });
  });
  for (const r of requests) proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...r })}\n`);
  await done;
  proc.kill();
  return answers;
}

const ALL = { accounts: { slack: { connected: true }, notion: { connected: true }, github: { connected: true } } };

describe('the about tool', () => {
  it('lists every tool the server lists, and every tool it describes is a real tool', async () => {
    const a = await session(home(ALL));
    const listed = a.get(2).result.tools.map((t) => t.name);
    const info = JSON.parse(a.get(3).result.content[0].text);
    expect(info.tools.map((t) => t.name)).toEqual(listed);
    expect(Object.keys(TOOL_USE).sort()).toEqual([...listed].sort());
    for (const t of info.tools) {
      expect(t.returns, t.name).toBeTruthy();
      expect(t.useWhen, t.name).toBeTruthy();
    }
  });
  it('lists only the connected accounts\' tools, the same as tools/list', async () => {
    const a = await session(home({}));
    const listed = a.get(2).result.tools.map((t) => t.name);
    expect(listed).not.toContain('slack_search');
    expect(JSON.parse(a.get(3).result.content[0].text).tools.map((t) => t.name)).toEqual(listed);
  });
  it('answers the graph, search and decision questions as data', async () => {
    const info = JSON.parse((await session(home({}))).get(3).result.content[0].text);
    expect(info.untrusted).toBeUndefined();
    expect(info.graph.typedEntities).toBe(true);
    expect(info.graph.provenance).toMatch(/explicit.*rule.*model.*person/);
    expect(info.search.semantic).toBe(true);
    expect(info.findDecisionsAbout).toMatch(/^For every decision about project X: call decisions with about X/);
    expect(info.data.length).toBeGreaterThan(0);
    expect(info.notFor.length).toBeGreaterThan(0);
  });
  it('is named in the instructions, which state the graph and search facts', async () => {
    const { instructions } = (await session(home({}))).get(1).result;
    expect(instructions).toContain('about tool');
    expect(instructions).toMatch(/knowledge graph/);
    expect(instructions).toMatch(/typed edges, each with provenance/);
    expect(instructions).toMatch(/search is hybrid/);
    expect(instructions).toMatch(/the one call is decisions with about X/);
    expect(instructions).toMatch(/start with entity .*, decisions or search/);
    expect(instructions.length).toBeLessThan(2048);
  });
  it('is not listed for the in-app chat, which gets the connector tools only', async () => {
    const a = await session(home(ALL), { QUORUM_MCP_TOOLS: 'connectors' });
    expect(a.get(2).result.tools.map((t) => t.name)).not.toContain('about');
  });
});
