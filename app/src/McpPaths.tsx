import { useEffect, useState } from 'react';
import type { McpOverlap, McpOverlapServer } from './quorum';
import { mcpPathsOf, type LibraryConnector } from '../connectors/library';

// When the person's agent already has a provider's own MCP server, the connector's row says so and shows what each
// path gives (connectors/library.js mcpPathsOf) and the recommended setup. Settings > Connections and the Agent OS
// step in onboarding both render it. Detection runs in the main process (connectors/mcpOverlap.js), read only: the
// config files are read again on open and, with refreshOnFocus, on focus; `claude mcp list` runs once per session in
// the background, and its answer arrives through onMcpOverlap. check runs it again for Check again
export function useMcpOverlap({ refreshOnFocus = false, key = '' }: { refreshOnFocus?: boolean; key?: string } = {}) {
  const [overlap, setOverlap] = useState<McpOverlap | null>(null);
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    let live = true;
    const get = (refresh: boolean) => { window.quorum.mcpOverlap({ refresh }).then((r) => { if (live) setOverlap(r); }).catch(() => {}); };
    get(refreshOnFocus);
    const off = window.quorum.onMcpOverlap(() => get(false));
    const onFocus = () => get(true);
    if (refreshOnFocus) window.addEventListener('focus', onFocus);
    return () => { live = false; off(); window.removeEventListener('focus', onFocus); };
  }, [refreshOnFocus, key]);
  const check = async () => {
    setChecking(true);
    try { setOverlap(await window.quorum.mcpOverlapCheck()); } catch { /* the last answer stays */ } finally { setChecking(false); }
  };
  return { overlap, checking, check };
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

// what the detail page says about the agent's MCP for this provider, with Check again to run `claude mcp list` anew
export function McpStatus({ connector, overlap, checking, onCheck }: { connector: LibraryConnector; overlap: McpOverlap; checking: boolean; onCheck: () => void }) {
  const p = mcpPathsOf(connector);
  if (!p) return null;
  const on = overlap.matches[connector.id];
  const off = overlap.off[connector.id];
  const unread = !overlap.read.claudeList && !overlap.read.claudeConfig && !overlap.read.vault && !overlap.listing;
  const line = unread ? 'Quorum could not read your agent\'s MCP setup.'
    : off?.length ? `Your agent has ${connector.name}'s MCP set up but turned off (${foundLine(off)}).${p.alone ? ` ${p.alone}` : ''}`
    : `Your agent has no ${connector.name} MCP set up.${p.alone ? ` ${p.alone}` : ''}`;
  return (
    <>
      {on?.length ? <McpPaths connector={connector} servers={on} open /> : <p className="src-status">{line}</p>}
      <div className="mcp-paths-check">
        {overlap.listing && !checking && <span className="muted">Checking Claude Code's servers…</span>}
        <button className="pill small-pill" disabled={checking} onClick={onCheck}>{checking ? 'Checking…' : 'Check again'}</button>
      </div>
    </>
  );
}
