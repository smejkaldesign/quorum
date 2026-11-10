import { useMenu } from './controls';
import type { NoteViews } from './quorum';

// how many times a note has been read, as a pill in the metadata row; the popover splits people from agents and
// names the agents, with the tokens they spent reading it
const AGENT_NAMES: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', cursor: 'Cursor', antigravity: 'Antigravity', cli: 'quorum CLI', mcp: 'MCP client' };
const agentName = (via: string) => AGENT_NAMES[via] ?? via.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
const ago = (iso: string) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ${h === 1 ? 'hour' : 'hours'} ago`;
  const d = Math.round(h / 24);
  return `${d} ${d === 1 ? 'day' : 'days'} ago`;
};
const tokensText = (n: number) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function ViewsPill({ views }: { views?: NoteViews | null }) {
  const [open, setOpen] = useMenu();
  if (!views || !views.total) return null;
  return (
    <span className="menu-wrap views-wrap" onClick={(e) => e.stopPropagation()}>
      <button className="meta-pill meta-views" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o: boolean) => !o)}>{views.total} {views.total === 1 ? 'view' : 'views'}</button>
      {open && (
        <div className="menu views-pop" role="dialog" aria-label="Who has read this note">
          <div className="views-row"><span>People</span><strong>{views.human}</strong></div>
          <div className="views-row"><span>Agents</span><strong>{views.agent}</strong></div>
          {views.agents.map((a) => <div key={a.via} className="views-row sub"><span>{agentName(a.via)}</span><strong>{a.count}</strong></div>)}
          {views.agent > 0 && <p className="views-note">About {tokensText(views.tokens)} tokens read by agents{views.lastAgentAt ? ` · last ${ago(views.lastAgentAt)}` : ''}</p>}
          {views.agent === 0 && <p className="views-note">No agent has read this note yet. Reads through Claude Code and the quorum MCP server count here.</p>}
        </div>
      )}
    </span>
  );
}
