import { useEffect, useState, type ReactNode } from 'react';
import type { AgentActivity } from './quorum';
import { IconCheck, IconClose } from './icons';
import { took } from './NotificationsView';

// The AI working banner: the spinning mark, a shimmering line of what runs now, the time it has run and a progress bar.
// Memory health's bulk batch banner and the agent activity banner (Home and Memory health) both draw it.
export function WorkBanner({ state, text, startedAt, endedAt = null, progress = null, note = null, actions = null, children = null, onOpen, className = '' }: {
  state: 'live' | 'success' | 'error'; text: string; startedAt: number; endedAt?: number | null; progress?: number | null; note?: ReactNode; actions?: ReactNode; children?: ReactNode; onOpen?: () => void; className?: string;
}) {
  const live = state === 'live';
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (!live) return; const t = window.setInterval(() => setNow(Date.now()), 500); return () => window.clearInterval(t); }, [live]);
  const elapsed = (live ? now : endedAt ?? now) - startedAt;
  const open = onOpen ? { role: 'button', tabIndex: 0, onClick: onOpen, onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } } } : {};
  return (
    <div className={`run-banner mh-batch ${state}${onOpen ? ' work-open' : ''} ${className}`.trim()} role="status" aria-live="polite">
      <div className="run-head" {...open}>
        <span className="run-icon" aria-hidden="true">{live ? <i className="run-spin" /> : state === 'error' ? <IconClose width={17} height={17} /> : <IconCheck width={18} height={18} />}</span>
        <span className={`run-text${live ? ' shimmer' : ''}`} data-tip={text}>{text}</span>
        <span className="run-time">{took(Math.max(0, elapsed))}</span>
        {actions && <span className="work-actions" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>{actions}</span>}
      </div>
      {progress != null && <div className="mh-batch-bar" aria-hidden="true"><i style={{ width: `${Math.max(0, Math.min(1, progress)) * 100}%` }} /></div>}
      {note && <p className="mh-batch-note">{note}</p>}
      {children}
    </div>
  );
}

// the agent activity main reports (agentActivity.js): one state, the same on Home and in Memory health
export function useAgentActivity() {
  const [activity, setActivity] = useState<AgentActivity | null>(null);
  useEffect(() => {
    let live = true;
    window.quorum.agentActivity().then((s) => { if (live) setActivity(s); }).catch(() => {});
    const off = window.quorum.onAgentActivity((s) => setActivity(s));
    return () => { live = false; off(); };
  }, []);
  return activity;
}

const MORE = (n: number) => (n ? ` and ${n} more ${n === 1 ? 'task' : 'tasks'}` : '');
// Long memory work (more than 30 seconds): what runs, its progress and Cancel. onOpen opens Memory health, where the
// same banner shows; it hides when the work ends
export function AgentActivityBanner({ onOpen, className = '' }: { onOpen?: () => void; className?: string }) {
  const a = useAgentActivity();
  const [stopping, setStopping] = useState<string | null>(null);
  if (!a) return null;
  const progress = a.progress ? a.progress.done / a.progress.total : null;
  const count = a.progress && a.kind === 'batch' ? ` (${a.progress.done} of ${a.progress.total})` : '';
  const cancel = async () => { setStopping(a.id); try { await window.quorum.agentActivityCancel(a.id); } catch { setStopping(null); } };
  return (
    <WorkBanner
      className={className}
      state="live"
      text={`${a.label}${count}${MORE(a.more)}`}
      startedAt={a.startedAt}
      progress={progress}
      note={a.kind === 'check' ? 'Quorum is checking your memory. This can take a few minutes and runs in the background.' : null}
      onOpen={onOpen}
      actions={a.cancellable && stopping !== a.id ? <button className="act-pill run-dismiss" onClick={cancel}>Cancel</button> : null}
    />
  );
}
