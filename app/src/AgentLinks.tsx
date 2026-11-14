import { useEffect, useState, type ReactNode } from 'react';
import type { AgentsStatus, ConnectionCheck, ConnectionCheckAction, ConnectionCheckItem } from './quorum';
import { Row, useMenu } from './controls';
import { IconCheck, IconClose, IconCode, IconInfo, IconMore, IconReset, ProviderMark } from './icons';

const home = (p: string) => p.replace(/^\/Users\/[^/]+/, '~');

// Claude Code, Codex and the quorum command, read and set up in the main process (agentLink.js). Settings > AI settings
// and the onboarding Connect step both use it
// load false skips the first read, for a view that gets the statuses from a check run instead
export function useAgents({ load = true }: { load?: boolean } = {}) {
  const [status, setStatus] = useState<AgentsStatus | null>(null);
  const [busy, setBusy] = useState<'' | 'claude' | 'codex' | 'cli'>('');
  const [msg, setMsg] = useState<{ claude?: string; codex?: string; cli?: string }>({});
  const refresh = () => window.quorum.agentsStatus().then(setStatus).catch(() => {});
  useEffect(() => { if (load) refresh(); }, [load]);
  // reread false leaves the status to whoever runs next (a check run reads every status itself)
  const run = async (kind: 'claude' | 'codex' | 'cli', op: () => Promise<{ added: boolean; error?: string | null }>, reread = true) => {
    setBusy(kind); setMsg((m) => ({ ...m, [kind]: '' }));
    try { const r = await op(); if (r?.error) setMsg((m) => ({ ...m, [kind]: r.error ?? '' })); } catch (e) { setMsg((m) => ({ ...m, [kind]: String((e as Error).message || e) })); }
    if (reread) await refresh();
    setBusy('');
  };
  const q = window.quorum;
  return {
    status, busy, msg, refresh, setStatus,
    addClaude: (reread = true) => run('claude', () => q.mcpAdd(), reread),
    removeClaude: () => run('claude', () => q.mcpRemove()),
    addCodex: (reread = true) => run('codex', () => q.codexAdd(), reread),
    removeCodex: () => run('codex', () => q.codexRemove()),
    addCli: (reread = true) => run('cli', () => q.cliAdd(), reread),
    removeCli: () => run('cli', () => q.cliRemove()),
    fixCli: (reread = true) => run('cli', () => q.cliAdd(), reread),
  };
}
export type Agents = ReturnType<typeof useAgents>;

export function claudeDesc(s: AgentsStatus | null) {
  if (!s) return 'Checking…';
  if (!s.claude.installed) return 'Install Claude Code first. Quorum then adds itself as an MCP server';
  if (s.claude.added && s.claude.error) return `${s.claude.error}. Add it again to fix it`;
  return s.claude.added ? 'Added for all your folders. Claude Code can read your meetings and notes' : 'Adds Quorum as an MCP server in Claude Code, so you can ask about your meetings and notes';
}
export function codexDesc(s: AgentsStatus | null) {
  if (!s) return 'Checking…';
  if (!s.codex.installed) return 'Install Codex first. Quorum then adds itself as an MCP server';
  if (s.codex.added && s.codex.error) return `${s.codex.error}. Add it again to fix it`;
  return s.codex.added ? 'Added. Codex can read your meetings and notes' : 'Adds Quorum as an MCP server in Codex, so you can ask about your meetings and notes';
}
export function cliDesc(s: AgentsStatus | null) {
  const c = s?.cli;
  if (!c) return 'Checking…';
  if (!c.added) return 'Adds the quorum command to Terminal on this Mac';
  if (c.error) return `${c.error}. Fix it from the menu`;
  const name = c.name ?? 'quorum';
  const renamed = name !== 'quorum' ? `Another quorum command is on this Mac, so Quorum's is called ${name}. ` : '';
  if (c.shadowed) return `Another program answers to ${name} in Terminal. Fix it from the menu`;
  if (c.where === 'path') return c.onPath === false ? `Installed at ${home(c.path ?? '')}, which is not on your PATH. Fix it from the menu` : `${renamed}Installed at ${home(c.path ?? '')}. Type ${name} in any Terminal window`;
  return `${renamed}Open a new Terminal window and type ${name}`;
}

// the three rows. Settings renders them as set rows; onboarding as its own choice lines
export function AgentRows({ agents, variant, manual }: { agents: Agents; variant: 'settings' | 'onboarding'; manual?: (command: string) => ReactNode }) {
  const { status: s, busy, msg } = agents;
  const [more, setMore] = useMenu();
  const claudeBtn = s?.claude.added && !s.claude.error
    ? <button className="pill" disabled={!!busy} onClick={agents.removeClaude}>{busy === 'claude' ? 'Removing…' : 'Remove'}</button>
    : <button className={`pill ${variant === 'onboarding' ? 'primary' : ''}`} disabled={!!busy || !s?.claude.installed} onClick={() => agents.addClaude()}>{busy === 'claude' ? 'Adding…' : 'Add'}</button>;
  const codexBtn = s?.codex.added && !s.codex.error
    ? <button className="pill" disabled={!!busy} onClick={agents.removeCodex}>{busy === 'codex' ? 'Removing…' : 'Remove'}</button>
    : <button className={`pill ${variant === 'onboarding' ? 'primary' : ''}`} disabled={!!busy || !s?.codex.installed} onClick={() => agents.addCodex()}>{busy === 'codex' ? 'Adding…' : 'Add'}</button>;
  const cli = s?.cli;
  const cliBroken = !!cli?.added && (!!cli.error || !!cli.shadowed || (cli.where === 'path' && cli.onPath === false));
  const cliBtn = cli?.added
    ? <span className="menu-wrap">
        <button className="icon-btn" aria-label="Terminal options" aria-haspopup="menu" aria-expanded={more} onClick={(e) => { e.stopPropagation(); setMore((o) => !o); }}><IconMore width={16} height={16} /></button>
        {more && (
          <div className="menu end" role="menu">
            {(cliBroken || cli.where === 'alias') && <button role="menuitem" disabled={!!busy} onClick={() => agents.fixCli()}><IconReset width={15} height={15} /> Fix connection</button>}
            <button role="menuitem" className="danger" disabled={!!busy} onClick={agents.removeCli}><IconClose width={15} height={15} /> Disconnect</button>
          </div>
        )}
      </span>
    : <button className={`pill ${variant === 'onboarding' ? 'primary' : ''}`} disabled={!!busy || !cli} onClick={() => agents.addCli()}>{busy === 'cli' ? 'Connecting…' : 'Connect'}</button>;
  const cliIcon = <IconCode width={18} height={18} className={!cli?.added ? undefined : cliBroken ? 'err' : 'ok'} />;
  const rows: { id: 'claude' | 'codex' | 'cli'; icon: ReactNode; title: string; desc: string; on: boolean; ctrl: ReactNode }[] = [
    { id: 'claude', icon: <ProviderMark provider="anthropic" />, title: 'Claude Code MCP', desc: claudeDesc(s), on: !!s?.claude.added && !s.claude.error, ctrl: claudeBtn },
    { id: 'codex', icon: <ProviderMark provider="openai" />, title: 'Codex MCP', desc: codexDesc(s), on: !!s?.codex.added && !s.codex.error, ctrl: codexBtn },
    { id: 'cli', icon: cliIcon, title: 'Quorum CLI', desc: cliDesc(s), on: !!cli?.added && !cliBroken, ctrl: cliBtn },
  ];
  return (
    <>
      {rows.map((r) => (
        <div key={r.id}>
          {variant === 'settings'
            ? <Row icon={r.icon} title={r.title} desc={r.desc}>{r.ctrl}</Row>
            : <div className={`onb-choice line ${r.on ? 'on' : ''}`}>{r.icon}<div><strong>{r.title}</strong><em>{r.desc}</em></div>{r.ctrl}</div>}
          {msg[r.id] && <p className="set-note mcp-msg">{msg[r.id]}</p>}
          {r.id === 'cli' && (!cli?.added || !!cli.error) && cli?.command && manual?.(cli.command)}
        </div>
      ))}
    </>
  );
}

const STATE_ICON: Record<ConnectionCheckItem['state'], ReactNode> = {
  ok: <IconCheck width={16} height={16} className="ok" />,
  fail: <IconClose width={16} height={16} className="err" />,
  warn: <IconInfo width={16} height={16} />,
  skip: <IconInfo width={16} height={16} />,
};

const ACTION_LABEL: Record<ConnectionCheckAction, string> = {
  'add-claude': 'Add to Claude Code', 'add-codex': 'Add to Codex', 'add-cli': 'Connect', 'fix-cli': 'Fix',
  'connect-folder': 'Choose folder', 'choose-meetings': 'Choose folder', retry: 'Check again',
};

// Check connection: runs connectionCheck.js and lists each check. A failure carries one button, and the button does
// the fix (adds or fixes a registration, opens a folder picker, or checks again), then checks again
export function useConnectionCheck(agents: Agents) {
  const [result, setResult] = useState<ConnectionCheck | null>(null);
  const [running, setRunning] = useState(false);
  const run = async () => {
    setRunning(true);
    try { const r = await window.quorum.connectionCheck(); setResult(r); if (r.agents) agents.setStatus(r.agents); } catch { setResult(null); } finally { setRunning(false); }
  };
  // the fix, then one check run, which reads every status again
  const act = async (a: ConnectionCheckAction) => {
    if (a === 'add-claude') await agents.addClaude(false);
    else if (a === 'add-codex') await agents.addCodex(false);
    else if (a === 'add-cli') await agents.addCli(false);
    else if (a === 'fix-cli') await agents.fixCli(false);
    else if (a === 'connect-folder') await window.quorum.connectBrain();
    else if (a === 'choose-meetings') await window.quorum.pickMeetingsDir();
    await run();
  };
  return { result, running, run, act };
}
export function ConnectionCheckList({ result, running, onAction }: { result: ConnectionCheck; running: boolean; onAction: (a: ConnectionCheckAction) => void }) {
  return (
    <ul className="conn-check" aria-live="polite">
      {result.checks.map((c) => (
        <li key={c.id} className={`conn-check-item ${c.state}`}>
          {STATE_ICON[c.state]}
          <div>
            <strong>{c.label}</strong>
            {c.fix && <span className="conn-check-fix">{c.fix}</span>}
            {c.detail && <span className="muted">{home(c.detail)}</span>}
          </div>
          {c.action ? <button className="pill small-pill" disabled={running} onClick={() => onAction(c.action as ConnectionCheckAction)}>{ACTION_LABEL[c.action]}</button> : <span />}
        </li>
      ))}
    </ul>
  );
}
export function ConnectionCheckButton({ running, onRun, label = 'Check connection' }: { running: boolean; onRun: () => void; label?: string }) {
  return <button className="pill" disabled={running} onClick={onRun}>{running ? 'Checking…' : label}</button>;
}
