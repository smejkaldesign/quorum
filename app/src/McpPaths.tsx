import { useEffect, useState } from 'react';
import type { McpOverlap, McpOverlapServer } from './quorum';
import { mcpPathsOf, type LibraryConnector } from '../connectors/library';

// When the person's agent already has a provider's own MCP server, the connector's row says so and shows what each
// path gives (connectors/library.js mcpPathsOf) and the recommended setup. Settings > Connections and the Agent OS
// step in onboarding both render it. Detection runs in the main process (connectors/mcpOverlap.js), read only, and is
// kept for the session; refreshOnFocus asks for a new pass whenever the window gets focus again.
export function useMcpOverlap({ refreshOnFocus = false, key = '' }: { refreshOnFocus?: boolean; key?: string } = {}) {
  const [overlap, setOverlap] = useState<McpOverlap | null>(null);
  useEffect(() => {
    let live = true;
    const get = (refresh: boolean) => window.quorum.mcpOverlap({ refresh }).then((r) => { if (live) setOverlap(r); return r; }).catch(() => null);
    // a pass older than a minute is redone when the page opens, so a server added since shows up
    get(false).then((r) => { if (refreshOnFocus && r && Date.now() - new Date(r.at).getTime() > 60000) get(true); });
    if (!refreshOnFocus) return () => { live = false; };
    const onFocus = () => { get(true); };
    window.addEventListener('focus', onFocus);
    return () => { live = false; window.removeEventListener('focus', onFocus); };
  }, [refreshOnFocus, key]);
  return overlap;
}

const WHERE: Record<McpOverlapServer['where'][number], string> = {
  'claude-list': 'Claude Code',
  'claude-user': 'Claude Code, all folders',
  'claude-project': 'Claude Code, this folder',
  vault: '.mcp.json in your Agent OS',
};
// "granola" in Claude Code; a server found in several places names each place once
const foundLine = (servers: McpOverlapServer[]) => servers.map((s) => {
  const places = s.where.includes('claude-list') && s.where.some((w) => w !== 'claude-list') ? s.where.filter((w) => w !== 'claude-list') : s.where;
  return `"${s.name}" in ${places.map((w) => WHERE[w]).join(', ')}`;
}).join('; ');

export function McpPaths({ connector, servers, open = false }: { connector: LibraryConnector; servers: McpOverlapServer[] | undefined; open?: boolean }) {
  const p = mcpPathsOf(connector);
  if (!p || !servers?.length) return null;
  return (
    <details className="mcp-paths" open={open}>
      <summary><strong>{p.title}</strong><span>{foundLine(servers)}</span></summary>
      <table className="mcp-paths-table">
        <thead><tr><th /><th scope="col">Quorum connector</th><th scope="col">{connector.name} MCP</th></tr></thead>
        <tbody>{p.rows.map((r) => <tr key={r.id}><th scope="row">{r.label}</th><td>{r.connector}</td><td>{r.mcp}</td></tr>)}</tbody>
      </table>
      <p>{p.explain}</p>
      <p className="mcp-paths-rec">{p.recommend}</p>
    </details>
  );
}

// the detail page's line when the agent has no MCP for this provider: the connector covers both jobs
export function McpAlone({ connector }: { connector: LibraryConnector }) {
  const p = mcpPathsOf(connector);
  if (!p?.alone) return null;
  return <p className="src-status">Your agent has no {connector.name} MCP set up. {p.alone}</p>;
}
