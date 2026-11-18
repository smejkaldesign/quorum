// The connector read tools in the quorum MCP server (cli/quorum.mjs): listed only for the accounts settings.json says
// are connected, forwarded to the running app over its control socket with the MCP client's name, a plain answer when
// the account is not connected or the app is closed, and the chat's connectors-only mode. A fake app listens here.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { startControl } from '../control.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'quorum.mjs');
const homes = [];
function home(accounts, { app = true } = {}) {
  // a short path: a Unix socket path must stay under about 100 characters
  const h = mkdtempSync('/tmp/qcn-');
  homes.push(h);
  const dir = path.join(h, 'Library/Application Support/Quorum');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ accounts }));
  const seen = [];
  const stop = app ? startControl(path.join(dir, 'quorum.sock'), async ({ cmd, args }) => {
    seen.push({ cmd, args });
    if (args?.name === 'slack_thread') throw new Error('That Slack thread was not found.');
    return { results: [{ text: 'hello' }] };
  }, () => {}) : () => {};
  return { h, seen, stop };
}
const stops = [];
afterAll(() => { stops.forEach((s) => s()); homes.forEach((h) => rmSync(h, { recursive: true, force: true })); });

async function session(h, requests, env = {}) {
  const proc = spawn(process.execPath, [CLI, 'mcp'], { env: { ...process.env, HOME: h, QUORUM_ENV: '', QUORUM_MCP_TOOLS: '', ...env } });
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
const names = (a, id) => a.get(id).result.tools.map((t) => t.name);

describe('connector tools over MCP', () => {
  it('lists no connector tools with nothing connected, and a call says how to connect', async () => {
    const { h, seen, stop } = home({ slack: null });
    stops.push(stop);
    const a = await session(h, [{ id: 1, method: 'tools/list' }, { id: 2, method: 'tools/call', params: { name: 'slack_search', arguments: { query: 'x' } } }]);
    expect(names(a, 1).filter((n) => /^(slack|notion|github)_/.test(n))).toEqual([]);
    expect(names(a, 1)).toContain('search_meetings');
    expect(a.get(2).result.isError).toBe(true);
    expect(a.get(2).result.content[0].text).toContain('Slack is not connected in Quorum');
    expect(seen).toEqual([]);
  });
  it('lists a connected account\'s tools and forwards a call to the app with the client\'s name', async () => {
    const { h, seen, stop } = home({ slack: { connected: true, account: 'Acme' }, github: { connected: false } });
    stops.push(stop);
    const a = await session(h, [
      { id: 1, method: 'initialize', params: { clientInfo: { name: 'Claude Code' } } },
      { id: 2, method: 'tools/list' },
      { id: 3, method: 'tools/call', params: { name: 'slack_search', arguments: { query: 'roadmap', limit: 5 } } },
      { id: 4, method: 'tools/call', params: { name: 'slack_thread', arguments: { channel: 'C1', ts: '1.1' } } },
      { id: 5, method: 'tools/call', params: { name: 'github_repos', arguments: {} } },
    ]);
    const listed = names(a, 2).filter((n) => /^(slack|notion|github)_/.test(n));
    expect(listed).toEqual(['slack_search', 'slack_channels', 'slack_channel_history', 'slack_thread']);
    expect(a.get(2).result.tools.find((t) => t.name === 'slack_search').inputSchema.required).toEqual(['query']);
    expect(JSON.parse(a.get(3).result.content[0].text)).toEqual({ results: [{ text: 'hello' }] });
    expect(seen[0]).toEqual({ cmd: 'connector_tool', args: { name: 'slack_search', args: { query: 'roadmap', limit: 5 }, via: 'claude-code' } });
    expect(a.get(4).result).toEqual({ content: [{ type: 'text', text: 'That Slack thread was not found.' }], isError: true });
    expect(a.get(5).result.content[0].text).toContain('GitHub is not connected in Quorum');
  });
  it('says the app must be open when it is closed', async () => {
    const { h } = home({ notion: { connected: true } }, { app: false });
    const a = await session(h, [{ id: 1, method: 'tools/call', params: { name: 'notion_search', arguments: { query: 'x' } } }]);
    expect(a.get(1).result.content[0].text).toBe('notion_search reads Notion through the Quorum app, which holds your Notion sign-in, and Quorum is not open. Open Quorum and try again.');
  });
  it('serves only the connector tools in the chat\'s mode, and refuses the others', async () => {
    const { h, stop } = home({ notion: { connected: true } });
    stops.push(stop);
    const a = await session(h, [{ id: 1, method: 'tools/list' }, { id: 2, method: 'tools/call', params: { name: 'import_meeting', arguments: {} } }], { QUORUM_MCP_TOOLS: 'connectors' });
    expect(names(a, 1)).toEqual(['notion_search', 'notion_page']);
    expect(a.get(2).error.message).toBe('Unknown tool import_meeting');
  });
});
