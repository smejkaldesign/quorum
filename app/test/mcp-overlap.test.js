import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MCP_PROVIDERS, claudeConfigServers, createOverlapCache, detectOverlap, looksLikeToken, matchServers, mcpJsonServers, mcpListServers, providerOf, redactArgs, redactUrl } from '../connectors/mcpOverlap.js';
import { CONNECTOR_BY_ID, MCP_ALONE, MCP_EXPLAIN_INGEST, MCP_RECOMMEND_INGEST, mcpPathsOf } from '../connectors/library.js';

const GH = 'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
const SECRET = 'sk-live-9f8e7d6c5b4a39281706f5e4d3c2b1a0';

const LIST = [
  'Checking MCP server health…',
  '',
  'plugin:figma:figma: https://mcp.figma.com/mcp (HTTP) - ✔ Connected',
  'granola: https://mcp.granola.ai/mcp (HTTP) - ✔ Connected',
  'claude.ai Slack: https://mcp.slack.com/mcp (HTTP) - ✓ Connected',
  `github: npx -y @modelcontextprotocol/server-github --token ${GH} - ✗ Failed to connect`,
  'quorum: /usr/local/bin/node /x/cli/quorum.mjs mcp - ✔ Connected',
  'nonlinear-tools: npx nonlinear - ! Needs authentication',
].join('\n');

const CLAUDE = (vault) => JSON.stringify({
  numStartups: 4,
  mcpServers: {
    granola: { type: 'http', url: 'https://mcp.granola.ai/mcp', headers: { Authorization: `Bearer ${SECRET}` } },
    notion: { command: 'npx', args: ['-y', '@notionhq/notion-mcp-server'], env: { NOTION_TOKEN: SECRET } },
  },
  projects: {
    [vault]: { mcpServers: { linear: { type: 'http', url: 'https://mcp.linear.app/mcp' } } },
    '/somewhere/else': { mcpServers: { zoom: { url: 'https://api.zoom.us/mcp' } } },
  },
});

const dirs = [];
const temp = () => { const d = mkdtempSync(path.join(tmpdir(), 'mcp-overlap-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });

describe('redaction', () => {
  it('spots token shapes and leaves ordinary args alone', () => {
    for (const t of [GH, SECRET, 'xoxb-1234-5678-abcd', 'lin_api_abcdef123456', 'Bearer abc.def', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7']) expect(looksLikeToken(t)).toBe(true);
    for (const t of ['-y', '@modelcontextprotocol/server-github', '--project-ref=ttbjntphwogjdzqx', '/Applications/Some.app/server', 'mcp', 'https://mcp.granola.ai/mcp']) expect(looksLikeToken(t)).toBe(false);
  });
  it('replaces a token in args, after a secret flag, in --flag=value and in KEY=value', () => {
    const out = redactArgs(['-y', 'pkg', '--token', 'plain-but-secret', '--api-key=short', `GITHUB_TOKEN=${GH}`, '-e', 'MODE=dev', GH, '--header', 'X-Anything: v', 'Authorization: Bearer zzz', '--project-ref=abc']);
    expect(out).toEqual(['-y', 'pkg', '--token', '<redacted>', '--api-key=<redacted>', 'GITHUB_TOKEN=<redacted>', '-e', 'MODE=dev', '<redacted>', '--header', '<redacted>', 'Authorization: <redacted>', '--project-ref=abc']);
    expect(JSON.stringify(out)).not.toContain(GH);
  });
  it('drops user info and query strings from URLs and replaces token path segments', () => {
    expect(redactUrl(`https://user:${SECRET}@mcp.example.com/mcp?key=${SECRET}`)).toBe('https://mcp.example.com/mcp');
    expect(redactUrl(`https://mcp.zapier.com/api/mcp/s/${'Zx9'.repeat(12)}/mcp`)).toBe('https://mcp.zapier.com/api/mcp/s/<redacted>/mcp');
    expect(redactUrl(null)).toBeNull();
  });
});

describe('config readers', () => {
  it('parses claude mcp list, names with colons included', () => {
    const s = mcpListServers(LIST);
    expect(s.map((x) => x.name)).toEqual(['plugin:figma:figma', 'granola', 'claude.ai Slack', 'github', 'quorum', 'nonlinear-tools']);
    expect(s[1]).toMatchObject({ url: 'https://mcp.granola.ai/mcp', command: null, where: 'claude-list' });
    expect(s[3].command).toBe('npx');
    expect(s[3].args).toEqual(['-y', '@modelcontextprotocol/server-github', '--token', '<redacted>']);
    expect(JSON.stringify(s)).not.toContain(GH);
  });
  it('reads ~/.claude.json at user scope and project scope for the Agent OS folder only, never env or headers', () => {
    const s = claudeConfigServers(CLAUDE('/vault/root'), ['/vault/root/', null]);
    expect(s.map((x) => [x.name, x.where])).toEqual([['granola', 'claude-user'], ['notion', 'claude-user'], ['linear', 'claude-project']]);
    expect(Object.keys(s[0]).sort()).toEqual(['args', 'command', 'name', 'url', 'where']);
    expect(JSON.stringify(s)).not.toContain(SECRET);
    expect(claudeConfigServers('not json')).toEqual([]);
  });
  it('reads the vault .mcp.json', () => {
    const s = mcpJsonServers(JSON.stringify({ mcpServers: { drive: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-gdrive'], env: { GDRIVE_CREDS: SECRET } } } }));
    expect(s).toEqual([{ name: 'drive', url: null, command: 'npx', args: ['-y', '@modelcontextprotocol/server-gdrive'], where: 'vault' }]);
  });
});

describe('provider matcher', () => {
  const m = (name, v = {}) => providerOf({ name, url: v.url ?? null, command: v.command ?? null, args: v.args ?? [] });
  it('matches by name, host and package', () => {
    expect(m('granola')).toBe('granola');
    expect(m('claude.ai Granola')).toBe('granola');
    expect(m('meetings', { url: 'https://mcp.granola.ai/mcp' })).toBe('granola');
    expect(m('docs', { command: 'npx', args: ['-y', '@notionhq/notion-mcp-server'] })).toBe('notion');
    expect(m('notes', { url: 'https://mcp.notion.com/mcp' })).toBe('notion');
    expect(m('chat', { command: 'npx', args: ['@modelcontextprotocol/server-slack'] })).toBe('slack');
    expect(m('files', { command: 'npx', args: ['@modelcontextprotocol/server-gdrive'] })).toBe('google-drive');
    expect(m('google-calendar')).toBe('google-calendar');
    expect(m('gh', { url: 'https://api.githubcopilot.com/mcp/' })).toBe('github');
    expect(m('gh', { command: 'docker', args: ['run', '-i', 'ghcr.io/github/github-mcp-server'] })).toBe('github');
    expect(m('calls', { url: 'https://api.zoom.us/mcp' })).toBe('zoom');
    expect(m('issues', { url: 'https://mcp.linear.app/sse' })).toBe('linear');
  });
  it('skips Quorum itself, unrelated servers and partial words', () => {
    expect(m('quorum', { url: 'https://mcp.granola.ai/mcp' })).toBeNull();
    expect(m('nonlinear-tools', { command: 'npx', args: ['nonlinear'] })).toBeNull();
    expect(m('plugin:figma:figma', { url: 'https://mcp.figma.com/mcp' })).toBeNull();
    expect(m('evil', { url: 'https://granola.ai.example.com/mcp' })).toBeNull();
  });
  it('groups matches by connector and merges the places one server was found', () => {
    const r = matchServers([...mcpListServers(LIST), ...claudeConfigServers(CLAUDE('/v'), ['/v'])]);
    expect(Object.keys(r).sort()).toEqual(['github', 'granola', 'linear', 'notion', 'slack']);
    expect(r.granola).toEqual([{ name: 'granola', url: 'https://mcp.granola.ai/mcp', command: null, args: [], where: ['claude-list', 'claude-user'] }]);
  });
  it('maps every provider to a connector in the library with a paths table', () => {
    for (const id of Object.keys(MCP_PROVIDERS)) { expect(CONNECTOR_BY_ID[id]).toBeTruthy(); expect(mcpPathsOf(CONNECTOR_BY_ID[id])).toBeTruthy(); }
  });
});

describe('detection on fixture folders', () => {
  it('reads claude mcp list, ~/.claude.json and the vault .mcp.json without writing anything', async () => {
    const home = temp();
    const root = temp();
    const vault = path.join(root, 'vault');
    mkdirSync(vault);
    writeFileSync(path.join(home, '.claude.json'), CLAUDE(root));
    writeFileSync(path.join(vault, '.mcp.json'), JSON.stringify({ mcpServers: { 'granola-notes': { command: 'npx', args: ['granola-mcp', `--api-key=${SECRET}`] } } }));
    const r = await detectOverlap({ root, vault, home, list: async () => LIST });
    expect(r.read).toEqual({ claudeList: true, claudeConfig: true, vault: true });
    expect(r.matches.granola.map((s) => [s.name, s.where])).toEqual([['granola', ['claude-list', 'claude-user']], ['granola-notes', ['vault']]]);
    expect(r.matches.linear[0].where).toEqual(['claude-project']);
    expect(r.matches.zoom).toBeUndefined();
    const text = JSON.stringify(r);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(GH);
  });
  it('reports what it could not read and still answers', async () => {
    const r = await detectOverlap({ root: temp(), vault: null, home: temp(), list: async () => null });
    expect(r.read).toEqual({ claudeList: false, claudeConfig: false, vault: false });
    expect(r.matches).toEqual({});
  });
  it('keeps one pass for the session until a refresh or a new folder', async () => {
    let runs = 0;
    const cache = createOverlapCache(async () => ({ n: ++runs }));
    const [a, b] = await Promise.all([cache({ root: '/a' }), cache({ root: '/a' })]);
    expect([a.n, b.n, runs]).toEqual([1, 1, 1]);
    expect((await cache({ root: '/a' })).n).toBe(1);
    expect((await cache({ root: '/a' }, { refresh: true })).n).toBe(2);
    expect((await cache({ root: '/b' })).n).toBe(3);
  });
});

describe('what each path gives', () => {
  it('shows the Granola table, the split and the recommended setup in the issue wording', () => {
    const p = mcpPathsOf(CONNECTOR_BY_ID.granola);
    expect(p.title).toBe("Your agent also has Granola's MCP");
    expect(p.ingest).toBe(true);
    expect(p.rows.map((r) => [r.label, r.connector, r.mcp])).toEqual([
      ['Writes notes into the vault', 'Yes (summaries)', 'No'],
      ['Full transcripts', 'Off by default', 'Yes'],
      ['Linked to people, projects and daily notes', 'Yes, by the keeper', 'No'],
      ['Opted-out customers withheld', 'Yes', 'No'],
      ['Live lookups', 'No', 'Yes: search, participant filters, screenshots'],
    ]);
    expect(p.explain).toBe(MCP_EXPLAIN_INGEST);
    expect(p.explain).toMatch(/^Quorum keeps your meeting memory local\./);
    expect(p.recommend).toBe(MCP_RECOMMEND_INGEST);
    expect(p.recommend).toMatch(/keep the connector on for ingestion and upkeep, and keep the provider MCP for depth/);
    expect(p.alone).toBe(MCP_ALONE);
  });
  it('gives account connectors their own wording and every row both answers', () => {
    const n = mcpPathsOf(CONNECTOR_BY_ID.notion);
    expect(n.ingest).toBe(false);
    expect(n.alone).toBeNull();
    expect(n.explain).toContain("Notion's MCP");
    for (const id of Object.keys(MCP_PROVIDERS)) for (const r of mcpPathsOf(CONNECTOR_BY_ID[id]).rows) { expect(r.label).toBeTruthy(); expect(r.connector).toBeTruthy(); expect(r.mcp).toBeTruthy(); }
  });
  it('has no table for a connector without a provider MCP', () => {
    expect(mcpPathsOf(CONNECTOR_BY_ID['apple-calendar'])).toBeNull();
    expect(mcpPathsOf(undefined)).toBeNull();
  });
});
