// the names of agents that read notes, for the Views section of a note's panel
const AGENT_NAMES: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', cursor: 'Cursor', antigravity: 'Antigravity', cli: 'quorum CLI', mcp: 'MCP client' };
export const agentName = (via: string) => AGENT_NAMES[via] ?? via.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
