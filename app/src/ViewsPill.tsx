import { useMenu } from './controls';
import type { NoteViews } from './quorum';

// how many times a note has been read, as a pill in the metadata row; the popover splits people from agents and
// names the agents, with the tokens they spent reading it
const AGENT_NAMES: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', cursor: 'Cursor', antigravity: 'Antigravity', cli: 'quorum CLI', mcp: 'MCP client' };
const agentName = (via: string) => AGENT_NAMES[via] ?? via.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());

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
        </div>
      )}
    </span>
  );
}
