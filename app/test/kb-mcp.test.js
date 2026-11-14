// The quorum MCP server's knowledge base tools (cli/quorum.mjs): kb_search, kb_read and kb_list are listed, and a
// call goes to the running app over its control socket with the arguments as given, so the app answers as the person
// signed in to it. A fake app listens on the socket here; ee/kbSearch.js is tested in kb-search.test.js.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { startControl } from '../control.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'quorum.mjs');
// a short path: a Unix socket path must stay under about 100 characters
const home = mkdtempSync('/tmp/qkb-');
const appDir = path.join(home, 'Library/Application Support/Quorum');
mkdirSync(appDir, { recursive: true });
const seen = [];
const stop = startControl(path.join(appDir, 'quorum.sock'), async ({ cmd, args }) => {
  seen.push({ cmd, args });
  if (cmd === 'kb_search') return { results: [{ noteId: '01KB000000000000000000N001', citation: 'Handbook / Travel policy', snippet: 'Trains for short trips.' }] };
  if (cmd === 'kb_read') throw new Error('No knowledge base note there that you can read.');
  if (cmd === 'ask') return { text: 'Book trains.', steps: [], sources: [
    { n: 1, rel: 'notes/travel.md', title: 'travel', abs: '/v/notes/travel.md', app: 'Vault', url: 'quorum://note/notes%2Ftravel.md' },
    { n: 2, rel: 'Handbook / Policies', title: 'Travel policy', abs: null, app: 'Knowledge', url: 'quorum://kb/01KB00000000000000000000K1/01KB000000000000000000N001', kb: { kbId: '01KB00000000000000000000K1', noteId: '01KB000000000000000000N001' } },
  ] };
  return { kbs: [] };
}, () => {});
afterAll(() => { stop(); rmSync(home, { recursive: true, force: true }); });

// one MCP session: send each request, collect each answer by id
async function session(requests) {
  const proc = spawn(process.execPath, [CLI, 'mcp'], { env: { ...process.env, HOME: home, QUORUM_ENV: '' } });
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

// one CLI command against the fake app; resolves to what it printed
function cli(args) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, HOME: home, QUORUM_ENV: '' } });
    let out = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.on('close', () => resolve(out));
  });
}

describe('quorum ask', () => {
  it('prints a knowledge base source with its title, place, note id and link', async () => {
    expect(await cli(['ask', 'how do I travel'])).toBe([
      'Book trains.', '', '[1] notes/travel.md',
      '[2] Travel policy  (Handbook / Policies)', '    01KB000000000000000000N001', '    quorum://kb/01KB00000000000000000000K1/01KB000000000000000000N001', '',
    ].join('\n'));
  });
});

describe('the knowledge base tools over MCP', () => {
  it('lists the three tools and forwards a call to the running app', async () => {
    const a = await session([
      { id: 1, method: 'initialize', params: { clientInfo: { name: 'Claude Code' } } },
      { id: 2, method: 'tools/list' },
      { id: 3, method: 'tools/call', params: { name: 'kb_search', arguments: { query: 'travel policy', kb: 'Handbook', limit: 3 } } },
      { id: 4, method: 'tools/call', params: { name: 'kb_read', arguments: { path: 'Handbook/Secret' } } },
      { id: 5, method: 'tools/call', params: { name: 'kb_list', arguments: {} } },
    ]);
    const tools = a.get(2).result.tools;
    for (const name of ['kb_search', 'kb_read', 'kb_list']) expect(tools.find((t) => t.name === name)?.inputSchema.type).toBe('object');
    expect(tools.find((t) => t.name === 'kb_search').inputSchema.required).toEqual(['query']);
    expect(JSON.parse(a.get(3).result.content[0].text).results[0].citation).toBe('Handbook / Travel policy');
    expect(a.get(4).result).toEqual({ content: [{ type: 'text', text: 'No knowledge base note there that you can read.' }], isError: true });
    expect(JSON.parse(a.get(5).result.content[0].text)).toEqual({ kbs: [] });
    expect(seen.filter((s) => s.cmd !== 'ask')).toEqual([
      { cmd: 'kb_search', args: { query: 'travel policy', kb: 'Handbook', limit: 3 } },
      { cmd: 'kb_read', args: { path: 'Handbook/Secret' } },
      { cmd: 'kb_list', args: {} },
    ]);
  });
});
