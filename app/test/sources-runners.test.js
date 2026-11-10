import { describe, expect, it } from 'vitest';
import { antigravityServers, claudeServers, codexServers, detectRunners, runnersWithSource } from '../sources/runners.js';

const CLAUDE = JSON.stringify({
  numStartups: 3,
  mcpServers: { granola: { type: 'http', url: 'https://mcp.granola.ai/mcp' }, quorum: { command: '/Applications/Quorum.app/Contents/MacOS/Quorum', args: ['/x/cli/quorum.mjs', 'mcp'] } },
  projects: { '/tmp/work': { mcpServers: { fireflies: { type: 'http', url: 'https://api.fireflies.ai/mcp' } } }, '/tmp/other': {} },
});
const CODEX = `
model = "o3"
[mcp_servers]

[mcp_servers.granola]
url = "https://mcp.granola.ai/mcp"   # remote

[mcp_servers.quorum]
command = "/Applications/Quorum.app/Contents/MacOS/Quorum"
args = ["/x/cli/quorum.mjs", "mcp"]

[other]
url = "https://ignored.example.com"
`;
const AGY = JSON.stringify({ mcpServers: { granola: { serverUrl: 'https://mcp.granola.ai/mcp', url: 'https://mcp.granola.ai/mcp' } } });

describe('runner configs', () => {
  it('reads Claude Code servers at user and project scope', () => {
    const s = claudeServers(CLAUDE);
    expect(s.map((x) => [x.name, x.scope])).toEqual([['granola', 'user'], ['quorum', 'user'], ['fireflies', 'project']]);
    expect(s[2].project).toBe('/tmp/work');
    expect(s[1].args).toEqual(['/x/cli/quorum.mjs', 'mcp']);
  });
  it('reads Codex mcp_servers tables and ignores everything else', () => {
    const s = codexServers(CODEX);
    expect(s.map((x) => x.name)).toEqual(['granola', 'quorum']);
    expect(s[0].url).toBe('https://mcp.granola.ai/mcp');
    expect(s[1].command).toContain('Quorum');
    expect(s[1].args).toEqual(['/x/cli/quorum.mjs', 'mcp']);
  });
  it('reads Antigravity servers and survives bad JSON', () => {
    expect(antigravityServers(AGY)[0]).toMatchObject({ name: 'granola', url: 'https://mcp.granola.ai/mcp' });
    expect(antigravityServers('{')).toEqual([]);
  });
});

describe('detectRunners and runnersWithSource', async () => {
  const files = { '/h/.claude.json': CLAUDE, '/h/.codex/config.toml': CODEX };
  const runners = await detectRunners({ home: '/h', readFile: (f) => { if (!(f in files)) throw new Error('missing'); return files[f]; }, exists: (f) => f in files, which: async (bin) => bin === 'claude' || bin === 'agy' });
  it('lists a runner that is installed or configured, with what it knows', () => {
    expect(runners.map((r) => [r.id, r.installed, r.configured, r.servers.length])).toEqual([['claude-code', true, true, 3], ['codex', false, true, 2], ['antigravity', true, false, 0]]);
  });
  it('matches a source by the host of its MCP URL and says whether the runner can write back', () => {
    const granola = { id: 'granola', url: 'https://mcp.granola.ai/mcp' };
    expect(runnersWithSource(granola, runners)).toEqual([
      { id: 'claude-code', name: 'Claude Code', installed: true, server: 'granola', scope: 'user', project: null, hasQuorum: true },
      { id: 'codex', name: 'Codex', installed: false, server: 'granola', scope: 'user', project: null, hasQuorum: true },
    ]);
    expect(runnersWithSource({ id: 'fireflies', url: 'https://api.fireflies.ai/mcp' }, runners)).toEqual([expect.objectContaining({ id: 'claude-code', server: 'fireflies', scope: 'project' })]);
    expect(runnersWithSource({ id: 'x', url: 'https://nowhere.example.com/mcp' }, runners)).toEqual([]);
  });
});
