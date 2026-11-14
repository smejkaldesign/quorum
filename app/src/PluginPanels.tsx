import { useEffect, useState } from 'react';
import type { ContextBudget, ContextFile } from './quorum';

// the result a report plugin shows under its row in Settings › Memory › Plugins, while the row is Quorum's
const n = (v: number) => v.toLocaleString('en-US');
const SCOPE: Record<ContextFile['scope'], string> = { user: 'every session, all projects', project: 'every session', memory: 'every session', nested: 'only when Claude works in that folder' };

export function ContextPanel() {
  const [c, setC] = useState<ContextBudget | null | undefined>(undefined);
  const load = () => window.quorum.pluginContext().then(setC).catch(() => setC(null));
  useEffect(() => { load(); }, []);
  if (c === undefined) return <div className="plugin-detail"><p className="plugin-line">Measuring…</p></div>;
  if (!c) return null;
  const share = c.quorum
    ? c.quorum.share != null
      ? `Quorum's learned block: ${n(c.quorum.chars)} characters in ${c.quorum.path}, ${Math.round(c.quorum.share * 100)}% of each session.`
      : `Quorum's learned block: ${n(c.quorum.chars)} characters in ${c.quorum.path}, which loads only when Claude works in that folder.`
    : 'Quorum has written no learned facts here.';
  return (
    <div className="plugin-detail">
      <p className="plugin-line"><strong>About {n(c.total.tokens)} tokens</strong> ({n(c.total.chars)} characters) load in every session.</p>
      {c.files.map((f) => (
        <div key={f.abs} className="plugin-item">
          <span className="plugin-path">{f.path}</span>
          <span className="plugin-meta">{n(f.chars)} characters, {n(f.lines)} lines · {SCOPE[f.scope]}</span>
          {f.warn && <span className="plugin-warn">{f.warn}</span>}
        </div>
      ))}
      <p className="plugin-line">{share}</p>
      {c.quorum?.aside && <p className="plugin-line muted">The facts themselves are in {c.quorum.aside.path} ({n(c.quorum.aside.chars)} characters), which Claude Code does not load on its own.</p>}
      {c.agent?.cut ? <p className="plugin-line plugin-warn">Quorum's own agent reads the first {n(c.agent.limit)} characters of {c.agent.path}, so the last {n(c.agent.cut)} are left out of its answers{c.agent.learnedCut ? ', including part of the learned facts' : ''}.</p> : null}
      <p className="plugin-line muted">Advice only. Quorum does not change these files.</p>
      <button className="pill small-pill" onClick={load}>Measure again</button>
    </div>
  );
}
